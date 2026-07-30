"use strict";

const status = document.querySelector("#status");
const statusText = document.querySelector("#statusText");

fetch("http://127.0.0.1:48731/status")
  .then((response) => {
    status.classList.toggle("online", response.ok);
    statusText.textContent = response.ok ? "Media Scout connected" : "Media Scout unavailable";
  })
  .catch(() => {
    status.classList.remove("online");
    statusText.textContent = "Open Media Scout to connect";
  });
