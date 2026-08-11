"use strict";

const BLOCK_RULE_ID = 1;

const blockRule = {
  id: BLOCK_RULE_ID,
  priority: 1,
  action: {
    type: "block"
  },
  condition: {
    regexFilter: "^https?://",
    resourceTypes: [
      "script",
      "stylesheet",
      "image",
      "font",
      "media",
      "object",
"websocket"
    ]
  }
};

async function setRawWebEnabled(enabled) {
  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [BLOCK_RULE_ID],
    addRules: enabled ? [blockRule] : []
  });

  await browser.storage.local.set({ enabled });
}

async function restoreStoredState() {
  const { enabled = false } =
    await browser.storage.local.get("enabled");

  await setRawWebEnabled(enabled);
}

browser.runtime.onMessage.addListener((request) => {
  if (request?.action !== "toggle") {
    return undefined;
  }

  const enabled = Boolean(request.state);

  return setRawWebEnabled(enabled)
    .then(() => ({
      success: true,
      enabled
    }))
    .catch((error) => {
      console.error("RawWeb could not update its rules:", error);

      return {
        success: false,
        error: error.message
      };
    });
});

browser.runtime.onInstalled.addListener(() => {
  restoreStoredState().catch((error) => {
    console.error("RawWeb installation initialization failed:", error);
  });
});

browser.runtime.onStartup.addListener(() => {
  restoreStoredState().catch((error) => {
    console.error("RawWeb startup initialization failed:", error);
  });
});