"use strict";

const toggle = document.getElementById("checkbox");
const countTarget = document.getElementById("nService");
const serviceLabel = document.getElementById("serviceLabel");
const statusText = document.getElementById("status-text");
const pageStatus = document.getElementById("pageStatus");

function updateToggleText() {
  statusText.textContent = toggle.checked
    ? "Enabled"
    : "Disabled";
}

function updateCount(count) {
  const safeCount = Number.isFinite(Number(count))
    ? Number(count)
    : 0;

  countTarget.textContent = String(safeCount);

  serviceLabel.textContent =
    safeCount === 1
      ? "Google service detected on this webpage."
      : "Google services detected on this webpage.";

  pageStatus.textContent =
    safeCount > 0
      ? "Googless detected Google services on this page."
      : "No supported Google services were detected.";
}

function getActiveTab(callback) {
  chrome.tabs.query(
    {
      active: true,
      currentWindow: true
    },
    (tabs) => {
      callback(tabs[0] || null);
    }
  );
}

function refreshPopup() {
  chrome.storage.local.get(
    { enabled: true },
    (settings) => {
      toggle.checked = settings.enabled !== false;
      updateToggleText();

      getActiveTab((tab) => {
        if (!tab || typeof tab.id !== "number") {
          updateCount(0);
          pageStatus.textContent = "No active webpage is available.";
          return;
        }

        chrome.tabs.sendMessage(
          tab.id,
          { type: "GOOGLESS_GET_STATUS" },
          (response) => {
            if (chrome.runtime.lastError) {
              updateCount(0);
              pageStatus.textContent =
                "The content script is not running. Reload the extension, then reload this tab.";
              return;
            }

            if (!response) {
              updateCount(0);
              pageStatus.textContent =
                "The webpage did not return a status.";
              return;
            }

            toggle.checked = response.enabled !== false;
            updateToggleText();
            updateCount(response.count);
          }
        );
      });
    }
  );
}

toggle.addEventListener("change", () => {
  const enabled = toggle.checked;

  updateToggleText();

  chrome.storage.local.set({ enabled }, () => {
    getActiveTab((tab) => {
      if (!tab || typeof tab.id !== "number") {
        return;
      }

      chrome.tabs.sendMessage(
        tab.id,
        {
          type: "GOOGLESS_SET_ENABLED",
          enabled
        },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            pageStatus.textContent =
              "Reload this webpage to apply the change.";
            return;
          }

          updateCount(response.count);
        }
      );
    });
  });
});

refreshPopup();