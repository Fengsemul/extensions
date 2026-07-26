"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const ENGINE_CONFIGS = [
  {
    matches(hostname) {
      return hostname.includes("google.");
    },
    resultSelectors: [
      "#search .MjjYud",
      "#search .g",
      "#rso > div[data-hveid]",
      "#botstuff .MjjYud"
    ],
    preferredLinkSelectors: [
      "a[href] h3"
    ],
    unwrapUrl(url) {
      if (
        url.pathname === "/url" &&
        url.hostname.includes("google.")
      ) {
        const target =
          url.searchParams.get("q") ??
          url.searchParams.get("url");

        if (target) {
          try {
            return new URL(target);
          } catch {
            return null;
          }
        }
      }

      return url;
    }
  },
  {
    matches(hostname) {
      return hostname.endsWith("bing.com");
    },
    resultSelectors: [
      "#b_results > li.b_algo"
    ],
    preferredLinkSelectors: [
      "h2 > a[href]"
    ]
  },
  {
    matches(hostname) {
      return hostname.endsWith("duckduckgo.com");
    },
    resultSelectors: [
      "article[data-testid='result']",
      ".react-results--main article",
      ".results_links",
      ".result"
    ],
    preferredLinkSelectors: [
      "a[data-testid='result-title-a']",
      "a.result__a"
    ],
    unwrapUrl(url) {
      if (
        url.hostname.endsWith("duckduckgo.com") &&
        url.pathname === "/l/"
      ) {
        const target = url.searchParams.get("uddg");

        if (target) {
          try {
            return new URL(target);
          } catch {
            return null;
          }
        }
      }

      return url;
    }
  },
  {
    matches(hostname) {
      return hostname === "search.yahoo.com";
    },
    resultSelectors: [
      "#web > ol > li",
      "#web .dd.algo"
    ],
    preferredLinkSelectors: [
      "h3 a[href]"
    ]
  },
  {
    matches(hostname) {
      return hostname.endsWith("startpage.com");
    },
    resultSelectors: [
      ".w-gl__result",
      ".result"
    ],
    preferredLinkSelectors: [
      "a.result-title[href]",
      "h3 a[href]"
    ]
  },
  {
    matches(hostname) {
      return hostname.endsWith("ecosia.org");
    },
    resultSelectors: [
      "article.result",
      ".result"
    ],
    preferredLinkSelectors: [
      "a.result-title[href]",
      "h2 a[href]"
    ]
  },
  {
    matches(hostname) {
      return hostname === "search.brave.com";
    },
    resultSelectors: [
      ".snippet[data-type='web']",
      "[data-type='web']"
    ],
    preferredLinkSelectors: [
      "a[href] h2",
      "a[href] .title"
    ]
  },
  {
    matches(hostname) {
      return (
        hostname.endsWith("yandex.com") ||
        hostname.endsWith("yandex.ru")
      );
    },
    resultSelectors: [
      "li.serp-item",
      ".serp-item"
    ],
    preferredLinkSelectors: [
      "a.Link[href]",
      "h2 a[href]"
    ]
  }
];

const pageHostname = location.hostname.toLowerCase();

const engine = ENGINE_CONFIGS.find((candidate) =>
  candidate.matches(pageHostname)
);

if (engine) {
  initialize().catch((error) => {
    console.error("SERP Domain Index failed:", error);
  });
}

function anchorFromPreferredMatch(result, selector) {
  const match = result.querySelector(selector);

  if (!match) {
    return null;
  }

  if (match instanceof HTMLAnchorElement) {
    return match;
  }

  return match.closest("a[href]");
}

function destinationFromAnchor(anchor) {
  if (!(anchor instanceof HTMLAnchorElement)) {
    return null;
  }

  const rawHref = anchor.getAttribute("href");

  if (
    !rawHref ||
    rawHref.startsWith("#") ||
    rawHref.toLowerCase().startsWith("javascript:")
  ) {
    return null;
  }

  let url;

  try {
    url = new URL(rawHref, location.href);
  } catch {
    return null;
  }

  if (typeof engine.unwrapUrl === "function") {
    url = engine.unwrapUrl(url);
  }

  if (
    !url ||
    (url.protocol !== "http:" &&
      url.protocol !== "https:")
  ) {
    return null;
  }

  if (
    url.hostname.toLowerCase() ===
    location.hostname.toLowerCase()
  ) {
    return null;
  }

  return url;
}

function primaryDestination(result) {
  for (
    const selector of
      engine.preferredLinkSelectors ?? []
  ) {
    const anchor = anchorFromPreferredMatch(
      result,
      selector
    );

    const destination = destinationFromAnchor(anchor);

    if (destination) {
      return destination;
    }
  }

  for (const anchor of result.querySelectorAll("a[href]")) {
    const destination = destinationFromAnchor(anchor);

    if (destination) {
      return destination;
    }
  }

  return null;
}

function setResultHidden(result, hidden) {
  if (!(result instanceof HTMLElement)) {
    return;
  }

  if (hidden) {
    result.style.setProperty(
      "display",
      "none",
      "important"
    );
    result.dataset.serpDomainIndexHidden = "1";
    return;
  }

  if (result.dataset.serpDomainIndexHidden === "1") {
    result.style.removeProperty("display");
    delete result.dataset.serpDomainIndexHidden;
  }
}

function collectResults(root, selector, output) {
  if (
    root instanceof Element &&
    root.matches(selector)
  ) {
    output.add(root);
  }

  if (
    root instanceof Document ||
    root instanceof Element
  ) {
    for (
      const result of root.querySelectorAll(selector)
    ) {
      output.add(result);
    }
  }
}

async function initialize() {
  const resultSelector =
    engine.resultSelectors.join(",");

  const pendingResults = new Set();
  const hostnameCache = new Map();

  let scheduled = false;
  let lookupGeneration = 0;

  async function flushPendingResults() {
    scheduled = false;

    const results = Array.from(pendingResults);
    pendingResults.clear();

    const resultToHostname = new Map();
    const unresolvedHostnames = [];

    for (const result of results) {
      if (!result.isConnected) {
        continue;
      }

      const destination = primaryDestination(result);

      const hostname = destination
        ? destination.hostname
            .toLowerCase()
            .replace(/\.$/, "")
        : "";

      resultToHostname.set(result, hostname);

      if (!hostname) {
        setResultHidden(result, false);
        continue;
      }

      const cached = hostnameCache.get(hostname);

      if (cached !== undefined) {
        setResultHidden(result, cached);
      } else {
        unresolvedHostnames.push(hostname);
      }
    }

    const uniqueHostnames = Array.from(
      new Set(unresolvedHostnames)
    );

    if (uniqueHostnames.length === 0) {
      return;
    }

    const localGeneration = lookupGeneration;

    for (
      let start = 0;
      start < uniqueHostnames.length;
      start += 256
    ) {
      const hostnameBatch = uniqueHostnames.slice(
        start,
        start + 256
      );

      let response;

      try {
        response = await api.runtime.sendMessage({
          type: "lookup",
          hostnames: hostnameBatch
        });
      } catch (error) {
        console.error(
          "SERP Domain Index lookup failed:",
          error
        );
        return;
      }

      if (localGeneration !== lookupGeneration) {
        return;
      }

      const blockedResults = Array.isArray(
        response?.blocked
      )
        ? response.blocked
        : [];

      for (
        let index = 0;
        index < hostnameBatch.length;
        index++
      ) {
        hostnameCache.set(
          hostnameBatch[index],
          blockedResults[index] === true
        );
      }
    }

    for (
      const [result, hostname] of resultToHostname
    ) {
      if (
        result.isConnected &&
        hostname &&
        hostnameCache.has(hostname)
      ) {
        setResultHidden(
          result,
          hostnameCache.get(hostname)
        );
      }
    }
  }

  function scheduleResultsFromRoot(root) {
    collectResults(
      root,
      resultSelector,
      pendingResults
    );

    if (
      pendingResults.size > 0 &&
      !scheduled
    ) {
      scheduled = true;

      requestAnimationFrame(() => {
        flushPendingResults().catch((error) => {
          console.error(
            "SERP Domain Index processing failed:",
            error
          );
        });
      });
    }
  }

  function invalidateCacheAndRescan() {
    lookupGeneration++;
    hostnameCache.clear();
    scheduleResultsFromRoot(document);
  }

  scheduleResultsFromRoot(document);

  const observer = new MutationObserver(
    (mutationRecords) => {
      for (const record of mutationRecords) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            scheduleResultsFromRoot(node);
          }
        }
      }
    }
  );

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  api.runtime.onMessage.addListener((message) => {
    if (
      message?.type !== "filter-state-changed"
    ) {
      return undefined;
    }

    invalidateCacheAndRescan();
    return undefined;
  });
}
