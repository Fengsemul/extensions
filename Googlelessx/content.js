(() => {
  "use strict";

  let enabled = true;
  let whitelist = [];
  let trackingDomains = [];
  let detectedEntities = new Set();
  let bypassedForSession = false;
  let originalTitle = document.title;
  let shadowRoot = null;
  let overlayWrapper = null;

  function init() {
    browser.storage.local.get({
      enabled: true,
      whitelist: ["startpage.com"],
      domains: []
    }).then(config => {
      enabled = config.enabled;
      whitelist = config.whitelist;
      trackingDomains = config.domains;

      if (!enabled || isWhitelisted(location.hostname)) {
        return;
      }

      runInspections();
      setupObserver();
    });
  }

  function isWhitelisted(host) {
    const cur = host.toLowerCase();
    return whitelist.some(w => cur === w || cur.endsWith("." + w));
  }

  function isTrackedHost(host) {
    if (!host) return false;
    const cleanHost = host.toLowerCase();
    return trackingDomains.some(d => cleanHost === d || cleanHost.endsWith("." + d));
  }

  function runInspections() {
    // 1. Check current host
    if (isTrackedHost(location.hostname)) {
      detectedEntities.add(location.hostname);
    }

    // 2. Scan DOM targets
    const elements = document.querySelectorAll("script, link, iframe, img, embed, object, form");
    elements.forEach(el => {
      const path = el.src || el.href || el.data || el.action;
      inspectSourceString(path);
      if (el.tagName === "SCRIPT" && !el.src) {
        inspectInlineText(el.textContent);
      }
    });

    // 3. Highlight Outbound GAFAM Anchor Links (GAFALink Feature)
    highlightLinks();

    // 4. Update Lock Screen / Title
    renderExtensionStatus();
  }

  function inspectSourceString(str) {
    if (!str) return;
    try {
      const parsed = new URL(str, document.baseURI);
      if (isTrackedHost(parsed.hostname)) {
        detectedEntities.add(parsed.hostname);
      }
    } catch (e) {
      // Relative or invalid link
    }
  }

  function inspectInlineText(text) {
    if (!text) return;
    const lower = text.toLowerCase();
    for (let i = 0; i < trackingDomains.length; i++) {
      if (lower.includes(trackingDomains[i])) {
        detectedEntities.add(trackingDomains[i]);
      }
    }
  }

  function highlightLinks() {
    const links = document.querySelectorAll("a[href]");
    links.forEach(a => {
      try {
        const u = new URL(a.href, document.baseURI);
        if (isTrackedHost(u.hostname) && u.hostname !== location.hostname) {
          a.style.setProperty("background-color", "#FF0000", "important");
          a.style.setProperty("color", "#FFFF00", "important");
          a.style.setProperty("font-weight", "bold", "important");
          a.style.setProperty("text-decoration", "underline", "important");
        }
      } catch (e) {}
    });
  }

  function renderExtensionStatus() {
    const count = detectedEntities.size;

    browser.runtime.sendMessage({
      type: "STATUS_UPDATE",
      count: count,
      services: Array.from(detectedEntities)
    }).catch(() => {});

    if (count > 0 && !bypassedForSession && enabled) {
      applyTitleBlock();
      showBlockedOverlay();
    } else {
      removeTitleBlock();
      hideBlockedOverlay();
    }
  }

  function applyTitleBlock() {
    if (!document.title.startsWith("[Googless Blocked]")) {
      originalTitle = document.title;
      document.title = "[Googless Blocked] " + originalTitle;
    }
  }

  function removeTitleBlock() {
    if (document.title.startsWith("[Googless Blocked]")) {
      document.title = originalTitle;
    }
  }

  function createOverlayComponent() {
    if (overlayWrapper) return;

    overlayWrapper = document.createElement("div");
    overlayWrapper.id = "googless-isolated-root";
    overlayWrapper.style.all = "initial";

    // Closed shadow boundary avoids parent site CSS pollution
    shadowRoot = overlayWrapper.attachShadow({ mode: "closed" });

    const container = document.createElement("div");
    container.id = "googless-container";
    container.innerHTML = `
      <style>
        :host { all: initial; }
        #googless-container {
          position: fixed !important;
          inset: 0 !important;
          z-index: 2147483647 !important;
          background: #F9F5F4 !important;
          color: #141414 !important;
          font-family: Arial, sans-serif !important;
          box-sizing: border-box !important;
          display: flex !important;
          flex-direction: column !important;
          overflow-y: auto !important;
          padding: 40px !important;
        }
        .topbar {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: 16px;
          background: repeating-linear-gradient(135deg, #f3d898, #f3d898 15px, #141414 15px, #141414 30px);
          border-bottom: 2px solid #000;
        }
        .header {
          font-size: 42px !important;
          font-weight: 900 !important;
          color: #f3d898 !important;
          text-shadow: 2px 2px 0 #141414, -1px -1px 0 #141414 !important;
          margin: 20px 0 10px 0 !important;
          text-transform: uppercase !important;
        }
        .description {
          font-size: 18px !important;
          font-weight: bold !important;
          margin-bottom: 20px !important;
        }
        .controls {
          display: flex !important;
          gap: 15px !important;
          margin-bottom: 30px !important;
        }
        button {
          cursor: pointer !important;
          border: 2px solid #141414 !important;
          border-radius: 20px !important;
          padding: 8px 20px !important;
          font-size: 14px !important;
          font-weight: bold !important;
          box-shadow: 2px 2px 0 #141414 !important;
        }
        .btn-continue { background: #1A73E8 !important; color: #FFF !important; }
        .btn-disable { background: #E64F9B !important; color: #FFF !important; }
        .grid {
          display: grid !important;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)) !important;
          gap: 15px !important;
        }
        .card {
          background: #FFF !important;
          border: 2px solid #141414 !important;
          padding: 15px !important;
          box-shadow: 4px 4px 0 #E64F9B !important;
        }
        .domain-tag {
          font-weight: bold !important;
          color: #E64F9B !important;
          word-break: break-all !important;
        }
      </style>
      <div class="topbar"></div>
      <div class="header">Website Unavailable</div>
      <div class="description">Googless detected outbound tracking/monopoly services integrated on this webpage:</div>
      <div class="controls">
        <button id="btn-pass" class="btn-continue">Continue Once</button>
        <button id="btn-off" class="btn-disable">Disable Everywhere</button>
      </div>
      <div class="grid" id="card-mount"></div>
    `;

    shadowRoot.appendChild(container);
    (document.body || document.documentElement).appendChild(overlayWrapper);

    shadowRoot.getElementById("btn-pass").addEventListener("click", () => {
      bypassedForSession = true;
      renderExtensionStatus();
    });

    shadowRoot.getElementById("btn-off").addEventListener("click", () => {
      browser.storage.local.set({ enabled: false }).then(() => {
        enabled = false;
        renderExtensionStatus();
      });
    });
  }

  function showBlockedOverlay() {
    createOverlayComponent();
    if (!shadowRoot) return;

    const mount = shadowRoot.getElementById("card-mount");
    mount.innerHTML = "";

    detectedEntities.forEach(item => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div style="font-size:12px;color:#777;">DETECTED SYSTEM</div>
        <div class="domain-tag">${item}</div>
        <div style="font-size:13px;margin-top:8px;">GAFAM/CDN tracking or host dependency detected on this platform.</div>
      `;
      mount.appendChild(card);
    });

    overlayWrapper.style.display = "block";
    document.documentElement.style.setProperty("overflow", "hidden", "important");
  }

  function hideBlockedOverlay() {
    if (overlayWrapper) {
      overlayWrapper.style.display = "none";
    }
    document.documentElement.style.removeProperty("overflow");
  }

  function setupObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const m of mutations) {
        if (m.target && m.target.id === "googless-isolated-root") continue;
        shouldScan = true;
        break;
      }
      if (shouldScan) {
        runInspections();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "href"]
    });
  }

  // Network listener updates from background.js
  browser.runtime.onMessage.addListener((request) => {
    if (request.type === "NETWORK_DETECTION_TRIGGER") {
      request.services.forEach(s => detectedEntities.add(s));
      renderExtensionStatus();
    }
    if (request.type === "GET_INTERNAL_STATUS") {
      return Promise.resolve({
        count: detectedEntities.size,
        services: Array.from(detectedEntities),
        enabled: enabled,
        whitelisted: isWhitelisted(location.hostname)
      });
    }
  });

  init();
})();
