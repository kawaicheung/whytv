// Runs on tv.youtube.com. Wraps <ytu-player-controller> in a div so we can
// apply a filter (and later, scanlines/vignette overlays) without touching
// YouTube's own DOM structure. The wrapper's filter affects the element's
// full rendered output, shadow DOM included, since CSS filter composites the
// whole box regardless of what's inside it.

const TARGET_SELECTOR = "ytu-player-controller";
const WRAPPER_CLASS = "retro-tv-wrapper";
const OSD_CLASS = "retro-tv-osd";
const DEFAULT_FILTER = { color: 100, contrast: 100, brightness: 100, hue: 0, lines: 30 };
const MAX_SCANLINE_OPACITY = 0.55;

let currentFilter = DEFAULT_FILTER;
let osdEl = null;
let osdTimeout = null;

function ensureFontLoaded() {
  if (document.getElementById("retro-tv-font")) return;
  const link = document.createElement("link");
  link.id = "retro-tv-font";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=VT323&display=swap";
  document.head.appendChild(link);
}
ensureFontLoaded();

function ensureOsdElement(wrapper) {
  if (osdEl && wrapper.contains(osdEl)) return osdEl;
  osdEl = document.createElement("div");
  osdEl.className = OSD_CLASS;
  wrapper.appendChild(osdEl);
  return osdEl;
}

function showChannelOSD(label, number) {
  const wrapper = document.querySelector("." + WRAPPER_CLASS);
  if (!wrapper) return;
  const el = ensureOsdElement(wrapper);
  el.textContent = `${String(number).padStart(2, "0")}-${label}`;
  el.classList.add("show");
  clearTimeout(osdTimeout);
  osdTimeout = setTimeout(() => el.classList.remove("show"), 5000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "channelOSD") showChannelOSD(msg.label, msg.number);
});

// ---------- Guide scraping (Settings > Find channels) ----------
// tv.youtube.com's guide rows are Polymer custom elements built with Shady
// DOM, so a plain querySelectorAll from document won't see into elements
// that do have a real shadowRoot — walk down through any we find.
function deepQueryAll(selector, root = document) {
  let results = [...root.querySelectorAll(selector)];
  root.querySelectorAll("*").forEach((el) => {
    if (el.shadowRoot) results = results.concat(deepQueryAll(selector, el.shadowRoot));
  });
  return results;
}

// Each guide row's "watch" endpoint carries an aria-label of "watch <name>"
// right next to the watch link itself — cheaper than correlating it with
// the separate sibling element that shows the channel logo/title.
function scrapeGuideChannels() {
  return deepQueryAll('ytu-endpoint.tenx-thumb[aria-label]')
    .map((endpoint) => {
      const link = endpoint.querySelector('a[href*="watch/"]');
      if (!link) return null;
      return {
        label: endpoint.getAttribute("aria-label").replace(/^watch\s+/i, ""),
        url: new URL(link.getAttribute("href"), location.origin).href
      };
    })
    .filter(Boolean);
}

// Guide rows render lazily after the SPA boots, so poll briefly rather than
// scraping the instant the message arrives.
function waitForGuideChannels(timeoutMs = 8000, intervalMs = 300) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function poll() {
      const found = scrapeGuideChannels();
      if (found.length > 0 || Date.now() - start > timeoutMs) resolve(found);
      else setTimeout(poll, intervalMs);
    })();
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "scrapeGuide") return;
  waitForGuideChannels().then((channels) => sendResponse({ ok: true, channels }));
  return true; // async response
});

// Coupled to the TRK slider (f.lines, 0-100) rather than its own control —
// 0 at the bottom of the track means no sepia, 100 at the top caps it at
// 50%, so tracking distortion and the warm tube cast ride together.
const MAX_SEPIA = 0.5;

function buildFilterString(f) {
  // saturate() is the real "color knob": 0% is true black-and-white, 100% is
  // normal color, past that is punchy. Everything else (contrast/brightness/
  // hue) layers on top.
  const sepia = (f.lines / 100) * MAX_SEPIA;
  return `sepia(${sepia}) saturate(${f.color}%) contrast(${f.contrast}%) brightness(${f.brightness}%) hue-rotate(${f.hue}deg)`;
}

function wrapPlayer() {
  const target = document.querySelector(TARGET_SELECTOR);
  if (!target) return;

  let wrapper = target.parentElement;
  if (!wrapper || !wrapper.classList.contains(WRAPPER_CLASS)) {
    wrapper = document.createElement("div");
    wrapper.className = WRAPPER_CLASS;
    target.parentNode.insertBefore(wrapper, target);
    wrapper.appendChild(target);
  }
  wrapper.style.filter = buildFilterString(currentFilter);
  // Drives .retro-tv-wrapper::after's scanline overlay in content.css — a
  // CSS var rather than a filter() term since it's painting stripes on top
  // of the frame, not transforming the video's own pixels.
  wrapper.style.setProperty("--scanline-opacity", (currentFilter.lines / 100) * MAX_SCANLINE_OPACITY);
}

// Renamed from "filterSettings" to leave any stale saved values behind and
// start clean on the new 5-control (incl. lines) shape and rotation math.
const FILTER_STORAGE_KEY = "filterSettingsV2";

async function loadFilterSettings() {
  const { [FILTER_STORAGE_KEY]: filterSettings } = await chrome.storage.local.get(FILTER_STORAGE_KEY);
  currentFilter = { ...DEFAULT_FILTER, ...(filterSettings || {}) };
  wrapPlayer();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[FILTER_STORAGE_KEY]) return;
  currentFilter = { ...DEFAULT_FILTER, ...changes[FILTER_STORAGE_KEY].newValue };
  wrapPlayer();
});

loadFilterSettings();
wrapPlayer();

const observer = new MutationObserver(() => wrapPlayer());
observer.observe(document.documentElement, { childList: true, subtree: true });
