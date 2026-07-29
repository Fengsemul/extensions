"use strict";
(() => {
    const MAX_HOSTS_PER_REQUEST = 64;
    const MAX_PENDING_ROOTS = 128;
    const MAX_CANDIDATES_PER_SCAN = 256;
    const MAX_DECISION_CACHE_ENTRIES = 5000;
    const SCAN_DELAY_MS = 120;
    const ENGINE_MATCHERS = Object.freeze({
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
            hostname.endsWith(".slsearch.eu.org"),
        searchthis: hostname =>
            hostname === "searchthis.ch" ||
            hostname.endsWith(".searchthis.ch"),
        degoog: hostname =>
            hostname === "degoog.org" ||
            hostname.endsWith(".degoog.org")
    });
    const ENGINE_RULES = Object.freeze({
        google: Object.freeze({
            roots: [
                "div.MjjYud",
                "div.g"
            ],
            links: [
                "a[href] h3"
            ],
            navigationExclusions: [
                "nav",
                "[role='navigation']",
                "#botstuff",
                "#foot"
            ],
            allowGenericRoot: false
        }),
        bing: Object.freeze({
            roots: [
                "li.b_algo",
                "li.b_ans",
                "div.b_algo",
                ".b_results > li"
            ],
            links: [
                "h2 a[href]",
                "h3 a[href]",
                "a.tilk[href]"
            ],
            navigationExclusions: [
                "nav",
                "[role='navigation']",
                ".b_pag",
                ".sb_pagF",
                "#b_footer"
            ],
            allowGenericRoot: false
        }),
        duckduckgo: Object.freeze({
            roots: [
                "article[data-testid='result']",
                ".result.results_links",
                ".result",
                ".web-result",
                "tr.result-link",
                "tr.result-snippet"
            ],
            links: [
                "h2 a[href]",
                "h3 a[href]",
                "a[data-testid='result-title-a']",
                "a.result__a[href]",
                "a.result-link[href]"
            ],
            navigationExclusions: [
                "nav",
                "[role='navigation']",
                ".nav-link",
                ".navbutton",
                ".next",
                ".previous",
                ".pagination",
                "form"
            ],
            allowGenericRoot: false
        }),
        brave: Object.freeze({
            roots: [
                ".snippet",
                ".search-result",
                "[data-type='web']",
                "[data-testid='web-result']"
            ],
            links: [
                "h2 a[href]",
                "h3 a[href]",
                "a[href][data-testid='result-title']",
                ".title a[href]"
            ],
            navigationExclusions: [
                "nav",
                "[role='navigation']",
                ".pagination",
                "footer"
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
            navigationExclusions: [
                "nav",
                ".pagination",
                "form",
                "footer"
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
                "h2 a[href]",
                "h3 a[href]",
                ".title a[href]"
            ],
            navigationExclusions: [
                "nav",
                ".pagination",
                "form",
                "footer"
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
                "h2 a[href]",
                "h3 a[href]",
                ".title a[href]",
                ".result-title a[href]"
            ],
            navigationExclusions: [
                "header",
                "nav",
                "main > form",
                ".pagination",
                "footer"
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
                "h2 a[href]",
                "h3 a[href]",
                ".title a[href]"
            ],
            navigationExclusions: [
                "nav",
                ".pagination",
                "form",
                "footer"
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
                "h2 a[href]",
                "h3 a[href]",
                ".title a[href]"
            ],
            navigationExclusions: [
                "nav",
                ".pagination",
                "form",
                "footer"
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
                "h2 a[href]",
                "h3 a[href]",
                ".title a[href]"
            ],
            navigationExclusions: [
                "nav",
                ".pagination",
                "form",
                "footer"
            ],
            allowGenericRoot: true
        }),
        degoog: Object.freeze({
            roots: [
                ".result",
                ".search-result",
                ".result-item"
            ],
            links: [
				"a.result-title.degoog-result--title[href]",
				"h2 a[href]",
				"h3 a[href]",
				".title a[href]"
			],
            navigationExclusions: [
                "nav",
                ".pagination",
                "form",
                "footer"
            ],
            allowGenericRoot: true
        })
    });
    const pendingRoots = new Set();
    const processedElements = new WeakMap();
    const decisionCache = new Map();
    let engine = "";
    let observer = null;
    let scanTimer = null;
    let scanRunning = false;
    let rescanRequested = false;
    let pageVisible = !document.hidden;
    let stopped = false;
	let dynamicAdapters = [];
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
            return location.pathname === "/search";
        }
        if (engine === "duckduckgo") {
            return (
                location.pathname === "/" ||
                location.pathname === "/html/" ||
                location.pathname === "/lite/"
            );
        }
        if (engine === "brave") {
            return location.pathname.startsWith(
                "/search"
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
    function decodeRedirect(href) {
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
            return href;
        }
    }
    function getHostname(link) {
        const href =
            link.getAttribute("href");
        if (!href) {
            return "";
        }
        try {
            const url = new URL(
                decodeRedirect(href),
                location.href
            );
            if (
                url.protocol !== "http:" &&
                url.protocol !== "https:"
            ) {
                return "";
            }
            const hostname = url.hostname
                .trim()
                .toLowerCase()
                .replace(/^\.+|\.+$/g, "");
            if (
                hostname.length === 0 ||
                hostname.length > 253 ||
                !hostname.includes(".") ||
                hostname ===
                    location.hostname.toLowerCase()
            ) {
                return "";
            }
            return hostname;
        } catch {
            return "";
        }
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

function getDynamicRule() {
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
            ).toLowerCase() !== hostname
        ) {
            continue;
        }
        if (!pathMatchesAdapter(adapter)) {
            continue;
        }
        return {
            roots: [
                String(
                    adapter.resultSelector || ""
                )
            ].filter(Boolean),
            links: [
                String(
                    adapter.linkSelector || ""
                )
            ].filter(Boolean),
            navigationExclusions: [
                "header",
                "nav",
                "footer",
                "form",
                "[role='navigation']",
                ".pagination"
            ],
            allowGenericRoot: false
        };
    }
    return null;
}
function getRule() {
    const dynamicRule =
        getDynamicRule();
    if (dynamicRule) {
        return dynamicRule;
    }
    return ENGINE_RULES[engine] || null;
}
    function isExcluded(link, rule) {
        for (
            const selector of
            rule.navigationExclusions
        ) {
            if (link.closest(selector)) {
                return true;
            }
        }
        return false;
    }
    function getCandidateLinks(root, rule) {
        const links = [];
        const seen = new Set();
        for (const selector of rule.links) {
            let matches;
            try {
                matches =
                    root.querySelectorAll(selector);
            } catch {
                continue;
            }
            for (const match of matches) {
                const link =
                    match.matches("a[href]")
                        ? match
                        : match.closest("a[href]");
                if (
                    !link ||
                    seen.has(link)
                ) {
                    continue;
                }
                seen.add(link);
                links.push(link);
                if (
                    links.length >=
                    MAX_CANDIDATES_PER_SCAN
                ) {
                    return links;
                }
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
    function getWibyContainer(link) {
        if (!link.matches("a.tlink")) {
            return null;
        }
        let current = link.parentElement;
        for (
            let depth = 0;
            current &&
            depth < 5 &&
            current !== document.body;
            depth += 1
        ) {
            const text =
                String(
                    current.textContent || ""
                )
                    .replace(/\s+/g, " ")
                    .trim();
            const resultLinkCount =
                current.querySelectorAll(
                    "a.tlink"
                ).length;
            if (
                resultLinkCount === 1 &&
                text.length >= 20
            ) {
                return current;
            }
            current = current.parentElement;
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
        let current = link.parentElement;
        for (
            let depth = 0;
            current &&
            depth < 5 &&
            current !== document.body &&
            current !== document.documentElement;
            depth += 1
        ) {
            if (
                current.matches(
                    "header, nav, footer, main, form"
                )
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
                        "a[href]"
                    )
                ).filter(
                    candidate =>
                        getHostname(candidate)
                ).length;
            if (
                text.length >= 20 &&
                text.length <= 5000 &&
                externalLinks >= 1 &&
                externalLinks <= 5
            ) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }
    function getResultContainer(
        link,
        rule
    ) {
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
    function isSafeContainer(
        container,
        link
    ) {
        if (
            !container ||
            container === document.body ||
            container ===
                document.documentElement ||
            container.matches(
                "html, body, main, header, nav, footer, form"
            )
        ) {
            return false;
        }
        if (
            container.contains(
                document.querySelector(
                    "form[role='search']"
                )
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
            text.length > 10000
        ) {
            return false;
        }
        const resultRule = getRule();
        const candidateLinks =
            getCandidateLinks(
                container,
                resultRule
            );
        if (
            candidateLinks.length > 8 &&
            !container.matches(
                resultRule.roots.join(",")
            )
        ) {
            return false;
        }
        return container.contains(link);
    }
    function hasProcessedHostname(
        container,
        hostname
    ) {
        return (
            processedElements.get(container) ===
            hostname
        );
    }
    function markProcessed(
        container,
        hostname
    ) {
        processedElements.set(
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
                link.closest("[data-leanserp-ui]")
            ) {
                continue;
            }
            const hostname =
                getHostname(link);
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
                seenContainers.has(container) ||
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
    function deleteBlockedResult(
        candidate
    ) {
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
        markProcessed(
            candidate.container,
            candidate.hostname
        );
        if (
            decision &&
            decision.blocked
        ) {
            deleteBlockedResult(candidate);
        }
    }
    async function requestDecisions(
        candidates
    ) {
        const hostnames = Array.from(
            new Set(
                candidates.map(
                    item => item.hostname
                )
            )
        );
        const response =
            await browser.runtime.sendMessage({
                type: "confirmHostnames",
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
                decisionCache.get(
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
                    await requestDecisions(batch);
            } catch {
                continue;
            }
            for (const candidate of batch) {
                const decision =
                    decisions[
                        candidate.hostname
                    ] || {
                        blocked: false,
                        matchedRule: "",
                        matchedType: ""
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
                        candidates.push(candidate);
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
        scanTimer = window.setTimeout(
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
    function cleanup() {
        stopped = true;
        disconnectObserver();
        pendingRoots.clear();
        decisionCache.clear();
        if (scanTimer !== null) {
            window.clearTimeout(scanTimer);
            scanTimer = null;
        }
    }
    function start() {
        if (stopped) {
            return;
        }
        document.documentElement.classList.add(
            "leanserp-disable-animations"
        );
        queueRoot(document);
        scheduleScan();
        connectObserver();
    }
    function initialize() {
        engine = detectEngine();
        if (
            !engine ||
            !isSearchPage()
        ) {
            return;
        }
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
            pageVisible = !document.hidden;
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
	function proposeResultAdapter() {
    const MAX_LINKS = 300;
    const MAX_DEPTH = 8;
    const MAX_SELECTOR_MATCHES = 300;
    const FORBIDDEN_TAGS = new Set([
        "HTML",
        "BODY",
        "MAIN",
        "HEADER",
        "NAV",
        "FOOTER",
        "FORM"
    ]);
    function normalizeClassList(element) {
        return Array.from(
            element.classList || []
        ).filter(
            name =>
                /^[a-zA-Z_-][a-zA-Z0-9_-]*$/
                    .test(name)
        );
    }
    function escapeIdentifier(value) {
        if (
            globalThis.CSS &&
            typeof CSS.escape === "function"
        ) {
            return CSS.escape(value);
        }
        return String(value)
            .replace(
                /[^a-zA-Z0-9_-]/g,
                character =>
                    "\\" + character
            );
    }
    function createSelector(element) {
        if (
            !element ||
            FORBIDDEN_TAGS.has(
                element.tagName
            )
        ) {
            return "";
        }
        if (element.id) {
            const selector =
                "#" + escapeIdentifier(
                    element.id
                );
            try {
                if (
                    document.querySelectorAll(
                        selector
                    ).length === 1
                ) {
                    return selector;
                }
            } catch {
            }
        }
        const classes =
            normalizeClassList(element)
                .slice(0, 3);
        if (classes.length === 0) {
            return "";
        }
        return (
            element.tagName.toLowerCase() +
            classes.map(
                name =>
                    "." +
                    escapeIdentifier(name)
            ).join("")
        );
    }
    function extractDestination(link) {
        const values = [
            link.getAttribute("href"),
            link.getAttribute("data-href"),
            link.getAttribute("data-url"),
            link.getAttribute("data-target")
        ];
        for (const value of values) {
            if (!value) {
                continue;
            }
            try {
                const decoded =
                    decodeRedirect(value);
                const url = new URL(
                    decoded,
                    location.href
                );
                if (
                    (
                        url.protocol === "http:" ||
                        url.protocol === "https:"
                    ) &&
                    url.hostname !==
                        location.hostname
                ) {
                    return url.href;
                }
            } catch {
            }
        }
        return "";
    }
    function isNavigationLink(link) {
        return Boolean(
            link.closest(
                "header, nav, footer, form, " +
                "[role='navigation'], " +
                ".pagination, .pager, .pages"
            )
        );
    }
    function isSafeContainer(
        container,
        link
    ) {
        if (
            !container ||
            FORBIDDEN_TAGS.has(
                container.tagName
            ) ||
            !container.contains(link)
        ) {
            return false;
        }
        if (
            container.querySelector(
                "form[role='search'], " +
                "input[type='search']"
            )
        ) {
            return false;
        }
        const text = String(
            container.textContent || ""
        )
            .replace(/\s+/g, " ")
            .trim();
        if (
            text.length < 10 ||
            text.length > 8000
        ) {
            return false;
        }
        const externalLinks =
            Array.from(
                container.querySelectorAll(
                    "a[href], " +
                    "a[data-href], " +
                    "a[data-url]"
                )
            ).filter(
                candidate =>
                    Boolean(
                        extractDestination(
                            candidate
                        )
                    )
            );
        return (
            externalLinks.length >= 1 &&
            externalLinks.length <= 8
        );
    }
    function describeLinkSelector(link) {
        const classes =
            normalizeClassList(link)
                .slice(0, 3);
        if (classes.length > 0) {
            return (
                "a" +
                classes.map(
                    name =>
                        "." +
                        escapeIdentifier(name)
                ).join("") +
                "[href]"
            );
        }
        const parent = link.parentElement;
        if (
            parent &&
            /^H[1-4]$/.test(
                parent.tagName
            )
        ) {
            return (
                parent.tagName.toLowerCase() +
                " a[href]"
            );
        }
        return "a[href]";
    }
    const links = Array.from(
        document.querySelectorAll(
            "a[href], " +
            "a[data-href], " +
            "a[data-url]"
        )
    )
        .filter(
            link =>
                !isNavigationLink(link) &&
                Boolean(
                    extractDestination(link)
                )
        )
        .slice(0, MAX_LINKS);
    const selectorStats = new Map();
    for (const link of links) {
        const linkSelector =
            describeLinkSelector(link);
        let current =
            link.parentElement;
        for (
            let depth = 0;
            current &&
            depth < MAX_DEPTH;
            depth += 1
        ) {
            if (
                FORBIDDEN_TAGS.has(
                    current.tagName
                )
            ) {
                break;
            }
            const resultSelector =
                createSelector(current);
            if (
                resultSelector &&
                isSafeContainer(
                    current,
                    link
                )
            ) {
                const key =
                    resultSelector +
                    "\n" +
                    linkSelector;
                let record =
                    selectorStats.get(key);
                if (!record) {
                    record = {
                        resultSelector,
                        linkSelector,
                        urlSources: [
                            "href",
                            "data-href",
                            "data-url",
                            "data-target"
                        ],
                        containers:
                            new Set(),
                        destinations:
                            new Set(),
                        depths: []
                    };
                    selectorStats.set(
                        key,
                        record
                    );
                }
                record.containers.add(
                    current
                );
                record.destinations.add(
                    extractDestination(
                        link
                    )
                );
                record.depths.push(depth);
            }
            current =
                current.parentElement;
        }
    }
    const proposals = [];
    for (
        const record of
        selectorStats.values()
    ) {
        let selectorMatches = 0;
        try {
            selectorMatches =
                document.querySelectorAll(
                    record.resultSelector
                ).length;
        } catch {
            continue;
        }
        const containerCount =
            record.containers.size;
        const destinationCount =
            record.destinations.size;
        if (
            containerCount < 2 ||
            selectorMatches < 2 ||
            selectorMatches >
                MAX_SELECTOR_MATCHES
        ) {
            continue;
        }
        const coverage =
            selectorMatches > 0
                ? containerCount /
                    selectorMatches
                : 0;
        const averageDepth =
            record.depths.reduce(
                (sum, value) =>
                    sum + value,
                0
            ) /
            record.depths.length;
        const score =
            containerCount * 20 +
            destinationCount * 10 +
            coverage * 40 -
            averageDepth * 3 -
            Math.max(
                0,
                selectorMatches -
                    containerCount
            );
        proposals.push({
            hostname:
                location.hostname,
            pathPattern:
                "^" +
                location.pathname
                    .replace(
                        /[.*+?^${}()|[\]\\]/g,
                        "\\$&"
                    ) +
                "$",
            resultSelector:
                record.resultSelector,
            linkSelector:
                record.linkSelector,
            urlSources:
                record.urlSources,
            containerCount,
            selectorMatches,
            destinationCount,
            coverage:
                Number(
                    coverage.toFixed(3)
                ),
            averageDepth:
                Number(
                    averageDepth.toFixed(2)
                ),
            score:
                Number(
                    score.toFixed(2)
                )
        });
    }
    proposals.sort(
        (left, right) =>
            right.score - left.score
    );
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
        proposals:
            proposals.slice(0, 20)
    };
}
const ADAPTER_PREVIEW_ATTRIBUTE =
    "data-leanserp-adapter-preview";

function escapeCssIdentifier(value) {
    const text = String(value || "");
    if (
        globalThis.CSS &&
        typeof CSS.escape === "function"
    ) {
        return CSS.escape(text);
    }
    return text.replace(
        /[^a-zA-Z0-9_-]/g,
        character =>
            `\\${character.codePointAt(0)
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
        element.tagName.toLowerCase();

    if (element.id) {
        return (
            tag +
            "#" +
            escapeCssIdentifier(
                element.id
            )
        );
    }

    const classes = Array.from(
        element.classList
    )
        .filter(className =>
            /^[a-zA-Z_][a-zA-Z0-9_-]*$/
                .test(className)
        )
        .slice(0, 4);

    if (classes.length > 0) {
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

    return tag;
}

function isForbiddenAdapterContainer(
    element
) {
    return (
        !element ||
        element === document.body ||
        element ===
            document.documentElement ||
        element.matches(
            "html, body, main, header, " +
            "nav, footer, form, " +
            "[role='navigation'], " +
            "[role='search']"
        )
    );
}

function getExternalResultLinks() {
    const pageHostname =
        location.hostname.toLowerCase();

    return Array.from(
        document.querySelectorAll(
            "a[href], " +
            "a[data-href], " +
            "a[data-url]"
        )
    ).filter(link => {
        if (
            link.closest(
                "header, nav, footer, " +
                "form, [role='navigation']"
            )
        ) {
            return false;
        }

        const hostname =
            getHostname(link);

        return (
            hostname &&
            hostname !== pageHostname
        );
    });
}

function scoreContainer(
    container,
    link
) {
    if (
        isForbiddenAdapterContainer(
            container
        ) ||
        !container.contains(link)
    ) {
        return null;
    }

    const text = String(
        container.textContent || ""
    )
        .replace(/\s+/g, " ")
        .trim();

    if (
        text.length < 15 ||
        text.length > 6000
    ) {
        return null;
    }

    const allLinks = Array.from(
        container.querySelectorAll(
            "a[href], " +
            "a[data-href], " +
            "a[data-url]"
        )
    );

    const externalLinks =
        allLinks.filter(candidate =>
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

    const containsSearchForm =
        Boolean(
            container.querySelector(
                "form, " +
                "[role='search'], " +
                "input[type='search']"
            )
        );

    if (containsSearchForm) {
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
        externalLinks:
            externalLinks.length,
        textLength: text.length,
        score
    };
}

function findBestContainerForLink(
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
            scoreContainer(
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
            right.score - left.score ||
            left.depth - right.depth ||
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
            findBestContainerForLink(
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

        const existing =
            proposals.get(key) || {
                resultSelector:
                    result.selector,
                linkSelector,
                supportingLinks: 0,
                resultMatches:
                    result.selectorMatches,
                score: 0
            };

        existing.supportingLinks += 1;
        existing.score +=
            result.score;

        proposals.set(
            key,
            existing
        );
    }

    const ranked =
        Array.from(
            proposals.values()
        )
            .filter(proposal =>
                proposal.supportingLinks >=
                    2 &&
                proposal.resultMatches >=
                    2 &&
                proposal.resultMatches <=
                    300
            )
            .map(proposal => ({
                ...proposal,
                averageScore:
                    proposal.score /
                    proposal.supportingLinks
            }))
            .sort(
                (left, right) =>
                    right.supportingLinks -
                        left.supportingLinks ||
                    right.averageScore -
                        left.averageScore ||
                    left.resultMatches -
                        right.resultMatches
            );

    const best = ranked[0] || null;

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
        proposal: best,
        alternatives:
            ranked.slice(1, 6)
    };
}

function clearAdapterPreview() {
    for (
        const element of
        document.querySelectorAll(
            `[${ADAPTER_PREVIEW_ATTRIBUTE}]`
        )
    ) {
        element.removeAttribute(
            ADAPTER_PREVIEW_ATTRIBUTE
        );
    }
}

function previewResultAdapter(
    proposal
) {
    clearAdapterPreview();

    if (
        !proposal ||
        typeof proposal.resultSelector !==
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
                document.querySelectorAll(
                    proposal.resultSelector
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
            isForbiddenAdapterContainer(
                element
            ) ||
            element.querySelector(
                "form, [role='search'], " +
                "input[type='search']"
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
            ADAPTER_PREVIEW_ATTRIBUTE,
            "true"
        );
    }

    return {
        matches: matches.length,
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
            element && element.textContent
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

        const attributes = Object.create(null);

        for (
            const attribute of
            Array.from(element.attributes || [])
        ) {
            if (
                attribute.name === "style" ||
                attribute.name.startsWith("on")
            ) {
                continue;
            }

            attributes[attribute.name] =
                String(attribute.value || "")
                    .slice(0, 500);
        }

        return {
            tag: element.tagName,
            id: element.id || "",
            className:
                typeof element.className === "string"
                    ? element.className
                    : "",
            text:
                normalizeText(element)
                    .slice(0, MAX_TEXT_LENGTH),
            attributes,
            outerHTML:
                String(element.outerHTML || "")
                    .slice(0, MAX_HTML_LENGTH)
        };
    }

    function describeLink(link) {
        return {
            text:
                normalizeText(link)
                    .slice(0, MAX_TEXT_LENGTH),
            hrefAttribute:
                link.getAttribute("href"),
            resolvedHref:
                link.href || "",
            dataHref:
                link.getAttribute("data-href"),
            dataUrl:
                link.getAttribute("data-url"),
            dataTarget:
                link.getAttribute("data-target"),
            rel:
                link.getAttribute("rel"),
            className:
                typeof link.className === "string"
                    ? link.className
                    : "",
            outerHTML:
                String(link.outerHTML || "")
                    .slice(0, 3000)
        };
    }

    const selectors = [
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

    const elements = Array.from(
        document.querySelectorAll(selectors)
    )
        .filter(element => {
            if (
                element.closest(
                    "header, nav, footer, " +
                    "[role='navigation']"
                )
            ) {
                return false;
            }

            const text =
                normalizeText(element);

            const links =
                element.matches("a")
                    ? [element]
                    : Array.from(
                        element.querySelectorAll("a")
                    );

            return (
                text.length >= 3 ||
                links.some(link =>
                    Boolean(
                        link.getAttribute("href") ||
                        link.getAttribute("data-href") ||
                        link.getAttribute("data-url")
                    )
                )
            );
        })
        .slice(0, MAX_ELEMENTS);

    const report = elements.map(element => {
        const ancestors = [];
        let current = element;

        for (
            let depth = 0;
            current &&
            depth < MAX_ANCESTORS &&
            current !== document.documentElement;
            depth += 1
        ) {
            ancestors.push(
                describeElement(current)
            );
            current = current.parentElement;
        }

        const links = Array.from(
            element.matches("a")
                ? [element]
                : element.querySelectorAll("a")
        )
            .slice(0, MAX_LINKS)
            .map(describeLink);

        return {
            element: describeElement(element),
            links,
            ancestors
        };
    });

    return {
        page: {
            url: location.href,
            hostname: location.hostname,
            pathname: location.pathname,
            title: document.title
        },
        engine,
        capturedAt:
            new Date().toISOString(),
        report
    };
}

browser.runtime.onMessage.addListener(
    message => {
        if (
            !message ||
            typeof message !== "object"
        ) {
            return undefined;
        }
        if (
            message.type ===
            "pingLeanSerpContent"
        ) {
			if (
    message.type ===
    "proposeResultAdapter"
) {
    try {
        return Promise.resolve({
            ok: true,
            proposal:
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
    "proposeResultAdapter"
) {
    try {
        const result =
            proposeResultAdapter();
        return Promise.resolve({
            ok: true,
            result
        });
    } catch (error) {
        return Promise.resolve({
            ok: false,
            error:
                error && error.message
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
        const result =
            previewResultAdapter(
                message.proposal
            );
        return Promise.resolve({
            ok: true,
            result
        });
    } catch (error) {
        return Promise.resolve({
            ok: false,
            error:
                error && error.message
                    ? error.message
                    : String(error)
        });
    }
}
if (
    message.type ===
    "clearResultAdapterPreview"
) {
    try {
        clearAdapterPreview();
        return Promise.resolve({
            ok: true,
            result: {
                cleared: true
            }
        });
    } catch (error) {
        return Promise.resolve({
            ok: false,
            error:
                error && error.message
                    ? error.message
                    : String(error)
        });
    }
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
    "setDynamicAdapters"
) {
    dynamicAdapters = Array.isArray(
        message.adapters
    )
        ? message.adapters
        : [];
    return Promise.resolve({
        ok: true,
        count:
            dynamicAdapters.length
    });
}
        return undefined;
    }
);
async function loadDynamicAdapters() {
    try {
        const response =
            await browser.runtime.sendMessage({
                type:
                    "getAdaptersForLocation",
                url: location.href
            });
        if (
            response &&
            response.ok &&
            Array.isArray(
                response.adapters
            )
        ) {
            dynamicAdapters =
                response.adapters;
        } else {
            dynamicAdapters = [];
        }
    } catch {
        dynamicAdapters = [];
    }
}
async function initialize() {
    engine = detectEngine();
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
    void initialize();
})();
