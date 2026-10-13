"use strict";

const status = document.querySelector("#status");
const statusText = document.querySelector("#statusText");
const pairForm = document.querySelector("#pairForm");
const pairingCode = document.querySelector("#pairingCode");
const captureButton = document.querySelector("#captureButton");
const resetButton = document.querySelector("#resetButton");
const mediaResults = document.querySelector("#mediaResults");
const clientTarget = document.querySelector("#clientTarget");
const clientInfo = document.querySelector("#clientInfo");
let pairingCodes = {};
let activeCode = "";

function renderMedia(candidates) {
  mediaResults.replaceChildren();
  const urls = [...new Set(candidates)].filter((url) => /^https?:/i.test(url));
  if (!urls.length) {
    const empty = document.createElement("p");
    empty.textContent = "No media detected yet. Play a video, then scan again.";
    mediaResults.append(empty);
    return 0;
  }
  for (const url of urls.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "media-item";
    const label = document.createElement("span");
    try {
      label.textContent = new URL(url).hostname;
    } catch {
      label.textContent = "Video link";
    }
    label.title = url;
    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.textContent = "Preview";
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Download";
    const video = document.createElement("video");
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.hidden = true;
    const error = document.createElement("p");
    error.className = "preview-error";
    error.hidden = true;
    video.addEventListener("error", () => {
      error.textContent = "Preview unavailable for this link. Try Download.";
      error.hidden = false;
    });
    previewButton.addEventListener("click", () => {
      video.hidden = !video.hidden;
      previewButton.textContent = video.hidden ? "Preview" : "Hide preview";
      if (!video.src) video.src = url;
      if (!video.hidden) video.load();
      else video.pause();
    });
    download.addEventListener("click", () => {
      download.disabled = true;
      chrome.downloads.download({ url, saveAs: true });
    });
    row.append(label, previewButton, download, video, error);
    mediaResults.append(row);
  }
  return urls.length;
}

function showPaired(paired) {
  pairForm.hidden = paired;
}
function showStatus(online, message) {
  status.classList.toggle("online", online);
  statusText.textContent = message;
}

async function connect(port, code) {
  const headers = code ? { "X-Media-Scout-Pairing": code } : {};
  let response = await fetch(`http://127.0.0.1:${port}/status`, {
    cache: "no-store",
    headers,
  });
  let payload = await response.json();
  if (response.ok && !payload.paired && code) {
    response = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: "POST",
      headers,
    });
    payload = await response.json();
  }
  return { ok: response.ok, payload };
}

async function selectClient(port) {
  const code = pairingCodes[String(port)] || (port === 48731 ? activeCode : "");
  await chrome.storage.local.set({ bridgePort: port });
  pairingCode.value = code;
  try {
    const { ok, payload } = await connect(port, code);
    const flavor = payload.appChannel === "local" ? "Local dev" : "Installed";
    const version = payload.appVersion ? ` · v${payload.appVersion}` : "";
    showPaired(ok && payload.paired);
    clientInfo.textContent = `${flavor}${version} · ${ok && payload.paired ? "connected" : "pairing required"}`;
  } catch {
    showPaired(false);
    clientInfo.textContent =
      port === 48732
        ? "Local dev client · offline"
        : "Installed client · offline";
    showStatus(
      false,
      port === 48732
        ? "Local dev client is offline"
        : "Installed client is offline",
    );
  }
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

async function initialize() {
  const saved = await chrome.storage.local.get([
    "bridgePort",
    "pairingCode",
    "pairingCodes",
  ]);
  pairingCodes = saved.pairingCodes || {};
  activeCode = saved.pairingCode || "";
  if (activeCode && !pairingCodes["48731"]) pairingCodes["48731"] = activeCode;
  const statuses = await Promise.all(
    [48731, 48732].map(async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          cache: "no-store",
        });
        const payload = await response.json();
        return response.ok ? { port, payload } : null;
      } catch {
        return null;
      }
    }),
  );
  const available = statuses.filter(Boolean);
  for (const option of clientTarget.options) {
    const found = available.find((item) => item.port === Number(option.value));
    option.hidden = Boolean(available.length && !found);
    if (found)
      option.textContent = `${found.payload.appChannel === "local" ? "Local dev" : "Installed"}${found.payload.appVersion ? ` · v${found.payload.appVersion}` : ""}`;
  }
  const selected = available.some((item) => item.port === saved.bridgePort)
    ? saved.bridgePort
    : available[0]?.port || saved.bridgePort || 48731;
  clientTarget.value = String(selected);
  await selectClient(Number(selected));
  await detectMedia();
}

clientTarget.addEventListener("change", () =>
  selectClient(Number(clientTarget.value)),
);
pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const port = Number(clientTarget.value);
  const code = pairingCode.value.trim();
  if (!/^\d{6}$/.test(code)) return showStatus(false, "Enter the 6-digit code");
  try {
    const response = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: "POST",
      headers: { "X-Media-Scout-Pairing": code },
    });
    if (!response.ok) return showStatus(false, "Pairing code rejected");
    pairingCodes[String(port)] = code;
    if (port === 48731) activeCode = code;
    await chrome.storage.local.set({ pairingCode: activeCode, pairingCodes });
    await selectClient(port);
  } catch {
    showStatus(false, "Open the selected Media Scout client to connect");
  }
});
captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  showStatus(true, "Detecting current media…");
  await detectMedia();
  captureButton.disabled = false;
});
resetButton.addEventListener("click", async () => {
  const port = String(clientTarget.value);
  delete pairingCodes[port];
  if (port === "48731") activeCode = "";
  await chrome.storage.local.set({ pairingCode: activeCode, pairingCodes });
  pairingCode.value = "";
  showPaired(false);
  showStatus(false, "Pairing reset");
});

initialize().catch(() => {
  showStatus(false, "Open Media Scout to connect");
  renderMedia([]);
});
