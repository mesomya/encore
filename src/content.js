/*
 * content.js  —  runs in the ISOLATED world on x.com.
 *
 * Two jobs:
 *   1. Bridge — relay between the page hook (MAIN world) and the background
 *      worker. Sync commands flow down; harvested tweets flow up.
 *   2. Weave — quietly drop archived posts into the home timeline as the user
 *      scrolls, each tagged with where it came from.
 *
 * Injection note: X's timeline is a virtualized React list. Fighting it with
 * sibling cells loses (React recycles them). Instead we append our card *inside*
 * an existing tweet cell — X runs a ResizeObserver on each cell, so it measures
 * the new height and repositions everything below it for us. When the host cell
 * scrolls off and unmounts, our card goes with it; scroll back and we re-weave.
 */
(() => {
  "use strict";

  // Installed once per tab. Like the page hook, we can be injected twice (once
  // by the manifest, once by the worker into an already-open tab) — bail on the
  // second so we don't register duplicate listeners or run two weavers.
  if (window.__REFEED_CONTENT__) return;
  window.__REFEED_CONTENT__ = true;

  const PAGE = "xhm-page";
  const CONTENT = "xhm-content";

  let settings = {
    mixEnabled: true,
    every: 5,
    mixSources: { bookmarks: true, likes: true },
    dedupe: true,
  };

  // ---------------------------------------------------------------- bridge ---
  function toPage(msg) {
    window.postMessage({ source: CONTENT, ...msg }, "*");
  }

  // All background messaging funnels through here. chrome.runtime.sendMessage
  // throws *synchronously* ("Extension context invalidated") if the extension
  // was reloaded/updated while this tab stayed open — a plain .catch() can't
  // stop that. We guard the call, and once the context is gone we go quiet until
  // the tab is refreshed (which injects a fresh, reconnected content script).
  let contextLost = false;
  let routePoll = null;
  function bg(msg) {
    if (contextLost) return Promise.resolve(null);
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        onContextLost();
        return Promise.resolve(null);
      }
      const p = chrome.runtime.sendMessage(msg);
      return p && typeof p.then === "function" ? p.catch(() => null) : Promise.resolve(p);
    } catch (_) {
      onContextLost();
      return Promise.resolve(null);
    }
  }
  function onContextLost() {
    if (contextLost) return;
    contextLost = true;
    try { clearInterval(routePoll); } catch (_) {}
    try { observer.disconnect(); } catch (_) {}
    try { animObserver.disconnect(); } catch (_) {}
  }

  // RPC wrapper around the page hook's paginated sync.
  function pageSync(kind, maxPages, template, silent, knownIds) {
    return new Promise((resolve, reject) => {
      const requestId = "rq_" + Math.random().toString(36).slice(2);
      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.source !== PAGE || d.requestId !== requestId) return;
        if (d.type === "PAGE") {
          bg({
            type: "STORE_TWEETS",
            tweets: d.tweets,
            source: kind,
            progress: !silent,
            page: d.page,
            totalSoFar: d.total,
          });
        } else if (d.type === "SYNC_DONE") {
          window.removeEventListener("message", onMsg);
          resolve({ total: d.total });
        } else if (d.type === "SYNC_ERROR") {
          window.removeEventListener("message", onMsg);
          reject(new Error(d.message));
        }
      };
      window.addEventListener("message", onMsg);
      toPage({ type: "SYNC", kind, maxPages, requestId, template, knownIds });
    });
  }

  async function runSync(kind, maxPages) {
    const phases = kind === "both" ? ["bookmarks", "likes"] : [kind];
    // Hand the hook any persisted templates so it can collect without the
    // bookmarks/likes page being open this session.
    let saved = {};
    try {
      saved = (await bg({ type: "GET_TEMPLATES" })) || {};
    } catch (_) {}
    const counts = {};
    let anyOk = false;
    let lastErr = null;
    for (const ph of phases) {
      let known = [];
      try {
        known = (await bg({ type: "GET_KNOWN_IDS", source: ph })) || [];
      } catch (_) {}
      try {
        const r = await pageSync(ph, maxPages, saved[ph], false, known);
        counts[ph] = r.total;
        anyOk = true;
      } catch (e) {
        counts[ph] = "error";
        lastErr = e.message || String(e);
      }
    }
    if (anyOk) bg({ type: "SYNC_COMPLETE", kind, counts });
    else bg({ type: "SYNC_FAILED", kind, error: lastErr });
  }

  // Collection is manual-only: the user runs it from the popup (RUN_SYNC).
  // Request recipes are still learned passively in the background — see the
  // webRequest capture in background.js — so the popup's collect just works
  // once you've visited your Bookmarks/Likes page. Nothing collects or pops up
  // on its own.

  // Messages coming up from the page hook.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== PAGE) return;
    if (d.type === "HARVEST") {
      bg({ type: "STORE_TWEETS", tweets: d.tweets, source: d.source, progress: false });
    } else if (d.type === "STATUS" || d.type === "CAPTURED") {
      bg({ type: "CAPTURE_STATUS", captured: d.captured, userId: d.userId });
    } else if (d.type === "TEMPLATE") {
      bg({ type: "STORE_TEMPLATE", kind: d.kind, template: d.template });
    }
  });

  // Commands coming down from the background / popup.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "RUN_SYNC") runSync(msg.kind, msg.maxPages);
    else if (msg.type === "SETTINGS_CHANGED") {
      settings = { ...settings, ...msg.settings };
      if (!settings.mixEnabled) removeAllCards();
    }
  });

  // ----------------------------------------------------------------- weave ---
  const queue = [];
  const shownIds = new Set();
  let refilling = false;
  let tweetOrdinal = 0;
  // Set when a due card was held back because its slot fell mid-conversation;
  // the card is dealt at the first standalone post instead.
  let pendingInject = false;

  const isHome = () => /^\/(home)?$/.test(location.pathname);

  function enabledSources() {
    const s = settings.mixSources || {};
    return ["bookmarks", "likes"].filter((k) => s[k] !== false);
  }

  async function refill() {
    if (refilling || queue.length >= 6) return;
    refilling = true;
    try {
      const exclude = settings.dedupe ? [...shownIds].slice(-600) : [];
      const batch = await bg({
        type: "GET_MIX_BATCH",
        count: 25,
        exclude,
        sources: enabledSources(),
      });
      for (const t of batch || []) {
        if (!settings.dedupe || !shownIds.has(t.id)) queue.push(t);
      }
    } catch (_) {
    } finally {
      refilling = false;
    }
  }

  function nextItem() {
    refill();
    while (queue.length) {
      const t = queue.shift();
      if (settings.dedupe && shownIds.has(t.id)) continue;
      return t;
    }
    return null;
  }

  // Open a post the way X itself does — a client-side route change in the same
  // tab — so pressing Back drops you straight back into the feed where you were
  // (X keeps the timeline mounted and the browser restores scroll). We push the
  // route and fire popstate, which X's router listens for. Falls back to a plain
  // same-tab load only if something throws.
  function openInApp(url) {
    let path = url;
    try {
      path = new URL(url, location.origin).pathname;
    } catch (_) {}
    try {
      history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    } catch (_) {
      location.assign(path);
    }
  }

  // -------- card rendering (built node-by-node; tweet text never goes through
  //          innerHTML, so a malicious post body can't inject markup) ----------
  const VERIFIED_SVG =
    '<svg viewBox="0 0 22 22" aria-label="Verified" width="18" height="18"><g><path fill="#1d9bf0" d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.27-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.083 1.29.14 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.223.607-.27 1.264-.14 1.897.131.634.437 1.218.882 1.687.47.445 1.053.75 1.687.882.633.13 1.29.083 1.897-.14.274.587.705 1.086 1.246 1.44.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"></path></g></svg>';

  // X shows "Jan 9" within the current year, "Jan 9, 2024" otherwise.
  function fmtDate(s) {
    const d = new Date(s);
    if (isNaN(d)) return "";
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    });
  }

  // X's own action-bar / context glyphs (24×24), so the card's icons match natively.
  const IC = {
    reply:
      "M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z",
    repost:
      "M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z",
    like:
      "M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z",
    views: "M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z",
    bookmark:
      "M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z",
    share:
      "M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zm-7 12.5v3.5c0 .28.22.5.5.5h13c.28 0 .5-.22.5-.5v-3.5h2v3.5c0 1.38-1.12 2.5-2.5 2.5h-13C4.12 21.59 3 20.47 3 19.09v-3.5h2z",
    // Post header top-right (mirror X's Grok + "More"). Grok is xAI's real mark.
    grok: "M213.235 306.019l178.976-180.002v.169l51.695-51.763c-.924 1.32-1.86 2.605-2.785 3.89-39.281 54.164-58.46 80.649-43.07 146.922l-.09-.101c10.61 45.11-.744 95.137-37.398 131.836-46.216 46.306-120.167 56.611-181.063 14.928l42.462-19.675c38.863 15.278 81.392 8.57 111.947-22.03 30.566-30.6 37.432-75.159 22.065-112.252-2.92-7.025-11.67-8.795-17.792-4.263l-124.947 92.341zm-25.786 22.437l-.033.034L68.094 435.217c7.565-10.429 16.957-20.294 26.327-30.149 26.428-27.803 52.653-55.359 36.654-94.302-21.422-52.112-8.952-113.177 30.724-152.898 41.243-41.254 101.98-51.661 152.706-30.758 11.23 4.172 21.016 10.114 28.638 15.639l-42.359 19.584c-39.44-16.563-84.629-5.299-112.207 22.313-37.298 37.308-44.84 102.003-1.128 143.81z",
    more: "M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z",
  };
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"></path></svg>`;
  // The Grok mark sits in a lot of empty padding on its native 512 art board, so
  // it renders shrunken. Crop the viewBox tight to the glyph's measured bounding
  // box so it fills the icon box; it's also rendered a touch larger in CSS
  // (.xhm-head-grok) since the mark is sparse and reads small at equal size.
  const GROK_VB = "68 74 376 362";

  // Filled (active) variants — solid heart / solid bookmark, shown when the
  // post is one the user already liked / saved.
  const ICF = {
    like: "M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z",
    bookmark: "M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5z",
  };
  const svgCls = (d, cls) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" class="${cls}"><path d="${d}"></path></svg>`;
  // Eight dots that fly outward for the like/save burst (X's confetti feel).
  const particleDots = () => {
    let s = "";
    for (let i = 0; i < 8; i++) s += `<i style="--a:${i * 45}deg"></i>`;
    return s;
  };

  // X's exact secondary color + divider for the active theme (Default/Dim/
  // Lights-out), read from the page background so muted text matches natively.
  function themeVars() {
    let rgb = [0, 0, 0];
    for (const node of [document.body, document.documentElement]) {
      const m = node && getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
      if (m && m[3] !== "0") {
        rgb = m.map(Number);
        break;
      }
    }
    const [r, , b] = rgb;
    if (r >= 240)
      return { muted: "rgb(83,100,113)", border: "rgb(239,243,244)", faint: "rgba(0,0,0,0.03)" };
    if (b >= 30)
      return { muted: "rgb(139,152,165)", border: "rgb(56,68,77)", faint: "rgba(255,255,255,0.03)" };
    return { muted: "rgb(113,118,123)", border: "rgb(47,51,54)", faint: "rgba(255,255,255,0.03)" };
  }
  // Match X's engagement counts exactly: exact below 1K, then abbreviated with a
  // single decimal ONLY while the leading value is one digit (1.2K, 9.9K, 1.2M)
  // and NO decimal once it reaches two (35K, 235K, 12M). X truncates rather than
  // rounds — 1,999 shows "1.9K", not "2K" — so we floor. Integer math throughout
  // to dodge float slips (e.g. 1.2 * 10 = 11.999…).
  function fmtCount(n) {
    if (!n) return "";
    // tenths = value in tenths of the unit; below 10 keep the decimal, else drop.
    const abbr = (tenths, suffix) => {
      const whole = Math.floor(tenths / 10);
      const frac = tenths % 10;
      return frac ? `${whole}.${frac}${suffix}` : `${whole}${suffix}`;
    };
    if (n < 1e3) return String(n);
    if (n < 1e6) return n < 1e4 ? abbr(Math.floor(n / 100), "K") : Math.floor(n / 1e3) + "K";
    if (n < 1e9) return n < 1e7 ? abbr(Math.floor(n / 1e5), "M") : Math.floor(n / 1e6) + "M";
    return n < 1e10 ? abbr(Math.floor(n / 1e8), "B") : Math.floor(n / 1e9) + "B";
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // X's API HTML-escapes tweet text (& < > …). New collects are decoded at
  // harvest in page-hook.js; this cleans up posts already in the archive.
  const codePoint = (n) => {
    try {
      return String.fromCodePoint(n);
    } catch (_) {
      return "";
    }
  };
  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => codePoint(Number(d)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  // Render a string into `container` as text nodes with @mentions turned into
  // real profile links, built node-by-node (tweet text never goes through
  // innerHTML). Clicking a mention opens the profile in-app without triggering
  // the card's own open-post click.
  const MENTION_RE = /@([A-Za-z0-9_]{1,15})/g;
  function appendRichText(container, text) {
    let last = 0;
    let m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(text))) {
      const prev = m.index > 0 ? text[m.index - 1] : "";
      if (prev && /[\w@]/.test(prev)) continue; // emails / mid-word @ aren't mentions
      const handle = m[1];
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = el("a", "xhm-mention", "@" + handle);
      a.href = "https://x.com/" + handle;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openInApp("/" + handle);
      });
      container.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

  // X clips a long post in the timeline behind a "Show more". A standard post
  // (<= 280 chars) is a hard cap for non-premium users, so anything longer is a
  // long-form post that X previews; we mirror that, and also cap very tall
  // many-line posts. Returns the character index to cut at, or -1 to show whole.
  const TEXT_CHAR_LIMIT = 280;
  const TEXT_LINE_LIMIT = 12;
  function previewCut(text) {
    let cut = text.length > TEXT_CHAR_LIMIT ? TEXT_CHAR_LIMIT : -1;
    // Cap the number of lines the preview shows, too.
    let nl = -1;
    let lines = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n" && ++lines === TEXT_LINE_LIMIT) {
        nl = i;
        break;
      }
    }
    if (nl !== -1 && (cut === -1 || nl < cut)) cut = nl;
    if (cut === -1 || cut >= text.length) return -1;
    // Don't split a word: back up to the nearest whitespace in a small window.
    if (!/\s/.test(text[cut])) {
      for (let i = cut; i > cut - 40 && i > 0; i--) {
        if (/\s/.test(text[i])) {
          cut = i;
          break;
        }
      }
    }
    return cut;
  }

  // Body text, clipped with a "Show more" when long. Clicking "Show more"
  // expands the post in place (the timeline cell's ResizeObserver reflows for
  // us) rather than opening it — clicking anywhere else on the card still opens.
  function buildText(text) {
    const div = el("div", "xhm-text");
    const render = (str, truncated) => {
      div.textContent = "";
      appendRichText(div, str);
      if (!truncated) return;
      div.appendChild(document.createTextNode(" "));
      const more = el("button", "xhm-showmore", "Show more");
      more.type = "button";
      more.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        render(text, false);
      });
      div.appendChild(more);
    };
    const cut = previewCut(text);
    if (cut === -1) render(text, false);
    else render(text.slice(0, cut).replace(/\s+$/, ""), true);
    return div;
  }

  function buildCard(t) {
    const sources = t.sources || [t.source];
    const isBookmarked = sources.includes("bookmarks");
    const isLiked = sources.includes("likes");
    // The context line reflects how it was saved (bookmark wins if it's both).
    const ctxSave = isBookmarked;
    const card = el("div", "xhm-card");
    card.dataset.xhmCard = "1";
    // Pin X's exact secondary color + divider for the current theme, so the
    // muted text/icons match natively (not an approximation).
    const tv = themeVars();
    card.style.setProperty("--xhm-muted", tv.muted);
    card.style.setProperty("--xhm-border", tv.border);
    card.style.setProperty("--xhm-faint", tv.faint);
    // Open the post in-app in the same tab (Back returns to this exact spot).
    card.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openInApp(t.url);
    });

    // social-context line — mirrors X's own "You reposted" row (icon in the
    // avatar gutter, gray label aligned with the post body). The icon plays a
    // like/save "burst" when the card scrolls into view (see animObserver).
    const ctx = el("div", "xhm-context");
    const cicon = el("div", "xhm-context-icon");
    const anim = el("div", "xhm-ctx-anim" + (ctxSave ? " is-save" : ""));
    anim.innerHTML =
      svgCls(ctxSave ? IC.bookmark : IC.like, "xhm-ctx-outline") +
      svgCls(ctxSave ? ICF.bookmark : ICF.like, "xhm-ctx-fill") +
      '<span class="xhm-ctx-ring"></span>' +
      '<span class="xhm-ctx-particles">' + particleDots() + "</span>";
    cicon.appendChild(anim);
    ctx.appendChild(cicon);
    ctx.appendChild(
      el("span", "xhm-context-label", ctxSave ? "You bookmarked this" : "You liked this")
    );
    card.appendChild(ctx);

    // main row: avatar + content column (X's exact layout)
    const row = el("div", "xhm-row");
    if (t.user.avatar) {
      const av = el("img", "xhm-avatar");
      av.src = t.user.avatar;
      av.referrerPolicy = "no-referrer";
      row.appendChild(av);
    } else {
      row.appendChild(el("div", "xhm-avatar xhm-avatar-empty"));
    }
    const col = el("div", "xhm-col");

    // header on one line: Name ✓ @handle · date
    const head = el("div", "xhm-head");
    head.appendChild(el("span", "xhm-name", t.user.name));
    if (t.user.verified) {
      const v = el("span", "xhm-verified");
      v.innerHTML = VERIFIED_SVG;
      head.appendChild(v);
    }
    head.appendChild(el("span", "xhm-handle", "@" + t.user.screen));
    head.appendChild(el("span", "xhm-sep", "·"));
    head.appendChild(el("span", "xhm-date", fmtDate(t.createdAt)));
    // top-right icons — placeholders that mirror X's Grok + "More" buttons.
    const headEnd = el("div", "xhm-head-end");
    const headBtn = (d, tip, vb) => {
      const b = el("div", "xhm-head-btn xhm-tip xhm-c-blue" + (vb ? " xhm-head-grok" : ""));
      b.dataset.xhmTip = tip;
      const ic = el("span", "xhm-head-ic");
      ic.innerHTML = vb
        ? `<svg viewBox="${vb}" aria-hidden="true"><path d="${d}"></path></svg>`
        : svg(d);
      b.appendChild(ic);
      return b;
    };
    headEnd.appendChild(headBtn(IC.grok, "Grok", GROK_VB));
    headEnd.appendChild(headBtn(IC.more, "More"));
    head.appendChild(headEnd);
    col.appendChild(head);

    // body text
    if (t.text) col.appendChild(buildText(decodeEntities(t.text)));

    // media — first image (videos/gifs carry a poster image too)
    const m = (t.media || [])[0];
    if (m && m.url) {
      const wrap = el("div", "xhm-media");
      const img = el("img");
      img.src = m.url;
      img.referrerPolicy = "no-referrer";
      wrap.appendChild(img);
      col.appendChild(wrap);
    }

    // action bar — X's own glyphs + the post's real counts. Four metrics on
    // the left (spread within X's ~425px), bookmark + share pushed to far right.
    const acts = el("div", "xhm-actions");
    const act = (d, n, extra, tip, color) => {
      const a = el(
        "div",
        "xhm-act" +
          (extra ? " " + extra : "") +
          (tip ? " xhm-tip" : "") +
          (color ? " xhm-c-" + color : "")
      );
      if (tip) a.dataset.xhmTip = tip;
      const ic = el("span", "xhm-act-ic");
      ic.innerHTML = svg(d);
      a.appendChild(ic);
      if (n) a.appendChild(el("span", "xhm-act-n", fmtCount(n)));
      return a;
    };
    const main = el("div", "xhm-actions-main");
    main.appendChild(act(IC.reply, t.stats.replies, "", "Reply", "blue"));
    main.appendChild(act(IC.repost, t.stats.reposts, "", "Repost", "green"));
    // A liked post shows a filled red heart + red count, like native X. Every
    // action here is a placeholder — a click anywhere on the card opens the real
    // post, where like / reply / bookmark all work natively.
    main.appendChild(
      act(isLiked ? ICF.like : IC.like, t.stats.likes, isLiked ? "is-liked" : "", isLiked ? "Unlike" : "Like", "pink")
    );
    main.appendChild(act(IC.views, t.stats.views, "", "Views", "blue"));
    const end = el("div", "xhm-actions-end");
    // A saved post shows a filled blue bookmark.
    end.appendChild(
      act(isBookmarked ? ICF.bookmark : IC.bookmark, 0, isBookmarked ? "is-bookmarked" : "", isBookmarked ? "Remove from Bookmarks" : "Bookmark", "blue")
    );
    end.appendChild(act(IC.share, 0, "", "Share", "blue"));
    acts.appendChild(main);
    acts.appendChild(end);
    col.appendChild(acts);

    row.appendChild(col);
    card.appendChild(row);
    return card;
  }

  // Plays the like/save burst on a card's context icon when it scrolls into
  // view, and re-arms it when the card leaves — X recycles cells as you scroll,
  // so the little "liking it" moment naturally repeats through the feed.
  const animObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const node = e.target.querySelector(".xhm-ctx-anim");
        if (!node) continue;
        if (e.isIntersecting) {
          node.classList.remove("play");
          void node.offsetWidth; // force reflow so the animation can restart
          node.classList.add("play");
        } else {
          node.classList.remove("play");
        }
      }
    },
    { threshold: 0.25 }
  );

  // Each card is pinned to the host tweet it was woven under. X's virtualized
  // list tears cells down and remounts them (scrolling away and back, or
  // returning from a post via Back) — without this, a remounted host got a
  // *different* card and the one the user just read seemed to vanish. Keyed by
  // the host tweet's status id, so the same card reappears in the same place
  // and behaves like a normal, stable tweet.
  const placements = new Map(); // host status id -> archived item

  function rememberPlacement(anchorId, item) {
    if (!anchorId) return;
    placements.set(anchorId, item);
    // Bounded: drop the oldest once we're past what a long scroll session needs.
    if (placements.size > 500) placements.delete(placements.keys().next().value);
  }

  function injectItem(cell, item) {
    if (settings.dedupe) shownIds.add(item.id);
    const card = buildCard(item);
    cell.appendChild(card);
    cell.dataset.xhmHosted = "1";
    animObserver.observe(card);
  }

  function injectInto(cell, anchorId) {
    const item = nextItem();
    if (!item) return;
    rememberPlacement(anchorId, item);
    injectItem(cell, item);
  }

  function removeAllCards() {
    document.querySelectorAll(".xhm-card").forEach((c) => {
      animObserver.unobserve(c);
      c.remove();
    });
    document.querySelectorAll('[data-xhm-hosted]').forEach((c) => delete c.dataset.xhmHosted);
  }

  // A woven card lands *inside* the host cell, right under its tweet — so if
  // that tweet's conversation continues in the next cell (X threads home-
  // timeline replies together with a thin vertical connector in the avatar
  // gutter), the card would cut straight through the exchange. X's class names
  // are obfuscated and churn, so we detect the connector geometrically: a
  // ~2px-wide bar in the avatar's column that extends below the avatar.
  function threadContinuesBelow(cell) {
    const article = cell.querySelector("article");
    const av = article && article.querySelector('[data-testid="Tweet-User-Avatar"]');
    if (!av) return false;
    const a = av.getBoundingClientRect();
    if (!a.width || !a.height) return false; // not laid out; assume standalone
    for (const d of article.querySelectorAll("div")) {
      const r = d.getBoundingClientRect();
      if (r.width < 1 || r.width > 4 || r.height < 12) continue; // not a connector bar
      const cx = r.left + r.width / 2;
      if (cx < a.left || cx > a.right) continue; // not in the avatar gutter
      if (r.bottom > a.bottom + 4) return true; // runs on past the avatar → thread continues
    }
    return false;
  }

  // Decide what to do with a freshly-mounted timeline cell.
  function considerCell(cell) {
    if (!settings.mixEnabled || !isHome()) return;
    if (cell.dataset.xhmSeen) return;
    const article = cell.querySelector("article");
    const link = cell.querySelector('a[href*="/status/"]');
    if (!article || !link) return; // not a tweet (ads, who-to-follow, etc.)
    cell.dataset.xhmSeen = "1";
    const idMatch = (link.getAttribute("href") || "").match(/\/status\/(\d+)/);
    const anchorId = idMatch ? idMatch[1] : null;
    // This host tweet already carries one of our cards — re-weave the same one
    // (its cell was recycled or remounted) instead of dealing a new card.
    if (anchorId && placements.has(anchorId)) {
      if (!cell.querySelector(".xhm-card")) injectItem(cell, placements.get(anchorId));
      return;
    }
    tweetOrdinal++;
    const every = Math.max(1, Number(settings.every) || 5);
    if (!pendingInject && tweetOrdinal % every !== 0) return;
    // Never split a conversation: if this tweet's thread carries on in the next
    // cell, hold the card and weave it under the first post after the thread.
    if (threadContinuesBelow(cell)) {
      pendingInject = true;
      return;
    }
    pendingInject = false;
    injectInto(cell, anchorId);
  }

  const CELL = 'div[data-testid="cellInnerDiv"]';
  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.closest && node.closest("[data-xhm-card]")) return; // ignore our own DOM
    if (node.matches && node.matches(CELL)) considerCell(node);
    if (node.querySelectorAll) node.querySelectorAll(CELL).forEach(considerCell);
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) scan(n);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // SPA route changes: reset the home weaving cadence when we land on Home.
  let lastPath = location.pathname;
  function onRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (isHome()) {
      tweetOrdinal = 0;
      pendingInject = false;
      refill();
    }
  }
  // A content script runs in an isolated world, so we poll the path to notice
  // X's own SPA navigations (its history reference is separate from ours).
  // popstate still covers Back/Forward.
  routePoll = setInterval(onRoute, 700);
  window.addEventListener("popstate", onRoute);

  // Boot: load settings, prime the queue, announce capability to the popup.
  (async () => {
    try {
      const state = await bg({ type: "GET_STATE" });
      if (state && state.settings) settings = { ...settings, ...state.settings };
    } catch (_) {}
    refill();
    toPage({ type: "PING" });
  })();
})();
