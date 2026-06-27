/*
 * background.js  —  service worker. The single source of truth.
 *
 * Owns the IndexedDB archive (lives on the extension's own origin, private to
 * it), the settings, and the sync orchestration. The popup talks only to here;
 * the content script forwards harvested tweets here and asks here for the
 * batch of items to weave into the timeline.
 */

const DB_NAME = "xhm";
const DB_VERSION = 1;
const STORE = "tweets";

const DEFAULTS = {
  mixEnabled: true,
  every: 5, // weave one saved post in after every N native posts
  pages: 40, // max pages to walk per source when syncing
  mixSources: { bookmarks: true, likes: true },
  dedupe: true, // never show the same archived post twice in a session run
  theme: "auto", // auto | dark | light
};

// ------------------------------ IndexedDB ----------------------------------
let dbPromise = null;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const os = d.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("source", "source", { unique: false });
        os.createIndex("addedAt", "addedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return db().then((d) => d.transaction(STORE, mode).objectStore(STORE));
}

async function upsertTweets(tweets, source) {
  const store = await tx("readwrite");
  const now = Date.now();
  let added = 0;
  await Promise.all(
    tweets.map(
      (t) =>
        new Promise((resolve) => {
          const getReq = store.get(t.id);
          getReq.onsuccess = () => {
            const existing = getReq.result;
            // Merge source flags so a post saved in both shows up correctly.
            const sources = new Set(existing ? existing.sources : []);
            if (!sources.has(source)) sources.add(source);
            if (!existing) added++;
            store.put({
              ...t,
              sources: [...sources],
              source: existing ? existing.source : source, // primary = first seen
              addedAt: existing ? existing.addedAt : now,
            });
            resolve();
          };
          getReq.onerror = () => resolve();
        })
    )
  );
  return added;
}

function countBy() {
  return new Promise((resolve) => {
    db().then((d) => {
      const store = d.transaction(STORE, "readonly").objectStore(STORE);
      const stats = { total: 0, bookmarks: 0, likes: 0 };
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve(stats);
        const v = c.value;
        stats.total++;
        const srcs = v.sources || [v.source];
        if (srcs.includes("bookmarks")) stats.bookmarks++;
        if (srcs.includes("likes")) stats.likes++;
        c.continue();
      };
      cursor.onerror = () => resolve(stats);
    });
  });
}

async function clearArchive() {
  const store = await tx("readwrite");
  return new Promise((resolve) => {
    const r = store.clear();
    r.onsuccess = () => resolve(true);
    r.onerror = () => resolve(false);
  });
}

// Pull a random-ish batch for weaving in. We reservoir-sample across the store
// so even a 14k archive returns a fresh mix without loading everything.
async function getMixBatch({ count, exclude = [], sources }) {
  const wanted = new Set(sources && sources.length ? sources : ["bookmarks", "likes"]);
  const excludeSet = new Set(exclude);
  const picked = [];
  let seen = 0;
  return new Promise((resolve) => {
    db().then((d) => {
      const store = d.transaction(STORE, "readonly").objectStore(STORE);
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve(picked);
        const v = c.value;
        const srcs = v.sources || [v.source];
        if (!excludeSet.has(v.id) && srcs.some((s) => wanted.has(s))) {
          seen++;
          if (picked.length < count) {
            picked.push(v);
          } else {
            const j = Math.floor(Math.random() * seen);
            if (j < count) picked[j] = v;
          }
        }
        c.continue();
      };
      cursor.onerror = () => resolve(picked);
    });
  });
}

// All archived ids for a source — handed to the collector so it can stop as
// soon as it reaches posts we already have (incremental collect).
function knownIds(source) {
  return new Promise((resolve) => {
    db().then((d) => {
      const store = d.transaction(STORE, "readonly").objectStore(STORE);
      const ids = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve(ids);
        const v = c.value;
        const srcs = v.sources || [v.source];
        if (!source || srcs.includes(source)) ids.push(v.id);
        c.continue();
      };
      cursor.onerror = () => resolve(ids);
    });
  });
}

// ------------------------------ settings -----------------------------------
async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}
async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.sync.set({ settings: next });
  // Let any open X tabs react live (toggle mixing, change cadence).
  broadcastToTabs({ type: "SETTINGS_CHANGED", settings: next });
  return next;
}

async function getMeta() {
  const r = await chrome.storage.local.get("meta");
  return r.meta || { lastSync: null, lastResult: null };
}
async function setMeta(patch) {
  const next = { ...(await getMeta()), ...patch };
  await chrome.storage.local.set({ meta: next });
  return next;
}

// ------------------------------ badge --------------------------------------
function compact(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}
async function refreshBadge() {
  const { total } = await countBy();
  await chrome.action.setBadgeBackgroundColor({ color: "#1d9bf0" });
  await chrome.action.setBadgeText({ text: total ? compact(total) : "" });
}

// --------------------------- tab messaging ---------------------------------
async function xTabs() {
  const tabs = await chrome.tabs.query({
    url: ["https://x.com/*", "https://twitter.com/*"],
  });
  return tabs;
}
async function broadcastToTabs(msg) {
  const tabs = await xTabs();
  for (const t of tabs) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
}
function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// --------------------------- script injection ------------------------------
// Manifest content scripts only attach to pages loaded *after* the extension is
// enabled. A tab that was already open — the classic "I installed it while X was
// open" case — would capture nothing until a manual refresh, the #1 first-run
// failure. So whenever we (re)start, we programmatically inject both worlds into
// every open X tab. Injection is idempotent (each script guards against running
// twice) and non-disruptive (no forced reload). The request recipe itself is
// learned at the network layer (see request capture below), so capture doesn't
// depend on this injection succeeding.
async function injectIntoTab(tabId) {
  const run = (file, world) =>
    chrome.scripting
      .executeScript({ target: { tabId }, files: [file], world, injectImmediately: true })
      .catch(() => {});
  await run("src/page-hook.js", "MAIN");
  await run("src/content.js", "ISOLATED");
  chrome.scripting.insertCSS({ target: { tabId }, files: ["src/mixer.css"] }).catch(() => {});
}
async function injectIntoOpenTabs() {
  if (!chrome.scripting) return; // very old browser — manifest scripts still apply
  try {
    const tabs = await xTabs();
    for (const t of tabs) injectIntoTab(t.id);
  } catch (_) {}
}

// --------------------------- sync orchestration ----------------------------
let syncState = { active: false, kind: null, phase: null, total: 0 };

async function startSync(kind) {
  if (syncState.active) return { ok: false, error: "A sync is already running." };
  const tabs = await xTabs();
  if (!tabs.length)
    return { ok: false, error: "Open x.com in a tab first, then sync." };

  const { pages } = await getSettings();
  syncState = { active: true, kind, phase: kind === "both" ? "bookmarks" : kind, total: 0 };
  broadcastToPopup({ type: "SYNC_STARTED", kind });

  // Drive the sync from a logged-in tab. Prefer the active one.
  const tab = tabs.find((t) => t.active) || tabs[0];
  chrome.tabs
    .sendMessage(tab.id, { type: "RUN_SYNC", kind, maxPages: pages })
    .catch(() =>
      finishSync({ ok: false, error: "Could not reach the X tab. Reload it and retry." })
    );
  return { ok: true };
}

async function finishSync(result) {
  syncState = { active: false, kind: null, phase: null, total: 0 };
  await setMeta({ lastSync: Date.now(), lastResult: result });
  await refreshBadge();
  const stats = await countBy();
  broadcastToPopup({ type: "SYNC_DONE", result, stats });
}

// --------------------------- request templates -----------------------------
// Persisted so a fresh session can collect without re-visiting Bookmarks/Likes.
async function getTemplates() {
  const r = await chrome.storage.local.get("templates");
  return r.templates || {};
}
async function storeTemplate(kind, template) {
  const all = await getTemplates();
  all[kind] = template;
  await chrome.storage.local.set({ templates: all });
  const m = await getMeta();
  await setMeta({ captured: { ...(m.captured || {}), [kind]: true } });
}

// ---------------------- request capture (network layer) --------------------
// The reliable way to learn X's Bookmarks/Likes request: observe it at the
// browser's network layer from the background, independent of any page-side
// fetch hook. The page hook can silently miss the request — X may fire it from
// a worker, the page's CSP can interfere, or it can load before injection. This
// listener can't: it sees every request the tab makes. We read the URL + the
// auth headers X already sends and persist them as a replayable template.
// Nothing is modified or blocked — this is read-only observation.
const CAP_GQL_RE = /\/i\/api\/graphql\/[^/]+\/([^/?]+)/;

function classifyOp(opName) {
  const n = (opName || "").toLowerCase();
  if (n.includes("folder")) return null; // folder lists carry no timeline
  if (n.includes("bookmark")) return "bookmarks";
  if (n.includes("like") && !n.includes("liker") && !n.includes("dislike") && !n.includes("unlike"))
    return "likes";
  return null;
}

function templateFromRequest(kind, url, headers) {
  const u = new URL(url);
  let variables = {};
  let features = {};
  let fieldToggles = null;
  try { variables = JSON.parse(u.searchParams.get("variables") || "{}"); } catch (_) {}
  try { features = JSON.parse(u.searchParams.get("features") || "{}"); } catch (_) {}
  if (u.searchParams.get("fieldToggles")) fieldToggles = u.searchParams.get("fieldToggles");
  return {
    kind,
    base: u.origin + u.pathname, // /i/api/graphql/<qid>/<Op>
    headers,
    variables,
    features,
    fieldToggles,
    userId: variables.userId || null,
  };
}

// onBeforeRequest gives us the URL; onSendHeaders (a moment later) gives us the
// headers for that same request id. We stitch the two together.
const capPending = new Map(); // requestId -> kind
function setupRequestCapture() {
  if (!chrome.webRequest) return; // not a Chromium build with webRequest — page hook still applies
  const urls = ["https://x.com/i/api/graphql/*", "https://twitter.com/i/api/graphql/*"];
  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.method !== "GET") return; // reads only; bookmark/unbookmark are POSTs
      const m = d.url.match(CAP_GQL_RE);
      if (!m) return;
      const kind = classifyOp(m[1]);
      if (kind) capPending.set(d.requestId, kind);
    },
    { urls }
  );
  chrome.webRequest.onSendHeaders.addListener(
    (d) => {
      const kind = capPending.get(d.requestId);
      if (!kind) return;
      capPending.delete(d.requestId);
      const headers = {};
      for (const h of d.requestHeaders || []) {
        const name = h.name.toLowerCase();
        if (name === "cookie") continue; // the browser re-attaches this on replay
        headers[name] = h.value;
      }
      // Need at least the bearer token to be worth replaying.
      if (!headers["authorization"]) return;
      storeTemplate(kind, templateFromRequest(kind, d.url, headers)).catch(() => {});
    },
    { urls },
    ["requestHeaders", "extraHeaders"]
  );
}
setupRequestCapture();

// ------------------------------ messages -----------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "CAPTURE_STATUS": {
        // Merge — once we've learned a source (incl. a persisted template),
        // keep it marked even if a fresh page reports nothing captured yet.
        const m = await getMeta();
        const prev = m.captured || {};
        const cap = msg.captured || {};
        await setMeta({
          captured: {
            bookmarks: !!(prev.bookmarks || cap.bookmarks),
            likes: !!(prev.likes || cap.likes),
          },
          userId: msg.userId || m.userId || null,
        });
        sendResponse({ ok: true });
        break;
      }
      case "STORE_TEMPLATE": {
        if (msg.template) await storeTemplate(msg.kind, msg.template);
        sendResponse({ ok: true });
        break;
      }
      case "GET_TEMPLATES": {
        sendResponse(await getTemplates());
        break;
      }
      case "GET_STATE": {
        sendResponse({
          stats: await countBy(),
          settings: await getSettings(),
          meta: await getMeta(),
          sync: syncState,
        });
        break;
      }
      case "SET_SETTINGS": {
        sendResponse(await setSettings(msg.patch));
        break;
      }
      case "START_SYNC": {
        sendResponse(await startSync(msg.kind));
        break;
      }
      case "STORE_TWEETS": {
        // From content script during a sync (or passive harvest).
        await upsertTweets(msg.tweets || [], msg.source);
        if (msg.progress) {
          syncState.total = msg.totalSoFar || syncState.total;
          syncState.phase = msg.source;
          broadcastToPopup({
            type: "SYNC_PROGRESS",
            source: msg.source,
            page: msg.page,
            total: msg.totalSoFar,
            stats: await countBy(),
          });
        } else {
          // passive harvest — keep the badge fresh
          refreshBadge();
        }
        sendResponse({ ok: true });
        break;
      }
      case "SYNC_COMPLETE": {
        await finishSync({ ok: true, kind: msg.kind, counts: msg.counts });
        sendResponse({ ok: true });
        break;
      }
      case "SYNC_FAILED": {
        await finishSync({ ok: false, error: msg.error, kind: msg.kind });
        sendResponse({ ok: true });
        break;
      }
      case "GET_MIX_BATCH": {
        sendResponse(await getMixBatch(msg));
        break;
      }
      case "GET_KNOWN_IDS": {
        sendResponse(await knownIds(msg.source));
        break;
      }
      case "CLEAR_ARCHIVE": {
        await clearArchive();
        await refreshBadge();
        sendResponse({ ok: true, stats: await countBy() });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async response
});

chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
  // Reach back into any X tab that was already open when we were installed/
  // updated and attach the capture hook now, without reloading it out from
  // under the user. This is the #1 first-run gotcha on a fresh machine.
  injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(() => {
  refreshBadge();
  injectIntoOpenTabs();
});
refreshBadge();
// Worker (re)start — also covers the user enabling the extension with X already
// open. Runs once per worker lifetime; re-injection is a guarded no-op.
injectIntoOpenTabs();
