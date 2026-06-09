(function installPipzoSessionReset(globalScope) {
  "use strict";

  const REQUEST_TYPE = "pipzo.clearSpotifySession";
  const DIAGNOSTIC_MESSAGE_TYPE = "pipzo.extensionDiagnostic";
  const DIAGNOSTIC_ENDPOINT = "http://127.0.0.1:8000/api/v1/diagnostics/extension";
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

  function redactedPath(url) {
    try {
      const parsed = new URL(url ?? "");
      return parsed.pathname || "/";
    } catch {
      return "/";
    }
  }

  function originClass(url) {
    try {
      const parsed = new URL(url ?? "");
      if (TRUSTED_APP_ORIGINS.has(parsed.origin)) return "local_pipzo";
      if (parsed.protocol === "https:" && parsed.host === "accounts.spotify.com") return "spotify_accounts";
      if (parsed.protocol === "https:" && parsed.host.endsWith(".spotify.com")) return "other_spotify";
      return "other";
    } catch {
      return "unknown";
    }
  }

  function manifestVersion() {
    try {
      return globalScope.chrome?.runtime?.getManifest?.()?.version;
    } catch {
      return undefined;
    }
  }

  function postDiagnostic(event) {
    if (typeof globalScope.fetch !== "function") return;
    const body = {
      source: event.source,
      originClass: event.originClass,
      path: event.path || "/",
      topFrame: event.topFrame,
      manifestVersion: event.manifestVersion || manifestVersion(),
      keyboardRootPresent: event.keyboardRootPresent,
      keyboardVisible: event.keyboardVisible,
      launcherPresent: event.launcherPresent,
      scrollControlsPresent: event.scrollControlsPresent,
      editablePresent: event.editablePresent,
      otpLikePresent: event.otpLikePresent,
      tabStatus: event.tabStatus,
      injectionAttempted: event.injectionAttempted,
    };
    fetch(DIAGNOSTIC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }

  function postTabDiagnostic(tab, changeInfo = {}) {
    const url = changeInfo.url || tab?.url;
    if (!urlIsKeyboardOrigin(url)) return;
    postDiagnostic({
      source: "service_worker",
      originClass: originClass(url),
      path: redactedPath(url),
      manifestVersion: manifestVersion(),
      tabStatus: changeInfo.status || tab?.status,
      injectionAttempted: true,
    });
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
      tabs.forEach((tab) => {
        postTabDiagnostic(tab);
        injectKeyboardIntoTab(tab.id, tab.url);
      });
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
      if (message?.type === DIAGNOSTIC_MESSAGE_TYPE) {
        const senderUrl = sender?.url || "";
        if (urlIsKeyboardOrigin(senderUrl)) {
          postDiagnostic({
            ...message.event,
            source: "content_script",
            originClass: originClass(senderUrl),
            path: redactedPath(senderUrl),
            manifestVersion: manifestVersion(),
          });
        }
        sendResponse({ ok: true });
        return false;
      }
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
        postTabDiagnostic(tab, changeInfo);
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
    originClass,
    redactedPath,
  };
})(globalThis);
