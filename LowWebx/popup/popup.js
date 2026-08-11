"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const enabledInput = document.getElementById("enabled");
  const applyButton = document.getElementById("apply");
  const description = document.getElementById("description");
  const status = document.getElementById("status");

  const modeInputs = [
    ...document.querySelectorAll("input[name='mode']")
  ];

  function selectedMode() {
    return modeInputs.find((input) => input.checked)?.value
      || "balanced";
  }

  function updateDescription() {
    const mode = selectedMode();

    description.textContent = mode === "maximum"
      ? "Blocks images, fonts, media, objects, frames, and WebSockets. Some image-based or embedded content will disappear."
      : "Blocks fonts, media, objects, frames, and WebSockets. Images and page scripts remain available.";
  }

  try {
    const {
      enabled = true,
      mode = "balanced"
    } = await browser.storage.local.get([
      "enabled",
      "mode"
    ]);

    enabledInput.checked = enabled;

    const selected =
      modeInputs.find((input) => input.value === mode)
      || modeInputs[0];

    selected.checked = true;
    updateDescription();
  } catch (error) {
    status.textContent = `Could not load settings: ${error.message}`;
  }

  for (const input of modeInputs) {
    input.addEventListener("change", updateDescription);
  }

  applyButton.addEventListener("click", async () => {
    applyButton.disabled = true;
    status.textContent = "Applying...";

    try {
      await browser.storage.local.set({
        enabled: enabledInput.checked,
        mode: selectedMode()
      });

      const response = await browser.runtime.sendMessage({
        action: "applySettings"
      });

      if (!response?.success) {
        throw new Error(
          response?.error || "Rules could not be applied."
        );
      }

      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true
      });

      if (tabs[0]?.id !== undefined) {
        await browser.tabs.reload(tabs[0].id, {
          bypassCache: true
        });
      }

      window.close();
    } catch (error) {
      status.textContent = `Could not apply settings: ${error.message}`;
      applyButton.disabled = false;
    }
  });
});