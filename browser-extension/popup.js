"use strict";

const status = document.querySelector("#status");
const statusText = document.querySelector("#statusText");
const pairForm = document.querySelector("#pairForm");
const pairingCode = document.querySelector("#pairingCode");
const captureButton = document.querySelector("#captureButton");
const resetButton = document.querySelector("#resetButton");
const mediaResults = document.querySelector("#mediaResults");

function renderMedia(candidates) {
  mediaResults.replaceChildren();
  const uniqueCandidates = [...new Set(candidates)].filter((url) =>
    /^https?:/i.test(url),
  );
  if (!uniqueCandidates.length) {
    mediaResults.hidden = false;
    const empty = document.createElement("p");
    empty.textContent = "No media detected yet. Play a video, then scan again.";
    mediaResults.append(empty);
    return 0;
  }
  mediaResults.hidden = false;
  for (const url of uniqueCandidates.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "media-item";
    const label = document.createElement("span");
    label.textContent = url;
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Download";
    download.addEventListener("click", () => {
      download.disabled = true;
      chrome.downloads.download({ url, saveAs: true });
    });
    row.append(label, download);
    mediaResults.append(row);
  }
  return uniqueCandidates.length;
}

async function detectMedia() {
  const response = await chrome.runtime
    .sendMessage({ type: "capture-active" })
    .catch(() => ({ ok: false, candidates: [] }));
  const count = renderMedia(response?.candidates || []);
  showStatus(
    response?.ok !== false || count > 0,
    count
      ? `${count} media link${count === 1 ? "" : "s"} detected`
      : response?.ok === false
        ? "Could not detect media"
        : "No playable media found",
  );
  return response;
}

function showStatus(online, message) {
  status.classList.toggle("online", online);
  statusText.textContent = message;
}

async function connect(savedCode) {
  const headers = savedCode ? { "X-Media-Scout-Pairing": savedCode } : {};
  let response = await fetch("http://127.0.0.1:48731/status", {
    cache: "no-store",
    headers,
  });
  let payload = await response.json();
  if (response.ok && !payload.paired && savedCode) {
    response = await fetch("http://127.0.0.1:48731/pair", {
      method: "POST",
      headers,
    });
    payload = await response.json();
  }
  return { ok: response.ok, payload };
}

chrome.storage.local
  .get("pairingCode")
  .then(async ({ pairingCode: savedCode = "" }) => {
    pairingCode.value = savedCode;
    return connect(savedCode);
  })
  .then(({ ok, payload }) => {
    showStatus(
      ok && payload.paired,
      payload.paired ? "Media Scout connected" : "Pairing required",
    );
    return detectMedia();
  })
  .catch(() => {
    showStatus(false, "Open Media Scout to connect");
    renderMedia([]);
  });

pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = pairingCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    showStatus(false, "Enter the 6-digit code");
    return;
  }
  try {
    const response = await fetch("http://127.0.0.1:48731/pair", {
      method: "POST",
      headers: { "X-Media-Scout-Pairing": code },
    });
    if (!response.ok) {
      showStatus(false, "Pairing code rejected");
      return;
    }
    await chrome.storage.local.set({ pairingCode: code });
    showStatus(true, "Media Scout connected");
  } catch {
    showStatus(false, "Open Media Scout to connect");
  }
});

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  showStatus(true, "Detecting current media…");
  await detectMedia();
  captureButton.disabled = false;
});

resetButton.addEventListener("click", async () => {
  await chrome.storage.local.remove("pairingCode");
  pairingCode.value = "";
  showStatus(false, "Pairing reset");
});
