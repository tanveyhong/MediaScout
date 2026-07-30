"use strict";

(() => {
  const publishManifest = (url, text) => {
    if (!/^\s*#EXTM3U/i.test(text)) return;
    window.postMessage(
      {
        manifestText: text,
        sourceUrl: url,
        type: "media-scout-flix-manifest",
      },
      location.origin,
    );
  };
  const requestUrls = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalFetch = window.fetch;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      requestUrls.set(this, new URL(String(url), location.href).href);
    } catch {
      requestUrls.set(this, String(url || ""));
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = requestUrls.get(this) || "";
    if (/\.m3u8(?:$|[?#])/i.test(url)) {
      this.addEventListener(
        "load",
        () => {
          try {
            let text = "";
            if (!this.responseType || this.responseType === "text") {
              text = this.responseText;
            } else if (this.response instanceof ArrayBuffer) {
              text = new TextDecoder().decode(this.response);
            }
            publishManifest(url, text);
          } catch {
            // Observing playback must never interfere with the player.
          }
        },
        { once: true },
      );
    }
    return originalSend.apply(this, args);
  };

  if (typeof originalFetch === "function") {
    window.fetch = async function (input, init) {
      const response = await originalFetch.call(this, input, init);
      try {
        const rawUrl =
          typeof input === "string" || input instanceof URL
            ? String(input)
            : input?.url || "";
        const url = new URL(rawUrl, location.href).href;
        if (/\.m3u8(?:$|[?#])/i.test(url)) {
          response
            .clone()
            .text()
            .then((text) => publishManifest(url, text))
            .catch(() => {});
        }
      } catch {
        // Observing playback must never interfere with the player.
      }
      return response;
    };
  }
})();
