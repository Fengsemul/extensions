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
    function getRule() {
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
        return undefined;
    }
);
    initialize();
})();
