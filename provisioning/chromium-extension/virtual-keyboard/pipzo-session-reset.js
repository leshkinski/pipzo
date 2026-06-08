(function installPipzoSessionReset(globalScope) {
  "use strict";

  const REQUEST_TYPE = "pipzo.clearSpotifySession";
  const SPOTIFY_COOKIE_DOMAIN = "spotify.com";
  const SPOTIFY_BROWSING_ORIGINS = [
    "https://accounts.spotify.com",
    "https://open.spotify.com",
    "https://www.spotify.com",
    "https://spotify.com",
  ];
  const TRUSTED_APP_ORIGINS = new Set(["http://127.0.0.1:8000", "http://localhost:8000"]);
  const KEYBOARD_SCRIPT_FILE = "pipzo-keyboard.js";
  const KEYBOARD_STYLESHEET_FILE = "pipzo-keyboard.css";
  const KEYBOARD_ORIGIN_PATTERNS = [
    "http://127.0.0.1:8000/*",
    "http://localhost:8000/*",
    "https://accounts.spotify.com/*",
  ];

  function chromeLastError() {
    return globalScope.chrome?.runtime?.lastError?.message;
  }

  function senderIsTrustedApp(sender) {
    try {
      const senderUrl = new URL(sender?.url ?? "");
      return TRUSTED_APP_ORIGINS.has(senderUrl.origin);
    } catch {
      return false;
    }
  }

  function cookieUrl(cookie) {
    const domain = String(cookie.domain || SPOTIFY_COOKIE_DOMAIN).replace(/^\./, "");
    const scheme = cookie.secure ? "https" : "http";
    const path = cookie.path || "/";
    return `${scheme}://${domain}${path}`;
  }

  function urlIsKeyboardOrigin(url) {
    try {
      const parsed = new URL(url ?? "");
      if (parsed.origin === "http://127.0.0.1:8000" || parsed.origin === "http://localhost:8000") return true;
      return parsed.protocol === "https:" && parsed.host === "accounts.spotify.com";
    } catch {
      return false;
    }
  }

  function injectKeyboardIntoTab(tabId, url) {
    if (!Number.isInteger(tabId) || !urlIsKeyboardOrigin(url)) return;
    const target = { tabId, allFrames: true };
    const insertCSS = globalScope.chrome?.scripting?.insertCSS;
    const executeScript = globalScope.chrome?.scripting?.executeScript;
    if (typeof insertCSS === "function") {
      insertCSS({ target, files: [KEYBOARD_STYLESHEET_FILE] }, () => {
        chromeLastError();
      });
    }
    if (typeof executeScript === "function") {
      executeScript({ target, files: [KEYBOARD_SCRIPT_FILE] }, () => {
        chromeLastError();
      });
    }
  }

  function injectKeyboardIntoExistingTabs() {
    const query = globalScope.chrome?.tabs?.query;
    if (typeof query !== "function") return;
    query({ url: KEYBOARD_ORIGIN_PATTERNS }, (tabs) => {
      chromeLastError();
      if (!Array.isArray(tabs)) return;
      tabs.forEach((tab) => injectKeyboardIntoTab(tab.id, tab.url));
    });
  }

  function getSpotifyCookies() {
    return new Promise((resolve, reject) => {
      globalScope.chrome.cookies.getAll({ domain: SPOTIFY_COOKIE_DOMAIN }, (cookies) => {
        const error = chromeLastError();
        if (error) {
          reject(new Error(error));
          return;
        }
        resolve(Array.isArray(cookies) ? cookies : []);
      });
    });
  }

  function removeCookie(cookie) {
    return new Promise((resolve, reject) => {
      const details = {
        name: cookie.name,
        url: cookieUrl(cookie),
        storeId: cookie.storeId,
      };
      if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
      globalScope.chrome.cookies.remove(details, () => {
        const error = chromeLastError();
        if (error) {
          reject(new Error(error));
          return;
        }
        resolve();
      });
    });
  }

  function clearSpotifyBrowsingData() {
    return new Promise((resolve, reject) => {
      globalScope.chrome.browsingData.remove(
        {
          origins: SPOTIFY_BROWSING_ORIGINS,
          originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false },
        },
        {
          cacheStorage: true,
          cookies: true,
          indexedDB: true,
          localStorage: true,
          serviceWorkers: true,
        },
        () => {
          const error = chromeLastError();
          if (error) {
            reject(new Error(error));
            return;
          }
          resolve();
        },
      );
    });
  }

  async function clearSpotifySession() {
    const cookies = await getSpotifyCookies();
    await Promise.all(cookies.map((cookie) => removeCookie(cookie)));
    await clearSpotifyBrowsingData();
    return { ok: true, clearedCookies: cookies.length };
  }

  if (globalScope.chrome?.runtime?.onMessage) {
    globalScope.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== REQUEST_TYPE) return false;
      if (!senderIsTrustedApp(sender)) {
        sendResponse({ ok: false, error: "untrusted_sender" });
        return false;
      }
      clearSpotifySession()
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, error: "clear_failed" }));
      return true;
    });
  }

  if (globalScope.chrome?.tabs?.onUpdated) {
    globalScope.chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      const url = changeInfo?.url || tab?.url;
      const status = changeInfo?.status;
      if (url || status === "loading" || status === "complete") {
        injectKeyboardIntoTab(tabId, url);
      }
    });
  }

  if (globalScope.chrome?.runtime?.onStartup) {
    globalScope.chrome.runtime.onStartup.addListener(injectKeyboardIntoExistingTabs);
  }

  if (globalScope.chrome?.runtime?.onInstalled) {
    globalScope.chrome.runtime.onInstalled.addListener(injectKeyboardIntoExistingTabs);
  }

  injectKeyboardIntoExistingTabs();

  globalScope.__pipzoSessionResetTestApi = {
    KEYBOARD_ORIGIN_PATTERNS,
    SPOTIFY_BROWSING_ORIGINS,
    SPOTIFY_COOKIE_DOMAIN,
    TRUSTED_APP_ORIGINS,
    cookieUrl,
    senderIsTrustedApp,
    urlIsKeyboardOrigin,
  };
})(globalThis);
