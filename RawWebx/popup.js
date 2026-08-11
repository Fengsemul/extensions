document.addEventListener("DOMContentLoaded", async () => {
  const button = document.getElementById("toggle");
  const statusText = document.getElementById("statusText");

  let enabled = false;
  let updating = false;

  function updateUI() {
    button.textContent = enabled
      ? "Disable RawWeb"
      : "Enable RawWeb";

    button.style.backgroundColor = enabled
      ? "#dc3545"
      : "#007aff";

statusText.textContent = enabled
  ? "Text-only mode is active\nLinks, fonts, scripts, styles, images, and media are disabled"
  : "Normal browsing is active\nEnable RawWeb and the page will reload";

    button.disabled = updating;
  }

  async function reloadActiveTab() {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true
    });

    if (tabs[0]?.id !== undefined) {
      await browser.tabs.reload(tabs[0].id, {
        bypassCache: true
      });
    }
  }

  try {
    const stored = await browser.storage.local.get("enabled");
    enabled = stored.enabled ?? false;
  } catch (error) {
    console.error("Could not load RawWeb settings:", error);
    statusText.textContent = "Could not load the extension setting.";
  } finally {
    updateUI();
  }

  button.addEventListener("click", async () => {
    if (updating) {
      return;
    }

    const previousState = enabled;
    const newState = !enabled;

    updating = true;
    enabled = newState;
    updateUI();

    try {
      const response = await browser.runtime.sendMessage({
        action: "toggle",
        state: newState
      });

      if (!response?.success) {
        throw new Error(
          response?.error || "The blocking rule could not be updated."
        );
      }

      await reloadActiveTab();
      window.close();
    } catch (error) {
      console.error("Could not toggle RawWeb:", error);
      enabled = previousState;
      statusText.textContent =
        "RawWeb could not change the blocking setting.";
    } finally {
      updating = false;
      updateUI();
    }
  });
});