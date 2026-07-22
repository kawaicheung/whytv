const osdEl = document.getElementById("osd");
function showNumber(number) {
  osdEl.textContent = String(number).padStart(2, "0");
}

// Driven entirely by storage rather than chrome.tabs.sendMessage —
// this page is an extension page, not a content script, and tabs
// messaging targets content scripts specifically. Read the current
// value on load, then react to changes for as long as this tab stays
// open, same pattern content.js already uses for filterSettings.
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) {
  chrome.storage.session.get("staticChannel").then(({ staticChannel }) => {
    if (staticChannel) showNumber(staticChannel.number);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session" || !changes.staticChannel) return;
    showNumber(changes.staticChannel.newValue.number);
  });
}

// ---------- Picture controls ----------
// Same filter formula as content.js's wrapPlayer, applied to <body> (which
// holds both the bars and the OSD number, mirroring how content.js's
// wrapper holds both the player and its OSD) so this page tracks the mini
// dials instead of always rendering at defaults.
const DEFAULT_FILTER = { color: 100, contrast: 100, brightness: 100, hue: 0, lines: 30 };

// Coupled to the TRK slider (f.lines, 0-100) rather than its own control —
// 0 at the bottom of the track means no sepia, 100 at the top caps it at
// 50%. Kept in sync with content.js's MAX_SEPIA.
const MAX_SEPIA = 0.5;

// Same scanline treatment as content.js's wrapPlayer/content.css's
// .retro-tv-wrapper::after, just targeting .bars::after (in static.html's
// inline <style>) since this page has no player wrapper of its own.
const MAX_SCANLINE_OPACITY = 0.55;

function buildFilterString(f) {
  const sepia = (f.lines / 100) * MAX_SEPIA;
  return `sepia(${sepia}) saturate(${f.color}%) contrast(${f.contrast}%) brightness(${f.brightness}%) hue-rotate(${f.hue}deg)`;
}

function applyFilter(filterSettings) {
  const f = { ...DEFAULT_FILTER, ...(filterSettings || {}) };
  document.body.style.filter = buildFilterString(f);
  document.body.style.setProperty("--scanline-opacity", (f.lines / 100) * MAX_SCANLINE_OPACITY);
}

// Renamed from "filterSettings" to leave any stale saved values behind and
// start clean on the new 5-control (incl. lines) shape and rotation math.
const FILTER_STORAGE_KEY = "filterSettingsV2";

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(FILTER_STORAGE_KEY).then(({ [FILTER_STORAGE_KEY]: filterSettings }) => applyFilter(filterSettings));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[FILTER_STORAGE_KEY]) return;
    applyFilter(changes[FILTER_STORAGE_KEY].newValue);
  });
}
