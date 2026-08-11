(() => {
  "use strict";

const REMOVABLE_SELECTOR = [
  "script",
  "style:not([data-rawweb-style])",
  "template",
  "link",
  "img",
  "picture",
  "source",
  "svg",
  "canvas",
  "video",
  "audio",
  "track",
  "object",
  "embed",
  "applet",
  "portal",
  "model-viewer",
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "nav",
  "[role='navigation']",
  "[aria-label*='navigation' i]",
  "[aria-label*='menu' i]"
].join(",");

  const LINK_SELECTOR = "a, area";

  let observer = null;
  let stopTimer = null;

  function removeUnwantedElements(root) {
    if (
      root.nodeType === Node.ELEMENT_NODE &&
      root.matches(REMOVABLE_SELECTOR)
    ) {
      root.remove();
      return false;
    }

    if (!root.querySelectorAll) {
      return true;
    }

    for (const element of root.querySelectorAll(REMOVABLE_SELECTOR)) {
      element.remove();
    }

    return true;
  }

  function disableLinks(root) {
    const links = [];

    if (
      root.nodeType === Node.ELEMENT_NODE &&
      root.matches(LINK_SELECTOR)
    ) {
      links.push(root);
    }

    if (root.querySelectorAll) {
      links.push(...root.querySelectorAll(LINK_SELECTOR));
    }

    for (const link of links) {
      link.removeAttribute("href");
      link.removeAttribute("target");
      link.removeAttribute("download");
      link.removeAttribute("ping");
      link.removeAttribute("rel");
      link.setAttribute("tabindex", "-1");
      link.setAttribute("aria-disabled", "true");
    }
  }

  function removeInlineEventHandlers(root) {
    const elements = [];

    if (root.nodeType === Node.ELEMENT_NODE) {
      elements.push(root);
    }

    if (root.querySelectorAll) {
      elements.push(...root.querySelectorAll("*"));
    }

    for (const element of elements) {
      for (const attribute of [...element.attributes]) {
        if (attribute.name.toLowerCase().startsWith("on")) {
          element.removeAttribute(attribute.name);
        }
      }
    }
  }

  function sanitizeSubtree(root) {
    if (root !== document && !root?.isConnected) {
      return;
    }

    if (!removeUnwantedElements(root)) {
      return;
    }

    disableLinks(root);
    removeInlineEventHandlers(root);
  }

  function installRawStyle() {
    if (
      !document.documentElement ||
      document.querySelector("[data-rawweb-style]")
    ) {
      return;
    }

    const style = document.createElement("style");
    style.setAttribute("data-rawweb-style", "");

style.textContent = `
  html {
    overflow-x: hidden !important;
    overflow-y: auto !important;
    height: auto !important;
    max-height: none !important;
    scroll-behavior: auto !important;
  }

  body {
    display: block !important;
    overflow: visible !important;
    width: auto !important;
    height: auto !important;
    min-height: 100vh !important;
    max-height: none !important;
    visibility: visible !important;
    opacity: 1 !important;
    touch-action: auto !important;
    overscroll-behavior: auto !important;
  }

  body,
  body * {
    position: static !important;
    inset: auto !important;
    top: auto !important;
    right: auto !important;
    bottom: auto !important;
    left: auto !important;
    z-index: auto !important;
    float: none !important;
    transform: none !important;

    font-family: sans-serif !important;
    font-style: normal !important;
    font-variant: normal !important;
    font-weight: normal !important;
    font-stretch: normal !important;

    text-decoration: none !important;
    text-shadow: none !important;
    box-shadow: none !important;
    background-color: transparent !important;
    background-image: none !important;
    animation: none !important;
    transition: none !important;
    cursor: default !important;
  }

  main,
  article,
  section,
  header,
  footer,
  nav,
  aside,
  [role="main"],
  [role="navigation"],
  [role="banner"],
  [role="dialog"] {
    display: block !important;
    overflow: visible !important;
    width: auto !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    visibility: visible !important;
    opacity: 1 !important;
  }

  a,
  area {
    color: inherit !important;
    pointer-events: none !important;
    text-decoration: none !important;
    cursor: default !important;
  }

  img,
  picture,
  source,
  svg,
  canvas,
  video,
  audio,
  track,
  object,
  embed,
  iframe,
  button,
  input,
  select,
  textarea {
    display: none !important;
  }
`;

    document.documentElement.appendChild(style);
  }

function unlockScrolling() {
  const html = document.documentElement;
  const body = document.body;

  if (html) {
    html.style.setProperty("overflow-x", "hidden", "important");
    html.style.setProperty("overflow-y", "auto", "important");
    html.style.setProperty("height", "auto", "important");
    html.style.setProperty("max-height", "none", "important");
    html.style.setProperty("position", "static", "important");
    html.style.setProperty("scroll-behavior", "auto", "important");
  }

  if (body) {
    body.style.setProperty("overflow", "visible", "important");
    body.style.setProperty("height", "auto", "important");
    body.style.setProperty("min-height", "100vh", "important");
    body.style.setProperty("max-height", "none", "important");
    body.style.setProperty("position", "static", "important");
    body.style.setProperty("display", "block", "important");
  }

  if (document.scrollingElement) {
    document.scrollingElement.scrollTop =
      document.scrollingElement.scrollTop;
  }
}
  function scheduleObserverShutdown() {
    clearTimeout(stopTimer);

    stopTimer = setTimeout(() => {
      observer?.disconnect();
      observer = null;
    }, 3000);
  }

  function startObserver() {
    if (observer || !document.documentElement) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      const addedElements = new Set();

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            addedElements.add(node);
          }
        }
      }

      for (const element of addedElements) {
        sanitizeSubtree(element);
      }

      scheduleObserverShutdown();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    scheduleObserverShutdown();
  }

async function initialize() {
  try {
    const { enabled = false } =
      await browser.storage.local.get("enabled");

    if (!enabled) {
      return;
    }

    installRawStyle();
    sanitizeSubtree(document);
    unlockScrolling();
    startObserver();

    document.addEventListener(
      "DOMContentLoaded",
      () => {
        installRawStyle();
        sanitizeSubtree(document);
        unlockScrolling();
        startObserver();

        setTimeout(unlockScrolling, 250);
        setTimeout(unlockScrolling, 1000);
      },
      { once: true }
    );
  } catch (error) {
    console.error("RawWeb initialization failed:", error);
  }
}

  initialize();
})();
