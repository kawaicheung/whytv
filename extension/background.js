// Owns the live TV session: which window, which tabs, which channel is active.
// The side panel re-fetches this on load/re-render (it has no state of its own).
//
// Session shape: { windowId, tabsByUrl: { [channelUrl]: tabId }, activeUrl }

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

const CHANNEL_START = 2; // dial runs 2..13, matches sidepanel.js
const MAX_CHANNELS = 12; // dial has 12 slots (numbers 2..13), matches sidepanel.js

// Dead-air channel: any dial slot without a configured URL still tunes to
// this shared page instead of being unreachable. One tab serves every empty
// slot, same as any other channel would share a tab if it were reused.
const STATIC_URL = chrome.runtime.getURL("static.html");
const SETTINGS_URL = chrome.runtime.getURL("settings.html");

// `number` is the dial position (2..13) each channel lands on. Numbers don't
// need to be contiguous — leave gaps for channels you haven't assigned yet.
const DEFAULT_CHANNELS = [
];

// Places each default at the dial slot its `number` maps to, leaving null
// gaps in between for any numbers that were skipped.
function buildDefaultChannels(entries) {
  if (entries.length === 0) return [];
  const maxIndex = Math.max(...entries.map(({ number }) => number - CHANNEL_START));
  const channels = new Array(maxIndex + 1).fill(null);
  for (const { number, label, url } of entries) {
    const index = number - CHANNEL_START;
    if (index < 0 || index >= MAX_CHANNELS) {
      console.error(`channel number ${number} is out of dial range, skipping`, label);
      continue;
    }
    channels[index] = { label, url };
  }
  return channels;
}

chrome.runtime.onInstalled.addListener(async () => {
  const { channels } = await chrome.storage.local.get("channels");
  if (!channels) {
    await chrome.storage.local.set({ channels: buildDefaultChannels(DEFAULT_CHANNELS) });
  }
});

const SESSION_KEY = "session";

async function getSession() {
  const { session } = await chrome.storage.session.get(SESSION_KEY);
  return session || null;
}

async function setSession(session) {
  await chrome.storage.session.set({ [SESSION_KEY]: session });
}

async function clearSession() {
  await chrome.storage.session.remove(SESSION_KEY);
}

const STATIC_CHANNEL_KEY = "staticChannel";

// static.html can't be reverse-mapped to "which slot" from the tab/session
// state alone (every empty slot shares the one STATIC_URL tab), so whatever
// number/label it should currently show is persisted here. The page reads
// this on load — covering the case where it wasn't listening yet when the
// live channelOSD message went out — and also gets that message live for
// any later switch while it stays open.
async function setStaticChannel(number, label) {
  await chrome.storage.session.set({ [STATIC_CHANNEL_KEY]: { number, label } });
}

async function getChannels() {
  const { channels } = await chrome.storage.local.get("channels");
  return channels || [];
}

// Tells the tab that just became the active channel to flash its OSD banner.
// Best-effort: if the content script isn't listening yet (tab still loading
// right after creation), the message silently fails and no banner shows —
// acceptable for that one edge case rather than adding retry complexity.
// Only used for the tab launch() lands on first — switchChannel gets its
// number/label straight from the caller instead, since a shared static tab
// can't be reverse-looked-up by url the way a real channel can.
async function announceChannel(tabId, url) {
  const channels = await getChannels();
  const index = channels.findIndex((ch) => ch && ch.url === url);
  // Unmatched (the static tab, when nothing is configured yet) falls back
  // to channel 2 — same default slot the side panel itself lands on.
  const number = index === -1 ? CHANNEL_START : index + CHANNEL_START;
  const label = index === -1 ? "STATIC" : channels[index].label;
  if (url === STATIC_URL) await setStaticChannel(number, label);
  chrome.tabs.sendMessage(tabId, { type: "channelOSD", label, number }).catch(() => {});
}

// Resolves once a tab reports load status "complete" (or after timeoutMs,
// so a stalled load can't hang launch() forever).
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => cleanup() || resolve(), timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") cleanup() || resolve();
    }
    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function launch(windowId) {
  const channels = (await getChannels()).filter(Boolean);
  // No "nothing configured" bailout — with zero real channels the set below
  // still includes the static page, so there's always at least one tab to
  // launch into.

  const existingTabs = await chrome.tabs.query({ windowId });
  const tabsByUrl = {};

  // The static page and settings are appended once here, alongside the real
  // channels — any empty dial slot switches to the shared static tab rather
  // than needing one of its own, and settings is just another tab in the
  // rotation (the vanity "U" slot) instead of a one-off tab created and torn
  // down on every visit.
  for (const channel of [...channels, { label: "STATIC", url: STATIC_URL }, { label: "SETTINGS", url: SETTINGS_URL }]) {
    if (channel.url in tabsByUrl) continue; // already handled (e.g. static, deduped)
    const match = existingTabs.find((t) => t.url === channel.url);
    if (match) {
      tabsByUrl[channel.url] = match.id;
    } else {
      // tv.youtube.com defers its initial player layout/reveal until the
      // tab is genuinely visible — that's Chrome's own background-tab
      // render throttle, not something a content script can fake. So each
      // freshly created tab is made active (not backgrounded) here and
      // held until it finishes loading, letting that reveal play out now
      // instead of on the viewer's first real switch to it. This is what
      // causes the brief flicker through channels on power-on.
      // Created muted so its autoplay attempt qualifies for Chrome's
      // muted-autoplay exemption — unmuted, it's not a real user gesture,
      // Chrome blocks the audible autoplay, and the player falls back to a
      // "press play" prompt instead of starting on its own. The active
      // channel gets unmuted below once every tab has settled.
      const tab = await chrome.tabs.create({ windowId, url: channel.url, active: true });
      tabsByUrl[channel.url] = tab.id;
      // `muted` isn't a valid tabs.create property — has to be set via a
      // follow-up update, done immediately (before awaiting the page load)
      // so it's in effect before the player's own autoplay attempt fires.
      await chrome.tabs.update(tab.id, { muted: true });
      await waitForTabComplete(tab.id);
    }
    // Broadcast per-channel so the side panel can light up each dial number
    // the moment its own tab is ready, in step with the flicker above,
    // instead of waiting for the whole launch() loop (all channels) to
    // finish before anything lights up.
    chrome.runtime.sendMessage({ type: "channelLoaded", url: channel.url }).catch(() => {});
  }

  const activeUrl = channels[0] ? channels[0].url : STATIC_URL;
  const entries = Object.entries(tabsByUrl);
  await Promise.all(entries.map(([url, tabId]) =>
    chrome.tabs.update(tabId, { muted: url !== activeUrl, active: url === activeUrl }).catch(() => {})
  ));

  const groupId = await groupChannelTabs(windowId, Object.values(tabsByUrl));

  const session = { windowId, tabsByUrl, activeUrl, groupId };
  await setSession(session);

  // The tab was just created — give its content script a moment to load
  // before trying to message it.
  setTimeout(() => announceChannel(tabsByUrl[activeUrl], activeUrl), 800);
  checkTvFocus();

  return { ok: true, session };
}

// Whether the tab the user is actually looking at right now is part of the
// TV (a channel tab, the shared static tab — already just another entry in
// tabsByUrl — or the settings tab) rather than something unrelated they
// clicked or opened over top of it.
function isKnownTab(tab, session) {
  if (!tab || !session) return false;
  return Object.values(session.tabsByUrl).includes(tab.id) || tab.url === SETTINGS_URL;
}

async function getTvFocus(session) {
  session = session || (await getSession());
  if (!session) return { ok: true, away: false };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { ok: true, away: !isKnownTab(tab, session) };
}

// Lets the side panel park the dial's rotor at the vanity "U" slot whenever
// focus wanders off the TV — a lightweight "you've tabbed away" signal, kept
// separate from the session itself, which stays live and untouched.
async function checkTvFocus() {
  const session = await getSession();
  if (!session) return;
  const { away } = await getTvFocus(session);
  chrome.runtime.sendMessage({ type: "tvFocusChanged", away }).catch(() => {});
}

// Puts every channel tab into one named, colored group. Reuses the previous
// group if it still exists (so relaunching/adding channels doesn't fragment
// into multiple groups); otherwise creates a fresh one.
async function groupChannelTabs(windowId, tabIds) {
  const prevSession = await getSession();
  let groupId = prevSession && prevSession.windowId === windowId ? prevSession.groupId : undefined;

  if (groupId != null) {
    try {
      await chrome.tabGroups.get(groupId);
    } catch {
      groupId = undefined; // group no longer exists
    }
  }

  try {
    groupId = await chrome.tabs.group({ tabIds, groupId });
    await chrome.tabGroups.update(groupId, {
      title: "WHYTV",
      color: "orange",
      collapsed: false
    });
  } catch (err) {
    console.error("tab grouping failed:", err);
    return null;
  }

  return groupId;
}

async function switchChannel(url, number, label) {
  const session = await getSession();
  if (!session) return { ok: false, error: "no-session" };
  if (!(url in session.tabsByUrl)) return { ok: false, error: "unknown-channel" };
  // Already there — skip the mute/focus/OSD churn. Also what makes this
  // safe to call defensively (e.g. re-asserting the active channel after
  // closing settings) without side effects when nothing actually needs to
  // change. Excludes STATIC_URL: every empty slot shares that one url, so
  // "already there" doesn't mean "already on this particular slot" — those
  // still need to fall through and re-announce the right number/label.
  if (url === session.activeUrl && url !== STATIC_URL) return { ok: true, session };

  // Persist the new activeUrl *before* activating the tab. Activation fires
  // tabs.onActivated below, which re-reads the session to detect manual tab
  // clicks — if that read still saw the old activeUrl, it would think this
  // was a manual click, re-save, and broadcast a redundant sessionChanged
  // that made the side panel re-render mid-animation.
  session.activeUrl = url;
  await setSession(session);

  const entries = Object.entries(session.tabsByUrl);
  await Promise.all(entries.map(([chUrl, tabId]) =>
    chrome.tabs.update(tabId, { muted: chUrl !== url, active: chUrl === url }).catch(() => {})
  ));
  await chrome.windows.update(session.windowId, { focused: true });

  // Sent straight from the caller rather than looked up here — a shared
  // static tab can't be reverse-mapped to "which slot" the way a real
  // channel's url can (every empty slot points at the same STATIC_URL).
  if (url === STATIC_URL) await setStaticChannel(number, label);
  chrome.tabs.sendMessage(session.tabsByUrl[url], { type: "channelOSD", label, number }).catch(() => {});
  return { ok: true, session };
}

const GUIDE_URL = "https://tv.youtube.com/live";

// Backs the Settings "Find channels" button. Opens a throwaway background
// tab to the guide (rides on whatever tv.youtube.com session already exists
// in the browser — no separate auth), asks content.js's scraper to read it,
// then closes the tab either way.
async function scrapeChannels() {
  const tab = await chrome.tabs.create({ url: GUIDE_URL, active: false });

  try {
    await new Promise((resolve) => {
      function onUpdated(tabId, info) {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });

    // The tab reporting "complete" doesn't guarantee content.js has
    // registered its listener yet — retry the send instead of guessing a
    // fixed delay.
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        res = await chrome.tabs.sendMessage(tab.id, { type: "scrapeGuide" });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return res && res.ok ? { ok: true, channels: res.channels } : { ok: false, error: "scrape-failed" };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function stop(exceptTabId) {
  const session = await getSession();
  const sessionTabIds = session ? Object.values(session.tabsByUrl) : [];

  // OFF should mean everything's actually off — sweep up every
  // tv.youtube.com tab (any path: /live, /watch/..., whatever), not just
  // the ones this particular session happens to know about. Covers tabs
  // opened by hand, leftovers from a stale/crashed session, etc.
  const strayTabs = await chrome.tabs.query({ url: "https://tv.youtube.com/*" });
  // Settings is now a normal session tab, which means a "changed channels"
  // save (settings.js calling stop() then launch()) can trigger this while
  // its own tab is one of the ones being swept — excluding the caller's own
  // tab id keeps that script alive to finish the job instead of closing out
  // from under itself. launch() finds it still open afterward and reuses it
  // like any other tab, same as before this ever ran.
  const tabIds = [...new Set([...sessionTabIds, ...strayTabs.map((t) => t.id)])]
    .filter((id) => id !== exceptTabId);

  if (session) {
    // Clear first, then remove: removing a tab fires tabs.onRemoved, whose
    // listener below reads the session and writes it back (to drop that
    // tab from a still-live session). If that write landed after this
    // cleared the session, it would resurrect a phantom one — clearing
    // first means that listener already sees no session and bails out.
    await clearSession();
  }

  if (tabIds.length) {
    try { await chrome.tabs.remove(tabIds); } catch {}
  }

  if (session) {
    // Settings now lives in its own tab and can trigger a stop (forcing the
    // TV off after a channel edit) while the side panel is showing the dial
    // — let it know the session's gone rather than leaving it stuck showing
    // a channel that's no longer live.
    chrome.runtime.sendMessage({ type: "sessionChanged", session: null }).catch(() => {});
  }

  return { ok: true };
}

// If the user clicks a channel tab directly instead of using the remote,
// keep the session's notion of "active channel" honest and tell the panel.
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const session = await getSession();
  if (!session || session.windowId !== windowId) return;

  const entry = Object.entries(session.tabsByUrl).find(([, id]) => id === tabId);
  if (!entry) return; // activated tab isn't one of our channels — leave it alone
  const [url] = entry;
  if (url === session.activeUrl) return;

  await Promise.all(Object.entries(session.tabsByUrl).map(([chUrl, id]) =>
    chUrl === url ? Promise.resolve() : chrome.tabs.update(id, { muted: true }).catch(() => {})
  ));
  await chrome.tabs.update(tabId, { muted: false }).catch(() => {});

  session.activeUrl = url;
  await setSession(session);
  announceChannel(tabId, url);
  chrome.runtime.sendMessage({ type: "sessionChanged", session }).catch(() => {});
});

// If a channel tab gets closed manually, drop it from the session so dedupe
// and the remote's "active" state don't point at a dead tab.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSession();
  if (!session) return;
  const entry = Object.entries(session.tabsByUrl).find(([, id]) => id === tabId);
  if (!entry) return;

  const [url] = entry;
  delete session.tabsByUrl[url];
  if (session.activeUrl === url) {
    const remaining = Object.keys(session.tabsByUrl);
    session.activeUrl = remaining[0] || null;
  }
  await setSession(session);
  chrome.runtime.sendMessage({ type: "sessionChanged", session }).catch(() => {});
});

// Any of these can change which tab the user is actually looking at —
// switching tabs, switching windows (including away from Chrome entirely,
// which reports back to whatever tab/window Chrome had focused last), or a
// tab navigating to a new URL while it's the active one.
chrome.tabs.onActivated.addListener(checkTvFocus);
chrome.windows.onFocusChanged.addListener(checkTvFocus);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) checkTvFocus();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "launch") sendResponse(await launch(msg.windowId));
    else if (msg.type === "switch") sendResponse(await switchChannel(msg.url, msg.number, msg.label));
    else if (msg.type === "stop") sendResponse(await stop(sender.tab ? sender.tab.id : null));
    else if (msg.type === "getTvFocus") sendResponse(await getTvFocus());
    else if (msg.type === "scrapeGuide") sendResponse(await scrapeChannels());
    else if (msg.type === "getSession") sendResponse({ ok: true, session: await getSession() });
    else sendResponse({ ok: false, error: "unknown-message" });
  })();
  return true; // async response
});
