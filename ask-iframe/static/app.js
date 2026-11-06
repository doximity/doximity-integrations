"use strict";

const sessionPanel = document.getElementById("session-panel");
const errorBanner = document.getElementById("error-banner");
const askFrame = document.getElementById("ask-frame");

// One example launch per button — the payloads are hardcoded in the backend
// (LAUNCH_VARIANTS in main.py). Every launch mints a fresh single-use magic
// link and opens a fresh chat. Blank chat is the default tab.
const variantButtons = [...document.querySelectorAll(".header-actions button")];
let activeVariant = "blank";

function setActiveVariant(variant) {
  activeVariant = variant;
  for (const button of variantButtons) {
    button.classList.toggle("active", button.dataset.variant === variant);
  }
}
setActiveVariant(activeVariant);

for (const button of variantButtons) {
  button.addEventListener("click", () => {
    setActiveVariant(button.dataset.variant);
    mintLaunch(button.dataset.variant);
  });
}

// The default tab launches on page load: a fresh single-use magic link is
// minted just-in-time, per the launch lifecycle.
mintLaunch(activeVariant);

async function mintLaunch(variant) {
  errorBanner.hidden = true;
  for (const button of variantButtons) {
    button.disabled = true;
  }

  let response;
  try {
    response = await fetch("/api/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant }),
    });
  } catch (err) {
    showFailure("Could not reach the server. Is the backend running?");
    return;
  }

  const payload = await response.json().catch(() => null);
  for (const button of variantButtons) {
    button.disabled = false;
  }

  if (!response.ok) {
    const message =
      payload && payload.error && payload.error.message
        ? payload.error.message
        : `Launch failed with status ${response.status}`;
    showFailure(message);
    return;
  }

  // The launch URL is a single-use secret: set it straight into the frame,
  // never persist or log it.
  askFrame.src = payload.url;
  sessionPanel.hidden = false;
}

function showFailure(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}
