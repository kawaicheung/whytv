const MAX_CHANNELS = 12; // dial runs 2 through 13, VHF-style
const CHANNEL_START = 2;
const STATIC_URL = chrome.runtime.getURL("static.html");

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function getChannels() {
  const { channels } = await chrome.storage.local.get("channels");
  return channels || [];
}

async function setChannels(channels) {
  await chrome.storage.local.set({ channels });
}

// Nothing here touches storage until Done is pressed. `draft` mirrors the
// 12 dial slots (index 0 = channel 2 ... index 11 = channel 13);
// `available` holds scraped-but-unplaced channels shown in the grid.
let draft = new Array(MAX_CHANNELS).fill(null);
let available = [];
// Snapshot of `draft` as loaded, so Done can tell whether anything actually
// changed before paying the cost of a full stop/relaunch.
let originalChannels = [];

async function loadDraft() {
  const saved = await getChannels();
  draft = Array.from({ length: MAX_CHANNELS }, (_, i) => saved[i] || null);
  originalChannels = draft.slice();
  available = [];
}

// Trailing-null-trimmed url list, for comparing two channel sets regardless
// of how many empty slots pad the end of each.
function channelSignature(channels) {
  const trimmed = channels.slice();
  while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop();
  return trimmed.map((ch) => (ch ? ch.url : null)).join("|");
}

function renderAll() {
  renderAvailable();
  renderSlots();
  renderCount();
}

// Three states for the initial channel scan: "scanning" (intro copy only),
// "failed" (retry message, same font as the intro), and "succeeded" (grid
// shown, title switches from the scanning blurb to the drag instructions).
let scanState = "scanning";

function renderScanState() {
  document.getElementById("setupCopy").hidden = scanState !== "scanning";
  document.getElementById("filmScratches").hidden = scanState !== "scanning";
  document.getElementById("scanFailedMsg").hidden = scanState !== "failed";
  document.getElementById("availableSection").hidden = scanState !== "succeeded";
  document.getElementById("setupTitle").textContent = scanState === "succeeded"
    ? "Drag stations over to your channels"
    : "Setting up your WhyTV";
}

function renderCount() {
  const count = draft.filter(Boolean).length;
  document.getElementById("channelCount").textContent = `${count} / ${MAX_CHANNELS} channels configured`;
}

function renderAvailable() {
  const grid = document.getElementById("availableGrid");

  if (!available.length) {
    grid.innerHTML = `<p class="available-empty">No channels found.</p>`;
    return;
  }

  available.sort((a, b) => a.label.localeCompare(b.label));

  grid.innerHTML = available.map((ch, i) => `
    <div class="available-tile" draggable="true" data-index="${i}" title="${ch.label}">${ch.label}</div>
  `).join("");

  grid.querySelectorAll(".available-tile").forEach((tile) => {
    tile.addEventListener("dragstart", (e) => {
      const index = Number(tile.dataset.index);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/json", JSON.stringify({ source: "available", index }));
    });
  });
}

function renderSlots() {
  const slotsEl = document.getElementById("slots");

  slotsEl.innerHTML = draft.map((ch, i) => `
    <div class="slot${ch ? " filled" : ""}" data-index="${i}" draggable="${ch ? "true" : "false"}">
      <span class="slot-number">${CHANNEL_START + i}</span>
      ${ch ? `<button class="slot-remove" data-index="${i}" type="button" aria-label="Remove">&times;</button><span class="slot-label">${ch.label}</span>` : ""}
    </div>
  `).join("");

  slotsEl.querySelectorAll(".slot").forEach((slotEl) => {
    const index = Number(slotEl.dataset.index);

    slotEl.addEventListener("dragstart", (e) => {
      if (!draft[index]) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/json", JSON.stringify({ source: "slot", index }));
    });

    slotEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      slotEl.classList.add("drag-over");
    });
    slotEl.addEventListener("dragleave", () => slotEl.classList.remove("drag-over"));
    slotEl.addEventListener("drop", (e) => {
      e.preventDefault();
      slotEl.classList.remove("drag-over");
      let data;
      try {
        data = JSON.parse(e.dataTransfer.getData("application/json"));
      } catch {
        return;
      }
      placeInSlot(data, index);
    });
  });

  slotsEl.querySelectorAll(".slot-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const index = Number(btn.dataset.index);
      const ch = draft[index];
      if (!ch) return;
      draft[index] = null;
      available.push(ch);
      renderAll();
    });
  });
}

// Drops a channel (from the available grid or another slot) into
// `targetIndex`, bumping whatever's already there back into the available
// grid rather than just overwriting it.
function placeInSlot(data, targetIndex) {
  let channel;
  if (data.source === "available") {
    channel = available[data.index];
    if (!channel) return;
    available.splice(data.index, 1);
  } else if (data.source === "slot") {
    if (data.index === targetIndex) return;
    channel = draft[data.index];
    if (!channel) return;
    draft[data.index] = null;
  } else {
    return;
  }

  const evicted = draft[targetIndex];
  draft[targetIndex] = channel;
  if (evicted) available.push(evicted);

  renderAll();
}

async function init() {
  await loadDraft();

  renderAll();
  renderScanState();

  async function scrapeChannels() {
    scanState = "scanning";
    renderScanState();

    const res = await send({ type: "scrapeGuide" });

    if (!res.ok || !res.channels.length) {
      scanState = "failed";
      renderScanState();
      return;
    }

    const knownUrls = new Set([
      ...draft.filter(Boolean).map((ch) => ch.url),
      ...available.map((ch) => ch.url)
    ]);
    available = available.concat(res.channels.filter((ch) => !knownUrls.has(ch.url)));

    scanState = "succeeded";
    renderScanState();
    renderAll();
  }

  document.getElementById("scanAgainLink").addEventListener("click", (e) => {
    e.preventDefault();
    scrapeChannels();
  });

  document.getElementById("rescanBtn").addEventListener("click", () => {
    scrapeChannels();
  });

  // Scan automatically on open.
  scrapeChannels();

  document.getElementById("doneBtn").addEventListener("click", async () => {
    const doneBtn = document.getElementById("doneBtn");
    doneBtn.disabled = true;

    const updated = draft.slice();
    while (updated.length && !updated[updated.length - 1]) updated.pop();
    const changed = channelSignature(draft) !== channelSignature(originalChannels);

    const res = await send({ type: "getSession" });
    const session = res.ok ? res.session : null;

    if (!session) {
      // TV's off — settings is just a standalone tab with nothing to tune
      // away to, same as it's always worked.
      if (changed) await setChannels(updated);
      window.close();
      return;
    }

    if (changed) {
      // Settings is a normal session tab now (the dial's vanity "U" slot,
      // created during launch() like any other) — background.js's stop()
      // recognizes this tab as the caller and excludes it from the sweep,
      // so this script survives to actually finish setChannels()/launch()
      // instead of being torn down mid-await by its own stop() call.
      await send({ type: "stop" });
      await setChannels(updated);
      // Relaunch into the same window so edited channels take effect
      // immediately — a fresh set of tabs built off the just-saved list,
      // rather than leaving the old ones sitting there stale. launch()
      // finds this tab still open and reuses it, same as any other.
      await send({ type: "launch", windowId: session.windowId });
    } else {
      // Nothing changed — just tune away like turning the dial to channel
      // 2, the same place a fresh power-on lands. No stop/relaunch needed,
      // and switchChannel is the same trusted mechanism used everywhere
      // else a channel changes, so there's no focus race to get wrong.
      const channels = await getChannels();
      const target = channels[0];
      await send({
        type: "switch",
        url: target ? target.url : STATIC_URL,
        number: CHANNEL_START,
        label: target ? target.label : "STATIC"
      });
    }

    doneBtn.disabled = false;
  });

  // This tab is reused across visits now instead of being recreated each
  // time (settings lives permanently at the dial's "U" slot) — resync from
  // storage whenever it becomes visible again, so tuning back in always
  // reflects what's actually saved rather than stale state left over from
  // before it was last tuned away from. Deliberately not loadDraft() here —
  // that also clears `available`, which would blank out the scan results
  // shown on the last visit even though scanState still says "succeeded".
  // Just drop whatever's since been placed into a slot instead.
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) return;
    const saved = await getChannels();
    draft = Array.from({ length: MAX_CHANNELS }, (_, i) => saved[i] || null);
    originalChannels = draft.slice();
    const placedUrls = new Set(draft.filter(Boolean).map((ch) => ch.url));
    available = available.filter((ch) => !placedUrls.has(ch.url));
    renderAll();
  });
}

init();
