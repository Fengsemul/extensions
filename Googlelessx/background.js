"use strict";

const GAFAM_DOMAINS = [
  "1000minds.com", "alexa.com", "aliexpress.com", "aliexpress.fr", "amazon.com",
  "amazon.fr", "amazon-adsystem.com", "apple.com", "azure.com", "bing.com",
  "bing.fr", "bit.ly", "bitly.com", "blogger.com", "blogspot.com", "bubbl.us",
  "calameo.com", "cdnjs.cloudflare.com", "cloudflare.com", "codepen.io",
  "dailymotion.com", "discord.com", "doodle.com", "dropbox.com", "eventbrite.com",
  "eventbrite.fr", "evernote.com", "facebook.com", "facebook.fr", "facebook.net",
  "flickr.com", "foxmarks.com", "getpocket.com", "github.com", "github.io",
  "gmail.com", "goo.gl", "google.com", "google.fr", "del.icio.us", "imgur.com",
  "instagram.com", "instapaper.com", "jsfiddle.net", "linkedin.com", "live.com",
  "mappy.com", "mappy.fr", "microsoft.com", "microsoftonline.com", "netflix.com",
  "office.com", "office365.com", "onedrive.com", "openagenda.com", "cloud.orange.fr",
  "le-cloud.orange.fr", "outlook.com", "overblog.com", "pastebin.com", "periscope.tv",
  "pinterest.com", "pinterest.fr", "pscp.tv", "reddit.com", "reddit.fr", "shrtct.com",
  "skype.com", "slack.com", "snapchat.com", "sourceforge.com", "sourceforge.net",
  "tinder.com", "transifex.com", "trello.com", "tumblr.com", "twitch.tv",
  "twitter.com", "viadeo.fr", "viamichelin.fr", "viamichelin.com", "vimeo.com",
  "wetransfer.com", "whatsapp.com", "windowsazure.com", "xmarks.com", "yahoo.com",
  "yandex.ru", "yandex.com", "yandex.fr", "youtu.be", "youtube.com", "zoho.com",
  "padlet.com", "deezer.com", "deezer.fr", "soundcloud.com", "spotify.com",
  "spotify.fr", "taobao.com", "yammer.com", "youku.com", "paypal.com",
  "doubleclick.net", "googlesyndication.com", "google-analytics.com",
  "googletagmanager.com", "googleusercontent.com", "gstatic.com", "googleapis.com",
  "cloudfront.net", "akamaiedge.net", "akamai.net"
];

// Track runtime states
const tabDetections = new Map();

browser.runtime.onInstalled.addListener(() => {
  browser.storage.local.get({
    enabled: true,
    whitelist: ["startpage.com"],
    domains: GAFAM_DOMAINS
  }).then(res => {
    browser.storage.local.set(res);
  });
});

// Sniff background/asynchronous network queries
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;

    try {
      const reqUrl = new URL(details.url);
      const reqHost = reqUrl.hostname.toLowerCase();

      browser.storage.local.get({ enabled: true, whitelist: [], domains: GAFAM_DOMAINS }).then(conf => {
        if (!conf.enabled) return;

        browser.tabs.get(details.tabId).then(tab => {
          if (!tab || !tab.url) return;
          const pageHost = new URL(tab.url).hostname.toLowerCase();
          
          if (conf.whitelist.some(w => pageHost === w || pageHost.endsWith("." + w))) {
            return;
          }

          const matchedDomain = conf.domains.find(d => reqHost === d || reqHost.endsWith("." + d));
          if (matchedDomain) {
            let hits = tabDetections.get(details.tabId) || new Set();
            hits.add(matchedDomain);
            tabDetections.set(details.tabId, hits);

            browser.tabs.sendMessage(details.tabId, {
              type: "NETWORK_DETECTION_TRIGGER",
              services: Array.from(hits)
            }).catch(() => {});
          }
        }).catch(() => {});
      });
    } catch (e) {
      // Ignored non-HTTP URL parses
    }
  },
  { urls: ["<all_urls>"] }
);

browser.tabs.onRemoved.addListener((tabId) => {
  tabDetections.delete(tabId);
});

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "STATUS_UPDATE" && sender.tab) {
    const count = request.count || 0;
    browser.browserAction.setBadgeText({
      tabId: sender.tab.id,
      text: count > 0 ? String(count) : ""
    });
    browser.browserAction.setBadgeBackgroundColor({
      tabId: sender.tab.id,
      color: "#E64F9B"
    });
    sendResponse({ ok: true });
  }
});
