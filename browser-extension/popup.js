"use strict";

const status = document.querySelector("#status");
const statusText = document.querySelector("#statusText");
const pairForm = document.querySelector("#pairForm");
const pairingCode = document.querySelector("#pairingCode");

function showStatus(online, message) {
  status.classList.toggle("online", online);
  statusText.textContent = message;
}

fetch("http://127.0.0.1:48731/status")
  .then(async (response) => ({
    ok: response.ok,
    payload: await response.json(),
  }))
  .then(({ ok, payload }) => {
    showStatus(
      ok && payload.paired,
      payload.paired ? "Media Scout connected" : "Pairing required",
    );
  })
  .catch(() => showStatus(false, "Open Media Scout to connect"));

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
