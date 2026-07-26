"use strict";

const LeanDb = globalThis.LeanDb;

if (!LeanDb) {
    throw new Error(
        "database.js did not initialize LeanDb."
    );
}

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    blockImages: false,
    blockMedia: false,
    disableAutoplay: false,
    suppressPrefetch: false,
    removeAiSummaries: false,
    removePeopleAlsoAsk: false,
    removeDiscussionsForums: false,
    removeCarousels: false,
    removeRelatedSearches: false,
    disableAnimations: true,
    pauseHiddenTabs: true,
    textOnlyMode: false,
    preferLiteInterfaces: false,
    limitInfiniteScrolling: false,
    infiniteScrollResultLimit: 100,
    automaticPagination: false,
    paginationTargetVisibleResults: 20,
    paginationMaximumPages: 5,
    paginationMaximumProcessedResults: 500,
    paginationDelayMilliseconds: 1000,
    paginationEmptyPageLimit: 2,
    paginationStopOnCaptcha: true,
    paginationPauseHiddenTabs: true,
    paginationMaximumElapsedSeconds: 60,
    deleteBlockedResults: true,
    decodeKnownRedirects: true,
    experimentalWindowStop: false
});

const MAX_LRU_ENTRIES = 5000;
const MAX_MESSAGE_HOSTS = 64;
const MAX_PENDING_REQUESTS = 32;

class BoundedLru {
    constructor(limit) {
        this.limit = limit;
        this.map = new Map();
    }

    get(key) {
        if (!this.map.has(key)) {
            return undefined;
        }

        const value = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, value);

        return value;
    }

    set(key, value) {
        if (this.map.has(key)) {
            this.map.delete(key);
        }

        this.map.set(key, value);

        while (this.map.size > this.limit) {
            const oldestKey =
                this.map.keys().next().value;

            this.map.delete(oldestKey);
        }
    }

    clear() {
        this.map.clear();
    }
}

const hostnameCache =
    new BoundedLru(MAX_LRU_ENTRIES);

const pendingRequests = new Set();

let settings = {
    ...DEFAULT_SETTINGS
};

let pslPromise = null;
let activeSlotCache = undefined;

function normalizeHostname(value) {
    const hostname = String(value || "")
        .replace(/^\uFEFF/, "")
        .trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, "");

    if (
        hostname.length === 0 ||
        hostname.length > 253 ||
        hostname.includes(":") ||
        hostname.includes("..") ||
        !hostname.includes(".")
    ) {
        return "";
    }

    const labels = hostname.split(".");

    for (const label of labels) {
        if (
            label.length === 0 ||
            label.length > 63 ||
            !/^[a-z0-9_-]+$/.test(label) ||
            label.startsWith("-") ||
            label.endsWith("-")
        ) {
            return "";
        }
    }

    return labels.join(".");
}

function parsePublicSuffixList(text) {
    const exact = new Set();
    const wildcards = new Set();
    const exceptions = new Set();

    for (const rawLine of text.split(/\r?\n/)) {
        let line = rawLine
            .trim()
            .toLowerCase();

        if (
            line.length === 0 ||
            line.startsWith("//")
        ) {
            continue;
        }

        const commentIndex =
            line.indexOf(" //");

        if (commentIndex >= 0) {
            line = line
                .slice(0, commentIndex)
                .trim();
        }

        if (!line) {
            continue;
        }

        if (line.startsWith("!")) {
            exceptions.add(line.slice(1));
        } else if (line.startsWith("*.")) {
            wildcards.add(line.slice(2));
        } else {
            exact.add(line);
        }
    }

    if (
        exact.size < 1000 ||
        !exact.has("com") ||
        !exact.has("co.uk") ||
        !wildcards.has("ck") ||
        !exceptions.has("www.ck")
    ) {
        throw new Error(
            "The bundled Public Suffix List failed validation."
        );
    }

    return Object.freeze({
        exact,
        wildcards,
        exceptions
    });
}

async function loadPublicSuffixList() {
    if (!pslPromise) {
        pslPromise = fetch(
            browser.runtime.getURL(
                "public_suffix_list.dat"
            )
        )
            .then(response => {
                if (!response.ok) {
                    throw new Error(
                        "Could not load the Public Suffix List."
                    );
                }

                return response.text();
            })
            .then(parsePublicSuffixList)
            .catch(error => {
                pslPromise = null;
                throw error;
            });
    }

    return pslPromise;
}

function getPublicSuffixLength(
    hostname,
    rules
) {
    const labels = hostname.split(".");

    if (labels.length < 2) {
        return 1;
    }

    let bestLength = 1;
    let candidate = "";

    for (
        let index = labels.length - 1;
        index >= 0;
        index -= 1
    ) {
        candidate = candidate
            ? `${labels[index]}.${candidate}`
            : labels[index];

        const candidateLength =
            labels.length - index;

        if (rules.exceptions.has(candidate)) {
            return Math.max(
                1,
                candidateLength - 1
            );
        }

        if (
            rules.exact.has(candidate) &&
            candidateLength > bestLength
        ) {
            bestLength = candidateLength;
        }

        if (index < labels.length - 1) {
            const firstDot =
                candidate.indexOf(".");

            if (firstDot >= 0) {
                const wildcardBase =
                    candidate.slice(
                        firstDot + 1
                    );

                if (
                    rules.wildcards.has(
                        wildcardBase
                    ) &&
                    candidateLength > bestLength
                ) {
                    bestLength =
                        candidateLength;
                }
            }
        }
    }

    return Math.min(
        bestLength,
        labels.length
    );
}

async function analyzeHostname(hostname) {
    const normalized =
        normalizeHostname(hostname);

    if (!normalized) {
        return Object.freeze({
            hostname: "",
            searchableLabels: [],
            suffixLabels: []
        });
    }

    const cached =
        hostnameCache.get(normalized);

    if (cached) {
        return cached;
    }

    const rules =
        await loadPublicSuffixList();

    const labels =
        normalized.split(".");

    const suffixLength =
        getPublicSuffixLength(
            normalized,
            rules
        );

    const suffixStart =
        Math.max(
            0,
            labels.length - suffixLength
        );

    const analysis = Object.freeze({
        hostname: normalized,
        searchableLabels:
            labels.slice(0, suffixStart),
        suffixLabels:
            labels.slice(suffixStart)
    });

    hostnameCache.set(
        normalized,
        analysis
    );

    return analysis;
}

function clearLookupCaches() {
    hostnameCache.clear();
    activeSlotCache = undefined;
}

async function getActiveSlot() {
    if (activeSlotCache !== undefined) {
        return activeSlotCache;
    }

    activeSlotCache =
        await LeanDb.getActiveSlot();

    return activeSlotCache;
}

async function lookupProduction(
    slot,
    ruleType,
    keys
) {
    const uniqueKeys = Array.from(
        new Set(
            keys
                .map(value =>
                    String(value || "")
                        .trim()
                        .toLowerCase()
                )
                .filter(Boolean)
        )
    );

    const result = Object.create(null);

    for (const key of uniqueKeys) {
        result[key] = false;
    }

    if (slot === null) {
        return result;
    }

    for (
        let offset = 0;
        offset < uniqueKeys.length;
        offset += LeanDb.MAX_LOOKUP_BATCH
    ) {
        const batch = uniqueKeys.slice(
            offset,
            offset + LeanDb.MAX_LOOKUP_BATCH
        );

        Object.assign(
            result,
            await LeanDb.hasProductionBatch(
                slot,
                ruleType,
                batch
            )
        );
    }

    return result;
}

async function lookupManual(
    category,
    keys
) {
    const uniqueKeys = Array.from(
        new Set(
            keys
                .map(value =>
                    String(value || "")
                        .trim()
                        .toLowerCase()
                )
                .filter(Boolean)
        )
    );

    const result = Object.create(null);

    for (const key of uniqueKeys) {
        result[key] = false;
    }

    for (
        let offset = 0;
        offset < uniqueKeys.length;
        offset += LeanDb.MAX_LOOKUP_BATCH
    ) {
        const batch = uniqueKeys.slice(
            offset,
            offset + LeanDb.MAX_LOOKUP_BATCH
        );

        Object.assign(
            result,
            await LeanDb.hasManualBatch(
                category,
                batch
            )
        );
    }

    return result;
}

function mergeMatches(
    productionMatches,
    manualMatches
) {
    const result = Object.create(null);

    for (
        const key of new Set([
            ...Object.keys(
                productionMatches
            ),
            ...Object.keys(
                manualMatches
            )
        ])
    ) {
        result[key] = Boolean(
            productionMatches[key] ||
            manualMatches[key]
        );
    }

    return result;
}

async function lookupCombined(
    slot,
    ruleType,
    manualCategory,
    keys
) {
    const [
        productionMatches,
        manualMatches
    ] = await Promise.all([
        lookupProduction(
            slot,
            ruleType,
            keys
        ),
        lookupManual(
            manualCategory,
            keys
        )
    ]);

    return mergeMatches(
        productionMatches,
        manualMatches
    );
}

async function confirmHostnames(hostnames) {
    if (!Array.isArray(hostnames)) {
        throw new Error(
            "Hostnames must be an array."
        );
    }

    const normalizedHosts = Array.from(
        new Set(
            hostnames
                .slice(0, MAX_MESSAGE_HOSTS)
                .map(normalizeHostname)
                .filter(Boolean)
        )
    );

    const decisions = Object.create(null);

    for (const hostname of normalizedHosts) {
        decisions[hostname] = {
            blocked: false,
            matchedRule: "",
            matchedType: ""
        };
    }

    if (normalizedHosts.length === 0) {
        return decisions;
    }

    const activeSlot =
        await getActiveSlot();

    const analyses = [];

    for (const hostname of normalizedHosts) {
        analyses.push(
            await analyzeHostname(hostname)
        );
    }

    const searchableLabels = [];
    const suffixLabels = [];

    for (const analysis of analyses) {
        searchableLabels.push(
            ...analysis.searchableLabels
        );
        suffixLabels.push(
            ...analysis.suffixLabels
        );
    }

    const [
        exactMatches,
        ordinaryMatches,
        overrideMatches
    ] = await Promise.all([
        lookupCombined(
            activeSlot,
            LeanDb.RULE_TYPES.exactHost,
            "exactHosts",
            normalizedHosts
        ),
        lookupCombined(
            activeSlot,
            LeanDb.RULE_TYPES.label,
            "labels",
            searchableLabels
        ),
        lookupCombined(
            activeSlot,
            LeanDb.RULE_TYPES.pslOverride,
            "pslOverrides",
            suffixLabels
        )
    ]);

    const approvedSuffixLabels =
        Object.keys(
            overrideMatches
        ).filter(
            label => overrideMatches[label]
        );

    const blockedSuffixMatches =
        await lookupCombined(
            activeSlot,
            LeanDb.RULE_TYPES.label,
            "labels",
            approvedSuffixLabels
        );

    for (const analysis of analyses) {
        const hostname =
            analysis.hostname;

        if (exactMatches[hostname]) {
            decisions[hostname] = {
                blocked: true,
                matchedRule: hostname,
                matchedType: "exact-host"
            };

            continue;
        }

        let ordinaryMatch = "";

        for (
            const label of
            analysis.searchableLabels
        ) {
            if (ordinaryMatches[label]) {
                ordinaryMatch = label;
                break;
            }
        }

        if (ordinaryMatch) {
            decisions[hostname] = {
                blocked: true,
                matchedRule: ordinaryMatch,
                matchedType: "label"
            };

            continue;
        }

        for (
            const label of
            analysis.suffixLabels
        ) {
            if (
                overrideMatches[label] &&
                blockedSuffixMatches[label]
            ) {
                decisions[hostname] = {
                    blocked: true,
                    matchedRule: label,
                    matchedType:
                        "psl-override"
                };

                break;
            }
        }
    }

    return decisions;
}

function normalizeBoolean(
    value,
    fallback
) {
    return typeof value === "boolean"
        ? value
        : fallback;
}

function normalizeInteger(
    value,
    fallback,
    minimum,
    maximum
) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.min(
        maximum,
        Math.max(
            minimum,
            Math.round(number)
        )
    );
}

function normalizeSettings(value) {
    const source =
        value &&
        typeof value === "object"
            ? value
            : {};

    const booleanNames = [
        "enabled",
        "blockImages",
        "blockMedia",
        "disableAutoplay",
        "suppressPrefetch",
        "removeAiSummaries",
        "removePeopleAlsoAsk",
        "removeDiscussionsForums",
        "removeCarousels",
        "removeRelatedSearches",
        "disableAnimations",
        "pauseHiddenTabs",
        "textOnlyMode",
        "preferLiteInterfaces",
        "limitInfiniteScrolling",
        "automaticPagination",
        "paginationStopOnCaptcha",
        "paginationPauseHiddenTabs",
        "deleteBlockedResults",
        "decodeKnownRedirects",
        "experimentalWindowStop"
    ];

    const normalized = {
        ...DEFAULT_SETTINGS
    };

    for (const name of booleanNames) {
        normalized[name] =
            normalizeBoolean(
                source[name],
                DEFAULT_SETTINGS[name]
            );
    }

    normalized.infiniteScrollResultLimit =
        normalizeInteger(
            source.infiniteScrollResultLimit,
            DEFAULT_SETTINGS
                .infiniteScrollResultLimit,
            20,
            5000
        );

    normalized.paginationTargetVisibleResults =
        normalizeInteger(
            source.paginationTargetVisibleResults,
            DEFAULT_SETTINGS
                .paginationTargetVisibleResults,
            1,
            500
        );

    normalized.paginationMaximumPages =
        normalizeInteger(
            source.paginationMaximumPages,
            DEFAULT_SETTINGS
                .paginationMaximumPages,
            1,
            50
        );

    normalized.paginationMaximumProcessedResults =
        normalizeInteger(
            source.paginationMaximumProcessedResults,
            DEFAULT_SETTINGS
                .paginationMaximumProcessedResults,
            10,
            5000
        );

    normalized.paginationDelayMilliseconds =
        normalizeInteger(
            source.paginationDelayMilliseconds,
            DEFAULT_SETTINGS
                .paginationDelayMilliseconds,
            250,
            10000
        );

    normalized.paginationEmptyPageLimit =
        normalizeInteger(
            source.paginationEmptyPageLimit,
            DEFAULT_SETTINGS
                .paginationEmptyPageLimit,
            1,
            10
        );

    normalized.paginationMaximumElapsedSeconds =
        normalizeInteger(
            source.paginationMaximumElapsedSeconds,
            DEFAULT_SETTINGS
                .paginationMaximumElapsedSeconds,
            5,
            600
        );

    return normalized;
}

async function ensureSettings() {
    const stored =
        await browser.storage.local.get(
            "settings"
        );

    if (!stored.settings) {
        settings = {
            ...DEFAULT_SETTINGS
        };

        await browser.storage.local.set({
            settings
        });

        return;
    }

    settings =
        normalizeSettings(
            stored.settings
        );
}

async function getDatabaseStatus() {
    return LeanDb.getDatabaseStatus();
}

browser.storage.onChanged.addListener(
    (changes, areaName) => {
        if (
            areaName === "local" &&
            changes.settings
        ) {
            settings =
                normalizeSettings(
                    changes.settings.newValue
                );
        }
    }
);

browser.runtime.onMessage.addListener(
    async message => {
        if (
            !message ||
            typeof message !== "object"
        ) {
            return {
                ok: false,
                error: "Invalid message."
            };
        }

        try {
            switch (message.type) {
                case "confirmHostnames": {
                    if (
                        pendingRequests.size >=
                        MAX_PENDING_REQUESTS
                    ) {
                        throw new Error(
                            "Too many pending hostname checks."
                        );
                    }

                    const token = {};

                    pendingRequests.add(token);

                    try {
                        return {
                            ok: true,
                            decisions:
                                await confirmHostnames(
                                    message.hostnames
                                )
                        };
                    } finally {
                        pendingRequests.delete(
                            token
                        );
                    }
                }

                case "getSettings":
                    return {
                        ok: true,
                        settings: {
                            ...settings
                        }
                    };

                case "saveSettings": {
                    const nextSettings =
                        normalizeSettings(
                            message.settings
                        );

                    await browser.storage.local.set({
                        settings: nextSettings
                    });

                    settings = nextSettings;

                    return {
                        ok: true,
                        settings: {
                            ...settings
                        }
                    };
                }

                case "clearCaches":
                    clearLookupCaches();

                    return {
                        ok: true
                    };

                case "databaseStatus":
                    return {
                        ok: true,
                        status:
                            await getDatabaseStatus()
                    };

                case "beginProductionImport": {
                    const result =
                        await LeanDb.beginProductionImport(
                            message.metadata || {}
                        );

                    return {
                        ok: true,
                        slot: result.slot,
                        previousActiveSlot:
                            result.previousActiveSlot
                    };
                }

                case "putProductionBatch":
                    return {
                        ok: true,
                        imported:
                            await LeanDb.putProductionBatch(
                                message.slot,
                                message.ruleType,
                                message.rules || []
                            )
                    };

                case "activateProductionSlot": {
                    const result =
                        await LeanDb.activateProductionSlot(
                            message.slot
                        );

                    clearLookupCaches();

                    return {
                        ok: true,
                        result
                    };
                }

                case "failProductionSlot":
                    await LeanDb.markProductionSlotFailed(
                        message.slot,
                        message.error || ""
                    );

                    return {
                        ok: true
                    };

                case "deleteProductionSlot": {
                    const result =
                        await LeanDb.deleteProductionSlot(
                            message.slot
                        );

                    clearLookupCaches();

                    return {
                        ok: true,
                        result
                    };
                }

                case "beginManualImport":
                    return {
                        ok: true,
                        importId:
                            await LeanDb.beginManualImport(
                                message.metadata || {}
                            )
                    };

                case "putManualBatch":
                    return {
                        ok: true,
                        result:
                            await LeanDb.putManualBatch(
                                message.importId,
                                message.category,
                                message.rules || []
                            )
                    };

                case "completeManualImport":
                    return {
                        ok: true,
                        record:
                            await LeanDb.completeManualImport(
                                message.importId,
                                message.result || {}
                            )
                    };

                case "failManualImport":
                    await LeanDb.failManualImport(
                        message.importId,
                        message.error || ""
                    );

                    return {
                        ok: true
                    };

                case "removeManualImport": {
                    const result =
                        await LeanDb.removeManualImport(
                            message.importId
                        );

                    clearLookupCaches();

                    return {
                        ok: true,
                        result
                    };
                }

                case "clearAllDatabase":
                    await LeanDb.clearAll();

                    clearLookupCaches();

                    return {
                        ok: true
                    };

                default:
                    return {
                        ok: false,
                        error:
                            "Unknown message type."
                    };
            }
        } catch (error) {
            return {
                ok: false,
                error:
                    error && error.message
                        ? error.message
                        : String(error)
            };
        }
    }
);
browser.runtime.onInstalled.addListener(
    () => {
        void ensureSettings().catch(
            error => {
                console.error(
                    "LeanSERP installation initialization failed.",
                    error
                );
            }
        );
    }
);

void ensureSettings().catch(error => {
    console.error(
        "LeanSERP settings initialization failed.",
        error
    );
});
