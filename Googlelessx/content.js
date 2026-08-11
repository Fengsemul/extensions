(() => {
  "use strict";

  const OVERLAY_ID = "googless-container";

  const DEFAULT_SETTINGS = {
    enabled: true
  };

  const SERVICE_DATA = {
    google: {
      id: "google",
      name: "Google Website",
      icon: "icons/googless.svg",
      description: "This webpage is hosted on a Google-owned domain.",
      info_url: "[policies.google.com](https://policies.google.com/privacy)"
    },
    gstatic: {
      id: "gstatic",
      name: "Google Static Resources",
      icon: "icons/googless.svg",
      description:
        "This webpage loads resources from Google's static-content infrastructure.",
      info_url: "[policies.google.com](https://policies.google.com/privacy)"
    },
    gfonts: {
      id: "gfonts",
      name: "Google Fonts",
      icon: "icons/fonts.svg",
      description:
        "This webpage loads fonts or related resources from Google Fonts.",
      info_url: "[fonts.google.com](https://fonts.google.com/about)"
    },
    gmaps: {
      id: "gmaps",
      name: "Google Maps",
      icon: "icons/locations.svg",
      description: "This webpage embeds or loads Google Maps resources.",
      info_url: "[google.com](https://www.google.com/maps)"
    },
    ga: {
      id: "ga",
      name: "Google Analytics and Tag Manager",
      icon: "icons/analytics.svg",
      description:
        "This webpage appears to load Google Analytics or Google Tag Manager.",
      info_url: "[marketingplatform.google.com](https://marketingplatform.google.com/about/analytics/)"
    },
    gsi: {
      id: "gsi",
      name: "Google Identity Services",
      icon: "icons/gsi.svg",
      description: "This webpage loads Google sign-in or account services.",
      info_url: "[developers.google.com](https://developers.google.com/identity)"
    },
    recaptcha: {
      id: "recaptcha",
      name: "Google reCAPTCHA",
      icon: "icons/recaptcha.svg",
      description: "This webpage uses Google's reCAPTCHA service.",
      info_url: "[google.com](https://www.google.com/recaptcha/about/)"
    },
    gse: {
      id: "gse",
      name: "Google Search",
      icon: "icons/search.svg",
      description: "This webpage embeds Google programmable search.",
      info_url: "[programmablesearchengine.google.com](https://programmablesearchengine.google.com/about/)"
    },
    youtube: {
      id: "youtube",
      name: "YouTube",
      icon: "icons/youtube.svg",
      description: "This webpage embeds content hosted by YouTube.",
      info_url:
        "[youtube.com](https://www.youtube.com/howyoutubeworks/user-settings/privacy/)"
    },
    adsense: {
      id: "adsense",
      name: "Google Advertising",
      icon: "icons/analytics.svg",
      description:
        "This webpage loads Google advertising or DoubleClick resources.",
      info_url: "[policies.google.com](https://policies.google.com/technologies/ads)"
    }
  };

  let enabled = true;
  let detectedServices = [];
  let bypassedForThisPage = false;
  let observer = null;
  let scanTimer = null;

  function domainMatches(hostname, domain) {
    const host = String(hostname || "")
      .toLowerCase()
      .replace(/\.$/, "");

    const target = String(domain || "").toLowerCase();

    return host === target || host.endsWith(`.${target}`);
  }

  function isGoogleWebsite(hostname) {
    const host = String(hostname || "")
      .toLowerCase()
      .replace(/\.$/, "");

    /*
     * Matches:
     * google.com
     * www.google.com
     * maps.google.com
     * google.de
     * www.google.co.uk
     * google.com.au
     *
     * It does not match:
     * notgoogle.com
     * google.example.com
     */
    return (
      host === "google" ||
      host.startsWith("google.") ||
      host.includes(".google.")
    );
  }

  function parseUrl(value) {
    if (!value) {
      return null;
    }

    try {
      return new URL(value, document.baseURI || location.href);
    } catch (error) {
      return null;
    }
  }

  function addService(serviceSet, serviceId) {
    if (SERVICE_DATA[serviceId]) {
      serviceSet.add(serviceId);
    }
  }

  function inspectUrl(value, serviceSet) {
    const url = parseUrl(value);

    if (!url) {
      return;
    }

    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    const href = url.href.toLowerCase();

    if (
      domainMatches(hostname, "gstatic.com") ||
      domainMatches(hostname, "googleusercontent.com")
    ) {
      addService(serviceSet, "gstatic");
    }

    if (
      domainMatches(hostname, "fonts.googleapis.com") ||
      domainMatches(hostname, "fonts.gstatic.com")
    ) {
      addService(serviceSet, "gfonts");
    }

    if (
      domainMatches(hostname, "maps.googleapis.com") ||
      domainMatches(hostname, "maps.gstatic.com") ||
      (isGoogleWebsite(hostname) && pathname.startsWith("/maps"))
    ) {
      addService(serviceSet, "gmaps");
    }

    if (
      domainMatches(hostname, "google-analytics.com") ||
      domainMatches(hostname, "analytics.google.com") ||
      domainMatches(hostname, "googletagmanager.com") ||
      href.includes("/analytics.js") ||
      href.includes("/gtag/js") ||
      href.includes("/ga.js")
    ) {
      addService(serviceSet, "ga");
    }

    if (
      domainMatches(hostname, "accounts.google.com") ||
      href.includes("/gsi/client") ||
      href.includes("apis.google.com/js") ||
      href.includes("ssl.gstatic.com/accounts")
    ) {
      addService(serviceSet, "gsi");
    }

    if (
      domainMatches(hostname, "recaptcha.net") ||
      (isGoogleWebsite(hostname) && pathname.includes("/recaptcha/"))
    ) {
      addService(serviceSet, "recaptcha");
    }

    if (
      domainMatches(hostname, "cse.google.com") ||
      href.includes("/cse.js")
    ) {
      addService(serviceSet, "gse");
    }

    if (
      domainMatches(hostname, "youtube.com") ||
      domainMatches(hostname, "youtube-nocookie.com") ||
      domainMatches(hostname, "youtu.be") ||
      domainMatches(hostname, "ytimg.com")
    ) {
      addService(serviceSet, "youtube");
    }

    if (
      domainMatches(hostname, "doubleclick.net") ||
      domainMatches(hostname, "googlesyndication.com") ||
      domainMatches(hostname, "googletagservices.com") ||
      domainMatches(hostname, "googleadservices.com") ||
      href.includes("/adsbygoogle.js") ||
      href.includes("/tag/js/gpt.js")
    ) {
      addService(serviceSet, "adsense");
    }
  }

  function inspectText(text, serviceSet) {
    const value = String(text || "").toLowerCase();

    if (
      value.includes("google-analytics.com") ||
      value.includes("googletagmanager.com") ||
      value.includes("google_tag_manager") ||
      value.includes("gtag(")
    ) {
      addService(serviceSet, "ga");
    }

    if (
      value.includes("maps.googleapis.com/maps/api") ||
      value.includes("google.maps.")
    ) {
      addService(serviceSet, "gmaps");
    }

    if (
      value.includes("google.com/recaptcha") ||
      value.includes("recaptcha.net") ||
      value.includes("grecaptcha")
    ) {
      addService(serviceSet, "recaptcha");
    }

    if (
      value.includes("accounts.google.com/gsi") ||
      value.includes("google.accounts.")
    ) {
      addService(serviceSet, "gsi");
    }

    if (
      value.includes("googlesyndication.com") ||
      value.includes("doubleclick.net") ||
      value.includes("googletag.pubads")
    ) {
      addService(serviceSet, "adsense");
    }

    if (
      value.includes("youtube.com/embed") ||
      value.includes("youtube-nocookie.com/embed")
    ) {
      addService(serviceSet, "youtube");
    }
  }

  function scanDocument() {
    const services = new Set();

    /*
     * This detects google.com itself, independently of page markup.
     */
    if (isGoogleWebsite(window.location.hostname)) {
      addService(services, "google");
    }

    const selector = [
      "script[src]",
      "script:not([src])",
      "link[href]",
      "iframe[src]",
      "img[src]",
      "source[src]",
      "video[src]",
      "audio[src]",
      "object[data]",
      "embed[src]",
      "form[action]"
    ].join(",");

    document.querySelectorAll(selector).forEach((element) => {
      if (
        element.id === OVERLAY_ID ||
        element.closest(`#${OVERLAY_ID}`)
      ) {
        return;
      }

      if (element.tagName === "SCRIPT" && !element.src) {
        inspectText(element.textContent, services);
        return;
      }

      const value =
        element.src ||
        element.href ||
        element.data ||
        element.action ||
        element.getAttribute("src") ||
        element.getAttribute("href") ||
        element.getAttribute("data") ||
        element.getAttribute("action");

      inspectUrl(value, services);
    });

    return Array.from(services);
  }

  function makeElement(tagName, className, text) {
    const element = document.createElement(tagName);

    if (className) {
      element.className = className;
    }

    if (text !== undefined) {
      element.textContent = text;
    }

    return element;
  }

  function createServiceCard(serviceId) {
    const service = SERVICE_DATA[serviceId];
    const card = makeElement("article", "googless-service-card");

    const icon = makeElement("img", "googless-service-icon");
    icon.src = chrome.runtime.getURL(service.icon);
    icon.alt = "";

    const title = makeElement(
      "h2",
      "googless-service-title",
      service.name
    );

    const description = makeElement(
      "p",
      "googless-service-description",
      service.description
    );

    const link = makeElement(
      "a",
      "googless-service-link",
      "Find out more"
    );

    link.href = service.info_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    card.append(icon, title, description, link);

    return card;
  }

  function createOverlay() {
    const existing = document.getElementById(OVERLAY_ID);

    if (existing) {
      return existing;
    }

    const overlay = makeElement("section", "googless-overlay");
    overlay.id = OVERLAY_ID;
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Google services detected");

    const topbar = makeElement("div", "googless-topbar");
    const content = makeElement("div", "googless-content");

    const heading = makeElement(
      "h1",
      "googless-heading",
      "Website unavailable"
    );

    const description = makeElement(
      "p",
      "googless-description",
      "This webpage uses Google-owned services. Googless has covered the page so you can review what was detected."
    );

    const count = makeElement("p", "googless-count");
    count.id = "googless-count";

    const controls = makeElement("div", "googless-controls");

    const continueButton = makeElement(
      "button",
      "googless-button googless-button-secondary",
      "Continue once"
    );

    continueButton.type = "button";
    continueButton.addEventListener("click", () => {
      bypassedForThisPage = true;
      hideOverlay();
    });

    const disableButton = makeElement(
      "button",
      "googless-button",
      "Disable Googless"
    );

    disableButton.type = "button";
    disableButton.addEventListener("click", () => {
      enabled = false;

      chrome.storage.local.set({ enabled: false }, () => {
        hideOverlay();
        reportStatus();
      });
    });

    controls.append(continueButton, disableButton);

    const cards = makeElement(
      "div",
      "googless-service-container"
    );
    cards.id = "googless-service-container";

    content.append(
      heading,
      description,
      count,
      controls,
      cards
    );

    overlay.append(topbar, content);

    (document.body || document.documentElement).appendChild(overlay);

    return overlay;
  }

  function renderOverlay() {
    const overlay = createOverlay();
    const countElement = overlay.querySelector("#googless-count");
    const cardsElement = overlay.querySelector(
      "#googless-service-container"
    );

    const count = detectedServices.length;

    countElement.textContent =
      `${count} Google ` +
      `${count === 1 ? "service" : "services"} ` +
      "detected on this webpage.";

    cardsElement.replaceChildren(
      ...detectedServices.map(createServiceCard)
    );
  }

  function lockPage() {
    document.documentElement.classList.add("googless-page-locked");

    if (document.body) {
      document.body.classList.add("googless-page-locked");
    }
  }

  function unlockPage() {
    document.documentElement.classList.remove(
      "googless-page-locked"
    );

    if (document.body) {
      document.body.classList.remove("googless-page-locked");
    }
  }

  function showOverlay() {
    if (
      !enabled ||
      bypassedForThisPage ||
      detectedServices.length === 0
    ) {
      hideOverlay();
      return;
    }

    const overlay = createOverlay();
    renderOverlay();
    overlay.hidden = false;
    lockPage();
  }

  function hideOverlay() {
    const overlay = document.getElementById(OVERLAY_ID);

    if (overlay) {
      overlay.hidden = true;
    }

    unlockPage();
  }

  function reportStatus() {
    chrome.runtime.sendMessage(
      {
        type: "GOOGLESS_PAGE_STATUS",
        enabled,
        count: detectedServices.length,
        services: detectedServices
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  }

  function performScan() {
    detectedServices = scanDocument();

    if (
      enabled &&
      !bypassedForThisPage &&
      detectedServices.length > 0
    ) {
      showOverlay();
    } else {
      hideOverlay();
    }

    reportStatus();
  }

  function scheduleScan(delay = 100) {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(performScan, delay);
  }

  function startObserver() {
    if (observer || !document.documentElement) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => {
        const target = mutation.target;

        return !(
          target instanceof Element &&
          (target.id === OVERLAY_ID ||
            target.closest(`#${OVERLAY_ID}`))
        );
      });

      if (relevant) {
        scheduleScan();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "href", "data", "action"]
    });
  }

  chrome.runtime.onMessage.addListener(
    (request, sender, sendResponse) => {
      if (!request || typeof request.type !== "string") {
        return;
      }

      if (request.type === "GOOGLESS_GET_STATUS") {
        detectedServices = scanDocument();

        if (
          enabled &&
          !bypassedForThisPage &&
          detectedServices.length > 0
        ) {
          showOverlay();
        } else {
          hideOverlay();
        }

        sendResponse({
          enabled,
          count: detectedServices.length,
          services: detectedServices,
          hostname: location.hostname
        });

        return;
      }

      if (request.type === "GOOGLESS_SET_ENABLED") {
        enabled = request.enabled === true;
        bypassedForThisPage = false;

        chrome.storage.local.set({ enabled }, () => {
          performScan();

          sendResponse({
            ok: !chrome.runtime.lastError,
            enabled,
            count: detectedServices.length,
            services: detectedServices
          });
        });

        return true;
      }

      if (request.type === "GOOGLESS_RESCAN") {
        bypassedForThisPage = false;
        performScan();

        sendResponse({
          ok: true,
          enabled,
          count: detectedServices.length,
          services: detectedServices
        });
      }
    }
  );

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName !== "local" ||
      !Object.prototype.hasOwnProperty.call(changes, "enabled")
    ) {
      return;
    }

    enabled = changes.enabled.newValue !== false;
    bypassedForThisPage = false;
    performScan();
  });

  chrome.storage.local.get(DEFAULT_SETTINGS, (settings) => {
    enabled = settings.enabled !== false;

    /*
     * location.hostname is available at document_start, so google.com
     * can be identified before its DOM finishes loading.
     */
    performScan();
    startObserver();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", performScan, {
        once: true
      });
    }

    window.addEventListener("load", performScan, {
      once: true
    });
  });
})();