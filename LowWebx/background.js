"use strict";

const RULE_ID = 1;

const BLOCK_TYPES = {
  balanced: [
    "font",
    "media",
    "object",
    "sub_frame",
    "websocket"
  ],
  maximum: [
    "font",
    "image",
    "media",
    "object",
    "sub_frame",
    "websocket"
  ]
};

function makeRule(mode) {
  return {
    id: RULE_ID,
    priority: 1,
    action: {
      type: "block"
    },
    condition: {
      regexFilter: "^https?://",
      resourceTypes: BLOCK_TYPES[mode] || BLOCK_TYPES.balanced
    }
  };
}

async function applySettings() {
  const {
    enabled = true,
    mode = "balanced"
  } = await browser.storage.local.get([
    "enabled",
    "mode"
  ]);

  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: enabled ? [makeRule(mode)] : []
  });

  return {
    enabled,
    mode
  };
}

browser.runtime.onInstalled.addListener(async () => {
  const stored = await browser.storage.local.get([
    "enabled",
    "mode"
  ]);

  await browser.storage.local.set({
    enabled: stored.enabled ?? true,
    mode: stored.mode ?? "balanced"
  });

  await applySettings();
});

browser.runtime.onStartup.addListener(() => {
  applySettings().catch((error) => {
    console.error("LowWebx startup failed:", error);
  });
});

browser.runtime.onMessage.addListener((request) => {
  if (request?.action !== "applySettings") {
    return undefined;
  }

  return applySettings()
    .then((settings) => ({
      success: true,
      ...settings
    }))
    .catch((error) => ({
      success: false,
      error: error.message
    }));
});