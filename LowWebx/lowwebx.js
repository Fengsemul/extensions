(() => {
  "use strict";

  async function isEnabled() {
    try {
      const { enabled = true } =
        await browser.storage.local.get("enabled");

      return enabled;
    } catch {
      return true;
    }
  }

  function reduceElementWork(root = document) {
    for (const media of root.querySelectorAll("video, audio")) {
      try {
        media.pause();
      } catch {
        // Some custom media elements do not implement pause normally.
      }

      media.autoplay = false;
      media.loop = false;
      media.preload = "none";

      media.removeAttribute("autoplay");
      media.removeAttribute("loop");
    }

    for (const iframe of root.querySelectorAll("iframe")) {
      iframe.loading = "lazy";
    }

    for (const image of root.querySelectorAll("img")) {
      image.loading = "lazy";
      image.decoding = "async";
      image.fetchPriority = "low";
    }

    for (const marquee of root.querySelectorAll("marquee")) {
      try {
        marquee.stop();
      } catch {
        // Ignore obsolete-element implementation differences.
      }
    }
  }

  async function initialize() {
    if (!(await isEnabled())) {
      return;
    }

    reduceElementWork();

    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        () => reduceElementWork(),
        { once: true }
      );
    }
  }

  initialize().catch((error) => {
    console.error("LowWebx initialization failed:", error);
  });
})();