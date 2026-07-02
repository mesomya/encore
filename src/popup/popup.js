/* popup.js — the control surface. Talks to the background worker in the real
   extension; falls back to a self-contained mock when opened as a plain page
   (so the UI can be previewed and demoed without a logged-in X session). */

const IS_EXT = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;

/* ----------------------------------------------------------------- bus ---- */
const bus = IS_EXT ? realBus() : mockBus();

function realBus() {
  return {
    send: (msg) => chrome.runtime.sendMessage(msg),
    on: (fn) => chrome.runtime.onMessage.addListener((m) => fn(m)),
  };
}

// A tiny fake backend: sample numbers from the reference, a believable sync.
function mockBus() {
  let stats = { total: 14036, likes: 9920, bookmarks: 5303 };
  let settings = {
    mixEnabled: true,
    every: 5,
    pages: 40,
    mixSources: { bookmarks: true, likes: true },
    dedupe: true,
    theme: "auto",
  };
  let meta = { lastSync: Date.now() - 1000 * 60 * 42, captured: { bookmarks: true, likes: true } };
  const listeners = [];
  const emit = (m) => listeners.forEach((fn) => fn(m));

  return {
    on: (fn) => listeners.push(fn),
    send: (msg) =>
      new Promise((resolve) => {
        switch (msg.type) {
          case "GET_STATE":
            return resolve({ stats, settings, meta, sync: { active: false } });
          case "SET_SETTINGS":
            settings = { ...settings, ...msg.patch };
            return resolve(settings);
          case "CLEAR_ARCHIVE":
            stats = { total: 0, likes: 0, bookmarks: 0 };
            return resolve({ ok: true, stats });
          case "START_SYNC": {
            resolve({ ok: true });
            const base = { total: 0, likes: 0, bookmarks: 0 };
            stats = base;
            emit({ type: "SYNC_STARTED", kind: msg.kind });
            let p = 0;
            const tick = setInterval(() => {
              p++;
              stats = {
                likes: Math.min(9920, stats.likes + 1240),
                bookmarks: Math.min(5303, stats.bookmarks + 660),
                total: 0,
              };
              stats.total = stats.likes + stats.bookmarks;
              emit({ type: "SYNC_PROGRESS", source: p % 2 ? "bookmarks" : "likes", total: stats.total, stats });
              if (p >= 8) {
                clearInterval(tick);
                stats = { total: 14036, likes: 9920, bookmarks: 5303 };
                meta = { ...meta, lastSync: Date.now() };
                emit({ type: "SYNC_DONE", result: { ok: true }, stats });
              }
            }, 320);
            return;
          }
          default:
            return resolve({ ok: true });
        }
      }),
  };
}

/* --------------------------------------------------------------- helpers -- */
const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();
const root = document.documentElement;

function relTime(ts) {
  if (!ts) return null;
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

function countUp(elm, to) {
  const from = Number(elm.dataset.val || 0) || 0;
  elm.dataset.val = to;
  // No sense animating an invisible popup — just show the number.
  if (from === to || document.hidden || typeof requestAnimationFrame !== "function") {
    elm.textContent = nf.format(to);
    return;
  }
  const start = performance.now();
  const dur = 650;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    elm.textContent = nf.format(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step);
    else elm.dataset.val = to;
  };
  requestAnimationFrame(step);
}

function setStats(stats) {
  document.querySelectorAll(".stat-n").forEach((e) => countUp(e, stats[e.dataset.key] || 0));
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/* ----------------------------------------------------------------- state -- */
let settings = {};
let syncing = false;

function applyTheme(theme) {
  root.setAttribute("data-theme", theme || "auto");
  document.querySelectorAll("#themeSeg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.themeVal === (theme || "auto"))
  );
}

function renderSettings(s) {
  settings = s;
  $("mix").setAttribute("aria-checked", String(!!s.mixEnabled));
  $("every").value = s.every;
  $("pages").value = s.pages;
  $("dedupe").setAttribute("aria-checked", String(s.dedupe !== false));
  $("srcBookmarks").checked = s.mixSources?.bookmarks !== false;
  $("srcLikes").checked = s.mixSources?.likes !== false;
  applyTheme(s.theme);
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("is-error", kind === "error");
  el.classList.toggle("is-busy", kind === "busy");
}

function setBusy(on, label) {
  syncing = on;
  ["syncBoth", "syncLikes", "syncBookmarks", "clear"].forEach((id) => ($(id).disabled = on));
  const prog = $("progress");
  prog.hidden = !on;
  if (on) {
    $("bar").classList.add("indeterminate");
    setStatus(label || "Collecting…", "busy");
  } else {
    $("bar").classList.remove("indeterminate");
  }
}

function renderHint(meta) {
  const hint = $("hint");
  const cap = meta?.captured || {};
  if (IS_EXT && !cap.bookmarks && !cap.likes) {
    hint.innerHTML =
      "<b>First time?</b> Open your Bookmarks (or Likes) page on X just once. That's all Refeed needs to start pulling in your whole history.";
    hint.className = "hint tip";
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

// "bookmarks" is X's internal name; users see it as "saved".
const srcWord = (s) => (s === "bookmarks" ? "saves" : s === "likes" ? "likes" : s);

function idleStatus(meta) {
  const rel = relTime(meta?.lastSync);
  setStatus(rel ? `Last brought back ${rel}` : "Nothing collected yet");
}

/* ------------------------------------------------------------------ load -- */
async function load() {
  const state = await bus.send({ type: "GET_STATE" });
  renderSettings(state.settings);
  setStats(state.stats);
  if (state.sync?.active) setBusy(true, "Syncing…");
  else idleStatus(state.meta);
  renderHint(state.meta);
}

/* --------------------------------------------------------------- actions -- */
async function saveSettings() {
  const patch = {
    mixEnabled: $("mix").getAttribute("aria-checked") === "true",
    every: clampInt($("every").value, 1, 50, 5),
    pages: clampInt($("pages").value, 1, 500, 40),
    dedupe: $("dedupe").getAttribute("aria-checked") === "true",
    mixSources: { bookmarks: $("srcBookmarks").checked, likes: $("srcLikes").checked },
    theme: root.getAttribute("data-theme"),
  };
  settings = await bus.send({ type: "SET_SETTINGS", patch });
}
const saveSoon = debounce(saveSettings, 350);

function clampInt(v, min, max, fallback) {
  let n = parseInt(v, 10);
  if (isNaN(n)) n = fallback;
  return Math.min(max, Math.max(min, n));
}

async function startSync(kind) {
  if (syncing) return;
  setBusy(true, kind === "both" ? "Gathering your history…" : `Gathering ${srcWord(kind)}…`);
  const res = await bus.send({ type: "START_SYNC", kind });
  if (!res || !res.ok) {
    setBusy(false);
    setStatus(res?.error || "Couldn't start — open x.com in a tab first", "error");
  }
}

/* ------------------------------------------------------------------- wire -- */
function toggleSwitch(el) {
  const next = el.getAttribute("aria-checked") !== "true";
  el.setAttribute("aria-checked", String(next));
  return next;
}

$("mix").addEventListener("click", () => {
  toggleSwitch($("mix"));
  saveSettings();
});
$("dedupe").addEventListener("click", () => {
  toggleSwitch($("dedupe"));
  saveSettings();
});
$("every").addEventListener("input", saveSoon);
$("pages").addEventListener("input", saveSoon);
$("every").addEventListener("blur", () => {
  $("every").value = clampInt($("every").value, 1, 50, 5);
});
$("pages").addEventListener("blur", () => {
  $("pages").value = clampInt($("pages").value, 1, 500, 40);
});
$("srcBookmarks").addEventListener("change", saveSettings);
$("srcLikes").addEventListener("change", saveSettings);

$("syncBoth").addEventListener("click", () => startSync("both"));
$("syncLikes").addEventListener("click", () => startSync("likes"));
$("syncBookmarks").addEventListener("click", () => startSync("bookmarks"));

$("advToggle").addEventListener("click", () => {
  const adv = $("advanced");
  adv.hidden = !adv.hidden;
  $("advToggle").classList.toggle("open", !adv.hidden);
});

document.querySelectorAll("#themeSeg button").forEach((b) =>
  b.addEventListener("click", () => {
    applyTheme(b.dataset.themeVal);
    saveSettings();
  })
);

// Two-tap confirm for the destructive clear.
let clearArmed = false;
let clearTimer = null;
const clearBtn = $("clear");
clearBtn.addEventListener("click", async () => {
  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = "Tap again to empty it";
    clearBtn.style.color = "var(--danger)";
    clearBtn.style.borderColor = "var(--danger)";
    clearTimer = setTimeout(() => {
      clearArmed = false;
      clearBtn.textContent = "Empty the library";
      clearBtn.style.color = "";
      clearBtn.style.borderColor = "";
    }, 3000);
    return;
  }
  clearTimeout(clearTimer);
  clearArmed = false;
  clearBtn.textContent = "Clear local archive";
  clearBtn.style.color = "";
  clearBtn.style.borderColor = "";
  const res = await bus.send({ type: "CLEAR_ARCHIVE" });
  setStats(res.stats || { total: 0, likes: 0, bookmarks: 0 });
  setStatus("Library emptied");
});

/* ----------------------------------------------------------- live updates - */
bus.on((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "SYNC_STARTED") {
    setBusy(true, `Gathering ${msg.kind === "both" ? "your history" : srcWord(msg.kind)}…`);
  } else if (msg.type === "SYNC_PROGRESS") {
    if (msg.stats) setStats(msg.stats);
    setStatus(`Gathering ${srcWord(msg.source)}… ${nf.format(msg.total || 0)} so far`, "busy");
  } else if (msg.type === "SYNC_DONE") {
    setBusy(false);
    if (msg.stats) setStats(msg.stats);
    if (msg.result && msg.result.ok === false) setStatus(msg.result.error || "Stopped early", "error");
    else setStatus("All caught up");
  }
});

load();
