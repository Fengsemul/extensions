"use strict";

globalThis.LeanDb = (() => {
    const DATABASE_NAME = "leanserp-filter-v2";
    const DATABASE_VERSION = 1;

    const RULE_TYPES = Object.freeze({
        label: 0,
        exactHost: 1,
        pslOverride: 2
    });

    const MANUAL_CATEGORIES = Object.freeze({
        labels: "manualLabels",
        exactHosts: "manualExactHosts",
        pslOverrides: "manualPslOverrides"
    });

    const STORES = Object.freeze({
        productionRules: "productionRules",
        generations: "generations",
        state: "state",
        manualLabels: "manualLabels",
        manualExactHosts: "manualExactHosts",
        manualPslOverrides: "manualPslOverrides",
        manualImports: "manualImports",
        manualImportRules: "manualImportRules"
    });

    const STATE_KEYS = Object.freeze({
        activeGeneration: "activeGeneration",
        stagingGeneration: "stagingGeneration",
        nextGeneration: "nextGeneration"
    });

    const GENERATION_STATES = Object.freeze({
        staging: "staging",
        active: "active",
        obsolete: "obsolete",
        failed: "failed"
    });

    const MAX_TRANSACTION_ITEMS = 4000;
    const MAX_LOOKUP_BATCH = 128;
    const MAX_DELETE_BATCH = 4000;
    const MAX_MANUAL_IMPORT_RULES = 100000;

    let openPromise = null;
    let operationQueue = Promise.resolve();

    function queueExclusive(operation) {
        const run = operationQueue.then(
            operation,
            operation
        );

        operationQueue = run.catch(() => undefined);
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

    function validateRuleType(ruleType) {
        const values = Object.values(RULE_TYPES);

        if (
            !Number.isInteger(ruleType) ||
            !values.includes(ruleType)
        ) {
            throw new Error(
                "Unknown production rule type."
            );
        }
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

    function validateGeneration(generation) {
        if (
            !Number.isSafeInteger(generation) ||
            generation < 1
        ) {
            throw new Error(
                "Invalid production generation."
            );
        }
    }

    function normalizeRuleKey(value) {
        const key = String(value || "")
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

        const result = [];
        const seen = new Set();

        for (const value of values) {
            const key = normalizeRuleKey(value);

            if (
                key &&
                !seen.has(key)
            ) {
                seen.add(key);
                result.push(key);
            }
        }

        return result;
    }

    function generateImportId() {
        const randomPart =
            crypto.getRandomValues(
                new Uint32Array(4)
            );

        return [
            Date.now().toString(36),
            ...Array.from(
                randomPart,
                value => value.toString(36)
            )
        ].join("-");
    }

    function open() {
        if (openPromise) {
            return openPromise;
        }

        openPromise = new Promise(
            (resolve, reject) => {
                const request = indexedDB.open(
                    DATABASE_NAME,
                    DATABASE_VERSION
                );

                request.onupgradeneeded = event => {
                    const database =
                        request.result;
                    const transaction =
                        request.transaction;

                    if (
                        !database.objectStoreNames.contains(
                            STORES.productionRules
                        )
                    ) {
                        database.createObjectStore(
                            STORES.productionRules
                        );
                    }

                    if (
                        !database.objectStoreNames.contains(
                            STORES.generations
                        )
                    ) {
                        database.createObjectStore(
                            STORES.generations,
                            {
                                keyPath: "generation"
                            }
                        );
                    }

                    if (
                        !database.objectStoreNames.contains(
                            STORES.state
                        )
                    ) {
                        database.createObjectStore(
                            STORES.state
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
                            !database.objectStoreNames.contains(
                                storeName
                            )
                        ) {
                            database.createObjectStore(
                                storeName,
                                {
                                    keyPath: "key"
                                }
                            );
                        }
                    }

                    if (
                        !database.objectStoreNames.contains(
                            STORES.manualImports
                        )
                    ) {
                        const store =
                            database.createObjectStore(
                                STORES.manualImports,
                                {
                                    keyPath: "importId"
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
                        !database.objectStoreNames.contains(
                            STORES.manualImportRules
                        )
                    ) {
                        const store =
                            database.createObjectStore(
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
                            transaction.objectStore(
                                STORES.state
                            );

                        stateStore.put(
                            null,
                            STATE_KEYS.activeGeneration
                        );

                        stateStore.put(
                            null,
                            STATE_KEYS.stagingGeneration
                        );

                        stateStore.put(
                            1,
                            STATE_KEYS.nextGeneration
                        );
                    }
                };

                request.onsuccess = () => {
                    const database =
                        request.result;

                    database.onversionchange = () => {
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
                            "Could not open the LeanSERP v2 database."
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
        const store =
            transaction.objectStore(
                STORES.state
            );
        const value =
            await requestToPromise(
                store.get(key)
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

        transaction.objectStore(
            STORES.state
        ).put(
            value,
            key
        );

        await transactionToPromise(
            transaction
        );
    }

    async function getActiveGeneration() {
        const value = await getState(
            STATE_KEYS.activeGeneration
        );

        return Number.isSafeInteger(value)
            ? value
            : null;
    }

    async function getStagingGeneration() {
        const value = await getState(
            STATE_KEYS.stagingGeneration
        );

        return Number.isSafeInteger(value)
            ? value
            : null;
    }

    async function getGenerationRecord(
        generation
    ) {
        validateGeneration(generation);

        const database = await open();
        const transaction =
            database.transaction(
                STORES.generations,
                "readonly"
            );
        const record =
            await requestToPromise(
                transaction
                    .objectStore(
                        STORES.generations
                    )
                    .get(generation)
            );

        await transactionToPromise(
            transaction
        );

        return record || null;
    }

    async function listGenerations() {
        const database = await open();
        const transaction =
            database.transaction(
                STORES.generations,
                "readonly"
            );
        const records =
            await requestToPromise(
                transaction
                    .objectStore(
                        STORES.generations
                    )
                    .getAll()
            );

        await transactionToPromise(
            transaction
        );

        return records.sort(
            (left, right) =>
                right.generation -
                left.generation
        );
    }

async function allocateGenerationNumber() {
    const database = await open();
    const transaction =
        database.transaction(
            STORES.state,
            "readwrite"
        );
    const store =
        transaction.objectStore(
            STORES.state
        );
    const currentValue =
        await requestToPromise(
            store.get(
                STATE_KEYS.nextGeneration
            )
        );
    const generation =
        Number.isSafeInteger(currentValue)
            ? currentValue
            : 1;
    store.put(
        generation + 1,
        STATE_KEYS.nextGeneration
    );
    await transactionToPromise(
        transaction
    );
    return generation;
}

    async function beginProductionImport(
        metadata = {}
    ) {
        return queueExclusive(async () => {
            const existingStaging =
                await getStagingGeneration();

            if (existingStaging !== null) {
                throw new Error(
                    "Another production import is already staging."
                );
            }

            const generation =
                await allocateGenerationNumber();
            const database = await open();
            const transaction =
                database.transaction(
                    [
                        STORES.generations,
                        STORES.state
                    ],
                    "readwrite"
                );
            const now =
                new Date().toISOString();

            transaction.objectStore(
                STORES.generations
            ).put({
                generation,
                state:
                    GENERATION_STATES.staging,
                createdAt: now,
                activatedAt: null,
                completedAt: null,
                packageName:
                    String(
                        metadata.packageName ||
                        ""
                    ),
                expectedCounts: {
                    labels: Number(
                        metadata.expectedCounts
                            ?.labels || 0
                    ),
                    exactHosts: Number(
                        metadata.expectedCounts
                            ?.exactHosts || 0
                    ),
                    pslOverrides: Number(
                        metadata.expectedCounts
                            ?.pslOverrides || 0
                    )
                },
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

            transaction.objectStore(
                STORES.state
            ).put(
                generation,
                STATE_KEYS.stagingGeneration
            );

            await transactionToPromise(
                transaction
            );

            return generation;
        });
    }

    async function updateGenerationCounts(
        generation,
        increments
    ) {
        validateGeneration(generation);

        const database = await open();
        const transaction =
            database.transaction(
                STORES.generations,
                "readwrite"
            );
        const store =
            transaction.objectStore(
                STORES.generations
            );
        const record =
            await requestToPromise(
                store.get(generation)
            );

        if (!record) {
            transaction.abort();
            throw new Error(
                "The staging generation does not exist."
            );
        }

        if (
            record.state !==
            GENERATION_STATES.staging
        ) {
            transaction.abort();
            throw new Error(
                "Production rules can be added only to a staging generation."
            );
        }

        for (
            const name of [
                "labels",
                "exactHosts",
                "pslOverrides"
            ]
        ) {
            const increment =
                Number(increments[name] || 0);

            if (
                !Number.isSafeInteger(increment) ||
                increment < 0
            ) {
                transaction.abort();
                throw new Error(
                    "Invalid imported-count increment."
                );
            }

            record.importedCounts[name] =
                Number(
                    record.importedCounts[name] ||
                    0
                ) +
                increment;
        }

        store.put(record);

        await transactionToPromise(
            transaction
        );
    }

    async function putProductionBatch(
        generation,
        ruleType,
        rules
    ) {
        validateGeneration(generation);
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

        const generationRecord =
            await getGenerationRecord(
                generation
            );

        if (
            !generationRecord ||
            generationRecord.state !==
                GENERATION_STATES.staging
        ) {
            throw new Error(
                "The production generation is not staging."
            );
        }

        const database = await open();
        const transaction =
            database.transaction(
                STORES.productionRules,
                "readwrite"
            );
        const store =
            transaction.objectStore(
                STORES.productionRules
            );

        for (const rule of normalizedRules) {
            store.put(
                null,
                [
                    generation,
                    ruleType,
                    rule
                ]
            );
        }

        await transactionToPromise(
            transaction
        );

        const countName =
            ruleType === RULE_TYPES.label
                ? "labels"
                : ruleType ===
                    RULE_TYPES.exactHost
                    ? "exactHosts"
                    : "pslOverrides";

        await updateGenerationCounts(
            generation,
            {
                [countName]:
                    normalizedRules.length
            }
        );

        return normalizedRules.length;
    }

    async function verifyGenerationCounts(
        generation
    ) {
        validateGeneration(generation);

        const record =
            await getGenerationRecord(
                generation
            );

        if (!record) {
            throw new Error(
                "Generation metadata was not found."
            );
        }

        const counts = {
            labels: 0,
            exactHosts: 0,
            pslOverrides: 0
        };

        for (
            const [
                name,
                ruleType
            ] of [
                [
                    "labels",
                    RULE_TYPES.label
                ],
                [
                    "exactHosts",
                    RULE_TYPES.exactHost
                ],
                [
                    "pslOverrides",
                    RULE_TYPES.pslOverride
                ]
            ]
        ) {
            counts[name] =
                await countProductionRules(
                    generation,
                    ruleType
                );
        }

        const expected =
            record.expectedCounts || {};

        for (
            const name of [
                "labels",
                "exactHosts",
                "pslOverrides"
            ]
        ) {
            const expectedValue =
                Number(expected[name] || 0);

            if (
                expectedValue > 0 &&
                counts[name] !== expectedValue
            ) {
                throw new Error(
                    `${name} count mismatch: expected ${expectedValue}, found ${counts[name]}.`
                );
            }
        }

        return counts;
    }

    async function activateGeneration(
        generation
    ) {
        return queueExclusive(async () => {
            validateGeneration(generation);

            const counts =
                await verifyGenerationCounts(
                    generation
                );
            const previousGeneration =
                await getActiveGeneration();
            const database = await open();
            const transaction =
                database.transaction(
                    [
                        STORES.generations,
                        STORES.state
                    ],
                    "readwrite"
                );
            const generationsStore =
                transaction.objectStore(
                    STORES.generations
                );
            const stateStore =
                transaction.objectStore(
                    STORES.state
                );
            const record =
                await requestToPromise(
                    generationsStore.get(
                        generation
                    )
                );

            if (
                !record ||
                record.state !==
                    GENERATION_STATES.staging
            ) {
                transaction.abort();
                throw new Error(
                    "Only a staging generation can be activated."
                );
            }

            const now =
                new Date().toISOString();

            record.state =
                GENERATION_STATES.active;
            record.activatedAt = now;
            record.completedAt = now;
            record.importedCounts = counts;

            generationsStore.put(record);

            if (
                previousGeneration !== null &&
                previousGeneration !==
                    generation
            ) {
                const previousRecord =
                    await requestToPromise(
                        generationsStore.get(
                            previousGeneration
                        )
                    );

                if (previousRecord) {
                    previousRecord.state =
                        GENERATION_STATES.obsolete;
                    generationsStore.put(
                        previousRecord
                    );
                }
            }

            stateStore.put(
                generation,
                STATE_KEYS.activeGeneration
            );

            stateStore.put(
                null,
                STATE_KEYS.stagingGeneration
            );

            await transactionToPromise(
                transaction
            );

            return {
                activeGeneration: generation,
                previousGeneration,
                counts
            };
        });
    }

    async function markGenerationFailed(
        generation,
        error
    ) {
        validateGeneration(generation);

        const database = await open();
        const transaction =
            database.transaction(
                [
                    STORES.generations,
                    STORES.state
                ],
                "readwrite"
            );
        const generationsStore =
            transaction.objectStore(
                STORES.generations
            );
        const record =
            await requestToPromise(
                generationsStore.get(
                    generation
                )
            );

        if (record) {
            record.state =
                GENERATION_STATES.failed;
            record.completedAt =
                new Date().toISOString();
            record.error =
                error && error.message
                    ? error.message
                    : String(error || "");

            generationsStore.put(record);
        }

        const stateStore =
            transaction.objectStore(
                STORES.state
            );
        const stagingValue =
            await requestToPromise(
                stateStore.get(
                    STATE_KEYS.stagingGeneration
                )
            );

        if (stagingValue === generation) {
            stateStore.put(
                null,
                STATE_KEYS.stagingGeneration
            );
        }

        await transactionToPromise(
            transaction
        );
    }

    async function hasProductionBatch(
        generation,
        ruleType,
        rules
    ) {
        validateGeneration(generation);
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

        const database = await open();
        const transaction =
            database.transaction(
                STORES.productionRules,
                "readonly"
            );
        const store =
            transaction.objectStore(
                STORES.productionRules
            );

        await Promise.all(
            normalizedRules.map(
                async rule => {
                    const value =
                        await requestToPromise(
                            store.get([
                                generation,
                                ruleType,
                                rule
                            ])
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
        generation,
        ruleType
    ) {
        validateGeneration(generation);
        validateRuleType(ruleType);

        const database = await open();
        const transaction =
            database.transaction(
                STORES.productionRules,
                "readonly"
            );
        const store =
            transaction.objectStore(
                STORES.productionRules
            );
        const range = IDBKeyRange.bound(
            [
                generation,
                ruleType,
                ""
            ],
            [
                generation,
                ruleType,
                "\uffff"
            ]
        );
        const count =
            await requestToPromise(
                store.count(range)
            );

        await transactionToPromise(
            transaction
        );

        return count;
    }

    async function deleteProductionGeneration(
        generation
    ) {
        return queueExclusive(async () => {
            validateGeneration(generation);

            const activeGeneration =
                await getActiveGeneration();

            if (
                activeGeneration === generation
            ) {
                throw new Error(
                    "The active generation cannot be deleted."
                );
            }

            const database = await open();

            await new Promise(
                (resolve, reject) => {
                    let deletedInBatch = 0;
                    const transaction =
                        database.transaction(
                            STORES.productionRules,
                            "readwrite"
                        );
                    const store =
                        transaction.objectStore(
                            STORES.productionRules
                        );
                    const range =
                        IDBKeyRange.bound(
                            [
                                generation,
                                RULE_TYPES.label,
                                ""
                            ],
                            [
                                generation,
                                RULE_TYPES.pslOverride,
                                "\uffff"
                            ]
                        );
                    const request =
                        store.openCursor(range);

                    request.onsuccess = () => {
                        const cursor =
                            request.result;

                        if (
                            !cursor ||
                            deletedInBatch >=
                                MAX_DELETE_BATCH
                        ) {
                            return;
                        }

                        cursor.delete();
                        deletedInBatch += 1;
                        cursor.continue();
                    };

                    request.onerror = () => {
                        reject(
                            request.error ||
                            new Error(
                                "Could not delete generation rules."
                            )
                        );
                    };

                    transaction.oncomplete =
                        () => resolve(
                            deletedInBatch
                        );

                    transaction.onerror = () =>
                        reject(
                            transaction.error ||
                            new Error(
                                "Generation deletion transaction failed."
                            )
                        );

                    transaction.onabort = () =>
                        reject(
                            transaction.error ||
                            new Error(
                                "Generation deletion was aborted."
                            )
                        );
                }
            );

            let remaining = 1;

            while (remaining > 0) {
                const databaseForBatch =
                    await open();

                remaining =
                    await new Promise(
                        (resolve, reject) => {
                            let deleted = 0;
                            const transaction =
                                databaseForBatch.transaction(
                                    STORES.productionRules,
                                    "readwrite"
                                );
                            const store =
                                transaction.objectStore(
                                    STORES.productionRules
                                );
                            const range =
                                IDBKeyRange.bound(
                                    [
                                        generation,
                                        RULE_TYPES.label,
                                        ""
                                    ],
                                    [
                                        generation,
                                        RULE_TYPES.pslOverride,
                                        "\uffff"
                                    ]
                                );
                            const request =
                                store.openCursor(
                                    range
                                );

                            request.onsuccess =
                                () => {
                                    const cursor =
                                        request.result;

                                    if (
                                        !cursor ||
                                        deleted >=
                                            MAX_DELETE_BATCH
                                    ) {
                                        return;
                                    }

                                    cursor.delete();
                                    deleted += 1;
                                    cursor.continue();
                                };

                            request.onerror =
                                () => reject(
                                    request.error ||
                                    new Error(
                                        "Could not continue generation deletion."
                                    )
                                );

                            transaction.oncomplete =
                                () => resolve(
                                    deleted
                                );

                            transaction.onerror =
                                () => reject(
                                    transaction.error ||
                                    new Error(
                                        "Generation deletion transaction failed."
                                    )
                                );

                            transaction.onabort =
                                () => reject(
                                    transaction.error ||
                                    new Error(
                                        "Generation deletion was aborted."
                                    )
                                );
                        }
                    );
            }

            const cleanupDatabase =
                await open();
            const cleanupTransaction =
                cleanupDatabase.transaction(
                    [
                        STORES.generations,
                        STORES.state
                    ],
                    "readwrite"
                );

            cleanupTransaction
                .objectStore(
                    STORES.generations
                )
                .delete(generation);

            const stateStore =
                cleanupTransaction.objectStore(
                    STORES.state
                );
            const stagingGeneration =
                await requestToPromise(
                    stateStore.get(
                        STATE_KEYS.stagingGeneration
                    )
                );

            if (
                stagingGeneration === generation
            ) {
                stateStore.put(
                    null,
                    STATE_KEYS.stagingGeneration
                );
            }

            await transactionToPromise(
                cleanupTransaction
            );
        });
    }

    async function beginManualImport(
        metadata
    ) {
        const category =
            String(metadata.category || "");
        validateManualCategory(category);

        const importId =
            generateImportId();
        const database = await open();
        const transaction =
            database.transaction(
                STORES.manualImports,
                "readwrite"
            );

        transaction.objectStore(
            STORES.manualImports
        ).put({
            importId,
            category,
            fileName:
                String(metadata.fileName || ""),
            fileSize:
                Number(metadata.fileSize || 0),
            fileSha256:
                String(metadata.fileSha256 || ""),
            importedAt:
                new Date().toISOString(),
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
            validateManualCategory(category);
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

        if (normalizedRules.length === 0) {
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
            importRecord.uniqueRules +
                normalizedRules.length >
            MAX_MANUAL_IMPORT_RULES
        ) {
            transaction.abort();
            throw new Error(
                `Manual imports are limited to ${MAX_MANUAL_IMPORT_RULES} unique rules per file.`
            );
        }

        let newlyCreatedRules = 0;
        let linkedRules = 0;

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

        importRecord.validRules +=
            normalizedRules.length;
        importRecord.uniqueRules +=
            linkedRules;

        importStore.put(importRecord);

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
        record.rejectedRules =
            Number(result.rejectedRules || 0);
        record.validRules =
            Number(
                result.validRules ||
                record.validRules ||
                0
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
                String(right.importedAt)
                    .localeCompare(
                        String(left.importedAt)
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
            let deletedInBatch = 1;

            while (deletedInBatch > 0) {
                const batchDatabase =
                    await open();

                const result =
                    await new Promise(
                        (resolve, reject) => {
                            const transaction =
                                batchDatabase.transaction(
                                    [
                                        storeName,
                                        STORES.manualImportRules
                                    ],
                                    "readwrite"
                                );
                            const ruleStore =
                                transaction.objectStore(
                                    storeName
                                );
                            const ownershipStore =
                                transaction.objectStore(
                                    STORES.manualImportRules
                                );
                            const index =
                                ownershipStore.index(
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
                                                Number(
                                                    ruleRecord.referenceCount ||
                                                    0
                                                ) - 1;

                                            if (nextCount <= 0) {
                                                ruleStore.delete(
                                                    ownership.rule
                                                );
                                                rulesDeleted += 1;
                                            } else {
                                                ruleRecord.referenceCount =
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
                                () => reject(
                                    request.error ||
                                    new Error(
                                        "Could not read manual import ownership."
                                    )
                                );

                            transaction.oncomplete =
                                                           () => resolve({
                                    processed,
                                    rulesDeleted
                                });
                            transaction.onerror =
                                () => reject(
                                    transaction.error ||
                                    new Error(
                                        "Manual import removal transaction failed."
                                    )
                                );
                            transaction.onabort =
                                () => reject(
                                    transaction.error ||
                                    new Error(
                                        "Manual import removal was aborted."
                                    )
                                );
                        }
                    );
                deletedInBatch =
                    result.processed;
                removedLinks +=
                    result.processed;
                removedRules +=
                    result.rulesDeleted;
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
            validateManualCategory(category);
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
                            Number(
                                record.referenceCount ||
                                0
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
            validateManualCategory(category);
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
        const activeGeneration =
            await getActiveGeneration();
        const productionCounts = {
            labels: 0,
            exactHosts: 0,
            pslOverrides: 0
        };
        if (activeGeneration !== null) {
            productionCounts.labels =
                await countProductionRules(
                    activeGeneration,
                    RULE_TYPES.label
                );
            productionCounts.exactHosts =
                await countProductionRules(
                    activeGeneration,
                    RULE_TYPES.exactHost
                );
            productionCounts.pslOverrides =
                await countProductionRules(
                    activeGeneration,
                    RULE_TYPES.pslOverride
                );
        }
        const manualCounts = {
            labels:
                await countManualRules(
                    "labels"
                ),
            exactHosts:
                await countManualRules(
                    "exactHosts"
                ),
            pslOverrides:
                await countManualRules(
                    "pslOverrides"
                )
        };
        return {
            activeGeneration,
            production: productionCounts,
            manual: manualCounts,
            total: {
                labels:
                    productionCounts.labels +
                    manualCounts.labels,
                exactHosts:
                    productionCounts.exactHosts +
                    manualCounts.exactHosts,
                pslOverrides:
                    productionCounts.pslOverrides +
                    manualCounts.pslOverrides
            }
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
                    request.onsuccess =
                        () => resolve();
                    request.onerror =
                        () => reject(
                            request.error ||
                            new Error(
                                "Could not delete the LeanSERP v2 database."
                            )
                        );
                    request.onblocked =
                        () => reject(
                            new Error(
                                "Database deletion is blocked. Close other LeanSERP pages."
                            )
                        );
                }
            );
        });
    }
    return Object.freeze({
        DATABASE_NAME,
        DATABASE_VERSION,
        RULE_TYPES,
        MANUAL_CATEGORIES,
        STORES,
        STATE_KEYS,
        GENERATION_STATES,
        MAX_TRANSACTION_ITEMS,
        MAX_LOOKUP_BATCH,
        MAX_DELETE_BATCH,
        MAX_MANUAL_IMPORT_RULES,
        open,
        getState,
        setState,
        getActiveGeneration,
        getStagingGeneration,
        getGenerationRecord,
        listGenerations,
        beginProductionImport,
        putProductionBatch,
        verifyGenerationCounts,
        activateGeneration,
        markGenerationFailed,
        hasProductionBatch,
        countProductionRules,
        deleteProductionGeneration,
        beginManualImport,
        putManualBatch,
        completeManualImport,
        failManualImport,
        listManualImports,
        removeManualImport,
        hasManualBatch,
        countManualRules,
        getCombinedCounts,
        clearAll
    });
})();