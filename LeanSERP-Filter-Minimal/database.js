"use strict";

globalThis.LeanDb = (() => {
    const DATABASE_NAME = "leanserp-filter-v3";
    const DATABASE_VERSION = 1;

    const SLOTS = Object.freeze({
        A: "A",
        B: "B"
    });

    const RULE_TYPES = Object.freeze({
        label: 0,
        exactHost: 1,
        pslOverride: 2
    });

    const RULE_NAMES = Object.freeze({
        labels: "labels",
        exactHosts: "exactHosts",
        pslOverrides: "pslOverrides"
    });

    const MANUAL_CATEGORIES = Object.freeze({
        labels: "manualLabels",
        exactHosts: "manualExactHosts",
        pslOverrides: "manualPslOverrides"
    });

    const STORES = Object.freeze({
        productionLabelsA: "productionLabelsA",
        productionExactHostsA: "productionExactHostsA",
        productionPslOverridesA: "productionPslOverridesA",
        productionLabelsB: "productionLabelsB",
        productionExactHostsB: "productionExactHostsB",
        productionPslOverridesB: "productionPslOverridesB",
        state: "state",
        packages: "packages",
        manualLabels: "manualLabels",
        manualExactHosts: "manualExactHosts",
        manualPslOverrides: "manualPslOverrides",
        manualImports: "manualImports",
        manualImportRules: "manualImportRules"
    });

    const STATE_KEYS = Object.freeze({
        activeSlot: "activeSlot",
        stagingSlot: "stagingSlot"
    });

    const PACKAGE_STATES = Object.freeze({
        staging: "staging",
        active: "active",
        obsolete: "obsolete",
        failed: "failed"
    });

    const MAX_TRANSACTION_ITEMS = 4000;
    const MAX_LOOKUP_BATCH = 128;
    const MAX_DELETE_BATCH = 4000;
    const MAX_MANUAL_IMPORT_RULES = 100000;

    const PRODUCTION_STORE_MAP = Object.freeze({
        A: Object.freeze({
            labels: STORES.productionLabelsA,
            exactHosts: STORES.productionExactHostsA,
            pslOverrides: STORES.productionPslOverridesA
        }),
        B: Object.freeze({
            labels: STORES.productionLabelsB,
            exactHosts: STORES.productionExactHostsB,
            pslOverrides: STORES.productionPslOverridesB
        })
    });

    let openPromise = null;
    let operationQueue = Promise.resolve();

    function queueExclusive(operation) {
        const run = operationQueue.then(
            operation,
            operation
        );

        operationQueue = run.catch(
            () => undefined
        );

        return run;
    }

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onerror = () => {
                reject(
                    request.error ||
                    new Error(
                        "IndexedDB request failed."
                    )
                );
            };
        });
    }

    function transactionToPromise(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => {
                resolve();
            };

            transaction.onerror = () => {
                reject(
                    transaction.error ||
                    new Error(
                        "IndexedDB transaction failed."
                    )
                );
            };

            transaction.onabort = () => {
                reject(
                    transaction.error ||
                    new Error(
                        "IndexedDB transaction was aborted."
                    )
                );
            };
        });
    }

    function validateSlot(slot) {
        if (
            slot !== SLOTS.A &&
            slot !== SLOTS.B
        ) {
            throw new Error(
                "Invalid production slot."
            );
        }

        return slot;
    }

    function getInactiveSlot(activeSlot) {
        if (activeSlot === SLOTS.A) {
            return SLOTS.B;
        }

        return SLOTS.A;
    }

    function validateRuleName(ruleName) {
        if (
            ruleName !== RULE_NAMES.labels &&
            ruleName !== RULE_NAMES.exactHosts &&
            ruleName !== RULE_NAMES.pslOverrides
        ) {
            throw new Error(
                "Unknown production rule category."
            );
        }

        return ruleName;
    }

    function ruleTypeToName(ruleType) {
        if (ruleType === RULE_TYPES.label) {
            return RULE_NAMES.labels;
        }

        if (ruleType === RULE_TYPES.exactHost) {
            return RULE_NAMES.exactHosts;
        }

        if (ruleType === RULE_TYPES.pslOverride) {
            return RULE_NAMES.pslOverrides;
        }

        throw new Error(
            "Unknown production rule type."
        );
    }

    function validateRuleType(ruleType) {
        ruleTypeToName(ruleType);
        return ruleType;
    }

    function getProductionStoreName(
        slot,
        ruleName
    ) {
        validateSlot(slot);
        validateRuleName(ruleName);

        return PRODUCTION_STORE_MAP[
            slot
        ][ruleName];
    }

    function getProductionStoreFromType(
        slot,
        ruleType
    ) {
        return getProductionStoreName(
            slot,
            ruleTypeToName(ruleType)
        );
    }

    function validateManualCategory(category) {
        const storeName =
            MANUAL_CATEGORIES[category];

        if (!storeName) {
            throw new Error(
                "Unknown manual rule category."
            );
        }

        return storeName;
    }

    function normalizeRuleKey(value) {
        const key = String(value || "")
            .replace(/^\uFEFF/, "")
            .trim()
            .toLowerCase();

        if (
            key.length === 0 ||
            key.length > 253
        ) {
            return "";
        }

        return key;
    }

    function normalizeRuleKeys(values) {
        if (!Array.isArray(values)) {
            throw new Error(
                "Rule keys must be an array."
            );
        }

        const output = [];
        const seen = new Set();

        for (const value of values) {
            const key =
                normalizeRuleKey(value);

            if (
                key &&
                !seen.has(key)
            ) {
                seen.add(key);
                output.push(key);
            }
        }

        return output;
    }

    function normalizeCount(value) {
        const count = Number(value || 0);

        if (
            !Number.isSafeInteger(count) ||
            count < 0
        ) {
            return 0;
        }

        return count;
    }

    function normalizeCounts(value) {
        const source =
            value &&
            typeof value === "object"
                ? value
                : {};

        return {
            labels:
                normalizeCount(
                    source.labels
                ),
            exactHosts:
                normalizeCount(
                    source.exactHosts
                ),
            pslOverrides:
                normalizeCount(
                    source.pslOverrides
                )
        };
    }

    function generateImportId() {
        const randomValues =
            crypto.getRandomValues(
                new Uint32Array(4)
            );

        return [
            Date.now().toString(36),
            ...Array.from(
                randomValues,
                value =>
                    value.toString(36)
            )
        ].join("-");
    }

    function open() {
        if (openPromise) {
            return openPromise;
        }

        openPromise = new Promise(
            (resolve, reject) => {
                const request =
                    indexedDB.open(
                        DATABASE_NAME,
                        DATABASE_VERSION
                    );

                request.onupgradeneeded =
                    event => {
                        const database =
                            request.result;

                        const transaction =
                            request.transaction;

                        const primitiveStores = [
                            STORES.productionLabelsA,
                            STORES.productionExactHostsA,
                            STORES.productionPslOverridesA,
                            STORES.productionLabelsB,
                            STORES.productionExactHostsB,
                            STORES.productionPslOverridesB
                        ];

                        for (
                            const storeName of
                            primitiveStores
                        ) {
                            if (
                                !database.objectStoreNames
                                    .contains(
                                        storeName
                                    )
                            ) {
                                database
                                    .createObjectStore(
                                        storeName
                                    );
                            }
                        }

                        if (
                            !database.objectStoreNames
                                .contains(
                                    STORES.state
                                )
                        ) {
                            database
                                .createObjectStore(
                                    STORES.state
                                );
                        }

                        if (
                            !database.objectStoreNames
                                .contains(
                                    STORES.packages
                                )
                        ) {
                            database
                                .createObjectStore(
                                    STORES.packages,
                                    {
                                        keyPath: "slot"
                                    }
                                );
                        }

                        for (
                            const storeName of [
                                STORES.manualLabels,
                                STORES.manualExactHosts,
                                STORES.manualPslOverrides
                            ]
                        ) {
                            if (
                                !database.objectStoreNames
                                    .contains(
                                        storeName
                                    )
                            ) {
                                database
                                    .createObjectStore(
                                        storeName,
                                        {
                                            keyPath: "key"
                                        }
                                    );
                            }
                        }

                        if (
                            !database.objectStoreNames
                                .contains(
                                    STORES.manualImports
                                )
                        ) {
                            const store =
                                database
                                    .createObjectStore(
                                        STORES.manualImports,
                                        {
                                            keyPath:
                                                "importId"
                                        }
                                    );

                            store.createIndex(
                                "byImportedAt",
                                "importedAt",
                                {
                                    unique: false
                                }
                            );

                            store.createIndex(
                                "byCategory",
                                "category",
                                {
                                    unique: false
                                }
                            );
                        }

                        if (
                            !database.objectStoreNames
                                .contains(
                                    STORES.manualImportRules
                                )
                        ) {
                            const store =
                                database
                                    .createObjectStore(
                                        STORES.manualImportRules,
                                        {
                                            keyPath: [
                                                "importId",
                                                "rule"
                                            ]
                                        }
                                    );

                            store.createIndex(
                                "byImportId",
                                "importId",
                                {
                                    unique: false
                                }
                            );
                        }

                        if (
                            event.oldVersion === 0 &&
                            transaction
                        ) {
                            const stateStore =
                                transaction
                                    .objectStore(
                                        STORES.state
                                    );

                            stateStore.put(
                                null,
                                STATE_KEYS.activeSlot
                            );

                            stateStore.put(
                                null,
                                STATE_KEYS.stagingSlot
                            );
                        }
                    };

                request.onsuccess = () => {
                    const database =
                        request.result;

                    database.onversionchange =
                        () => {
                            database.close();
                            openPromise = null;
                        };

                    resolve(database);
                };

                request.onerror = () => {
                    openPromise = null;

                    reject(
                        request.error ||
                        new Error(
                            "Could not open the LeanSERP v3 database."
                        )
                    );
                };

                request.onblocked = () => {
                    openPromise = null;

                    reject(
                        new Error(
                            "The database is blocked by another LeanSERP page."
                        )
                    );
                };
            }
        );

        return openPromise;
    }

    async function getState(key) {
        const database = await open();

        const transaction =
            database.transaction(
                STORES.state,
                "readonly"
            );

        const value =
            await requestToPromise(
                transaction
                    .objectStore(
                        STORES.state
                    )
                    .get(key)
            );

        await transactionToPromise(
            transaction
        );

        return value === undefined
            ? null
            : value;
    }

    async function setState(key, value) {
        const database = await open();

        const transaction =
            database.transaction(
                STORES.state,
                "readwrite"
            );

        transaction
            .objectStore(
                STORES.state
            )
            .put(
                value,
                key
            );

        await transactionToPromise(
            transaction
        );
    }

    async function getActiveSlot() {
        const slot = await getState(
            STATE_KEYS.activeSlot
        );

        return (
            slot === SLOTS.A ||
            slot === SLOTS.B
        )
            ? slot
            : null;
    }

    async function getStagingSlot() {
        const slot = await getState(
            STATE_KEYS.stagingSlot
        );

        return (
            slot === SLOTS.A ||
            slot === SLOTS.B
        )
            ? slot
            : null;
    }

    async function getPackage(slot) {
        validateSlot(slot);

        const database = await open();

        const transaction =
            database.transaction(
                STORES.packages,
                "readonly"
            );

        const record =
            await requestToPromise(
                transaction
                    .objectStore(
                        STORES.packages
                    )
                    .get(slot)
            );

        await transactionToPromise(
            transaction
        );

        return record || null;
    }

    async function listPackages() {
        const database = await open();

        const transaction =
            database.transaction(
                STORES.packages,
                "readonly"
            );

        const records =
            await requestToPromise(
                transaction
                    .objectStore(
                        STORES.packages
                    )
                    .getAll()
            );

        await transactionToPromise(
            transaction
        );

        return records.sort(
            (left, right) =>
                String(right.createdAt || "")
                    .localeCompare(
                        String(left.createdAt || "")
                    )
        );
    }

    async function clearObjectStoreBatched(
        storeName
    ) {
        let deletedTotal = 0;

        while (true) {
            const database = await open();

            const deleted =
                await new Promise(
                    (resolve, reject) => {
                        const transaction =
                            database.transaction(
                                storeName,
                                "readwrite"
                            );

                        const store =
                            transaction
                                .objectStore(
                                    storeName
                                );

                        const request =
                            store.openCursor();

                        let processed = 0;

                        request.onsuccess =
                            () => {
                                const cursor =
                                    request.result;

                                if (
                                    !cursor ||
                                    processed >=
                                        MAX_DELETE_BATCH
                                ) {
                                    return;
                                }

                                cursor.delete();
                                processed += 1;
                                cursor.continue();
                            };

                        request.onerror =
                            () => {
                                reject(
                                    request.error ||
                                    new Error(
                                        "Could not enumerate rules for deletion."
                                    )
                                );
                            };

                        transaction.oncomplete =
                            () => {
                                resolve(processed);
                            };

                        transaction.onerror =
                            () => {
                                reject(
                                    transaction.error ||
                                    new Error(
                                        "Rule-deletion transaction failed."
                                    )
                                );
                            };

                        transaction.onabort =
                            () => {
                                reject(
                                    transaction.error ||
                                    new Error(
                                        "Rule deletion was aborted."
                                    )
                                );
                            };
                    }
                );

            deletedTotal += deleted;

            if (deleted < MAX_DELETE_BATCH) {
                break;
            }
        }

        return deletedTotal;
    }

    async function clearProductionSlot(
        slot
    ) {
        validateSlot(slot);

        const removed = {
            labels: 0,
            exactHosts: 0,
            pslOverrides: 0
        };

        for (
            const ruleName of [
                RULE_NAMES.labels,
                RULE_NAMES.exactHosts,
                RULE_NAMES.pslOverrides
            ]
        ) {
            removed[ruleName] =
                await clearObjectStoreBatched(
                    getProductionStoreName(
                        slot,
                        ruleName
                    )
                );
        }

        return removed;
    }

    async function beginProductionImport(
        metadata = {}
    ) {
        return queueExclusive(async () => {
            const stagingSlot =
                await getStagingSlot();

            if (stagingSlot !== null) {
                throw new Error(
                    "Another production package is already staging."
                );
            }

            const activeSlot =
                await getActiveSlot();

            const targetSlot =
                getInactiveSlot(
                    activeSlot
                );

            await clearProductionSlot(
                targetSlot
            );

            const database = await open();

            const transaction =
                database.transaction(
                    [
                        STORES.packages,
                        STORES.state
                    ],
                    "readwrite"
                );

            const now =
                new Date().toISOString();

            transaction
                .objectStore(
                    STORES.packages
                )
                .put({
                    slot: targetSlot,
                    state:
                        PACKAGE_STATES.staging,
                    packageName:
                        String(
                            metadata.packageName ||
                            ""
                        ),
                    createdAt: now,
                    completedAt: null,
                    activatedAt: null,
                    expectedCounts:
                        normalizeCounts(
                            metadata.expectedCounts
                        ),
                    importedCounts: {
                        labels: 0,
                        exactHosts: 0,
                        pslOverrides: 0
                    },
                    files:
                        metadata.files &&
                        typeof metadata.files ===
                            "object"
                            ? metadata.files
                            : {},
                    error: ""
                });

            transaction
                .objectStore(
                    STORES.state
                )
                .put(
                    targetSlot,
                    STATE_KEYS.stagingSlot
                );

            await transactionToPromise(                transaction
            );
            return {
                slot: targetSlot,
                previousActiveSlot: activeSlot
            };
        });
    }

    async function updatePackageCounts(
        slot,
        increments
    ) {
        validateSlot(slot);
        const database = await open();
        const transaction =
            database.transaction(
                STORES.packages,
                "readwrite"
            );
        const store =
            transaction.objectStore(
                STORES.packages
            );
        const record =
            await requestToPromise(
                store.get(slot)
            );
        if (
            !record ||
            record.state !==
                PACKAGE_STATES.staging
        ) {
            transaction.abort();
            throw new Error(
                "The production package is not staging."
            );
        }
        const normalized =
            normalizeCounts(increments);
        for (
            const ruleName of [
                RULE_NAMES.labels,
                RULE_NAMES.exactHosts,
                RULE_NAMES.pslOverrides
            ]
        ) {
            record.importedCounts[ruleName] =
                normalizeCount(
                    record.importedCounts[
                        ruleName
                    ]
                ) +
                normalized[ruleName];
        }
        store.put(record);
        await transactionToPromise(
            transaction
        );
    }

    async function putProductionBatch(
        slot,
        ruleType,
        rules
    ) {
        validateSlot(slot);
        validateRuleType(ruleType);
        const normalizedRules =
            normalizeRuleKeys(rules);
        if (
            normalizedRules.length >
            MAX_TRANSACTION_ITEMS
        ) {
            throw new Error(
                `Production batch exceeds ${MAX_TRANSACTION_ITEMS} rules.`
            );
        }
        if (normalizedRules.length === 0) {
            return 0;
        }
        const stagingSlot =
            await getStagingSlot();
        if (stagingSlot !== slot) {
            throw new Error(
                "Rules can be added only to the staging slot."
            );
        }
        const packageRecord =
            await getPackage(slot);
        if (
            !packageRecord ||
            packageRecord.state !==
                PACKAGE_STATES.staging
        ) {
            throw new Error(
                "The production package is not staging."
            );
        }
        const ruleName =
            ruleTypeToName(ruleType);
        const storeName =
            getProductionStoreName(
                slot,
                ruleName
            );
        const database = await open();
        const transaction =
            database.transaction(
                storeName,
                "readwrite"
            );
        const store =
            transaction.objectStore(
                storeName
            );
        for (const rule of normalizedRules) {
            store.put(0, rule);
        }
        await transactionToPromise(
            transaction
        );
        await updatePackageCounts(
            slot,
            {
                [ruleName]:
                    normalizedRules.length
            }
        );
        return normalizedRules.length;
    }

    async function hasProductionBatch(
        slot,
        ruleType,
        rules
    ) {
        validateSlot(slot);
        validateRuleType(ruleType);
        const normalizedRules =
            normalizeRuleKeys(rules);
        if (
            normalizedRules.length >
            MAX_LOOKUP_BATCH
        ) {
            throw new Error(
                `Lookup batch exceeds ${MAX_LOOKUP_BATCH} rules.`
            );
        }
        const result =
            Object.create(null);
        for (const rule of normalizedRules) {
            result[rule] = false;
        }
        if (normalizedRules.length === 0) {
            return result;
        }
        const storeName =
            getProductionStoreFromType(
                slot,
                ruleType
            );
        const database = await open();
        const transaction =
            database.transaction(
                storeName,
                "readonly"
            );
        const store =
            transaction.objectStore(
                storeName
            );
        await Promise.all(
            normalizedRules.map(
                async rule => {
                    const value =
                        await requestToPromise(
                            store.get(rule)
                        );
                    result[rule] =
                        value !== undefined;
                }
            )
        );
        await transactionToPromise(
            transaction
        );
        return result;
    }

    async function countProductionRules(
        slot,
        ruleType
    ) {
        validateSlot(slot);
        validateRuleType(ruleType);
        const storeName =
            getProductionStoreFromType(
                slot,
                ruleType
            );
        const database = await open();
        const transaction =
            database.transaction(
                storeName,
                "readonly"
            );
        const count =
            await requestToPromise(
                transaction
                    .objectStore(storeName)
                    .count()
            );
        await transactionToPromise(
            transaction
        );
        return count;
    }

    async function verifyProductionSlot(
        slot
    ) {
        validateSlot(slot);
        const packageRecord =
            await getPackage(slot);
        if (!packageRecord) {
            throw new Error(
                "Package metadata was not found."
            );
        }
        const counts = {
            labels:
                await countProductionRules(
                    slot,
                    RULE_TYPES.label
                ),
            exactHosts:
                await countProductionRules(
                    slot,
                    RULE_TYPES.exactHost
                ),
            pslOverrides:
                await countProductionRules(
                    slot,
                    RULE_TYPES.pslOverride
                )
        };
        const expected =
            normalizeCounts(
                packageRecord.expectedCounts
            );
        for (
            const ruleName of [
                RULE_NAMES.labels,
                RULE_NAMES.exactHosts,
                RULE_NAMES.pslOverrides
            ]
        ) {
            if (
                counts[ruleName] !==
                expected[ruleName]
            ) {
                throw new Error(
                    `${ruleName} count mismatch: expected ${expected[ruleName]}, found ${counts[ruleName]}.`
                );
            }
        }
        return counts;
    }

    async function activateProductionSlot(
        slot
    ) {
        return queueExclusive(async () => {
            validateSlot(slot);
            const stagingSlot =
                await getStagingSlot();
            if (stagingSlot !== slot) {
                throw new Error(
                    "Only the staging slot can be activated."
                );
            }
            const counts =
                await verifyProductionSlot(
                    slot
                );
            const oldActiveSlot =
                await getActiveSlot();
            const database = await open();
            const transaction =
                database.transaction(
                    [
                        STORES.packages,
                        STORES.state
                    ],
                    "readwrite"
                );
            const packageStore =
                transaction.objectStore(
                    STORES.packages
                );
            const stateStore =
                transaction.objectStore(
                    STORES.state
                );
            const record =
                await requestToPromise(
                    packageStore.get(slot)
                );
            if (
                !record ||
                record.state !==
                    PACKAGE_STATES.staging
            ) {
                transaction.abort();
                throw new Error(
                    "The package is not staging."
                );
            }
            const now =
                new Date().toISOString();
            record.state =
                PACKAGE_STATES.active;
            record.completedAt = now;
            record.activatedAt = now;
            record.importedCounts =
                counts;
            packageStore.put(record);
            if (
                oldActiveSlot !== null &&
                oldActiveSlot !== slot
            ) {
                const oldRecord =
                    await requestToPromise(
                        packageStore.get(
                            oldActiveSlot
                        )
                    );
                if (oldRecord) {
                    oldRecord.state =
                        PACKAGE_STATES.obsolete;
                    packageStore.put(
                        oldRecord
                    );
                }
            }
            stateStore.put(
                slot,
                STATE_KEYS.activeSlot
            );
            stateStore.put(
                null,
                STATE_KEYS.stagingSlot
            );
            await transactionToPromise(
                transaction
            );
            return {
                activeSlot: slot,
                previousActiveSlot:
                    oldActiveSlot,
                counts
            };
        });
    }

    async function markProductionSlotFailed(
        slot,
        error
    ) {
        validateSlot(slot);
        const database = await open();
        const transaction =
            database.transaction(
                [
                    STORES.packages,
                    STORES.state
                ],
                "readwrite"
            );
        const packageStore =
            transaction.objectStore(
                STORES.packages
            );
        const stateStore =
            transaction.objectStore(
                STORES.state
            );
        const record =
            await requestToPromise(
                packageStore.get(slot)
            );
        if (record) {
            record.state =
                PACKAGE_STATES.failed;
            record.completedAt =
                new Date().toISOString();
            record.error =
                error && error.message
                    ? error.message
                    : String(error || "");
            packageStore.put(record);
        }
        const stagingSlot =
            await requestToPromise(
                stateStore.get(
                    STATE_KEYS.stagingSlot
                )
            );
        if (stagingSlot === slot) {
            stateStore.put(
                null,
                STATE_KEYS.stagingSlot
            );
        }
        await transactionToPromise(
            transaction
        );
    }

    async function deleteProductionSlot(
        slot
    ) {
        return queueExclusive(async () => {
            validateSlot(slot);
            const activeSlot =
                await getActiveSlot();
            if (activeSlot === slot) {
                throw new Error(
                    "The active production slot cannot be deleted."
                );
            }
            const removed =
                await clearProductionSlot(
                    slot
                );
            const database = await open();
            const transaction =
                database.transaction(
                    [
                        STORES.packages,
                        STORES.state
                    ],
                    "readwrite"
                );
            transaction
                .objectStore(
                    STORES.packages
                )
                .delete(slot);
            const stateStore =
                transaction.objectStore(
                    STORES.state
                );
            const stagingSlot =
                await requestToPromise(
                    stateStore.get(
                        STATE_KEYS.stagingSlot
                    )
                );
            if (stagingSlot === slot) {
                stateStore.put(
                    null,
                    STATE_KEYS.stagingSlot
                );
            }
            await transactionToPromise(
                transaction
            );
            return {
                slot,
                removed
            };
        });
    }

    async function beginManualImport(
        metadata
    ) {
        const category =
            String(
                metadata.category || ""
            );
        validateManualCategory(
            category
        );
        const importId =
            generateImportId();
        const database = await open();
        const transaction =
            database.transaction(
                STORES.manualImports,
                "readwrite"
            );
        transaction
            .objectStore(
                STORES.manualImports
            )
            .put({
                importId,
                category,
                fileName:
                    String(
                        metadata.fileName ||
                        ""
                    ),
                fileSize:
                    Number(
                        metadata.fileSize ||
                        0
                    ),
                fileSha256:
                    String(
                        metadata.fileSha256 ||
                        ""
                    ),
                importedAt:
                    new Date().toISOString(),
                completedAt: null,
                state: "importing",
                validRules: 0,
                uniqueRules: 0,
                rejectedRules: 0,
                error: ""
            });
        await transactionToPromise(
            transaction
        );
        return importId;
    }

    async function putManualBatch(
        importId,
        category,
        rules
    ) {
        const storeName =
            validateManualCategory(
                category
            );
        const normalizedRules =
            normalizeRuleKeys(rules);
        if (
            normalizedRules.length >
            MAX_TRANSACTION_ITEMS
        ) {
            throw new Error(
                `Manual batch exceeds ${MAX_TRANSACTION_ITEMS} rules.`
            );
        }
        if (
            normalizedRules.length === 0
        ) {
            return {
                linkedRules: 0,
                newlyCreatedRules: 0
            };
        }
        const database = await open();
        const transaction =
            database.transaction(
                [
                    storeName,
                    STORES.manualImports,
                    STORES.manualImportRules
                ],
                "readwrite"
            );
        const ruleStore =
            transaction.objectStore(
                storeName
            );
        const importStore =
            transaction.objectStore(
                STORES.manualImports
            );
        const ownershipStore =
            transaction.objectStore(
                STORES.manualImportRules
            );
        const importRecord =
            await requestToPromise(
                importStore.get(importId)
            );
        if (
            !importRecord ||
            importRecord.state !==
                "importing"
        ) {
            transaction.abort();
            throw new Error(
                "The manual import is not active."
            );
        }
        if (
            importRecord.category !==
            category
        ) {
            transaction.abort();
            throw new Error(
                "The manual import category does not match."
            );
        }
        if (
            normalizeCount(
                importRecord.uniqueRules
            ) +
                normalizedRules.length >
            MAX_MANUAL_IMPORT_RULES
        ) {
            transaction.abort();
            throw new Error(
                `Manual imports are limited to ${MAX_MANUAL_IMPORT_RULES} unique rules per file.`
            );
        }
        let linkedRules = 0;
        let newlyCreatedRules = 0;
        for (const rule of normalizedRules) {
            const ownershipKey = [
                importId,
                rule
            ];
            const existingOwnership =
                await requestToPromise(
                    ownershipStore.get(
                        ownershipKey
                    )
                );
            if (existingOwnership) {
                continue;
            }
            const existingRule =
                await requestToPromise(
                    ruleStore.get(rule)
                );
            const referenceCount =
                existingRule &&
                Number.isSafeInteger(
                    existingRule.referenceCount
                )
                    ? existingRule.referenceCount
                    : 0;
            ruleStore.put({
                key: rule,
                referenceCount:
                    referenceCount + 1
            });
            ownershipStore.put({
                importId,
                rule,
                category
            });
            if (referenceCount === 0) {
                newlyCreatedRules += 1;
            }
            linkedRules += 1;
        }
        importRecord.validRules =
            normalizeCount(
                importRecord.validRules
            ) +
            normalizedRules.length;
        importRecord.uniqueRules =
            normalizeCount(
                importRecord.uniqueRules
            ) +
            linkedRules;
        importStore.put(
            importRecord
        );
        await transactionToPromise(
            transaction
        );
        return {
            linkedRules,
            newlyCreatedRules
        };
    }

    async function completeManualImport(
        importId,
        result
    ) {
        const database = await open();
        const transaction =
            database.transaction(
                STORES.manualImports,
                "readwrite"
            );
        const store =
            transaction.objectStore(
                STORES.manualImports
            );
        const record =
            await requestToPromise(
                store.get(importId)
            );
        if (!record) {
            transaction.abort();
            throw new Error(
                "Manual import metadata was not found."
            );
        }
        record.state = "complete";
        record.completedAt =
            new Date().toISOString();
        record.validRules =
            normalizeCount(
                result.validRules ??
                record.validRules
            );
        record.rejectedRules =
            normalizeCount(
                result.rejectedRules
            );
        store.put(record);
        await transactionToPromise(
            transaction
        );
        return record;
    }

    async function failManualImport(
        importId,
        error
    ) {
        const database = await open();
        const transaction =
            database.transaction(
                STORES.manualImports,
                "readwrite"
            );
        const store =
            transaction.objectStore(
                STORES.manualImports
            );
        const record =
            await requestToPromise(
                store.get(importId)
            );
        if (record) {
            record.state = "failed";
            record.completedAt =
                new Date().toISOString();
            record.error =
                error && error.message
                    ? error.message
                    : String(error || "");
            store.put(record);
        }
        await transactionToPromise(
            transaction
        );
    }

    async function listManualImports() {
        const database = await open();
        const transaction =
            database.transaction(
                STORES.manualImports,
                "readonly"
            );
        const records =
            await requestToPromise(
                transaction
                    .objectStore(
                        STORES.manualImports
                    )
                    .getAll()
            );
        await transactionToPromise(
            transaction
        );
        return records.sort(
            (left, right) =>
                String(
                    right.importedAt || ""
                ).localeCompare(
                    String(
                        left.importedAt || ""
                    )
                )
        );
    }

    async function removeManualImport(
        importId
    ) {
        return queueExclusive(async () => {
            const database = await open();
            const metadataTransaction =
                database.transaction(
                    STORES.manualImports,
                    "readonly"
                );
            const importRecord =
                await requestToPromise(
                    metadataTransaction
                        .objectStore(
                            STORES.manualImports
                        )
                        .get(importId)
                );
            await transactionToPromise(
                metadataTransaction
            );
            if (!importRecord) {
                throw new Error(
                    "Manual import was not found."
                );
            }
            const storeName =
                validateManualCategory(
                    importRecord.category
                );
            let removedLinks = 0;
            let removedRules = 0;
            while (true) {
                const batchDatabase =
                    await open();
                const result =
                    await new Promise(
                        (resolve, reject) => {
                            const transaction =
                                batchDatabase
                                    .transaction(
                                        [
                                            storeName,
                                            STORES.manualImportRules
                                        ],
                                        "readwrite"
                                    );
                            const ruleStore =
                                transaction
                                    .objectStore(
                                        storeName
                                    );
                            const ownershipStore =
                                transaction
                                    .objectStore(
                                        STORES.manualImportRules
                                    );
                            const index =
                                ownershipStore
                                    .index(
                                        "byImportId"
                                    );
                            const request =
                                index.openCursor(
                                    IDBKeyRange.only(
                                        importId
                                    )
                                );
                            let processed = 0;
                            let rulesDeleted = 0;
                            request.onsuccess =
                                async () => {
                                    const cursor =
                                        request.result;
                                    if (
                                        !cursor ||
                                        processed >=
                                            MAX_DELETE_BATCH
                                    ) {
                                        return;
                                    }
                                    try {
                                        const ownership =
                                            cursor.value;
                                        const ruleRecord =
                                            await requestToPromise(
                                                ruleStore.get(
                                                    ownership.rule
                                                )
                                            );
                                        if (ruleRecord) {
                                            const nextCount =
                                                normalizeCount(
                                                    ruleRecord
                                                        .referenceCount
                                                ) - 1;
                                            if (
                                                nextCount <= 0
                                            ) {
                                                ruleStore.delete(
                                                    ownership.rule
                                                );
                                                rulesDeleted += 1;
                                            } else {
                                                ruleRecord
                                                    .referenceCount =
                                                    nextCount;
                                                ruleStore.put(
                                                    ruleRecord
                                                );
                                            }
                                        }
                                        cursor.delete();
                                        processed += 1;
                                        cursor.continue();
                                    } catch (error) {
                                        transaction.abort();
                                        reject(error);
                                    }
                                };
                            request.onerror =
                                () => {
                                    reject(
                                        request.error ||
                                        new Error(
                                            "Could not read manual import ownership."
                                        )
                                    );
                                };
                            transaction.oncomplete =
                                () => {
                                    resolve({
                                        processed,
                                        rulesDeleted
                                    });
                                };
                            transaction.onerror =
                                () => {
                                    reject(
                                        transaction.error ||
                                        new Error(
                                            "Manual import removal transaction failed."
                                        )
                                    );
                                };
                            transaction.onabort =
                                () => {
                                    reject(
                                        transaction.error ||
                                        new Error(
                                            "Manual import removal was aborted."
                                        )
                                    );
                                };
                        }
                    );
                removedLinks +=
                    result.processed;
                removedRules +=
                    result.rulesDeleted;
                if (
                    result.processed <
                    MAX_DELETE_BATCH
                ) {
                    break;
                }
            }
            const cleanupDatabase =
                await open();
            const cleanupTransaction =
                cleanupDatabase.transaction(
                    STORES.manualImports,
                    "readwrite"
                );
            cleanupTransaction
                .objectStore(
                    STORES.manualImports
                )
                .delete(importId);
            await transactionToPromise(
                cleanupTransaction
            );
            return {
                importId,
                removedLinks,
                removedRules
            };
        });
    }

    async function hasManualBatch(
        category,
        rules
    ) {
        const storeName =
            validateManualCategory(
                category
            );
        const normalizedRules =
            normalizeRuleKeys(rules);
        if (
            normalizedRules.length >
            MAX_LOOKUP_BATCH
        ) {
            throw new Error(
                `Lookup batch exceeds ${MAX_LOOKUP_BATCH} rules.`
            );
        }
        const result =
            Object.create(null);
        for (const rule of normalizedRules) {
            result[rule] = false;
        }
        if (
            normalizedRules.length === 0
        ) {
            return result;
        }
        const database = await open();
        const transaction =
            database.transaction(
                storeName,
                "readonly"
            );
        const store =
            transaction.objectStore(
                storeName
            );
        await Promise.all(
            normalizedRules.map(
                async rule => {
                    const record =
                        await requestToPromise(
                            store.get(rule)
                        );
                    result[rule] =
                        Boolean(
                            record &&
                            normalizeCount(
                                record.referenceCount
                            ) > 0
                        );
                }
            )
        );
        await transactionToPromise(
            transaction
        );
        return result;
    }

    async function countManualRules(
        category
    ) {
        const storeName =
            validateManualCategory(
                category
            );
        const database = await open();
        const transaction =
            database.transaction(
                storeName,
                "readonly"
            );
        const count =
            await requestToPromise(
                transaction
                    .objectStore(storeName)
                    .count()
            );
        await transactionToPromise(
            transaction
        );
        return count;
    }

    async function getCombinedCounts() {
        const activeSlot =
            await getActiveSlot();
        const production = {
            labels: 0,
            exactHosts: 0,
            pslOverrides: 0
        };
        if (activeSlot !== null) {
            production.labels =
                await countProductionRules(
                    activeSlot,
                    RULE_TYPES.label
                );
            production.exactHosts =
                await countProductionRules(
                    activeSlot,
                    RULE_TYPES.exactHost
                );
            production.pslOverrides =
                await countProductionRules(
                    activeSlot,
                    RULE_TYPES.pslOverride
                );
        }
        const manual = {
            labels:
                await countManualRules(
                    RULE_NAMES.labels
                ),
            exactHosts:
                await countManualRules(
                    RULE_NAMES.exactHosts
                ),
            pslOverrides:
                await countManualRules(
                    RULE_NAMES.pslOverrides
                )
        };
        return {
            activeSlot,
            production,
            manual,
            total: {
                labels:
                    production.labels +
                    manual.labels,
                exactHosts:
                    production.exactHosts +
                    manual.exactHosts,
                pslOverrides:
                    production                        
		.pslOverrides +
                    manual.pslOverrides
            }
        };
    }
    async function getDatabaseStatus() {
        const [
            counts,
            packages,
            manualImports,
            stagingSlot
        ] = await Promise.all([
            getCombinedCounts(),
            listPackages(),
            listManualImports(),
            getStagingSlot()
        ]);
        return {
            counts,
            packages,
            manualImports,
            stagingSlot
        };
    }
    async function clearAll() {
        return queueExclusive(async () => {
            if (openPromise) {
                try {
                    const database =
                        await openPromise;
                    database.close();
                } catch {
                }
                openPromise = null;
            }
            await new Promise(
                (resolve, reject) => {
                    const request =
                        indexedDB.deleteDatabase(
                            DATABASE_NAME
                        );
                    request.onsuccess = () => {
                        resolve();
                    };
                    request.onerror = () => {
                        reject(
                            request.error ||
                            new Error(
                                "Could not delete the LeanSERP v3 database."
                            )
                        );
                    };
                    request.onblocked = () => {
                        reject(
                            new Error(
                                "Database deletion is blocked. Close other LeanSERP pages."
                            )
                        );
                    };
                }
            );
        });
    }
    return Object.freeze({
        DATABASE_NAME,
        DATABASE_VERSION,
        SLOTS,
        RULE_TYPES,
        RULE_NAMES,
        MANUAL_CATEGORIES,
        STORES,
        STATE_KEYS,
        PACKAGE_STATES,
        MAX_TRANSACTION_ITEMS,
        MAX_LOOKUP_BATCH,
        MAX_DELETE_BATCH,
        MAX_MANUAL_IMPORT_RULES,
        open,
        getState,
        setState,
        getActiveSlot,
        getStagingSlot,
        getPackage,
        listPackages,
        clearProductionSlot,
        beginProductionImport,
        putProductionBatch,
        hasProductionBatch,
        countProductionRules,
        verifyProductionSlot,
        activateProductionSlot,
        markProductionSlotFailed,
        deleteProductionSlot,
        beginManualImport,
        putManualBatch,
        completeManualImport,
        failManualImport,
        listManualImports,
        removeManualImport,
        hasManualBatch,
        countManualRules,
        getCombinedCounts,
        getDatabaseStatus,
        clearAll
    });
})();


