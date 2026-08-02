"use strict";

(() => {
    const MAX_HOSTS_PER_REQUEST = 64;
    const MAX_PENDING_ROOTS = 128;
    const MAX_CANDIDATES_PER_SCAN = 256;
    const MAX_DECISION_CACHE_ENTRIES = 5000;
    const SCAN_DELAY_MS = 100;

    const PREVIEW_ATTRIBUTE =
        "data-leanserp-adapter-preview";

    const ENGINE_MATCHERS = Object.freeze({
        google: hostname =>
            /(^|\.)google\./i.test(hostname),

        bing: hostname =>
            /(^|\.)bing\.com$/i.test(hostname),

        duckduckgo: hostname =>
            /(^|\.)duckduckgo\.com$/i.test(
                hostname
            ),

        brave: hostname =>
            hostname === "search.brave.com",

        startpage: hostname =>
            hostname === "startpage.com" ||
            hostname.endsWith(
                ".startpage.com"
            ),

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

    const ENGINE_RULES = Object.freeze({
        google: Object.freeze({
            roots: [
                "div.MjjYud",
                "div.wHYlTd.Ww4FFb.tF2Cxc",
                "div.tF2Cxc",
                "div.g"
            ],
            links: [
                "a[jsname='UWckNb'][href]",
                "a[data-sb][href]",
                "a[href] > h3"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                "[role='navigation']",
                "[role='menu']",
                "#botstuff",
                "#foot",
                "#taw",
                "#tvcap",
                "#pnprev",
                "#pnnext",
                "table.AaVjTc"
            ],
            allowGenericRoot: false
        }),

        bing: Object.freeze({
            roots: [
                "#b_results li.b_algo",
                "li.b_algo",
                "li.b_ans",
                "div.b_algo"
            ],
            links: [
                "#b_results li.b_algo h2 a[href]",
                "li.b_algo h2 a[href]",
                "h2 a[href]",
                "a.tilk[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                "[role='navigation']",
                ".b_pag",
                ".sb_pagF",
                "#b_footer",
                "#b_context",
                "#b_pole"
            ],
            allowGenericRoot: false
        }),

        duckduckgo: Object.freeze({
            roots: [
                "li[data-layout='organic']",
                "article[data-testid='result']",
                ".result.results_links",
                ".result",
                ".web-result",
                "tr.result-link",
                "tr.result-snippet"
            ],
            links: [
                "a[data-testid='result-title-a'][href]",
                "a.result__a[href]",
                "a.result-link[href]",
                "h2 a[href]",
                "h3 a[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                "[role='navigation']",
                "[role='menu']",
                "[role='menuitem']",
                ".nav-link",
                ".navbutton",
                ".next",
                ".previous",
                ".pagination"
            ],
            allowGenericRoot: false
        }),

        brave: Object.freeze({
            roots: [
                "[data-type='web']",
                "[data-testid='web-result']",
                ".search-result",
                ".snippet"
            ],
            links: [
                "a[data-testid='result-title'][href]",
                ".title a[href]",
                "h2 a[href]",
                "h3 a[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                "[role='navigation']",
                ".pagination"
            ],
            allowGenericRoot: false
        }),

        startpage: Object.freeze({
            roots: [
                ".w-gl__result",
                ".result",
                "[data-testid='result']",
                ".search-result"
            ],
            links: [
                "a.w-gl__result-title[href]",
                "a[data-testid='result-title'][href]",
                "h2 a[href]",
                "h3 a[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                "[role='navigation']",
                ".pagination"
            ],
            allowGenericRoot: false
        }),

        wiby: Object.freeze({
            roots: [
                ".result",
                ".search-result",
                ".result-item",
                "div:has(> a.tlink)"
            ],
            links: [
                "a.tlink[href]",
                "h2 a[href]",
                "h3 a[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                ".pagination"
            ],
            allowGenericRoot: true
        }),

        etools: Object.freeze({
            roots: [
                ".result",
                ".search-result",
                ".result-item"
            ],
            links: [
                ".title a[href]",
                "h2 a[href]",
                "h3 a[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                ".pagination"
            ],
            allowGenericRoot: true
        }),

        secretsearchenginelabs: Object.freeze({
            roots: [
                ".result",
                ".search-result",
                ".result-item",
                ".web-result"
            ],
            links: [
                ".result-title a[href]",
                ".title a[href]",
                "h2 a[href]",
                "h3 a[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                ".pagination"
            ],
            allowGenericRoot: false
        }),

        rawweb: Object.freeze({
            roots: [
                ".result",
                ".search-result",
                ".result-item"
            ],
            links: [
                ".title a[href]",
                "h2 a[href]",
                "h3 a[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                ".pagination"
            ],
            allowGenericRoot: true
        }),

        slsearch: Object.freeze({
            roots: [
                ".result",
                ".search-result",
                ".result-item"
            ],
            links: [
                ".title a[href]",
                "h2 a[href]",
                "h3 a[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                ".pagination"
            ],
            allowGenericRoot: true
        }),

        searchthis: Object.freeze({
            roots: [
                ".result",
                ".search-result",
                ".result-item"
            ],
            links: [
                ".title a[href]",
                "h2 a[href]",
                "h3 a[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                ".pagination"
            ],
            allowGenericRoot: true
        }),

        degoog: Object.freeze({
            roots: [
                "div.result-item.degoog-result",
                ".result-item",
                ".search-result"
            ],
            links: [
                "a.result-title.degoog-result--title[href]",
                ".title a[href]",
                "h2 a[href]",
                "h3 a[href]"
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                ".pagination",
                "#results-main"
            ],
            allowGenericRoot: false
        })
    });

    const pendingRoots = new Set();
    let processedHostnames = new WeakMap();
    const decisionCache = new Map();

    let engine = "";
    let observer = null;
    let scanTimer = null;
    let scanRunning = false;
    let rescanRequested = false;
    let pageVisible = !document.hidden;
    let stopped = false;
    let dynamicAdapters = [];
    const runtimeHealth = {
        adapterLoadOk: false,
        adapterCount: 0,
        lastScanAt: "",
        lastCandidateCount: 0,
        lastError: ""
    };
    let lastLocationHref =
        location.href;
    let locationTrackingInstalled =
        false;


    function detectEngine() {
        const hostname =
            location.hostname.toLowerCase();

        for (
            const [name, matcher] of
            Object.entries(ENGINE_MATCHERS)
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
                location.pathname === "/search" ||
                location.pathname === "/webhp"
            );
        }

        if (engine === "bing") {
            return (
                location.pathname === "/search"
            );
        }

        if (engine === "duckduckgo") {
            return (
                location.pathname === "/" ||
                location.pathname === "/html" ||
                location.pathname === "/html/" ||
                location.pathname === "/lite" ||
                location.pathname === "/lite/"
            );
        }

        if (engine === "brave") {
            return location.pathname.startsWith(
                "/search"
            );
        }

        if (engine === "startpage") {
            return (
                location.pathname === "/sp/search" ||
                location.pathname === "/do/search" ||
                location.pathname === "/search"
            );
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

    function redirectGoogleToCleanSearch() {
        return false;
    }

    function decodeBingTarget(value) {
        const encoded =
            String(value || "");

        if (
            !encoded.startsWith("a1") ||
            encoded.length <= 2
        ) {
            return "";
        }

        let base64 =
            encoded.slice(2)
                .replace(/-/g, "+")
                .replace(/_/g, "/");

        while (base64.length % 4 !== 0) {
            base64 += "=";
        }

        try {
            const binary = atob(base64);
            const bytes =
                Uint8Array.from(
                    binary,
                    character =>
                        character.charCodeAt(0)
                );
            const decoded =
                new TextDecoder(
                    "utf-8",
                    {
                        fatal: false
                    }
                ).decode(bytes);
            const target =
                new URL(decoded);

            if (
                target.protocol === "http:" ||
                target.protocol === "https:"
            ) {
                return target.href;
            }
        } catch {
        }

        return "";
    }

    function decodeRedirect(href) {
        try {
            const url = new URL(
                href,
                location.href
            );

            if (
                /(^|\.)bing\.com$/i.test(
                    url.hostname
                ) &&
                url.pathname === "/ck/a"
            ) {
                const target =
                    decodeBingTarget(
                        url.searchParams.get("u")
                    );

                if (target) {
                    return target;
                }
            }

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
                    url.searchParams.get("uddg");

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
            return String(href || "");
        }
    }

    function getUrlFromSource(
        link,
        source
    ) {
        if (source === "href") {
            return link.getAttribute("href") || "";
        }

        if (source === "data-href") {
            return (
                link.getAttribute("data-href") ||
                ""
            );
        }

        if (source === "data-url") {
            return (
                link.getAttribute("data-url") ||
                ""
            );
        }

        if (source === "data-target") {
            return (
                link.getAttribute("data-target") ||
                ""
            );
        }

        return "";
    }

    function getHostname(
        link,
        urlSources = [
            "href",
            "data-href",
            "data-url",
            "data-target"
        ]
    ) {
        if (
            !link ||
            link.nodeType !==
                Node.ELEMENT_NODE
        ) {
            return "";
        }

        for (const source of urlSources) {
            const raw =
                getUrlFromSource(
                    link,
                    source
                );

            if (!raw) {
                continue;
            }

            try {
                const decoded =
                    decodeRedirect(raw);
                const url =
                    new URL(
                        decoded,
                        location.href
                    );

                if (
                    url.protocol !== "http:" &&
                    url.protocol !== "https:"
                ) {
                    continue;
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
                    hostname.length > 253
                ) {
                    continue;
                }

                return hostname;
            } catch {
            }
        }

        return "";
    }
    function normalizeDynamicAdapter(value) {
        if (
            !value ||
            typeof value !== "object" ||
            value.enabled === false
        ) {
            return null;
        }
        const hostname =
            String(value.hostname || "")
                .trim()
                .toLowerCase();
        const pathPattern =
            String(
                value.pathPattern || ""
            ).trim();
        const resultSelector =
            String(
                value.resultSelector || ""
            ).trim();
        const linkSelector =
            String(
                value.linkSelector || ""
            ).trim();
        const allowedSources =
            new Set([
                "href",
                "data-href",
                "data-url",
                "data-target"
            ]);
        const urlSources =
            Array.isArray(
                value.urlSources
            )
                ? Array.from(
                    new Set(
                        value.urlSources
                            .map(source =>
                                String(
                                    source || ""
                                ).trim()
                            )
                            .filter(source =>
                                allowedSources.has(
                                    source
                                )
                            )
                    )
                )
                : [];
        if (
            !hostname ||
            !pathPattern ||
            !resultSelector ||
            !linkSelector
        ) {
            return null;
        }
        try {
            new RegExp(pathPattern);
            document.querySelector(
                resultSelector
            );
            document.querySelector(
                linkSelector
            );
        } catch {
            return null;
        }
        return {
            hostname,
            pathPattern,
            resultSelector,
            linkSelector,
            urlSources:
                urlSources.length > 0
                    ? urlSources
                    : [
                        "href",
                        "data-href",
                        "data-url"
                    ],
            enabled: true
        };
    }
    function pathMatchesAdapter(adapter) {
        try {
            return new RegExp(
                String(
                    adapter.pathPattern || ""
                )
            ).test(location.pathname);
        } catch {
            return false;
        }
    }

    function getDynamicAdapter() {
        const hostname =
            location.hostname.toLowerCase();

        for (const adapter of dynamicAdapters) {
            if (
                !adapter ||
                adapter.enabled === false
            ) {
                continue;
            }

            if (
                String(
                    adapter.hostname || ""
                )
                    .trim()
                    .toLowerCase() !==
                hostname
            ) {
                continue;
            }

            if (!pathMatchesAdapter(adapter)) {
                continue;
            }

            return adapter;
        }

        return null;
    }

    function getDynamicRule() {
        const adapter =
            getDynamicAdapter();

        if (!adapter) {
            return null;
        }

        const resultSelector =
            String(
                adapter.resultSelector || ""
            ).trim();
        const linkSelector =
            String(
                adapter.linkSelector || ""
            ).trim();

        if (
            !resultSelector ||
            !linkSelector
        ) {
            return null;
        }

        return {
            roots: [
                resultSelector
            ],
            links: [
                linkSelector
            ],
            exclusions: [
                "header",
                "nav",
                "footer",
                "form",
                "[role='navigation']",
                "[role='search']",
                ".pagination"
            ],
            allowGenericRoot: false,
            urlSources:
                Array.isArray(
                    adapter.urlSources
                ) &&
                adapter.urlSources.length > 0
                    ? adapter.urlSources
                    : [
                        "href",
                        "data-href",
                        "data-url"
                    ]
        };
    }

    function getRule() {
        const dynamicRule =
            getDynamicRule();
        const builtInRule =
            ENGINE_RULES[engine] || null;
        if (
            !dynamicRule ||
            !builtInRule
        ) {
            return (
                dynamicRule ||
                builtInRule
            );
        }
        return {
            roots: Array.from(
                new Set([
                    ...dynamicRule.roots,
                    ...builtInRule.roots
                ])
            ),
            links: Array.from(
                new Set([
                    ...dynamicRule.links,
                    ...builtInRule.links
                ])
            ),
            exclusions: Array.from(
                new Set([
                    ...dynamicRule.exclusions,
                    ...builtInRule.exclusions
                ])
            ),
            allowGenericRoot:
                Boolean(
                    builtInRule
                        .allowGenericRoot
                ),
            urlSources:
                dynamicRule.urlSources
        };
    }


    async function loadDynamicAdapters() {
        const MAX_ATTEMPTS = 3;
        const RETRY_DELAY_MS = 150;
        let lastError = null;
        for (
            let attempt = 1;
            attempt <= MAX_ATTEMPTS;
            attempt += 1
        ) {
            try {
                const response =
                    await browser.runtime
                        .sendMessage({
                            type:
                                "getAdaptersForLocation",
                            url: location.href
                        });
                if (
                    !response ||
                    !response.ok
                ) {
                    throw new Error(
                        response &&
                        response.error
                            ? response.error
                            : "Adapter loading failed."
                    );
                }
                const source =
                    Array.isArray(
                        response.adapters
                    )
                        ? response.adapters
                        : [];
                dynamicAdapters =
                    source
                        .map(
                            normalizeDynamicAdapter
                        )
                        .filter(Boolean);
                runtimeHealth.adapterLoadOk =
                    true;
                runtimeHealth.adapterCount =
                    dynamicAdapters.length;
                runtimeHealth.lastError =
                    "";
                return {
                    ok: true,
                    count:
                        dynamicAdapters.length
                };
            } catch (error) {
                lastError = error;
                if (
                    attempt < MAX_ATTEMPTS
                ) {
                    await new Promise(
                        resolve => {
                            window.setTimeout(
                                resolve,
                                RETRY_DELAY_MS *
                                    attempt
                            );
                        }
                    );
                }
            }
        }
        dynamicAdapters = [];
        runtimeHealth.adapterLoadOk =
            false;
        runtimeHealth.adapterCount = 0;
        runtimeHealth.lastError =
            lastError &&
            lastError.message
                ? lastError.message
                : String(
                    lastError ||
                    "Unknown adapter-loading error."
                );
        return {
            ok: false,
            count: 0,
            error:
                runtimeHealth.lastError
        };
    }

    function isExcluded(link, rule) {
        for (
            const selector of
            rule.exclusions || []
        ) {
            try {
                if (link.closest(selector)) {
                    return true;
                }
            } catch {
            }
        }

        return false;
    }

    function addCandidateLink(
        links,
        seen,
        match
    ) {
        const link =
            match.matches(
                "a[href], " +
                "a[data-href], " +
                "a[data-url], " +
                "a[data-target]"
            )
                ? match
                : match.closest(
                    "a[href], " +
                    "a[data-href], " +
                    "a[data-url], " +
                    "a[data-target]"
                );

        if (
            !link ||
            seen.has(link)
        ) {
            return false;
        }

        seen.add(link);
        links.push(link);

        return (
            links.length >=
            MAX_CANDIDATES_PER_SCAN
        );
    }

    function getCandidateLinks(root, rule) {
        const links = [];
        const seen = new Set();

        for (const selector of rule.links) {
            try {
                if (
                    root.nodeType ===
                        Node.ELEMENT_NODE &&
                    root.matches(selector) &&
                    addCandidateLink(
                        links,
                        seen,
                        root
                    )
                ) {
                    return links;
                }

                for (
                    const match of
                    root.querySelectorAll(
                        selector
                    )
                ) {
                    if (
                        addCandidateLink(
                            links,
                            seen,
                            match
                        )
                    ) {
                        return links;
                    }
                }
            } catch {
            }
        }

        return links;
    }

    function getConfiguredContainer(
        link,
        rule
    ) {
        for (const selector of rule.roots) {
            try {
                const container =
                    link.closest(selector);

                if (container) {
                    return container;
                }
            } catch {
            }
        }

        return null;
    }

    function getGoogleResultContainer(link) {
        const card =
            link.closest(
                "div.wHYlTd.Ww4FFb.tF2Cxc, " +
                "div.tF2Cxc, " +
                "div.g"
            );

        if (
            card &&
            card.querySelector(
                "a[jsname='UWckNb'][href], " +
                "a[data-sb][href], " +
                "a[href] > h3"
            )
        ) {
            return card;
        }

        return link.closest("div.MjjYud");
    }

    function getBingResultContainer(link) {
        return (
            link.closest(
                "#b_results li.b_algo"
            ) ||
            link.closest("li.b_algo") ||
            link.closest("li.b_ans") ||
            link.closest("div.b_algo")
        );
    }

    function getDuckDuckGoResultContainer(
        link
    ) {
        const organicItem =
            link.closest(
                "li[data-layout='organic']"
            );

        if (
            organicItem &&
            organicItem.querySelector(
                "article[data-testid='result']"
            )
        ) {
            return organicItem;
        }

        const article =
            link.closest(
                "article[data-testid='result']"
            );

        if (article) {
            return article;
        }

        const classicResult =
            link.closest(
                ".result.results_links, " +
                ".result, .web-result"
            );

        if (classicResult) {
            return classicResult;
        }

        const row =
            link.closest(
                "tr.result-link, " +
                "tr.result-snippet"
            );

        if (row) {
            return row;
        }

        return null;
    }

    function getWibyContainer(link) {
        if (!link.matches("a.tlink")) {
            return null;
        }

        let current =
            link.parentElement;

        for (
            let depth = 0;
            current &&
            depth < 6 &&
            current !== document.body;
            depth += 1
        ) {
            const resultLinks =
                current.querySelectorAll(
                    "a.tlink"
                ).length;
            const text =
                String(
                    current.textContent || ""
                )
                    .replace(/\s+/g, " ")
                    .trim();

            if (
                resultLinks === 1 &&
                text.length >= 20
            ) {
                return current;
            }

            current =
                current.parentElement;
        }

        return null;
    }

    function getSafeGenericContainer(
        link,
        rule
    ) {
        if (!rule.allowGenericRoot) {
            return null;
        }

        let current =
            link.parentElement;

        for (
            let depth = 0;
            current &&
            depth < 6 &&
            current !== document.body &&
            current !==
                document.documentElement;
            depth += 1
        ) {
            if (
                isProtectedContainer(current)
            ) {
                return null;
            }

            const text =
                String(
                    current.textContent || ""
                )
                    .replace(/\s+/g, " ")
                    .trim();

            const externalLinks =
                Array.from(
                    current.querySelectorAll(
                        "a[href], " +
                        "a[data-href], " +
                        "a[data-url]"
                    )
                ).filter(candidate =>
                    Boolean(
                        getHostname(candidate)
                    )
                ).length;

            if (
                text.length >= 20 &&
                text.length <= 5000 &&
                externalLinks >= 1 &&
                externalLinks <= 5
            ) {
                return current;
            }

            current =
                current.parentElement;
        }

        return null;
    }

    function getResultContainer(
        link,
        rule
    ) {
        if (engine === "google") {
            const container =
                getGoogleResultContainer(link);

            if (container) {
                return container;
            }
        }

        if (engine === "bing") {
            const container =
                getBingResultContainer(link);

            if (container) {
                return container;
            }
        }

        if (engine === "duckduckgo") {
            const container =
                getDuckDuckGoResultContainer(
                    link
                );

            if (container) {
                return container;
            }
        }

        const configured =
            getConfiguredContainer(
                link,
                rule
            );

        if (configured) {
            return configured;
        }

        if (engine === "wiby") {
            const wibyContainer =
                getWibyContainer(link);

            if (wibyContainer) {
                return wibyContainer;
            }
        }

        return getSafeGenericContainer(
            link,
            rule
        );
    }

    function isProtectedContainer(element) {
        if (!element) {
            return true;
        }

        if (
            element === document.body ||
            element ===
                document.documentElement
        ) {
            return true;
        }

        try {
            return element.matches(
                "html, body, main, header, nav, " +
                "footer, form, " +
                "[role='navigation'], " +
                "[role='search'], " +
                "#center_col, #search, #rso, " +
                "#results-page, #results-main, " +
                "#results-list, #b_results"
            );
        } catch {
            return true;
        }
    }

    function containsProtectedControls(
        container
    ) {
        try {
            return Boolean(
                container.querySelector(
                    "form, [role='search'], " +
                    "input[type='search'], " +
                    "#pnprev, #pnnext, " +
                    "table.AaVjTc, " +
                    ".pagination"
                )
            );
        } catch {
            return true;
        }
    }

    function isSafeContainer(
        container,
        link
    ) {
        if (
            !container ||
            !link ||
            isProtectedContainer(container) ||
            !container.contains(link) ||
            containsProtectedControls(
                container
            )
        ) {
            return false;
        }

        const text =
            String(
                container.textContent || ""
            )
                .replace(/\s+/g, " ")
                .trim();

        if (
            text.length === 0 ||
            text.length > 12000
        ) {
            return false;
        }

        return true;
    }

    function hasProcessedHostname(
        container,
        hostname
    ) {
        return (
            processedHostnames.get(
                container
            ) === hostname
        );
    }

    function markProcessed(
        container,
        hostname
    ) {
        processedHostnames.set(
            container,
            hostname
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

        const rule = getRule();

        if (!rule) {
            return [];
        }

        const candidates = [];
        const seenContainers = new Set();
        const links =
            getCandidateLinks(root, rule);

        for (const link of links) {
            if (
                candidates.length >=
                    MAX_CANDIDATES_PER_SCAN
            ) {
                break;
            }

            if (
                isExcluded(link, rule) ||
                link.closest(
                    "[data-leanserp-ui]"
                )
            ) {
                continue;
            }

            const hostname =
                getHostname(
                    link,
                    rule.urlSources
                );

            if (!hostname) {
                continue;
            }

            const container =
                getResultContainer(
                    link,
                    rule
                );

            if (
                !isSafeContainer(
                    container,
                    link
                ) ||
                seenContainers.has(
                    container
                ) ||
                hasProcessedHostname(
                    container,
                    hostname
                )
            ) {
                continue;
            }

            seenContainers.add(container);
            candidates.push({
                hostname,
                container
            });
        }

        return candidates;
    }

    function getCachedDecision(hostname) {
        if (!decisionCache.has(hostname)) {
            return undefined;
        }

        const decision =
            decisionCache.get(hostname);

        decisionCache.delete(hostname);
        decisionCache.set(
            hostname,
            decision
        );

        return decision;
    }

    function cacheDecision(
        hostname,
        decision
    ) {
        if (decisionCache.has(hostname)) {
            decisionCache.delete(hostname);
        }

        decisionCache.set(
            hostname,
            decision
        );

        while (
            decisionCache.size >
            MAX_DECISION_CACHE_ENTRIES
        ) {
            const oldest =
                decisionCache.keys()
                    .next().value;
            decisionCache.delete(oldest);
        }
    }

    function deleteBlockedResult(candidate) {
        const container =
            candidate.container;

        if (
            container &&
            container.isConnected
        ) {
            container.remove();
        }
    }

    function applyDecision(
        candidate,
        decision
    ) {
        if (
            !candidate ||
            !candidate.container ||
            !candidate.container.isConnected
        ) {
            return;
        }

        if (
            decision &&
            decision.blocked
        ) {
            deleteBlockedResult(candidate);
            return;
        }

        markProcessed(
            candidate.container,
            candidate.hostname
        );
    }

    async function requestDecisions(
        candidates
    ) {
        const hostnames =
            Array.from(
                new Set(
                    candidates.map(
                        candidate =>
                            candidate.hostname
                    )
                )
            );

        const response =
            await browser.runtime
                .sendMessage({
                    type:
                        "confirmHostnames",
                    hostnames
                });

        if (
            !response ||
            !response.ok ||
            !response.decisions
        ) {
            throw new Error(
                "Hostname confirmation failed."
            );
        }

        return response.decisions;
    }

    async function processCandidates(
        candidates
    ) {
        const uncached = [];

        for (const candidate of candidates) {
            const cached =
                getCachedDecision(
                    candidate.hostname
                );

            if (cached !== undefined) {
                applyDecision(
                    candidate,
                    cached
                );
            } else {
                uncached.push(candidate);
            }
        }

        for (
            let offset = 0;
            offset < uncached.length;
            offset += MAX_HOSTS_PER_REQUEST
        ) {
            const batch =
                uncached.slice(
                    offset,
                    offset +
                        MAX_HOSTS_PER_REQUEST
                );

            let decisions;

            try {
                decisions =
                    await requestDecisions(
                        batch
                    );
            } catch {
                continue;
            }

            for (const candidate of batch) {
                const decision =
                    decisions[
                        candidate.hostname
                    ] || {
                        blocked: false,
                        matchedRule:
                            "",
                        matchedType:
                            ""
                    };
                cacheDecision(
                    candidate.hostname,
                    decision
                );
                applyDecision(
                    candidate,
                    decision
                );
            }
        }
    }
    function queueRoot(root) {
        if (!root) {
            return;
        }
        if (
            pendingRoots.size >=
                MAX_PENDING_ROOTS
        ) {
            pendingRoots.clear();
            pendingRoots.add(document);
            return;
        }
        pendingRoots.add(root);
    }
    async function scanPendingRoots() {
        if (
            stopped ||
            !pageVisible
        ) {
            return;
        }
        if (scanRunning) {
            rescanRequested = true;
            return;
        }
        scanRunning = true;
        try {
            do {
                rescanRequested = false;
                const roots =
                    Array.from(
                        pendingRoots
                    ).slice(
                        0,
                        MAX_PENDING_ROOTS
                    );
                for (const root of roots) {
                    pendingRoots.delete(root);
                }
                if (roots.length === 0) {
                    roots.push(document);
                }
                const candidates = [];
                const seenContainers =
                    new Set();
                for (const root of roots) {
                    for (
                        const candidate of
                        findCandidates(root)
                    ) {
                        if (
                            seenContainers.has(
                                candidate.container
                            )
                        ) {
                            continue;
                        }
                        seenContainers.add(
                            candidate.container
                        );
                        candidates.push(
                            candidate
                        );
                        if (
                            candidates.length >=
                                MAX_CANDIDATES_PER_SCAN
                        ) {
                            break;
                        }
                    }
                    if (
                        candidates.length >=
                            MAX_CANDIDATES_PER_SCAN
                    ) {
                        break;
                    }
                }
                runtimeHealth.lastScanAt =
                    new Date()
                        .toISOString();
                runtimeHealth
                    .lastCandidateCount =
                    candidates.length;
                await processCandidates(
                    candidates
                );

            } while (
                rescanRequested &&
                !stopped &&
                pageVisible
            );
        } finally {
            scanRunning = false;
        }
    }
    function scheduleScan(root) {
        if (root) {
            queueRoot(root);
        }
        if (
            stopped ||
            !pageVisible ||
            scanTimer !== null
        ) {
            return;
        }
        scanTimer =
            window.setTimeout(
                () => {
                    scanTimer = null;
                    void scanPendingRoots();
                },
                SCAN_DELAY_MS
            );
    }
    function connectObserver() {
        if (
            observer ||
            stopped ||
            !pageVisible ||
            !document.documentElement
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
    function escapeCssIdentifier(value) {
        const text =
            String(value || "");
        if (
            globalThis.CSS &&
            typeof CSS.escape ===
                "function"
        ) {
            return CSS.escape(text);
        }
        return text.replace(
            /[^a-zA-Z0-9_-]/g,
            character =>
                `\\${character
                    .codePointAt(0)
                    .toString(16)} `
        );
    }
    function buildElementSelector(element) {
        if (
            !element ||
            element.nodeType !==
                Node.ELEMENT_NODE
        ) {
            return "";
        }
        const tag =
            element.tagName
                .toLowerCase();
        if (element.id) {
            return (
                tag +
                "#" +
                escapeCssIdentifier(
                    element.id
                )
            );
        }
        const classes =
            Array.from(
                element.classList
            )
                .filter(className =>
                    /^[a-zA-Z_][a-zA-Z0-9_-]*$/
                        .test(className)
                )
                .slice(0, 4);
        if (classes.length === 0) {
            return tag;
        }
        return (
            tag +
            classes
                .map(className =>
                    "." +
                    escapeCssIdentifier(
                        className
                    )
                )
                .join("")
        );
    }
    function getExternalResultLinks() {
        const pageHostname =
            location.hostname
                .toLowerCase();
        return Array.from(
            document.querySelectorAll(
                "a[href], " +
                "a[data-href], " +
                "a[data-url], " +
                "a[data-target]"
            )
        ).filter(link => {
            if (
                link.closest(
                    "header, nav, footer, " +
                    "form, " +
                    "[role='navigation'], " +
                    "[role='menu'], " +
                    "[role='menuitem']"
                )
            ) {
                return false;
            }
            const hostname =
                getHostname(link);
            return (
                hostname.length > 0 &&
                hostname !== pageHostname
            );
        });
    }
    function scoreAdapterContainer(
        container,
        link
    ) {
        if (
            isProtectedContainer(
                container
            ) ||
            !container.contains(link) ||
            containsProtectedControls(
                container
            )
        ) {
            return null;
        }
        const text =
            String(
                container.textContent ||
                    ""
            )
                .replace(/\s+/g, " ")
                .trim();
        if (
            text.length < 15 ||
            text.length > 6000
        ) {
            return null;
        }
        const externalLinks =
            Array.from(
                container.querySelectorAll(
                    "a[href], " +
                    "a[data-href], " +
                    "a[data-url]"
                )
            ).filter(candidate =>
                Boolean(
                    getHostname(candidate)
                )
            );
        if (
            externalLinks.length < 1 ||
            externalLinks.length > 8
        ) {
            return null;
        }
        const selector =
            buildElementSelector(
                container
            );
        if (!selector) {
            return null;
        }
        let selectorMatches = 0;
        try {
            selectorMatches =
                document.querySelectorAll(
                    selector
                ).length;
        } catch {
            return null;
        }
        if (
            selectorMatches < 2 ||
            selectorMatches > 300
        ) {
            return null;
        }
        let score = 0;
        score += Math.min(
            selectorMatches,
            30
        );
        score +=
            externalLinks.length === 1
                ? 20
                : 8;
        if (
            /result|search|item|entry|web/i
                .test(
                    `${container.id} ` +
                    `${container.className}`
                )
        ) {
            score += 25;
        }
        if (
            container.matches(
                "article, li"
            )
        ) {
            score += 10;
        }
        if (text.length <= 1500) {
            score += 8;
        }
        return {
            container,
            selector,
            selectorMatches,
            textLength: text.length,
            score
        };
    }
    function findBestAdapterContainer(
        link
    ) {
        const candidates = [];
        let current =
            link.parentElement;
        for (
            let depth = 0;
            current &&
            depth < 8 &&
            current !== document.body;
            depth += 1
        ) {
            const scored =
                scoreAdapterContainer(
                    current,
                    link
                );
            if (scored) {
                candidates.push({
                    ...scored,
                    depth
                });
            }
            current =
                current.parentElement;
        }
        candidates.sort(
            (left, right) =>
                right.score -
                    left.score ||
                left.depth -
                    right.depth ||
                left.textLength -
                    right.textLength
        );
        return candidates[0] || null;
    }
    function proposeResultAdapter() {
        const links =
            getExternalResultLinks()
                .slice(0, 300);
        const proposals =
            new Map();
        for (const link of links) {
            const result =
                findBestAdapterContainer(
                    link
                );
            if (!result) {
                continue;
            }
            const linkSelector =
                buildElementSelector(
                    link
                );
            if (!linkSelector) {
                continue;
            }
            const key =
                result.selector +
                "\u0000" +
                linkSelector;
            const proposal =
                proposals.get(key) || {
                    resultSelector:
                        result.selector,
                    linkSelector,
                    supportingLinks: 0,
                    resultMatches:
                        result
                            .selectorMatches,
                    score: 0
                };
            proposal.supportingLinks += 1;
            proposal.score +=
                result.score;
            proposals.set(
                key,
                proposal
            );
        }
        const ranked =
            Array.from(
                proposals.values()
            )
                .filter(proposal =>
                    proposal
                        .supportingLinks >=
                        2 &&
                    proposal
                        .resultMatches >=
                        2 &&
                    proposal
                        .resultMatches <=
                        300
                )
                .map(proposal => ({
                    ...proposal,
                    averageScore:
                        proposal.score /
                        proposal
                            .supportingLinks
                }))
                .sort(
                    (left, right) =>
                        right
                            .supportingLinks -
                            left
                                .supportingLinks ||
                        right
                            .averageScore -
                            left
                                .averageScore ||
                        left
                            .resultMatches -
                            right
                                .resultMatches
                );
        return {
            page: {
                hostname:
                    location.hostname,
                pathname:
                    location.pathname,
                url:
                    location.href
            },
            engine,
            candidateLinks:
                links.length,
            proposal:
                ranked[0] || null,
            alternatives:
                ranked.slice(1, 6)
        };
    }
    function clearAdapterPreview() {
        for (
            const element of
            document.querySelectorAll(
                `[${PREVIEW_ATTRIBUTE}]`
            )
        ) {
            element.removeAttribute(
                PREVIEW_ATTRIBUTE
            );
        }
    }
    function previewResultAdapter(
        proposal
    ) {
        clearAdapterPreview();
        if (
            !proposal ||
            typeof proposal
                .resultSelector !==
                "string"
        ) {
            throw new Error(
                "No result selector was supplied."
            );
        }
        let matches;
        try {
            matches =
                Array.from(
                    document
                        .querySelectorAll(
                            proposal
                                .resultSelector
                        )
                );
        } catch {
            throw new Error(
                "The proposed result selector is invalid."
            );
        }
        if (
            matches.length < 2 ||
            matches.length > 300
        ) {
            throw new Error(
                "The proposed selector matched an unsafe number of elements."
            );
        }
        for (const element of matches) {
            if (
                isProtectedContainer(
                    element
                ) ||
                containsProtectedControls(
                    element
                )
            ) {
                clearAdapterPreview();
                throw new Error(
                    "The proposed selector includes a protected page container."
                );
            }
        }
        for (const element of matches) {
            element.setAttribute(
                PREVIEW_ATTRIBUTE,
                "true"
            );
        }
        return {
            matches:
                matches.length,
            resultSelector:
                proposal.resultSelector,
            linkSelector:
                proposal.linkSelector
        };
    }
    function collectResultDiagnostics() {
        const MAX_ELEMENTS = 40;
        const MAX_ANCESTORS = 7;
        const MAX_LINKS = 12;
        const MAX_TEXT_LENGTH = 500;
        const MAX_HTML_LENGTH = 6000;
        function normalizeText(element) {
            return String(
                element &&
                element.textContent
                    ? element.textContent
                    : ""
            )
                .replace(/\s+/g, " ")
                .trim();
        }
        function describeElement(element) {
            if (!element) {
                return null;
            }
            const attributes =
                Object.create(null);
            for (
                const attribute of
                Array.from(
                    element.attributes ||
                        []
                )
            ) {
                if (
                    attribute.name ===
                        "style" ||
                    attribute.name
                        .startsWith("on")
                ) {
                    continue;
                }
                attributes[
                    attribute.name
                ] =
                    String(
                        attribute.value ||
                            ""
                    ).slice(0, 500);
            }
            return {
                tag: element.tagName,
                id: element.id || "",
                className:
                    typeof element
                        .className ===
                        "string"
                        ? element.className
                        : "",
                text:
                    normalizeText(element)
                        .slice(
                            0,
                            MAX_TEXT_LENGTH
                        ),
                attributes,
                outerHTML:
                    String(
                        element.outerHTML ||
                            ""
                    ).slice(
                        0,
                        MAX_HTML_LENGTH
                    )
            };
        }
        function describeLink(link) {
            return {
                text:
                    normalizeText(link)
                        .slice(
                            0,
                            MAX_TEXT_LENGTH
                        ),
                hrefAttribute:
                    link.getAttribute(
                        "href"
                    ),
                resolvedHref:
                    link.href || "",
                dataHref:
                    link.getAttribute(
                        "data-href"
                    ),
                dataUrl:
                    link.getAttribute(
                        "data-url"
                    ),
                dataTarget:
                    link.getAttribute(
                        "data-target"
                    ),
                rel:
                    link.getAttribute(
                        "rel"
                    ),
                className:
                    typeof link.className ===
                        "string"
                        ? link.className
                        : "",
                outerHTML:
                    String(
                        link.outerHTML || ""
                    ).slice(0, 3000)
            };
        }
        const selector = [
            "a[href]",
            "a[data-href]",
            "a[data-url]",
            "h1",
            "h2",
            "h3",
            "h4",
            "article",
            "li",
            "[class*='result' i]",
            "[id*='result' i]",
            "[class*='search' i]"
        ].join(",");
        const elements =
            Array.from(
                document.querySelectorAll(
                    selector
                )
            )
                .filter(element => {
                    if (
                        element.closest(
                            "header, nav, " +
                            "footer, " +
                            "[role='navigation']"
                        )
                    ) {
                        return false;
                    }
                    const text =
                        normalizeText(
                            element
                        );
                    const links =
                        element.matches("a")
                            ? [element]
                            : Array.from(
                                element
                                    .querySelectorAll(
                                        "a"
                                    )
                            );
                    return (
                        text.length >= 3 ||
                        links.some(link =>
                            Boolean(
                                link.getAttribute(
                                    "href"
                                ) ||
                                link.getAttribute(
                                    "data-href"
                                ) ||
                                link.getAttribute(
                                    "data-url"
                                )
                            )
                        )
                    );
                })
                .slice(
                    0,
                    MAX_ELEMENTS
                );
        const report =
            elements.map(element => {
                const ancestors = [];
                let current = element;
                for (
                    let depth = 0;
                    current &&
                    depth <
                        MAX_ANCESTORS &&
                    current !==
                        document
                            .documentElement;
                    depth += 1
                ) {
                    ancestors.push(
                        describeElement(
                            current
                        )
                    );
                    current =
                        current.parentElement;
                }
                const links =
                    Array.from(
                        element.matches("a")
                            ? [element]
                            : element
                                .querySelectorAll(
                                    "a"
                                )
                    )
                        .slice(
                            0,
                            MAX_LINKS
                        )
                        .map(describeLink);
                return {
                    element:
                        describeElement(
                            element
                        ),
                    links,
                    ancestors
                };
            });
        return {
            page: {
                url: location.href,
                hostname:
                    location.hostname,
                pathname:
                    location.pathname,
                title:
                    document.title
            },
            engine,
            capturedAt:
                new Date()
                    .toISOString(),
            report
        };
    }
    async function refreshDynamicAdapters() {
        const before =
            JSON.stringify(
                dynamicAdapters
            );
        const result =
            await loadDynamicAdapters();
        const after =
            JSON.stringify(
                dynamicAdapters
            );
        if (before !== after) {
            decisionCache.clear();
            processedHostnames =
                new WeakMap();
            pendingRoots.clear();
            queueRoot(document);
            scheduleScan();
        }
        return result;
    }
    function installMessageListener() {
        browser.runtime.onMessage
            .addListener(message => {
                if (
                    !message ||
                    typeof message !==
                        "object"
                ) {
                    return undefined;
                }

                if (
                    message.type ===
                    "pingLeanSerpContent"
                ) {
                    return Promise.resolve({
                        ok: true,
                        injected: true,
                        engine,
                        page: {
                            hostname:
                                location.hostname,
                            pathname:
                                location.pathname,
                            url:
                                location.href
                        }
                    });
                }

                if (
                    message.type ===
                    "collectResultDiagnostics"
                ) {
                    try {
                        return Promise.resolve({
                            ok: true,
                            diagnostics:
                                collectResultDiagnostics()
                        });
                    } catch (error) {
                        return Promise.resolve({
                            ok: false,
                            error:
                                error &&
                                error.message
                                    ? error.message
                                    : String(error)
                        });
                    }
                }

                if (
                    message.type ===
                    "proposeResultAdapter"
                ) {
                    try {
                        return Promise.resolve({
                            ok: true,
                            result:
                                proposeResultAdapter()
                        });
                    } catch (error) {
                        return Promise.resolve({
                            ok: false,
                            error:
                                error &&
                                error.message
                                    ? error.message
                                    : String(error)
                        });
                    }
                }

                if (
                    message.type ===
                    "previewResultAdapter"
                ) {
                    try {
                        return Promise.resolve({
                            ok: true,
                            result:
                                previewResultAdapter(
                                    message.proposal
                                )
                        });
                    } catch (error) {
                        return Promise.resolve({
                            ok: false,
                            error:
                                error &&
                                error.message
                                    ? error.message
                                    : String(error)
                        });
                    }
                }

                if (
                    message.type ===
                    "clearResultAdapterPreview"
                ) {
                    clearAdapterPreview();
                    return Promise.resolve({
                        ok: true,
                        result: {
                            cleared: true
                        }
                    });
                }

                if (
                    message.type ===
                    "refreshDynamicAdapters"
                ) {
                    return refreshDynamicAdapters()
                        .then(result => ({
                            ok: result.ok,
                            count:
                                result.count,
                            error:
                                result.error ||
                                ""
                        }));
                }

                if (
                    message.type ===
                    "getLeanSerpHealth"
                ) {
                    return Promise.resolve({
                        ok: true,
                        health: {
                            ...runtimeHealth,
                            engine,
                            visible:
                                pageVisible,
                            observerConnected:
                                observer !== null,
                            pendingRoots:
                                pendingRoots.size,
                            decisionCache:
                                decisionCache.size,
                            url:
                                location.href
                        }
                    });
                }

                if (
                    message.type ===
                    "setDynamicAdapters"
                ) {
                    dynamicAdapters =
                        Array.isArray(
                            message.adapters
                        )
                            ? message.adapters
                                .map(
                                    normalizeDynamicAdapter
                                )
                                .filter(Boolean)
                            : [];
                    runtimeHealth.adapterLoadOk =
                        true;
                    runtimeHealth.adapterCount =
                        dynamicAdapters.length;
                    runtimeHealth.lastError =
                        "";
                    decisionCache.clear();
                    processedHostnames =
                        new WeakMap();
                    pendingRoots.clear();
                    queueRoot(document);
                    scheduleScan();
                    return Promise.resolve({
                        ok: true,
                        count:
                            dynamicAdapters.length
                    });
                }

                return undefined;
            });
    }
    function cleanup() {
        stopped = true;
        disconnectObserver();
        pendingRoots.clear();
        decisionCache.clear();
        clearAdapterPreview();
		 window.removeEventListener(
            "popstate",
            handleLocationChange
        );
        if (scanTimer !== null) {
            window.clearTimeout(
                scanTimer
            );
            scanTimer = null;
        }
    }
    function start() {
        if (stopped) {
            return;
        }
        document.documentElement
            .classList.add(
                "leanserp-disable-animations"
            );
        queueRoot(document);
        scheduleScan();
        connectObserver();
    }



    function installLocationTracking() {
        if (locationTrackingInstalled) {
            return;
        }
        locationTrackingInstalled = true;
        const originalPushState =
            history.pushState;
        const originalReplaceState =
            history.replaceState;
        history.pushState =
            function (...args) {
                const result =
                    originalPushState.apply(
                        this,
                        args
                    );
                queueMicrotask(
                    handleLocationChange
                );
                return result;
            };
        history.replaceState =
            function (...args) {
                const result =
                    originalReplaceState.apply(
                        this,
                        args
                    );
                queueMicrotask(
                    handleLocationChange
                );
                return result;
            };
        window.addEventListener(
            "popstate",
            handleLocationChange
        );
    }

    function handleLocationChange() {
        if (
            stopped ||
            location.href ===
                lastLocationHref
        ) {
            return;
        }
        lastLocationHref =
            location.href;
        engine = detectEngine();
        decisionCache.clear();
        processedHostnames =
            new WeakMap();
        pendingRoots.clear();
        void refreshDynamicAdapters()
            .finally(() => {
                if (
                    engine &&
                    isSearchPage()
                ) {
                    queueRoot(document);
                    scheduleScan();
                    connectObserver();
                } else {
                    disconnectObserver();
                }
            });
    }

    async function initialize() {
        engine = detectEngine();
        installMessageListener();
        installLocationTracking();
        if (
            engine === "google" &&
            redirectGoogleToCleanSearch()
        ) {
            return;
        }
        if (
            !engine ||
            !isSearchPage()
        ) {
            return;
        }
        await loadDynamicAdapters();
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
            if (pageVisible) {
                connectObserver();
                scheduleScan(document);
            } else {
                disconnectObserver();
                if (scanTimer !== null) {
                    window.clearTimeout(
                        scanTimer
                    );
                    scanTimer = null;
                }
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
    void initialize();
})();
