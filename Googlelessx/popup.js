"use strict";

const metricCount = document.getElementById("metric-count");
const toggleActive = document.getElementById("toggle-active");
const btnWhitelist = document.getElementById("btn-whitelist");
const entitiesList = document.getElementById("entities-list");

function restorePopup() {
  browser.storage.local.get({ enabled: true, whitelist: [] }).then(conf => {
    toggleActive.checked = conf.enabled;

    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      const activeTab = tabs[0];
      if (!activeTab || !activeTab.id) return;

      const activeUrl = new URL(activeTab.url);
      const isDomainWhitelisted = conf.whitelist.includes(activeUrl.hostname);

      btnWhitelist.textContent = isDomainWhitelisted
        ? "Remove From Whitelist"
        : "Whitelist This Domain";

      browser.tabs.sendMessage(activeTab.id, { type: "GET_INTERNAL_STATUS" }).then(res => {
        if (!res) return;
        metricCount.textContent = res.count;
        entitiesList.innerHTML = res.services.map(s => `<div>• ${s}</div>`).join("");
      }).catch(() => {
        metricCount.textContent = "0";
      });
    });
  });
}

toggleActive.addEventListener("change", () => {
  browser.storage.local.set({ enabled: toggleActive.checked }).then(() => {
    browser.tabs.reload();
    window.close();
  });
});

btnWhitelist.addEventListener("click", () => {
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    const activeTab = tabs[0];
    if (!activeTab || !activeTab.url) return;

    const hostname = new URL(activeTab.url).hostname;
    browser.storage.local.get({ whitelist: [] }).then(conf => {
      let list = conf.whitelist;
      if (list.includes(hostname)) {
        list = list.filter(item => item !== hostname);
      } else {
        list.push(hostname);
      }
      browser.storage.local.set({ whitelist: list }).then(() => {
        browser.tabs.reload();
        window.close();
      });
    });
  });
});

restorePopup();
