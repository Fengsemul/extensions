"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const META_DB_NAME = "serp-domain-label-meta";
const META_DB_VERSION = 1;
const META_STORE = "metadata";
const STATE_KEY = "state";
const IMPORT_KEY = "import-state";

const GENERATION_DB_PREFIX = "serp-domain-label-generation-";
const GENERATION_DB_VERSION = 1;
const LABEL_STORE = "labels";

const LOOKUP_LIMIT = 256;
const IMPORT_BATCH_LIMIT = 5000;
const LOOKUP_CACHE_LIMIT = 20000;
const MAX_LABEL_LENGTH = 63;
const MAX_SOURCE_COUNT = 100;

const DEFAULT_STATE = Object.freeze({
  activeGeneration: null,
  count: 0,
  enabled: true,
  revision: 0,
  importedAt: null
});

let metaDatabasePromise = null;
let state = { ...DEFAULT_STATE };
let stateLoaded = false;

const generationDatabasePromises = new Map();
const pendingGenerationDeletions = new Set();

class LruCache {
  constructor(limit) {
    this.limit = limit;
    this.values = new Map();
  }

  get(key) {
    if (!this.values.has(key)) {
      return undefined;
    }

    const value = this.values.get(key);
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.values.has(key)) {
      this.values.delete(key);
    }

    this.values.set(key, value);

    if (this.values.size > this.limit) {
      const oldestKey = this.values.keys().next().value;
      this.values.delete(oldestKey);
    }
  }

  clear() {
    this.values.clear();
  }
}

const lookupCache = new LruCache(LOOKUP_CACHE_LIMIT);

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(
        request.error ??
          new Error("An IndexedDB request failed.")
      );
    };
  });
}

function transactionAsPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onerror = () => {
      reject(
        transaction.error ??
          new Error("An IndexedDB transaction failed.")
      );
    };

    transaction.onabort = () => {
      reject(
        transaction.error ??
          new Error("An IndexedDB transaction was aborted.")
      );
    };
  });
}

function openMetaDatabase() {
  if (metaDatabasePromise) {
    return metaDatabasePromise;
  }

  metaDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(
      META_DB_NAME,
      META_DB_VERSION
    );

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE);
      }
    };

    request.onsuccess = () => {
      const database = request.result;

      database.onversionchange = () => {
        database.close();
        metaDatabasePromise = null;
      };

      resolve(database);
    };

    request.onerror = () => {
      metaDatabasePromise = null;
      reject(
        request.error ??
          new Error("Could not open the metadata database.")
      );
    };

    request.onblocked = () => {
      metaDatabasePromise = null;
      reject(
        new Error(
          "Opening the metadata database was blocked."
        )
      );
    };
  });

  return metaDatabasePromise;
}

async function readMetadata(key) {
  const database = await openMetaDatabase();
  const transaction = database.transaction(
    META_STORE,
    "readonly"
  );

  const request = transaction
    .objectStore(META_STORE)
    .get(key);

  const value = await requestAsPromise(request);
  await transactionAsPromise(transaction);

  return value;
}

async function writeMetadata(key, value) {
  const database = await openMetaDatabase();
  const transaction = database.transaction(
    META_STORE,
    "readwrite"
  );

  transaction
    .objectStore(META_STORE)
    .put(value, key);

  await transactionAsPromise(transaction);
}

async function deleteMetadata(key) {
  const database = await openMetaDatabase();
  const transaction = database.transaction(
    META_STORE,
    "readwrite"
  );

  transaction
    .objectStore(META_STORE)
    .delete(key);

  await transactionAsPromise(transaction);
}

async function ensureStateLoaded() {
  if (stateLoaded) {
    return;
  }

  const storedState = await readMetadata(STATE_KEY);

  state = {
    ...DEFAULT_STATE,
    ...(
      storedState &&
      typeof storedState === "object" &&
      !Array.isArray(storedState)
        ? storedState
        : {}
    )
  };

  if (
    !Number.isSafeInteger(state.activeGeneration) ||
    state.activeGeneration < 1
  ) {
    state.activeGeneration = null;
    state.count = 0;
  }

  state.enabled = state.enabled !== false;

  state.revision =
    Number.isSafeInteger(state.revision) &&
    state.revision >= 0
      ? state.revision
      : 0;

  state.count =
    Number.isSafeInteger(state.count) &&
    state.count >= 0
      ? state.count
      : 0;

  stateLoaded = true;
}

function validateGeneration(value) {
  const generation = Number(value);

  if (
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new Error("Invalid database generation.");
  }

  return generation;
}

function generationDatabaseName(generation) {
  return (
    GENERATION_DB_PREFIX +
    validateGeneration(generation)
  );
}

function openGenerationDatabase(generation) {
  const validGeneration = validateGeneration(generation);

  if (generationDatabasePromises.has(validGeneration)) {
    return generationDatabasePromises.get(validGeneration);
  }

  const promise = new Promise((resolve, reject) => {
    const request = indexedDB.open(
      generationDatabaseName(validGeneration),
      GENERATION_DB_VERSION
    );

    request.onupgradeneeded = () => {
      const database = request.result;

      if (
        !database.objectStoreNames.contains(
          LABEL_STORE
        )
      ) {
        database.createObjectStore(LABEL_STORE);
      }
    };

    request.onsuccess = () => {
      const database = request.result;

      database.onversionchange = () => {
        database.close();
        generationDatabasePromises.delete(
          validGeneration
        );
      };

      resolve(database);
    };

    request.onerror = () => {
      generationDatabasePromises.delete(
        validGeneration
      );

      reject(
        request.error ??
          new Error(
            "Could not open generation database " +
              validGeneration +
              "."
          )
      );
    };

    request.onblocked = () => {
      generationDatabasePromises.delete(
        validGeneration
      );

      reject(
        new Error(
          "Opening generation database " +
            validGeneration +
            " was blocked."
        )
      );
    };
  });

  generationDatabasePromises.set(
    validGeneration,
    promise
  );

  return promise;
}

async function closeGenerationDatabase(generation) {
  const validGeneration = validateGeneration(generation);
  const promise = generationDatabasePromises.get(
    validGeneration
  );

  generationDatabasePromises.delete(validGeneration);

  if (!promise) {
    return;
  }

  try {
    const database = await promise;
    database.close();
  } catch {
    // A database that failed to open does not need closing.
  }
}

function deleteDatabaseRequest(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);

    request.onsuccess = () => {
      resolve(true);
    };

    request.onerror = () => {
      reject(
        request.error ??
          new Error(
            "Could not delete database " +
              databaseName +
              "."
          )
      );
    };

    request.onblocked = () => {
      resolve(false);
    };
  });
}

async function deleteGenerationDatabaseNow(generation) {
  const validGeneration = validateGeneration(generation);

  if (state.activeGeneration === validGeneration) {
    throw new Error(
      "The active generation cannot be deleted."
    );
  }

  await closeGenerationDatabase(validGeneration);

  const deleted = await deleteDatabaseRequest(
    generationDatabaseName(validGeneration)
  );

  if (!deleted) {
    throw new Error(
      "Deleting generation " +
        validGeneration +
        " is currently blocked."
    );
  }
}

function scheduleGenerationDeletion(generation) {
  const validGeneration = validateGeneration(generation);

  if (
    state.activeGeneration === validGeneration ||
    pendingGenerationDeletions.has(validGeneration)
  ) {
    return;
  }

  pendingGenerationDeletions.add(validGeneration);

  setTimeout(() => {
    deleteGenerationDatabaseNow(validGeneration)
      .catch((error) => {
        console.error(
          "Could not delete abandoned generation:",
          error
        );
      })
      .finally(() => {
        pendingGenerationDeletions.delete(
          validGeneration
        );
      });
  }, 0);
}

async function writeLabelBatch(generation, labels) {
  if (labels.length === 0) {
    return;
  }

  const database = await openGenerationDatabase(
    generation
  );

  const transaction = database.transaction(
    LABEL_STORE,
    "readwrite"
  );

  const store = transaction.objectStore(LABEL_STORE);

  for (const label of labels) {
    store.put(1, label);
  }

  await transactionAsPromise(transaction);
}

async function countGeneration(generation) {
  const database = await openGenerationDatabase(
    generation
  );

  const transaction = database.transaction(
    LABEL_STORE,
    "readonly"
  );

  const request = transaction
    .objectStore(LABEL_STORE)
    .count();

  const count = await requestAsPromise(request);
  await transactionAsPromise(transaction);

  return count;
}

async function generationContainsLabel(
  generation,
  label
) {
  const database = await openGenerationDatabase(
    generation
  );

  const transaction = database.transaction(
    LABEL_STORE,
    "readonly"
  );

  const request = transaction
    .objectStore(LABEL_STORE)
    .getKey(label);

  const key = await requestAsPromise(request);
  await transactionAsPromise(transaction);

  return key !== undefined;
}

function normalizeLabel(value) {
  let label = String(value)
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();

  if (!label) {
    return "";
  }

  if (label.startsWith("*://*.")) {
    label = label.slice(6);
  } else if (label.startsWith("*://")) {
    label = label.slice(4);
    label = label.replace(/^\*\./, "");
  }

  if (label.endsWith("/*")) {
    label = label.slice(0, -2);
  }

  label = label
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");

  if (
    label.includes("/") ||
    label.includes("\\") ||
    label.includes(":") ||
    label.includes("?") ||
    label.includes("#") ||
    label.includes("*") ||
    label.includes("|") ||
    label.includes("^") ||
    label.includes(".")
  ) {
    return "";
  }

  if (
    label.length === 0 ||
    label.length > MAX_LABEL_LENGTH
  ) {
    return "";
  }

  /*
   * Underscores are retained because the user's source lists
   * contain them. Ordinary web hostnames rarely expose them.
   */
  if (
    !/^[a-z0-9_-]+$/.test(label) ||
    label.startsWith("-") ||
    label.endsWith("-")
  ) {
    return "";
  }

  return label;
}

function normalizeHostname(value) {
  let hostname = String(value)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

  if (!hostname) {
    return "";
  }

  try {
    hostname = new URL(
      "http://" + hostname
    ).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return "";
  }

  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    hostname.includes(":") ||
    !hostname.includes(".")
  ) {
    return "";
  }

  const labels = hostname.split(".");

  if (labels.length < 2) {
    return "";
  }

  for (const label of labels) {
    if (
      label.length === 0 ||
      label.length > MAX_LABEL_LENGTH ||
      !/^[a-z0-9_-]+$/.test(label) ||
      label.startsWith("-") ||
      label.endsWith("-")
    ) {
      return "";
    }
  }

  return hostname;
}

function hostnameLabels(hostname) {
  const normalized = normalizeHostname(hostname);

  if (!normalized) {
    return [];
  }

  const labels = normalized.split(".");

  /*
   * Do not test the final label, which is generally a suffix
   * such as com, net, org, or uk.
   */
  return labels.slice(0, -1);
}

async function exactLabelIsBlocked(label) {
  await ensureStateLoaded();

  if (!state.enabled || !state.activeGeneration) {
    return false;
  }

  const normalized = normalizeLabel(label);

  if (!normalized) {
    return false;
  }

  const cacheKey =
    state.revision +
    ":" +
    state.activeGeneration +
    ":" +
    normalized;

  const cached = lookupCache.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const found = await generationContainsLabel(
    state.activeGeneration,
    normalized
  );

  lookupCache.set(cacheKey, found);
  return found;
}

async function hostnameIsBlocked(hostname) {
  for (const label of hostnameLabels(hostname)) {
    if (await exactLabelIsBlocked(label)) {
      return true;
    }
  }

  return false;
}

async function lookupHostnames(values) {
  await ensureStateLoaded();

  const input = Array.isArray(values)
    ? values.slice(0, LOOKUP_LIMIT)
    : [];

  const result = new Array(input.length).fill(false);
  const positions = new Map();
  const uniqueHostnames = [];

  for (let index = 0; index < input.length; index++) {
    const hostname = normalizeHostname(input[index]);

    if (!hostname) {
      continue;
    }

    if (!positions.has(hostname)) {
      positions.set(hostname, []);
      uniqueHostnames.push(hostname);
    }

    positions.get(hostname).push(index);
  }

  for (const hostname of uniqueHostnames) {
    const blocked = await hostnameIsBlocked(hostname);

    for (const position of positions.get(hostname)) {
      result[position] = blocked;
    }
  }

  return result;
}

function notifyFilteringChanged() {
  try {
    const operation = api.runtime.sendMessage({
      type: "filter-state-changed",
      generation: state.activeGeneration,
      revision: state.revision
    });

    if (
      operation &&
      typeof operation.catch === "function"
    ) {
      operation.catch(() => {});
    }
  } catch {
    // No content script may currently be listening.
  }
}

function publicImportState(importState) {
  if (!importState) {
    return null;
  }

  return {
    status: importState.status,
    importId: importState.importId,
    generation: importState.generation,
    expectedSourceCount:
      importState.expectedSourceCount,
    completedSources:
      importState.completedSources,
    currentSource: importState.currentSource,
    sourceNames: Array.isArray(importState.sourceNames)
      ? importState.sourceNames
      : [],
    batches: importState.batches,
    received: importState.received,
    accepted: importState.accepted,
    rejected: importState.rejected,
    startedAt: importState.startedAt,
    updatedAt: importState.updatedAt
  };
}

function publicStatus(importState = null) {
  const resumable =
    importState?.status === "building";

  return {
    enabled: state.enabled,
    active: Boolean(state.activeGeneration),
    count: state.count,
    generation: state.activeGeneration,
    revision: state.revision,
    importedAt: state.importedAt,
    importRunning: false,
    interruptedImport: resumable,
    resumableImport: resumable,
    importState: publicImportState(importState),
    sourceCount:
      importState?.expectedSourceCount ?? 0
  };
}

async function getStatus() {
  await ensureStateLoaded();

  const importState = await readMetadata(
    IMPORT_KEY
  );

  return publicStatus(importState ?? null);
}

async function updateSettings(message) {
  await ensureStateLoaded();

  if (typeof message.enabled === "boolean") {
    state.enabled = message.enabled;
  }

  state = {
    ...state,
    revision: state.revision + 1
  };

  await writeMetadata(STATE_KEY, state);

  lookupCache.clear();
  notifyFilteringChanged();

  return getStatus();
}

function validateImportId(importState, importId) {
  if (
    !importState ||
    importState.status !== "building" ||
    typeof importId !== "string" ||
    importState.importId !== importId
  ) {
    throw new Error(
      "No matching import session is active."
    );
  }
}

function validateExpectedSourceCount(value) {
  const count = Number(value);

  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_SOURCE_COUNT
  ) {
    throw new Error(
      "Invalid expected source count."
    );
  }

  return count;
}

function validateSourceNames(values, expectedCount) {
  if (
    !Array.isArray(values) ||
    values.length !== expectedCount
  ) {
    throw new Error(
      "The source-name list is missing or incomplete."
    );
  }

  const sourceNames = values.map((value) =>
    String(value).trim()
  );

  if (
    sourceNames.some(
      (name) =>
        !name ||
        name.length > 128 ||
        /[\\/\u0000]/.test(name)
    )
  ) {
    throw new Error(
      "The source-name list contains an invalid name."
    );
  }

  if (new Set(sourceNames).size !== sourceNames.length) {
    throw new Error(
      "The source-name list contains duplicates."
    );
  }

  return sourceNames;
}

async function allocateGeneration() {
  await ensureStateLoaded();

  const importState = await readMetadata(
    IMPORT_KEY
  );

  const candidates = [
    state.activeGeneration,
    importState?.generation,
    Date.now()
  ].filter(
    (value) =>
      Number.isSafeInteger(value) &&
      value >= 1
  );

  let generation = Math.max(0, ...candidates) + 1;

  while (
    generation === state.activeGeneration ||
    generation === importState?.generation
  ) {
    generation++;
  }

  return generation;
}

async function beginImport(message) {
  await ensureStateLoaded();

  const existingImport = await readMetadata(
    IMPORT_KEY
  );

  if (existingImport?.status === "building") {
    throw new Error(
      "A resumable import already exists."
    );
  }

  const importId = String(
    message.importId ?? ""
  ).trim();

  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(importId)) {
    throw new Error("Invalid import ID.");
  }

  const expectedSourceCount =
    validateExpectedSourceCount(
      message.expectedSourceCount
    );

  const sourceNames = validateSourceNames(
    message.sourceNames,
    expectedSourceCount
  );

  const generation = await allocateGeneration();

  /*
   * Opening the database creates an empty generation. No large
   * existing store is cleared here.
   */
  await openGenerationDatabase(generation);

  const now = new Date().toISOString();

  const importState = {
    status: "building",
    importId,
    generation,
    expectedSourceCount,
    sourceNames,
    completedSources: 0,
    currentSource: 1,
    batches: 0,
    received: 0,
    accepted: 0,
    rejected: 0,
    startedAt: now,
    updatedAt: now
  };

  await writeMetadata(IMPORT_KEY, importState);

  return {
    importId,
    generation,
    status: publicStatus(importState)
  };
}

async function resumeImport(message) {
  await ensureStateLoaded();

  const importState = await readMetadata(
    IMPORT_KEY
  );

  if (
    !importState ||
    importState.status !== "building"
  ) {
    throw new Error(
      "No resumable import exists."
    );
  }

  const expectedSourceCount =
    validateExpectedSourceCount(
      message.expectedSourceCount
    );

  const sourceNames = validateSourceNames(
    message.sourceNames,
    expectedSourceCount
  );

  if (
    importState.expectedSourceCount !==
      expectedSourceCount ||
    JSON.stringify(importState.sourceNames) !==
      JSON.stringify(sourceNames)
  ) {
    throw new Error(
      "The current source configuration does not match the saved import."
    );
  }

  await openGenerationDatabase(
    importState.generation
  );

  importState.currentSource = Math.min(
    importState.completedSources + 1,
    importState.expectedSourceCount
  );

  importState.updatedAt =
    new Date().toISOString();

  await writeMetadata(
    IMPORT_KEY,
    importState
  );

  return {
    importId: importState.importId,
    generation: importState.generation,
    nextSource: importState.currentSource,
    completedSources:
      importState.completedSources,
    status: publicStatus(importState)
  };
}

async function appendImportBatch(message) {
  await ensureStateLoaded();

  const importState = await readMetadata(
    IMPORT_KEY
  );

  validateImportId(
    importState,
    message.importId
  );

  const sourceIndex = Number(
    message.sourceIndex
  );

  if (
    !Number.isInteger(sourceIndex) ||
    sourceIndex !==
      importState.completedSources + 1 ||
    sourceIndex < 1 ||
    sourceIndex >
      importState.expectedSourceCount
  ) {
    throw new Error(
      "The batch does not belong to the next incomplete source."
    );
  }

  const values = Array.isArray(message.labels)
    ? message.labels.slice(
        0,
        IMPORT_BATCH_LIMIT
      )
    : [];

  const uniqueLabels = new Set();
  let rejected = 0;

  for (const value of values) {
    const label = normalizeLabel(value);

    if (label) {
      uniqueLabels.add(label);
    } else {
      rejected++;
    }
  }

  const labels = Array.from(uniqueLabels);

  await writeLabelBatch(
    importState.generation,
    labels
  );

  importState.batches += 1;
  importState.received += values.length;
  importState.accepted += labels.length;
  importState.rejected += rejected;
  importState.currentSource = sourceIndex;
  importState.updatedAt =
    new Date().toISOString();

  await writeMetadata(
    IMPORT_KEY,
    importState
  );

  return {
    accepted: labels.length,
    rejected,
    received: values.length,
    batches: importState.batches,
    generation: importState.generation
  };
}

async function completeImportSource(message) {
  await ensureStateLoaded();

  const importState = await readMetadata(
    IMPORT_KEY
  );

  validateImportId(
    importState,
    message.importId
  );

  const sourceIndex = Number(
    message.sourceIndex
  );

  if (
    !Number.isInteger(sourceIndex) ||
    sourceIndex < 1 ||
    sourceIndex >
      importState.expectedSourceCount
  ) {
    throw new Error("Invalid source index.");
  }

  if (
    sourceIndex !==
    importState.completedSources + 1
  ) {
    throw new Error(
      "Sources must complete in order."
    );
  }

  importState.completedSources = sourceIndex;
  importState.currentSource = Math.min(
    sourceIndex + 1,
    importState.expectedSourceCount
  );

  importState.updatedAt =
    new Date().toISOString();

  await writeMetadata(
    IMPORT_KEY,
    importState
  );

  return {
    completedSources:
      importState.completedSources,
    sourceCount:
      importState.expectedSourceCount,
    nextSource: importState.currentSource
  };
}

async function finishImport(message) {
  await ensureStateLoaded();

  const importState = await readMetadata(
    IMPORT_KEY
  );

  validateImportId(
    importState,
    message.importId
  );

  if (
    importState.completedSources !==
    importState.expectedSourceCount
  ) {
    throw new Error(
      "All configured sources must complete before activation."
    );
  }

  const exactCount = await countGeneration(
    importState.generation
  );

  if (exactCount < 1) {
    throw new Error(
      "The replacement label index is empty."
    );
  }

  const previousGeneration =
    state.activeGeneration;

  const nextState = {
    ...state,
    activeGeneration:
      importState.generation,
    count: exactCount,
    revision: state.revision + 1,
    importedAt: new Date().toISOString()
  };

  /*
   * This small metadata write is the activation point.
   */
  await writeMetadata(
    STATE_KEY,
    nextState
  );

  state = nextState;
  stateLoaded = true;
  lookupCache.clear();

  await deleteMetadata(IMPORT_KEY);
  notifyFilteringChanged();

  if (
    previousGeneration &&
    previousGeneration !==
      state.activeGeneration
  ) {
    scheduleGenerationDeletion(
      previousGeneration
    );
  }

  return {
    ...publicStatus(null),
    exactCount
  };
}

async function abandonImport(message) {
  await ensureStateLoaded();

  const importState = await readMetadata(
    IMPORT_KEY
  );

  if (!importState) {
    return {
      abandoned: false,
      message: "No import session exists."
    };
  }

  if (
    message.importId &&
    importState.importId !== message.importId
  ) {
    throw new Error(
      "The import ID does not match."
    );
  }

  /*
   * Release the interface first. Database deletion is scheduled
   * afterward and is not awaited.
   */
  await deleteMetadata(IMPORT_KEY);

  scheduleGenerationDeletion(
    importState.generation
  );

  return {
    abandoned: true,
    message:
      "The incomplete build was abandoned. Its database will be removed separately."
  };
}

async function clearAllData() {
  await ensureStateLoaded();

  const importState = await readMetadata(
    IMPORT_KEY
  );

  const activeGeneration =
    state.activeGeneration;

  /*
   * Remove metadata first so the options page becomes usable
   * immediately. Large database deletions happen afterward.
   */
  await deleteMetadata(IMPORT_KEY);

  state = {
    ...DEFAULT_STATE,
    enabled: state.enabled,
    revision: state.revision + 1
  };

  await writeMetadata(STATE_KEY, state);

  lookupCache.clear();
  notifyFilteringChanged();

  if (importState?.generation) {
    scheduleGenerationDeletion(
      importState.generation
    );
  }

  if (activeGeneration) {
    scheduleGenerationDeletion(
      activeGeneration
    );
  }

  return publicStatus(null);
}

api.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  switch (message.type) {
    case "lookup":
      return lookupHostnames(
        message.hostnames
      ).then((blocked) => ({
        blocked,
        generation:
          state.activeGeneration,
        revision: state.revision
      }));

    case "get-status":
      return getStatus();

    case "set-settings":
      return updateSettings(message);

    case "begin-import":
      return beginImport(message);

    case "resume-import":
      return resumeImport(message);

    case "append-import-batch":
      return appendImportBatch(message);

    case "complete-import-source":
      return completeImportSource(message);

    case "finish-import":
      return finishImport(message);

    case "abandon-import":
    case "cancel-import":
      return abandonImport(message);

    case "clear-data":
      return clearAllData();

    default:
      return undefined;
  }
});

ensureStateLoaded().catch((error) => {
  console.error(
    "Could not initialize SERP Domain Label Index:",
    error
  );
});
