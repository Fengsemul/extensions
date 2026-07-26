"use strict";

(() => {
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

    const LIMITS = Object.freeze({
        hostsPerRequest: 64,
        pendingRoots: 256,
        candidatesPerScan: 500,
        scanDebounceMilliseconds: 150,
        paginationCheckMilliseconds: 250
    });

    const ENGINE_HOSTS = Object.freeze({
        google: hostname =>
            /(^|\.)google\./i.test(hostname),
        bing: hostname =>
            /(^|\.)bing\.com$/i.test(hostname),
        duckduckgo: hostname =>
            /(^|\.)duckduckgo\.com$/i.test(hostname),
        brave: hostname =>
            hostname === "search.brave.com",
        etools: hostname =>
            hostname === "etools.ch" ||
            hostname.endsWith(".etools.ch"),
        wiby: hostname =>
            hostname === "wiby.org" ||
            hostname.endsWith(".wiby.org"),
        secretsearchenginelabs: hostname =>
            hostname ===
                "secretsearchenginelabs.com" ||
            hostname.endsWith(
                ".secretsearchenginelabs.com"
            ),
        rawweb: hostname =>
            hostname === "rawweb.org" ||
            hostname.endsWith(".rawweb.org"),
        slsearch: hostname =>
            hostname === "slsearch.eu.org" ||
            hostname.endsWith(
                ".slsearch.eu.org"
            ),
        searchthis: hostname =>
            hostname === "searchthis.ch" ||
            hostname.endsWith(
                ".searchthis.ch"
            ),
        degoog: hostname =>
            hostname === "degoog.org" ||
            hostname.endsWith(".degoog.org")
    });

    const RESULT_SELECTORS = Object.freeze({
        google: [
            "div.MjjYud",
            "div.g",
            "div[jscontroller]"
        ],
        bing: [
            "li.b_algo",
            "li.b_ans",
            "div.b_algo"
        ],
        duckduckgo: [
            "article[data-testid='result']",
            ".result",
            ".web-result",
            ".results_links"
        ],
        brave: [
            ".snippet",
            "[data-type='web']",
            ".search-result"
        ],
        etools: [
            ".result",
            ".search-result",
            "article",
            "li"
        ],
        wiby: [
            ".result",
            ".search-result",
            "article",
            "li"
        ],
        secretsearchenginelabs: [
            ".result",
            ".search-result",
            "article",
            "li"
        ],
        rawweb: [
            ".result",
            ".search-result",
            "article",
            "li"
        ],
        slsearch: [
            ".result",
            ".search-result",
            "article",
            "li"
        ],
        searchthis: [
            ".result",
            ".search-result",
            "article",
            "li"
        ],
        degoog: [
            ".result",
            ".search-result",
            "article",
            "li"
        ]
    });

    const NEXT_PAGE_SELECTORS = Object.freeze({
        google: [
            "a#pnnext",
            "a[aria-label='Next page']",
            "a[aria-label='Next']"
        ],
        bing: [
            "a.sb_pagN",
            "a[title='Next page']",
            "a[aria-label='Next page']"
        ],
        duckduckgo: [
            "a.result--more__btn",
            "input.result--more__btn",
            ".nav-link--next",
            "a[rel='next']"
        ],
        brave: [
            "a[rel='next']",
            "button[aria-label*='Next']"
        ],
        etools: [
            "a[rel='next']",
            ".pagination .next a",
            "a.next"
        ],
        wiby: [
            "a[rel='next']",
            ".pagination .next a",
            "a.next"
        ],
        secretsearchenginelabs: [
            "a[rel='next']",
            ".pagination .next a",
            "a.next"
        ],
        rawweb: [
            "a[rel='next']",
            ".pagination .next a",
            "a.next"
        ],
        slsearch: [
            "a[rel='next']",
            ".pagination .next a",
            "a.next"
        ],
        searchthis: [
            "a[rel='next']",
            ".pagination .next a",
            "a.next"
        ],
        degoog: [
            "a[rel='next']",
            ".pagination .next a",
            "a.next"
        ]
    });

    const CAPTCHA_SELECTORS = Object.freeze([
        "iframe[src*='recaptcha']",
        "iframe[src*='hcaptcha']",
        ".g-recaptcha",
        ".h-captcha",
        "#captcha",
        "[class*='captcha']",
        "[id*='captcha']"
    ]);

    let settings = {
        ...DEFAULT_SETTINGS
    };

    let engine = "";
    let observer = null;
	let relatedModulesObserver = null;
	let relatedModulesTimer = null;
    let scanTimer = null;
    let scanInProgress = false;
    let scanRequested = false;
    let stopped = false;
    let initialized = false;
    let pageVisible = !document.hidden;
    let processedResultCount = 0;

    let paginationState = null;
    let stopController = null;

    const pendingRoots = new Set();
    const processedLinks = new WeakSet();
    const processedContainers = new WeakSet();

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

        return {
            enabled:
                normalizeBoolean(
                    source.enabled,
                    DEFAULT_SETTINGS.enabled
                ),
            blockImages:
                normalizeBoolean(
                    source.blockImages,
                    DEFAULT_SETTINGS.blockImages
                ),
            blockMedia:
                normalizeBoolean(
                    source.blockMedia,
                    DEFAULT_SETTINGS.blockMedia
                ),
            disableAutoplay:
                normalizeBoolean(
                    source.disableAutoplay,
                    DEFAULT_SETTINGS.disableAutoplay
                ),
            suppressPrefetch:
                normalizeBoolean(
                    source.suppressPrefetch,
                    DEFAULT_SETTINGS.suppressPrefetch
                ),
            removeAiSummaries:
                normalizeBoolean(
                    source.removeAiSummaries,
                    DEFAULT_SETTINGS.removeAiSummaries
                ),
            removePeopleAlsoAsk:
                normalizeBoolean(
                    source.removePeopleAlsoAsk,
                    DEFAULT_SETTINGS.removePeopleAlsoAsk
                ),
            removeDiscussionsForums:
                normalizeBoolean(
                    source.removeDiscussionsForums,
                    DEFAULT_SETTINGS.removeDiscussionsForums
                ),
            removeCarousels:
                normalizeBoolean(
                    source.removeCarousels,
                    DEFAULT_SETTINGS.removeCarousels
                ),
			removeRelatedSearches:
                normalizeBoolean(
                    source.removeRelatedSearches,
                    DEFAULT_SETTINGS.removeRelatedSearches
                ),
            disableAnimations:
                normalizeBoolean(
                    source.disableAnimations,
                    DEFAULT_SETTINGS.disableAnimations
                ),
            pauseHiddenTabs:
                normalizeBoolean(
                    source.pauseHiddenTabs,
                    DEFAULT_SETTINGS.pauseHiddenTabs
                ),
            textOnlyMode:
                normalizeBoolean(
                    source.textOnlyMode,
                    DEFAULT_SETTINGS.textOnlyMode
                ),
            preferLiteInterfaces:
                normalizeBoolean(
                    source.preferLiteInterfaces,
                    DEFAULT_SETTINGS.preferLiteInterfaces
                ),
            limitInfiniteScrolling:
                normalizeBoolean(
                    source.limitInfiniteScrolling,
                    DEFAULT_SETTINGS.limitInfiniteScrolling
                ),
            infiniteScrollResultLimit:
                normalizeInteger(
                    source.infiniteScrollResultLimit,
                    DEFAULT_SETTINGS.infiniteScrollResultLimit,
                    20,
                    5000
                ),
            automaticPagination:
                normalizeBoolean(
                    source.automaticPagination,
                    DEFAULT_SETTINGS.automaticPagination
                ),
            paginationTargetVisibleResults:
                normalizeInteger(
                    source.paginationTargetVisibleResults,
                    DEFAULT_SETTINGS.paginationTargetVisibleResults,
                    1,
                    500
                ),
            paginationMaximumPages:
                normalizeInteger(
                    source.paginationMaximumPages,
                    DEFAULT_SETTINGS.paginationMaximumPages,
                    1,
                    50
                ),
            paginationMaximumProcessedResults:
                normalizeInteger(
                    source.paginationMaximumProcessedResults,
                    DEFAULT_SETTINGS.paginationMaximumProcessedResults,
                    10,
                    5000
                ),
            paginationDelayMilliseconds:
                normalizeInteger(
                    source.paginationDelayMilliseconds,
                    DEFAULT_SETTINGS.paginationDelayMilliseconds,
                    250,
                    10000
                ),
            paginationEmptyPageLimit:
                normalizeInteger(
                    source.paginationEmptyPageLimit,
                    DEFAULT_SETTINGS.paginationEmptyPageLimit,
                    1,
                    10
                ),
            paginationStopOnCaptcha:
                normalizeBoolean(
                    source.paginationStopOnCaptcha,
                    DEFAULT_SETTINGS.paginationStopOnCaptcha
                ),
            paginationPauseHiddenTabs:
                normalizeBoolean(
                    source.paginationPauseHiddenTabs,
                    DEFAULT_SETTINGS.paginationPauseHiddenTabs
                ),
            paginationMaximumElapsedSeconds:
                normalizeInteger(
                    source.paginationMaximumElapsedSeconds,
                    DEFAULT_SETTINGS.paginationMaximumElapsedSeconds,
                    5,
                    600
                ),
            deleteBlockedResults:
                normalizeBoolean(
                    source.deleteBlockedResults,
                    DEFAULT_SETTINGS.deleteBlockedResults
                ),
            decodeKnownRedirects:
                normalizeBoolean(
                    source.decodeKnownRedirects,
                    DEFAULT_SETTINGS.decodeKnownRedirects
                ),
            experimentalWindowStop:
                normalizeBoolean(
                    source.experimentalWindowStop,
                    DEFAULT_SETTINGS.experimentalWindowStop
                )
        };
    }

    function detectEngine() {
        const hostname =
            location.hostname.toLowerCase();

        for (
            const [
                name,
                matcher
            ] of Object.entries(
                ENGINE_HOSTS
            )
        ) {
            if (matcher(hostname)) {
                return name;
            }
        }

        return "";
    }

    function isSearchPage() {
        if (!engine) {
            return false;
        }

        if (engine === "google") {
            return (
                location.pathname ===
                    "/search" ||
                location.pathname ===
                    "/webhp"
            );
        }

        if (engine === "bing") {
            return (
                location.pathname ===
                "/search"
            );
        }

        if (engine === "duckduckgo") {
            return (
                location.pathname === "/" ||
                location.pathname ===
                    "/html/" ||
                location.pathname ===
                    "/lite/"
            );
        }

        if (engine === "brave") {
            return location.pathname
                .startsWith("/search");
        }

        if (engine === "wiby") {
            return (
                location.pathname === "/" ||
                location.pathname
                    .toLowerCase()
                    .includes("search")
            );
        }

        return true;
    }

    function decodeKnownRedirect(href) {
        if (
            !settings.decodeKnownRedirects
        ) {
            return href;
        }

        try {
            const url = new URL(
                href,
                location.href
            );

            if (
                /(^|\.)google\./i.test(
                    url.hostname
                ) &&
                url.pathname === "/url"
            ) {
                return (
                    url.searchParams.get("q") ||
                    url.searchParams.get("url") ||
                    url.href
                );
            }

            if (
                /(^|\.)duckduckgo\.com$/i.test(
                    url.hostname
                )
            ) {
                const target =
                    url.searchParams.get(
                        "uddg"
                    );

                if (target) {
                    try {
                        return decodeURIComponent(
                            target
                        );
                    } catch {
                        return target;
                    }
                }
            }

            return url.href;
        } catch {
            return href;
        }
    }

    function getHostname(link) {
        const rawHref =
            link.getAttribute("href");

        if (!rawHref) {
            return "";
        }

        try {
            const url = new URL(
                decodeKnownRedirect(
                    rawHref
                ),
                location.href
            );

            if (
                url.protocol !== "http:" &&
                url.protocol !== "https:"
            ) {
                return "";
            }

            const hostname =
                url.hostname
                    .trim()
                    .toLowerCase()
                    .replace(
                        /^\.+|\.+$/g,
                        ""
                    );

            if (
                hostname.length === 0 ||
                hostname ===
                    location.hostname
                        .toLowerCase() ||
                hostname.length > 253 ||
                !hostname.includes(".")
            ) {
                return "";
            }

            return hostname;
        } catch {
            return "";
        }
    }

    function getResultContainer(link) {
        const selectors =
            RESULT_SELECTORS[engine] ||
            [];

        for (const selector of selectors) {
            const container =
                link.closest(selector);

            if (container) {
                return container;
            }
        }

        let current = link;

        for (
            let depth = 0;
            current &&
            depth < 7;
            depth += 1
        ) {
            if (
                current.matches(
                    "article, li, section"
                )
            ) {
                return current;
            }

            if (
                current.parentElement &&
                current.parentElement
                    .children.length > 1 &&
                (
                    current.querySelector(
                        "h1, h2, h3, h4"
                    ) ||
                    String(
                        current.textContent ||
                        ""
                    ).trim().length >= 40
                )
            ) {
                return current;
            }

            current =
                current.parentElement;
        }

        return link.parentElement;
    }

    function requiresHeading() {
        return (
            engine === "google" ||
            engine === "bing" ||
            engine === "duckduckgo" ||
            engine === "brave"
        );
    }

    function findCandidates(root) {
        if (
            !root ||
            typeof root.querySelectorAll !==
                "function"
        ) {
            return [];
        }

        const candidates = [];
        const seenContainers =
            new Set();

        for (
            const link of
            root.querySelectorAll(
                "a[href]"
            )
        ) {
            if (
                candidates.length >=
                LIMITS.candidatesPerScan
            ) {
                break;
            }

            if (
                processedLinks.has(link) ||
                link.closest(
                    "[data-leanserp-ui]"
                )
            ) {
                continue;
            }

            const hostname =
                getHostname(link);

            if (!hostname) {
                continue;
            }

            const container =
                getResultContainer(link);

            if (
                !container ||
                seenContainers.has(
                    container
                ) ||
                processedContainers.has(
                    container
                )
            ) {
                continue;
            }

            if (
                requiresHeading() &&
                !container.querySelector(
                    "h1, h2, h3, h4"
                )
            ) {
                continue;
            }

            if (
                !requiresHeading() &&
                String(
                    container.textContent ||
                    ""
                ).trim().length < 20
            ) {
                continue;
            }

            processedLinks.add(link);
            seenContainers.add(
                container
            );

            candidates.push({
                hostname,
                container
            });
        }

        return candidates;
    }

    function markBlocked(
        candidate,
        decision
    ) {
        const container =
            candidate.container;

        container.dataset.leanserpBlocked =
            "true";

        container.dataset.leanserpHostname =
            candidate.hostname;

        container.dataset.leanserpRule =
            decision.matchedRule || "";

        container.dataset.leanserpRuleType =
            decision.matchedType || "";

        if (
            settings.deleteBlockedResults
        ) {
            container.remove();
        } else {
            container.hidden = true;
            container.setAttribute(
                "aria-hidden",
                "true"
            );
        }
    }

    async function processCandidates(
        candidates
    ) {
        for (
            let offset = 0;
            offset < candidates.length;
            offset +=
                LIMITS.hostsPerRequest
        ) {
            const batch =
                candidates.slice(
                    offset,
                    offset +
                        LIMITS.hostsPerRequest
                );

            const hostnames = Array.from(
                new Set(
                    batch.map(
                        item =>
                            item.hostname
                    )
                )
            );

            let response;

            try {
                response =
                    await browser.runtime.sendMessage({
                        type:
                            "confirmHostnames",
                        hostnames
                    });
            } catch {
                continue;
            }

            if (
                !response ||
                !response.ok ||
                !response.decisions
            ) {
                continue;
            }

            for (const candidate of batch) {
                const decision =
                    response.decisions[
                        candidate.hostname
                    ];

                if (
                    decision &&
                    decision.blocked
                ) {
                    markBlocked(
                        candidate,
                        decision
                    );
                } else {
                    candidate.container
                        .dataset
                        .leanserpProcessed =
                        "true";
                }

                processedContainers.add(
                    candidate.container
                );

                processedResultCount += 1;
            }
        }
    }

    function queueRoot(root) {
        if (
            !root ||
            pendingRoots.size >=
                LIMITS.pendingRoots
        ) {
            return;
        }

        pendingRoots.add(root);
    }

    async function scanPendingRoots() {
        if (
            stopped ||
            !settings.enabled ||
            (
                settings.pauseHiddenTabs &&
                !pageVisible
            )
        ) {
            return;
        }

        if (scanInProgress) {
            scanRequested = true;
            return;
        }
        scanInProgress = true;
        try {
            applyEnabledModuleRemoval();
            suppressResourceHints();
            disableAutoplay();
            do {
                scanRequested = false;

                const roots = Array.from(
                    pendingRoots
                ).slice(
                    0,
                    LIMITS.pendingRoots
                );

                for (const root of roots) {
                    pendingRoots.delete(root);
                }

                if (roots.length === 0) {
                    roots.push(document);
                }

                const candidates = [];
                const containers =
                    new Set();

                for (const root of roots) {
                    for (
                        const candidate of
                        findCandidates(root)
                    ) {
                        if (
                            containers.has(
                                candidate.container
                            )
                        ) {
                            continue;
                        }

                        containers.add(
                            candidate.container
                        );

                        candidates.push(
                            candidate
                        );

                        if (
                            candidates.length >=
                            LIMITS.pendingRoots
                        ) {
                            break;
                        }
                    }

                    if (
                        candidates.length >=
                        LIMITS.pendingRoots
                    ) {
                        break;
                    }
                }

                await processCandidates(
                    candidates
                );

                if (
                    settings
                        .limitInfiniteScrolling &&
                    processedResultCount >=
                        settings
                            .infiniteScrollResultLimit
                ) {
                    disconnectObserver();
                }
            } while (
                scanRequested &&
                !stopped
            );
        } finally {
            scanInProgress = false;
        }
    }

    function scheduleScan(root) {
        if (root) {
            queueRoot(root);
        }

        if (scanTimer !== null) {
            return;
        }

        scanTimer = window.setTimeout(
            () => {
                scanTimer = null;

                void scanPendingRoots();
            },
            LIMITS
                .scanDebounceMilliseconds
        );
    }

    function removeBySelectors(
        selectors
    ) {
        for (const selector of selectors) {
            for (
                const element of
                document.querySelectorAll(
                    selector
                )
            ) {
                element.remove();
            }
        }
    }
    function normalizeModuleText(element) {
        return String(
            element && element.textContent
                ? element.textContent
                : ""
        )
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    function isRelatedSearchText(text) {
        const phrases = [
            "more results from",
            "more results for",
            "people also search for",
            "related searches",
            "searches related to",
            "others searched for",
            "similar searches",
            "weitere ergebnisse von",
            "weitere ergebnisse für",
            "wird auch oft gesucht",
            "ähnliche suchanfragen",
            "verwandte suchanfragen",
            "andere suchten auch nach"
        ];

        return phrases.some(
            phrase => text.includes(phrase)
        );
    }

    function findSafeModuleContainer(element) {
        if (!element) {
            return null;
        }

        const explicitContainer = element.closest(
            "table.SwU7oc, " +
            "div.EIaa9b, " +
            "[data-snf='M7eMpf'], " +
            ".kb0PBd.A9Y9g[data-snf='M7eMpf'], " +
            ".related-searches, " +
            ".related-results, " +
            ".b_rs"
        );

        if (explicitContainer) {
            return explicitContainer;
        }

        let current = element;

        for (
            let depth = 0;
            current && depth < 7;
            depth += 1
        ) {
            if (
                current.matches(
                    "table, section, aside, div"
                )
            ) {
                const text =
                    normalizeModuleText(current);
                const links =
                    current.querySelectorAll(
                        "a[href]"
                    ).length;

                if (
                    links >= 2 &&
                    text.length >= 20 &&
                    text.length <= 6000 &&
                    isRelatedSearchText(text)
                ) {
                    return current;
                }
            }

            current = current.parentElement;
        }

        return null;
    }

    function removeRelatedModulesFromRoot(root) {
        if (
            !settings.removeRelatedSearches ||
            !root ||
            root.nodeType !==
                Node.ELEMENT_NODE
        ) {
            return false;
        }

        const explicitSelector = [
            "table.SwU7oc",
            "div.EIaa9b",
            "[data-snf='M7eMpf']",
            ".kb0PBd.A9Y9g[data-snf='M7eMpf']",
            ".related-searches",
            ".related-results",
            ".b_rs"
        ].join(", ");

        if (
            root.matches &&
            root.matches(explicitSelector)
        ) {
            root.remove();
            return true;
        }

        let removed = false;

        if (
            typeof root.querySelectorAll ===
            "function"
        ) {
            for (
                const element of
                root.querySelectorAll(
                    explicitSelector
                )
            ) {
                element.remove();
                removed = true;
            }

            const textCandidates =
                root.querySelectorAll(
                    "h2, h3, h4, span, div, td, a"
                );

            for (
                const element of
                textCandidates
            ) {
                if (!element.isConnected) {
                    continue;
                }

                const ownText =
                    normalizeModuleText(
                        element
                    );

                if (
                    ownText.length === 0 ||
                    ownText.length > 180 ||
                    !isRelatedSearchText(
                        ownText
                    )
                ) {
                    continue;
                }

                const container =
                    findSafeModuleContainer(
                        element
                    );

                if (container) {
                    container.remove();
                    removed = true;
                }
            }
        }

        if (
            root.isConnected &&
            isRelatedSearchText(
                normalizeModuleText(root)
            )
        ) {
            const container =
                findSafeModuleContainer(
                    root
                );

            if (container) {
                container.remove();
                removed = true;
            }
        }

        return removed;
    }

    function removeRelatedSearchModules() {
        if (
            !settings.removeRelatedSearches
        ) {
            return;
        }

        removeRelatedModulesFromRoot(
            document.documentElement
        );
    }
	function removeRelatedModuleElement(element) {
    if (
        !element ||
        element.nodeType !== Node.ELEMENT_NODE
    ) {
        return false;
    }

    const directSelectors = [
        "table.SwU7oc",
        "div.EIaa9b",
        "[data-snf='M7eMpf']",
        ".kb0PBd.A9Y9g[data-snf='M7eMpf']",
        ".related-searches",
        ".related-results",
        ".b_rs"
    ];

    for (const selector of directSelectors) {
        if (element.matches(selector)) {
            element.remove();
            return true;
        }

        for (
            const match of
            element.querySelectorAll(selector)
        ) {
            match.remove();
        }
    }

    const phrases = [
        "more results from",
        "more results for",
        "people also search for",
        "related searches",
        "searches related to",
        "others searched for",
        "similar searches",
        "weitere ergebnisse von",
        "weitere ergebnisse für",
        "wird auch oft gesucht",
        "ähnliche suchanfragen",
        "verwandte suchanfragen",
        "andere suchten auch nach"
    ];

    const textElements = [];

    if (
        element.matches(
            "h2, h3, h4, span, div, td, a"
        )
    ) {
        textElements.push(element);
    }

    for (
        const candidate of
        element.querySelectorAll(
            "h2, h3, h4, span, div, td, a"
        )
    ) {
        textElements.push(candidate);

        if (textElements.length >= 500) {
            break;
        }
    }

    for (const candidate of textElements) {
        const text = String(
            candidate.textContent || ""
        )
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        if (
            text.length === 0 ||
            text.length > 180 ||
            !phrases.some(
                phrase => text.includes(phrase)
            )
        ) {
            continue;
        }

        const container =
            candidate.closest(
                "table.SwU7oc, " +
                "div.EIaa9b, " +
                "[data-snf='M7eMpf'], " +
                ".kb0PBd.A9Y9g, " +
                ".related-searches, " +
                ".related-results, " +
                ".b_rs, " +
                "section, aside"
            ) ||
            findSafeModuleContainer(candidate);

        if (container) {
            container.remove();
            return true;
        }
    }

    return false;
}

function scheduleRelatedModuleRemoval() {
    if (
        !settings.removeRelatedSearches ||
        stopped ||
        relatedModulesTimer !== null
    ) {
        return;
    }

    relatedModulesTimer = window.setTimeout(
        () => {
            relatedModulesTimer = null;

            if (
                settings.removeRelatedSearches &&
                !stopped
            ) {
                removeRelatedSearchModules();
            }
        },
        50
    );
}

function startRelatedModulesObserver() {
    if (
        !settings.removeRelatedSearches ||
        relatedModulesObserver ||
        stopped
    ) {
        return;
    }

    removeRelatedSearchModules();

    relatedModulesObserver =
        new MutationObserver(mutations => {
            let relevantChange = false;

            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (
                        node.nodeType !==
                        Node.ELEMENT_NODE
                    ) {
                        continue;
                    }

                    if (
                        removeRelatedModuleElement(node)
                    ) {
                        relevantChange = true;
                    }
                }
            }

            if (relevantChange) {
                scheduleRelatedModuleRemoval();
            }
        });

    relatedModulesObserver.observe(
        document.documentElement,
        {
            childList: true,
            subtree: true
        }
    );
}

function stopRelatedModulesObserver() {
    if (relatedModulesObserver) {
        relatedModulesObserver.disconnect();
        relatedModulesObserver = null;
    }

    if (relatedModulesTimer !== null) {
        window.clearTimeout(
            relatedModulesTimer
        );
        relatedModulesTimer = null;
    }
}
    function applyEnabledModuleRemoval() {
        if (
            settings.removeAiSummaries
        ) {
            removeBySelectors([
                "[data-sgrd]",
                "[data-attrid*='AI Overview']",
                "[data-attrid*='Generative AI']",
                "[class*='ai-overview']"
            ]);
        }

        if (
            settings.removePeopleAlsoAsk
        ) {
            removeBySelectors([
                ".related-question-pair",
                "[class*='people-also-ask']",
                "[data-initq]"
            ]);
        }

        if (
            settings
                .removeDiscussionsForums
        ) {
            removeBySelectors([
                "[data-attrid*='Discussions']",
                "[data-attrid*='Forums']",
                "[class*='discussion']",
                "[class*='forum']",
                "[data-snf='M7eMpf']",
                ".kb0PBd.A9Y9g[data-snf='M7eMpf']",
                "div[data-snf='M7eMpf']:has(a[href*='reddit.com/'])"
            ]);
        }

        if (settings.removeCarousels) {
            removeBySelectors([
                "[data-video-docid]",
                "[data-news-docid]",
                ".image-pack",
                ".b_imgans",
                ".b_videos",
                "[class*='carousel']"
            ]);
        }
    }
	    if (settings.removeRelatedSearches) {
            removeRelatedSearchModules();
        }

    function suppressResourceHints() {
        if (!settings.suppressPrefetch) {
            return;
        }

        removeBySelectors([
            "link[rel='prefetch']",
            "link[rel='preconnect']",
            "link[rel='dns-prefetch']",
            "link[rel='prerender']",
            "link[rel='preload'][as='image']"
        ]);
    }

    function disableAutoplay() {
        if (!settings.disableAutoplay) {
            return            ;
        }
        for (
            const media of
            document.querySelectorAll(
                "video, audio"
            )
        ) {
            media.autoplay = false;
            media.removeAttribute(
                "autoplay"
            );
            if (!media.paused) {
                try {
                    media.pause();
                } catch {
                }
            }
        }
    }
    function applyPageClasses() {
        const root =
            document.documentElement;
        root.classList.toggle(
            "leanserp-disable-animations",
            settings.disableAnimations
        );
        root.classList.toggle(
            "leanserp-text-only",
            settings.textOnlyMode
        );
        root.classList.toggle(
            "leanserp-block-images",
            settings.blockImages
        );
        root.classList.toggle(
            "leanserp-block-media",
            settings.blockMedia
        );
    }
    function applyEnabledFeatures() {
        applyEnabledModuleRemoval();
        suppressResourceHints();
        disableAutoplay();
    }
    function observePage() {
        if (
            observer ||
            stopped ||
            (
                settings.pauseHiddenTabs &&
                !pageVisible
            )
        ) {
            return;
        }
        observer =
            new MutationObserver(
                mutations => {
                    let changed = false;
                    for (
                        const mutation of
                        mutations
                    ) {
                    for (
                            const node of
                            mutation.addedNodes
                        ) {
                            if (
                                node.nodeType !==
                                Node.ELEMENT_NODE
                            ) {
                                continue;
                            }

                            if (
                                settings
                                    .removeRelatedSearches &&
                                removeRelatedModulesFromRoot(
                                    node
                                )
                            ) {
                                changed = true;
                                continue;
                            }

                            queueRoot(node);
                            changed = true;
                        }

                    }
                    if (changed) {
                        applyEnabledFeatures();
                        scheduleScan();
                    }
                }
            );
        observer.observe(
            document.documentElement,
            {
                childList: true,
                subtree: true
            }
        );
    }
    function disconnectObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }
function getOrganicResultContainers() {
    const selectors = {
        google: [
            "div#search div.MjjYud",
            "div#search div.g"
        ],
        bing: [
            "ol#b_results > li.b_algo"
        ],
        duckduckgo: [
            "article[data-testid='result']",
            "#links .result",
            ".results .web-result"
        ],
        brave: [
            "#results [data-type='web']",
            "#results .snippet"
        ],
        etools: [
            ".result",
            ".search-result"
        ],
        wiby: [
            ".result",
            ".search-result"
        ],
        secretsearchenginelabs: [
            ".result",
            ".search-result"
        ],
        rawweb: [
            ".result",
            ".search-result"
        ],
        slsearch: [
            ".result",
            ".search-result"
        ],
        searchthis: [
            ".result",
            ".search-result"
        ],
        degoog: [
            ".result",
            ".search-result"
        ]
    };

    const containers = new Set();

    for (const selector of selectors[engine] || []) {
        for (const element of document.querySelectorAll(selector)) {
            if (
                element.isConnected &&
                !element.hidden &&
                element.getClientRects().length > 0 &&
                element.querySelector("a[href]")
            ) {
                containers.add(element);
            }
        }
    }

    return Array.from(containers);
}

function countVisibleResults() {
    return getOrganicResultContainers().length;
}
    function detectCaptcha() {
        for (
            const selector of
            CAPTCHA_SELECTORS
        ) {
            if (
                document.querySelector(
                    selector
                )
            ) {
                return true;
            }
        }
        const bodyText =
            String(
                document.body
                    ? document.body.innerText
                    : ""
            )
                .toLowerCase()
                .slice(0, 20000);
        return (
            bodyText.includes(
                "verify you are human"
            ) ||
            bodyText.includes(
                "unusual traffic"
            ) ||
            bodyText.includes(
                "complete the captcha"
            ) ||
            bodyText.includes(
                "security check"
            )
        );
    }
function getNextPageControl() {
    if (engine === "google") {
        return (
            document.querySelector("a#pnnext") ||
            document.querySelector("a[aria-label='Next page']") ||
            document.querySelector("a[aria-label='Next']")
        );
    }

    if (engine === "duckduckgo") {
        return (
            document.querySelector("a.result--more__btn") ||
            document.querySelector("button.result--more__btn") ||
            document.querySelector("input.result--more__btn") ||
            document.querySelector("a[rel='next']") ||
            document.querySelector(
                "form input[type='submit'][value*='Next']"
            ) ||
            Array.from(
                document.querySelectorAll(
                    "button, input[type='submit'], a"
                )
            ).find(element =>
                /next page|next|more results/i.test(
                    String(
                        element.value ||
                        element.textContent ||
                        element.getAttribute("aria-label") ||
                        ""
                    ).trim()
                )
            ) ||
            null
        );
    }

    const selectors =
        NEXT_PAGE_SELECTORS[engine] || [];

    for (const selector of selectors) {
        const element =
            document.querySelector(selector);

        if (
            element &&
            element.isConnected &&
            !element.disabled &&
            element.getAttribute("aria-disabled") !== "true"
        ) {
            return element;
        }
    }

    return null;
}
    function createPaginationPanel() {
        const panel =
            document.createElement("aside");
        panel.id =
            "leanserp-pagination-panel";
        panel.dataset.leanserpUi = "true";
        panel.setAttribute(
            "role",
            "status"
        );
        const status =
            document.createElement("span");
        status.className =
            "leanserp-pagination-status";
        const stopButton =
            document.createElement("button");
        stopButton.type = "button";
        stopButton.textContent =
            "Stop loading";
        stopButton.addEventListener(
            "click",
            () => {
                stopAutomaticPagination(
                    "Stopped manually."
                );
            }
        );
        const resumeButton =
            document.createElement("button");
        resumeButton.type = "button";
        resumeButton.textContent =
            "Resume after CAPTCHA";
        resumeButton.hidden = true;
        resumeButton.addEventListener(
            "click",
            () => {
                if (!paginationState) {
                    return;
                }
                paginationState
                    .captchaPaused = false;
                resumeButton.hidden = true;
                updatePaginationPanel(
                    "Resuming..."
                );
                schedulePaginationStep(
                    settings
                        .paginationDelayMilliseconds
                );
            }
        );
        panel.append(
            status,
            stopButton,
            resumeButton
        );
        const parent =
            document.body ||
            document.documentElement;
        parent.appendChild(panel);
        return {
            panel,
            status,
            stopButton,
            resumeButton
        };
    }
    function updatePaginationPanel(
        message = ""
    ) {
        if (
            !paginationState ||
            !paginationState.ui
        ) {
            return;
        }
        const visible =
            countVisibleResults();
        const prefix =
            `Pages: ${paginationState.pagesLoaded}/` +
            `${settings.paginationMaximumPages}; ` +
            `visible: ${visible}; ` +
            `processed: ${processedResultCount}/` +
            `${settings.paginationMaximumProcessedResults}`;
        paginationState.ui.status.textContent =
            message
                ? `${prefix} - ${message}`
                : prefix;
    }
    function clearPaginationTimer() {
        if (
            paginationState &&
            paginationState.timer !== null
        ) {
            window.clearTimeout(
                paginationState.timer
            );
            paginationState.timer = null;
        }
    }
    function stopAutomaticPagination(
        reason = "Stopped."
    ) {
        if (!paginationState) {
            return;
        }
        clearPaginationTimer();
        updatePaginationPanel(reason);
        if (paginationState.ui) {
            paginationState.ui
                .stopButton.disabled = true;
            paginationState.ui
                .resumeButton.hidden = true;
        }
        paginationState.running = false;
    }
    function schedulePaginationStep(
        delay
    ) {
        if (
            !paginationState ||
            !paginationState.running ||
            paginationState.timer !== null
        ) {
            return;
        }
        paginationState.timer =
            window.setTimeout(
                () => {
                    if (!paginationState) {
                        return;
                    }
                    paginationState.timer =
                        null;
                    void runPaginationStep();
                },
                delay
            );
    }
    async function waitForPaginationChange(
        previousVisibleCount
    ) {
        const deadline =
            Date.now() +
            Math.max(
                1500,
                settings
                    .paginationDelayMilliseconds *
                    3
            );
        while (
            paginationState &&
            paginationState.running &&
            Date.now() < deadline
        ) {
            await new Promise(resolve => {
                window.setTimeout(
                    resolve,
                    LIMITS
                        .paginationCheckMilliseconds
                );
            });
            if (
                countVisibleResults() >
                    previousVisibleCount ||
                pendingRoots.size > 0 ||
                scanInProgress
            ) {
                return true;
            }
        }
        return false;
    }
async function activateNextPage(control) {
    const previousVisibleCount =
        countVisibleResults();

    if (
        control instanceof HTMLInputElement &&
        control.form
    ) {
        if (typeof control.form.requestSubmit === "function") {
            control.form.requestSubmit(control);
        } else {
            control.click();
        }
    } else {
        control.click();
    }

    paginationState.pagesLoaded += 1;

    updatePaginationPanel(
        "Waiting for additional results..."
    );

    return waitForPaginationChange(
        previousVisibleCount
    );
}
    async function runPaginationStep() {
        if (
            !paginationState ||
            !paginationState.running ||
            stopped
        ) {
            return;
        }
        if (
            settings
                .paginationPauseHiddenTabs &&
            !pageVisible
        ) {
            updatePaginationPanel(
                "Paused in hidden tab."
            );
            schedulePaginationStep(
                settings
                    .paginationDelayMilliseconds
            );
            return;
        }
        const elapsed =
            Date.now() -
            paginationState.startedAt;
        if (
            elapsed >=
            settings
                .paginationMaximumElapsedSeconds *
                1000
        ) {
            stopAutomaticPagination(
                "Maximum elapsed time reached."
            );
            return;
        }
        if (
            settings.paginationStopOnCaptcha &&
            detectCaptcha()
        ) {
            clearPaginationTimer();
            paginationState.captchaPaused =
                true;
            paginationState.ui
                .resumeButton.hidden = false;
            updatePaginationPanel(
                "Paused for CAPTCHA. Complete it, then resume."
            );
            return;
        }
        const visibleResults =
            countVisibleResults();
        if (
            visibleResults >=
            settings
                .paginationTargetVisibleResults
        ) {
            stopAutomaticPagination(
                "Target visible results reached."
            );
            return;
        }
        if (
            paginationState.pagesLoaded >=
            settings.paginationMaximumPages
        ) {
            stopAutomaticPagination(
                "Maximum page count reached."
            );
            return;
        }
        if (
            processedResultCount >=
            settings
                .paginationMaximumProcessedResults
        ) {
            stopAutomaticPagination(
                "Maximum processed-result count reached."
            );
            return;
        }
		if (
    engine === "google" &&
    !getNextPageControl()
) {
    window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "auto"
    });

    await new Promise(resolve => {
        window.setTimeout(
            resolve,
            settings.paginationDelayMilliseconds
        );
    });
}
        const control =
            getNextPageControl();
        if (!control) {
            paginationState
                .emptyPages += 1;
            if (
                paginationState.emptyPages >=
                settings
                    .paginationEmptyPageLimit
            ) {
                stopAutomaticPagination(
                    "No next-page control found."
                );
                return;
            }
            updatePaginationPanel(
                "Waiting for a next-page control..."
            );
            schedulePaginationStep(
                settings
                    .paginationDelayMilliseconds
            );
            return;
        }
        const changed =
            await activateNextPage(
                control
            );
        if (
            !paginationState ||
            !paginationState.running
        ) {
            return;
        }
        if (changed) {
            paginationState.emptyPages = 0;
            scheduleScan(document);
        } else {
            paginationState
                .emptyPages += 1;
        }
        if (
            paginationState.emptyPages >=
            settings
                .paginationEmptyPageLimit
        ) {
            stopAutomaticPagination(
                "Empty-page limit reached."
            );
            return;
        }
        updatePaginationPanel();
        schedulePaginationStep(
            settings
                .paginationDelayMilliseconds
        );
    }
    function startAutomaticPagination() {
		if (engine === "google") {
            return;
        }

        if (
            !settings.automaticPagination ||
            paginationState ||
            stopped
        ) {
            return;
        }
        paginationState = {
            running: true,
            startedAt: Date.now(),
            pagesLoaded: 0,
            emptyPages: 0,
            captchaPaused: false,
            timer: null,
            ui: createPaginationPanel()
        };
        updatePaginationPanel(
            "Starting..."
        );
        schedulePaginationStep(
            settings
                .paginationDelayMilliseconds
        );
    }
    function resultContainersExist() {
        const selectors =
            RESULT_SELECTORS[engine] ||
            [];
        return selectors.some(
            selector =>
                Boolean(
                    document.querySelector(
                        selector
                    )
                )
        );
    }
    function startStablePageStop() {
        if (
            !settings.experimentalWindowStop ||
            stopController ||
            stopped
        ) {
            return;
        }
        stopController = {
            startedAt: Date.now(),
            timer: null
        };
        const step = () => {
            if (
                !stopController ||
                stopped
            ) {
                return;
            }
            const timedOut =
                Date.now() -
                    stopController.startedAt >=
                15000;
            const ready =
                resultContainersExist() &&
                !scanInProgress &&
                scanTimer === null &&
                pendingRoots.size === 0;
            if (ready || timedOut) {
                window.stop();
                if (
                    stopController &&
                    stopController.timer !==
                        null
                ) {
                    window.clearTimeout(
                        stopController.timer
                    );
                }
                stopController = null;
                return;
            }
            stopController.timer =
                window.setTimeout(
                    step,
                    100
                );
        };
        stopController.timer =
            window.setTimeout(
                step,
                100
            );
    }
    function applyPageClasses() {
        const root =
            document.documentElement;
        root.classList.toggle(
            "leanserp-disable-animations",
            settings.disableAnimations
        );
        root.classList.toggle(
            "leanserp-text-only",
            settings.textOnlyMode
        );
        root.classList.toggle(
            "leanserp-block-images",
            settings.blockImages
        );
        root.classList.toggle(
            "leanserp-block-media",
            settings.blockMedia
        );
    }
    function runEnabledPageFeatures() {
        applyEnabledModuleRemoval();
        suppressResourceHints();
        disableAutoplay();
    }
    function observePage() {
        if (
            observer ||
            stopped ||
            (
                settings.pauseHiddenTabs &&
                !pageVisible
            )
        ) {
            return;
        }
        observer =
            new MutationObserver(
                mutations => {
                    let changed = false;
                    for (
                        const mutation of
                        mutations
                    ) {
                        for (
                            const node of
                            mutation.addedNodes
                        ) {
                            if (
                                node.nodeType !==
                                Node.ELEMENT_NODE
                            ) {
                                continue;
                            }
                            queueRoot(node);
                            changed = true;
                        }
                    }
                    if (changed) {
                        runEnabledPageFeatures();
                        scheduleScan();
                    }
                }
            );
        observer.observe(
            document.documentElement,
            {
                childList: true,
                subtree: true
            }
        );
    }
    function disconnectObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }
    function cleanup() {
        stopped = true;
        disconnectObserver();
		stopRelatedModulesObserver();
        pendingRoots.clear();
        if (scanTimer !== null) {
            window.clearTimeout(
                scanTimer
            );
            scanTimer = null;
        }
        if (paginationState) {
            clearPaginationTimer();
            if (
                paginationState.ui &&
                paginationState.ui.panel
                    .isConnected
            ) {
                paginationState.ui.panel
                    .remove();
            }
            paginationState = null;
        }
        if (
            stopController &&
            stopController.timer !== null
        ) {
            window.clearTimeout(
                stopController.timer
            );
        }
        stopController = null;
    }
    async function initialize() {
        if (initialized) {
            return;
        }
        initialized = true;
        engine = detectEngine();
        if (
            !engine ||
            !isSearchPage()
        ) {
            return;
        }
        let response;
        try {
            response =
                await browser.runtime.sendMessage({
                    type: "getSettings"
                });
        } catch {
            return;
        }
        if (
            !response ||
            !response.ok
        ) {
            return;
        }
        settings =
            normalizeSettings(
                response.settings
            );
        if (!settings.enabled) {
            return;
        }
        applyPageClasses();
        const start = () => {
            if (stopped) {
                return;
            }
            runEnabledPageFeatures();

			if (settings.removeRelatedSearches) {
		startRelatedModulesObserver();
			}

queueRoot(document);
            scheduleScan();
            observePage();
            if (
                settings.automaticPagination
            ) {
                startAutomaticPagination();
            }
            if (
                settings.experimentalWindowStop
            ) {
                startStablePageStop();
            }
        };
        if (
            document.readyState ===
            "loading"
        ) {
            document.addEventListener(
                "DOMContentLoaded",
                start,
                {
                    once: true
                }
            );
        } else {
            start();
        }
    }
    document.addEventListener(
        "visibilitychange",
        () => {
            pageVisible =
                !document.hidden;
            if (
                settings.pauseHiddenTabs
            ) {
                if (pageVisible) {
                    observePage();
                    scheduleScan(document);
                } else {
                    disconnectObserver();
                }
            }
            if (
                pageVisible &&
                paginationState &&
                paginationState.running &&
                settings
                    .paginationPauseHiddenTabs
            ) {
                schedulePaginationStep(
                    settings
                        .paginationDelayMilliseconds
                );
            }
        }
    );
    window.addEventListener(
        "pagehide",
        cleanup,
        {
            once: true
        }
    );
    window.addEventListener(
        "beforeunload",
        cleanup,
        {
            once: true
        }
    );
    void initialize();
})();
