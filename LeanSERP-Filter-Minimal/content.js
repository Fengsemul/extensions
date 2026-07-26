"use strict";
(() => {
    const MAX_HOSTS_PER_REQUEST = 64;
    const MAX_PENDING_ROOTS = 128;
    const MAX_CANDIDATES_PER_SCAN = 256;
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
            hostname === "secretsearchenginelabs.com" ||
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

    const pendingRoots = new Set();
    const processedLinks = new WeakSet();
    const processedContainers = new WeakSet();

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
            const [
                name,
                matcher
            ] of Object.entries(ENGINE_MATCHERS)
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

    function requiresHeading() {
        return (
            engine === "google" ||
            engine === "bing" ||
            engine === "duckduckgo" ||
            engine === "brave"
        );
    }

    function getResultContainer(link) {
        const selectors =
            RESULT_SELECTORS[engine] || [];

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
            current && depth < 7;
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
                        current.textContent || ""
                    ).trim().length >= 40
                )
            ) {
                return current;
            }

            current = current.parentElement;
        }

        return link.parentElement;
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
        const seenContainers = new Set();

        for (
            const link of
            root.querySelectorAll("a[href]")
        ) {
            if (
                candidates.length >=
                MAX_CANDIDATES_PER_SCAN
            ) {
                break;
            }

            if (
                processedLinks.has(link) ||
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
                getResultContainer(link);

            if (
                !container ||
                seenContainers.has(container) ||
                processedContainers.has(container)
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
                    container.textContent || ""
                ).trim().length < 20
            ) {
                continue;
            }

            processedLinks.add(link);
            seenContainers.add(container);

            candidates.push({
                hostname,
                container
            });
        }

        return candidates;
    }

    function deleteBlockedResult(
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

        container.remove();
    }

    async function processCandidates(
        candidates
    ) {
        for (
            let offset = 0;
            offset < candidates.length;
            offset += MAX_HOSTS_PER_REQUEST
        ) {
            const batch = candidates.slice(
                offset,
                offset +
                    MAX_HOSTS_PER_REQUEST
            );

            const hostnames = Array.from(
                new Set(
                    batch.map(
                        item => item.hostname
                    )
                )
            );

            let response;

            try {
                response =
                    await browser.runtime.sendMessage({
                        type: "confirmHostnames",
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

                processedContainers.add(
                    candidate.container
                );

                if (
                    decision &&
                    decision.blocked
                ) {
                    deleteBlockedResult(
                        candidate,
                        decision
                    );
                }
            }
        }
    }

    function queueRoot(root) {
        if (
            !root ||
            pendingRoots.size >=
                MAX_PENDING_ROOTS
        ) {
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

                const roots = Array.from(
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

        if (scanTimer !== null) {
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
            !pageVisible
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

    window.addEventListener(
        "beforeunload",
        cleanup,
        {
            once: true
        }
    );

    initialize();
})();
