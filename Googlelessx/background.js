"use strict";
const DEFAULT_SETTINGS = {  enabled: true};
function initializeSettings() {  chrome.storage.local.get(DEFAULT_SETTINGS, (settings) => {    if (chrome.runtime.lastError) {      console.error(        "Googless could not read its settings:",        chrome.runtime.lastError.message      );      return;    }
    chrome.storage.local.set({      enabled: settings.enabled !== false    });  });}
chrome.runtime.onInstalled.addListener(initializeSettings);chrome.runtime.onStartup.addListener(initializeSettings);
chrome.runtime.onMessage.addListener(  (request, sender, sendResponse) => {    if (!request || request.type !== "GOOGLESS_PAGE_STATUS") {      return;    }
    if (!sender.tab || typeof sender.tab.id !== "number") {      sendResponse({ ok: false });      return;    }
    const count = Number.isFinite(request.count)      ? request.count      : 0;
    chrome.action.setBadgeText({      tabId: sender.tab.id,      text: count > 0 ? String(count) : ""    });
    chrome.action.setBadgeBackgroundColor({      tabId: sender.tab.id,      color: "#E64F9B"    });
    sendResponse({ ok: true });  });