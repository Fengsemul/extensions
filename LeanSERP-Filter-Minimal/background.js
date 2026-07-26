"use strict";

const LeanDb = globalThis.LeanDb;

if (!LeanDb) {
    throw new Error(
        "database.js did not initialize LeanDb."
    );
}

const MAX_HOSTNAMES_PER_MESSAGE = 64;
const MAX_PENDING_REQUESTS = 16;
const MAX_HOSTNAME_CACHE_ENTRIES = 5000;

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
    new BoundedLru(        
	MAX_HOSTNAME_CACHE_ENTRIES
    );
const pendingRequests = new Set();
let publicSuffixListPromise = null;
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

        if (line.length === 0) {
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
    if (!publicSuffixListPromise) {
        publicSuffixListPromise = fetch(
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
                publicSuffixListPromise = null;
                throw error;
            });
    }

    return publicSuffixListPromise;
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
        candidate = candidate.length === 0
            ? labels[index]
            : `${labels[index]}.${candidate}`;

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

    const suffixStart = Math.max(
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

function normalizeKeys(values) {
    return Array.from(
        new Set(
            values
                .map(value =>
                    String(value || "")
                        .trim()
                        .toLowerCase()
                )
                .filter(Boolean)
        )
    );
}

async function lookupProduction(
    slot,
    ruleType,
    keys
) {
    const uniqueKeys =
        normalizeKeys(keys);

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
        const batch =
            uniqueKeys.slice(
                offset,
                offset +
                    LeanDb.MAX_LOOKUP_BATCH
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
    const uniqueKeys =
        normalizeKeys(keys);

    const result = Object.create(null);

    for (const key of uniqueKeys) {
        result[key] = false;
    }

    for (
        let offset = 0;
        offset < uniqueKeys.length;
        offset += LeanDb.MAX_LOOKUP_BATCH
    ) {
        const batch =
            uniqueKeys.slice(
                offset,
                offset +
                    LeanDb.MAX_LOOKUP_BATCH
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
                .slice(
                    0,
                    MAX_HOSTNAMES_PER_MESSAGE
                )
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

async function getDatabaseStatus() {
    return LeanDb.getDatabaseStatus();
}

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

       
