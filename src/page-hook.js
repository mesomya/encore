/*
 * page-hook.js  —  runs in the MAIN world (the page's own JS context).
 *
 * X's web client talks to its private GraphQL API with a bundle of auth that
 * only the page itself holds: a bearer token, the `ct0` CSRF token, and a
 * per-request transaction id. Rather than try to forge any of that, we simply
 * observe the requests the page already makes, remember their shape, and replay
 * them with our own pagination cursor when the user asks to sync. The browser
 * attaches the session cookie automatically because we fire from the same origin.
 *
 * Nothing leaves the machine that the page wasn't already sending to X.
 */
(() => {
  "use strict";

  // Installed once per page. We may be injected twice — by the manifest at
  // document_start AND programmatically by the worker into a tab that was
  // already open. Guard so we never wrap fetch/XHR more than once.
  if (window.__ENCORE_PAGE_HOOK__) return;
  window.__ENCORE_PAGE_HOOK__ = true;

  const TAG_PAGE = "xhm-page"; // messages we send out
  const TAG_CONTENT = "xhm-content"; // messages we listen for
  const GQL_RE = /\/i\/api\/graphql\/([^/]+)\/([^/?]+)/;

  // Captured request templates, keyed by operation kind.
  const templates = Object.create(null); // { bookmarks: {...}, likes: {...} }

  const origFetch = window.fetch;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function post(msg) {
    window.postMessage({ source: TAG_PAGE, ...msg }, "*");
  }

  // ---- userId from the twid cookie (needed if a Likes template lacks one) ----
  function currentUserId() {
    const m = document.cookie.match(/twid=u%3D(\d+)/);
    return m ? m[1] : null;
  }
  // The CSRF token lives in the ct0 cookie and is refreshed by X often, so we
  // re-read it at replay time rather than trusting a saved one.
  function ct0() {
    const m = document.cookie.match(/(?:^|; )ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ----------------------------- response parsing ----------------------------
  // Walk an arbitrary object, calling fn(node, key) on every object node.
  function walk(root, fn) {
    const stack = [[root, null]];
    const seen = new Set();
    while (stack.length) {
      const [node, key] = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (seen.has(node)) continue;
      seen.add(node);
      fn(node, key);
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) stack.push([node[i], i]);
      } else {
        for (const k in node) stack.push([node[k], k]);
      }
    }
  }

  const get = (o, path) => path.reduce((a, k) => (a == null ? a : a[k]), o);

  // Turn a raw GraphQL tweet `result` into a compact record we can render.
  function normalizeTweet(result) {
    if (!result || typeof result !== "object") return null;
    if (result.__typename === "TweetWithVisibilityResults") result = result.tweet;
    if (!result || (result.__typename && result.__typename === "TweetTombstone")) return null;

    const legacy = result.legacy;
    const id = result.rest_id || (legacy && legacy.id_str);
    if (!id || !legacy) return null;

    const userRes = get(result, ["core", "user_results", "result"]) || {};
    const userLegacy = userRes.legacy || {};
    const userCore = userRes.core || {}; // X relocated name/screen_name here in late 2024
    const screen = userCore.screen_name || userLegacy.screen_name || "";
    const name = userCore.name || userLegacy.name || screen;
    const avatar =
      get(userRes, ["avatar", "image_url"]) || userLegacy.profile_image_url_https || "";
    const verified = !!userRes.is_blue_verified;

    // Prefer the long-form note tweet body when present.
    const noteText = get(result, ["note_tweet", "note_tweet_results", "result", "text"]);
    let text = noteText || legacy.full_text || "";

    // Collect media.
    const rawMedia =
      get(legacy, ["extended_entities", "media"]) || get(legacy, ["entities", "media"]) || [];
    const media = rawMedia.map((m) => ({
      type: m.type, // photo | video | animated_gif
      url: m.media_url_https,
      tco: m.url, // the t.co link embedded in the text
    }));

    // X appends a t.co link for media to full_text — strip it for clean display.
    for (const m of media) {
      if (m.tco) text = text.replace(m.tco, "").trim();
    }
    // Expand any remaining t.co links to their display form.
    const urls = get(legacy, ["entities", "urls"]) || [];
    for (const u of urls) {
      if (u.url && u.display_url) text = text.replace(u.url, "https://" + u.expanded_url.replace(/^https?:\/\//, ""));
    }

    return {
      id,
      text,
      createdAt: legacy.created_at,
      user: { name, screen, avatar, verified },
      media,
      stats: {
        replies: legacy.reply_count || 0,
        reposts: legacy.retweet_count || 0,
        likes: legacy.favorite_count || 0,
        views: Number(get(result, ["views", "count"])) || 0,
      },
      url: `https://x.com/${screen || "i"}/status/${id}`,
    };
  }

  // Pull top-level timeline tweets + the bottom cursor out of any GraphQL
  // timeline response, regardless of which endpoint produced it.
  function parseTimeline(json) {
    const tweets = [];
    const seen = new Set();
    let bottomCursor = null;

    const addEntry = (entry) => {
      if (!entry || typeof entry !== "object") return;
      const content = entry.content || entry.item || {};
      const entryId = entry.entryId || "";

      // Cursor entries drive pagination.
      const cursorType =
        get(content, ["cursorType"]) || get(content, ["itemContent", "cursorType"]);
      if (cursorType === "Bottom" || entryId.startsWith("cursor-bottom")) {
        bottomCursor = content.value || get(content, ["itemContent", "value"]) || bottomCursor;
        return;
      }

      // A single tweet item.
      const itemResult = get(content, ["itemContent", "tweet_results", "result"]);
      if (itemResult) {
        const t = normalizeTweet(itemResult);
        if (t && !seen.has(t.id)) {
          seen.add(t.id);
          tweets.push(t);
        }
      }

      // A module (carousels / conversations) holding several items.
      const items = content.items || [];
      for (const it of items) {
        const r = get(it, ["item", "itemContent", "tweet_results", "result"]);
        const t = normalizeTweet(r);
        if (t && !seen.has(t.id)) {
          seen.add(t.id);
          tweets.push(t);
        }
      }
    };

    walk(json, (node, key) => {
      if (key === "instructions" && Array.isArray(node)) {
        for (const ins of node) {
          if (ins && Array.isArray(ins.entries)) ins.entries.forEach(addEntry);
          if (ins && ins.entry) addEntry(ins.entry);
        }
      }
    });

    return { tweets, bottomCursor };
  }

  // ----------------------------- request capture -----------------------------
  function classify(opName) {
    const n = opName.toLowerCase();
    // Match by substring so we survive X renaming ops (Bookmarks,
    // BookmarksAllInOne, UserLikes, …). But exclude look-alikes that share the
    // word yet aren't the timeline we want:
    //  - "folder" → BookmarkFoldersSlice / BookmarkFolderTimeline: the folder
    //    LIST returns no tweets, and capturing it overwrote the real Bookmarks
    //    recipe — that's why collect fetched 0 despite a full archive.
    //  - "liker"/"unlike"/"dislike" → not the user's own Likes timeline.
    if (n.includes("folder")) return null;
    if (n.includes("bookmark")) return "bookmarks";
    if (n.includes("home")) return "home";
    if (n.includes("like") && !n.includes("liker") && !n.includes("dislike") && !n.includes("unlike"))
      return "likes";
    return null;
  }

  function headersFrom(input, init) {
    const h = {};
    try {
      const req = new Request(input, init);
      for (const [k, v] of req.headers.entries()) h[k] = v;
    } catch (_) {
      /* ignore */
    }
    return h;
  }

  function captureTemplate(kind, url, headers) {
    const m = url.match(GQL_RE);
    if (!m) return;
    const u = new URL(url, location.origin);
    let variables = {};
    let features = {};
    let fieldToggles = null;
    try {
      variables = JSON.parse(u.searchParams.get("variables") || "{}");
    } catch (_) {}
    try {
      features = JSON.parse(u.searchParams.get("features") || "{}");
    } catch (_) {}
    if (u.searchParams.get("fieldToggles")) fieldToggles = u.searchParams.get("fieldToggles");

    const had = !!templates[kind];
    templates[kind] = {
      kind,
      base: u.origin + u.pathname, // /i/api/graphql/<qid>/<Op>
      headers,
      variables,
      features,
      fieldToggles,
      userId: variables.userId || currentUserId(),
    };
    if (!had) post({ type: "CAPTURED", kind });
    // Persist the template so a later session can collect without re-teaching.
    post({ type: "TEMPLATE", kind, template: templates[kind] });
    // Seeing this request means the user is on (or loading) their bookmarks/
    // likes page — tell the content script so it can auto-collect. Our own
    // replay uses origFetch and bypasses this hook, so it won't echo back here.
    post({ type: "SOURCE_SEEN", kind });
    emitStatus();
  }

  function emitStatus() {
    post({
      type: "STATUS",
      captured: { bookmarks: !!templates.bookmarks, likes: !!templates.likes },
      userId: currentUserId(),
    });
  }

  // ------------------------------ fetch patch --------------------------------
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const method = (
      (init && init.method) ||
      (input && typeof input === "object" && input.method) ||
      "GET"
    ).toUpperCase();
    let kind = null;
    if (url && GQL_RE.test(url)) {
      const m = url.match(GQL_RE);
      kind = classify(m[2]);
      // Only learn from / harvest the list READ (GET). Bookmark + unbookmark are
      // POST mutations that share the "bookmark" name — capturing one would
      // overwrite the collect recipe with a request that can't paginate.
      if ((kind === "bookmarks" || kind === "likes") && method === "GET") {
        try {
          captureTemplate(kind, url, headersFrom(input, init));
        } catch (_) {}
      } else if (kind === "bookmarks" || kind === "likes") {
        kind = null; // a mutation, not the timeline — ignore it
      }
    }

    const res = await origFetch.apply(this, arguments);

    // Passively harvest whatever timeline data flew by (bookmarks / likes pages).
    if (kind === "bookmarks" || kind === "likes") {
      res
        .clone()
        .json()
        .then((json) => {
          const { tweets } = parseTimeline(json);
          if (tweets.length) post({ type: "HARVEST", source: kind, tweets });
        })
        .catch(() => {});
    }
    return res;
  };

  // ------------------------------ XHR patch ----------------------------------
  // Some X builds fetch GraphQL over XMLHttpRequest; mirror the fetch logic so
  // capture + harvest work either way.
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  const XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xhm = { method, url, headers: {} };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__xhm) this.__xhm.headers[k] = v;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const info = this.__xhm;
    if (info && info.url && GQL_RE.test(info.url)) {
      const op = info.url.match(GQL_RE)[2];
      const kind = classify(op);
      const method = (info.method || "GET").toUpperCase();
      // GET only — ignore bookmark/unbookmark mutations (see fetch patch).
      if ((kind === "bookmarks" || kind === "likes") && method === "GET") {
        try {
          captureTemplate(kind, info.url, info.headers);
        } catch (_) {}
        this.addEventListener("load", () => {
          try {
            const { tweets } = parseTimeline(JSON.parse(this.responseText));
            if (tweets.length) post({ type: "HARVEST", source: kind, tweets });
          } catch (_) {}
        });
      }
    }
    return XS.apply(this, arguments);
  };

  // ------------------------------- replay sync -------------------------------
  function buildRequest(tpl, cursor, count) {
    const variables = { ...tpl.variables };
    if (count) variables.count = count;
    if (cursor) variables.cursor = cursor;
    else delete variables.cursor;
    if (tpl.kind === "likes" && !variables.userId && tpl.userId) variables.userId = tpl.userId;

    const params = new URLSearchParams();
    params.set("variables", JSON.stringify(variables));
    params.set("features", JSON.stringify(tpl.features));
    if (tpl.fieldToggles) params.set("fieldToggles", tpl.fieldToggles);

    return {
      url: tpl.base + "?" + params.toString(),
      init: { method: "GET", headers: tpl.headers, credentials: "include" },
    };
  }

  async function fetchPage(tpl, cursor, count) {
    const { url, init } = buildRequest(tpl, cursor, count);
    const res = await origFetch(url, init);
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return parseTimeline(await res.json());
  }

  async function runSync(kind, maxPages, requestId, fallback, knownIds) {
    // Posts we already have (newest-first ordering lets us stop when we reach
    // them). Empty set ⇒ first-ever collect ⇒ walk the full history.
    const known = new Set(knownIds || []);

    // Prefer a template captured this session; fall back to a persisted one.
    let tpl = templates[kind];
    const persisted = !tpl && fallback ? fallback : null;
    if (persisted) tpl = persisted;
    if (!tpl) {
      post({
        type: "SYNC_ERROR",
        requestId,
        kind,
        message: `Open your ${kind} page on X once so the extension can learn the request, then try again.`,
      });
      return;
    }

    // Replay with a fresh CSRF token. A persisted template's one-time
    // transaction id is stale, so drop it (X is lenient on reads without one).
    tpl = { ...tpl, headers: { ...tpl.headers } };
    const token = ct0();
    if (token) tpl.headers["x-csrf-token"] = token;
    if (persisted) delete tpl.headers["x-client-transaction-id"];

    let cursor = null;
    let page = 0;
    let total = 0;
    let count = 100; // ask for big pages; fall back if X rejects it
    let emptyStreak = 0;

    try {
      while (page < maxPages) {
        let parsed;
        try {
          parsed = await fetchPage(tpl, cursor, count);
        } catch (e) {
          if (count > 20 && (e.status === 400 || e.status === 404)) {
            count = 20; // some endpoints cap the page size — retry smaller
            continue;
          }
          throw e;
        }

        const { tweets, bottomCursor } = parsed;
        page++;
        total += tweets.length;
        post({
          type: "PAGE",
          requestId,
          kind,
          tweets,
          page,
          total,
          done: false,
        });

        // Incremental: once a whole page is posts we already have, we've caught
        // up to the previously-collected history — stop instead of re-walking it.
        const newOnPage = known.size
          ? tweets.reduce((a, t) => a + (known.has(t.id) ? 0 : 1), 0)
          : tweets.length;
        if (known.size && tweets.length && newOnPage === 0) break;

        if (!tweets.length) emptyStreak++;
        else emptyStreak = 0;

        // Stop when the cursor stops advancing or we hit a run of empty pages.
        if (!bottomCursor || bottomCursor === cursor || emptyStreak >= 2) break;
        cursor = bottomCursor;
        await sleep(650 + Math.floor(700 * (page % 3) / 2)); // gentle, varied spacing
      }
      post({ type: "SYNC_DONE", requestId, kind, total });
    } catch (e) {
      post({
        type: "SYNC_ERROR",
        requestId,
        kind,
        message:
          e.status === 429
            ? "X is rate-limiting requests. Wait a minute and sync again."
            : "Sync stopped: " + (e.message || "unknown error") + ". Try reopening your " + kind + " page.",
        partial: total,
      });
    }
  }

  // ------------------------------ command intake -----------------------------
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== TAG_CONTENT) return;
    if (d.type === "SYNC") runSync(d.kind, d.maxPages || 50, d.requestId, d.template, d.knownIds);
    else if (d.type === "PING") emitStatus();
  });

  emitStatus();
})();
