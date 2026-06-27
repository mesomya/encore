# Architecture

How Encore is put together — the execution contexts, the data flows, the deliberate
decisions, and the gotchas. Read this before making non-trivial changes.

## The big picture

Encore is a Manifest V3 extension with **three execution contexts** plus a popup, talking
across worlds:

```
 ┌─────────────── x.com tab ───────────────┐         ┌── extension ──┐
 │  MAIN world           ISOLATED world     │         │  service      │
 │  page-hook.js  <────> content.js  <──────┼────────►│  background.js │
 │  (sees X's fetches)   (bridge + weave)   │  chrome │  (IndexedDB)   │
 └──────────────────────────────────────────┘  msgs   └───────────────┘
        ▲ window.postMessage  ▲ chrome.runtime              ▲ chrome.runtime
        └─── cross-world ─────┘                       ┌─────┴─────┐
                                                      │ popup/*   │
                                                      └───────────┘
```

Why these contexts? The **request recipe** is learned in the background via `webRequest`
(network-layer, read-only) — the reliable path that doesn't depend on page internals.
**Replay** then runs in the **page's own JavaScript world** (`page-hook.js`), because it
must reuse the page's logged-in session via the native `fetch`. Talking to the extension's
storage needs the **isolated content-script world** (only it has `chrome.*`). The page's
two worlds are bridged with `window.postMessage`.

## The contexts

### `src/page-hook.js` — page MAIN world, `document_start`

Runs in the page's own JS context so it can replay X's calls with the page's session.

- Owns the **replay engine** `runSync(kind, maxPages, requestId, fallback, knownIds)`: on
  a `SYNC` command it replays the saved template with a pagination cursor, posting `PAGE`
  per page and `SYNC_DONE` / `SYNC_ERROR`. **Replay uses the saved native `origFetch`**, so
  it reuses the page's logged-in session and never re-triggers capture.
- Also wraps `window.fetch` **and** `XMLHttpRequest` as a *secondary* capture path
  (`classify()` → `captureTemplate()` → `TEMPLATE`/`HARVEST`). The *primary* capture is
  `webRequest` in the background (below), so this is belt-and-braces.
- Idempotent: guards `window.__ENCORE_PAGE_HOOK__` so a double injection can't double-wrap.
- Uses **no `chrome.*` APIs** — it's immune to "Extension context invalidated".

### `src/content.js` — ISOLATED world, `document_start`

- **Bridge.** Relays page-hook messages up to `background.js` and commands down to the
  page hook. *All* background messaging goes through `bg(msg)` (see Gotchas).
- **Weave.** A `MutationObserver` watches for `div[data-testid="cellInnerDiv"]`; every
  _N_ real tweets it injects a card **inside** a host cell. Cards are built node-by-node
  in `buildCard()` (tweet text never via `innerHTML`). `themeVars()` pins X's exact
  per-theme grays. An `IntersectionObserver` plays the like/save burst animation.
  `openInApp()` does same-tab in-app navigation.
- **Collect orchestration.** `pageSync()` (RPC to the page hook) and `runSync()` (the
  manual collect the popup triggers — incremental, reports progress). A 700 ms route poll
  (`onRoute`) only resets the Home weaving cadence. Collection is **manual-only**: there is
  no auto-collect, top-up, or on-page toast.
- Idempotent: guards `window.__ENCORE_CONTENT__` against double injection.

### `src/background.js` — service worker

The single source of truth. Owns the IndexedDB `tweets` store (extension origin, private).

- **Primary request capture.** A read-only `webRequest` listener (`onBeforeRequest` +
  `onSendHeaders`) watches X's `/i/api/graphql/*` GET reads, `classifyOp()`s them, and
  persists a replayable template via `storeTemplate` — the reliable, cross-browser capture
  path, independent of any page-side hook.
- **Existing-tab injection.** `injectIntoOpenTabs()` uses `chrome.scripting` to attach both
  worlds to x.com tabs that were already open (on install / startup / worker wake), so a
  tab open before the extension loaded still works — no forced reload.
- Message handlers: `STORE_TWEETS` (upsert; merges `sources`), `GET_MIX_BATCH` (reservoir
  sample), `GET_STATE`, `SET_SETTINGS`, `START_SYNC`/`startSync` (the "Collect" the popup
  uses — drives a logged-in tab), `SYNC_COMPLETE`/`SYNC_FAILED`/`finishSync`,
  `GET_TEMPLATES`/`STORE_TEMPLATE`, `GET_KNOWN_IDS`/`knownIds`, `CAPTURE_STATUS`,
  `CLEAR_ARCHIVE`. Toolbar badge = archive count.

### `src/popup/`

The control surface. On open: `GET_STATE`, renders stats + settings, shows a first-run
hint. Has a **mock backend** when `chrome.runtime` is absent, so the UI can be previewed
as a plain HTML page.

## Data flows

**Capture / "teach" (first-run).** User opens Bookmarks/Likes → X fetches that timeline →
the background `webRequest` listener sees the GET, `classifyOp()`s it to bookmarks/likes,
and persists the template to `chrome.storage.local.templates`. (The page-hook fetch/XHR
patch is a secondary path to the same `STORE_TEMPLATE`, plus `HARVEST` → `STORE_TWEETS`.)

**Collect (popup button).** `START_SYNC` → `startSync` messages a logged-in tab `RUN_SYNC`
→ content `runSync` → `pageSync` sends `SYNC` (with the persisted template + `knownIds`) →
page-hook `runSync` replays paginated → `PAGE` events → content `STORE_TWEETS` → upsert.
**Incremental:** stops as soon as a whole page is already in `knownIds` (newest-first ⇒
caught up). Empty archive ⇒ full walk.

**Weave (feed injection).** content `MutationObserver` → `considerCell` (every Nth real
tweet) → `injectInto` → `GET_MIX_BATCH` → `buildCard` appended **inside** the host
`cellInnerDiv` (X's per-cell `ResizeObserver` repositions its virtualized list for us).

## Deliberate decisions (the non-obvious parts)

- **Piggyback, don't forge.** Capture X's own request shape and replay it; never fabricate
  the bearer / `ct0` / `x-client-transaction-id`. CSRF is refreshed from the `ct0` cookie
  at replay; a persisted template's stale transaction id is dropped (X is lenient on reads
  without one).
- **`classify()` substring matching, with guards.** Match by substring to survive X
  renaming ops (`Bookmarks`, `BookmarksAllInOne`, `UserLikes`…). Three guards exist
  because of real bugs:
  - `folder` → `null` (first check): `BookmarkFoldersSlice` is the folder *list* (no
    posts) and was overwriting the real `Bookmarks` template → collect fetched 0.
  - capture is **GET-only**: `CreateBookmark`/`DeleteBookmark` are POST mutations that
    share the name but must not become the collect recipe.
  - likes excludes `liker` / `dislike` / `unlike`.
- **Inject inside the host cell.** Appending our card as the last child of
  `div[data-testid="cellInnerDiv"]` lets X's per-cell `ResizeObserver` re-measure and
  reposition its virtualized list. Sibling nodes lose (React recycles them). That selector
  is the one knob to revisit if X overhauls its DOM.
- **Pixel-native card.** Set X's exact font stack explicitly (inheritance rendered the
  wrong font); 15px/20px, weight 400 (name 700), antialiased. Exact per-theme secondary
  grays + dividers via `themeVars()` (mixer.css holds only `color-mix` fallbacks).
  `border-bottom` divider (line *after* the post). Filled red like / blue bookmark when
  it's a post the user liked/saved. A "You liked/bookmarked this" line styled like X's
  "You reposted" row — no Encore branding on the post.
- **Incremental collect** with a forced-full escape hatch (Empty the library, then
  Collect — an empty archive does a full walk).
- **Capture at the network layer.** Learning the request recipe via `webRequest` in the
  background is immune to page CSP, injection timing, and which thread X uses — the
  page-side `fetch`/XHR hook is kept only as a secondary path. `classifyOp()` mirrors the
  page hook's `classify()` (same `folder` / `liker` / GET-only guards).
- **Manual-only collection.** Collecting runs solely from the popup's Collect buttons —
  no route-poll auto-collect, no background top-up, no on-page toast — so behavior is
  predictable and nothing surprises the user.

## Gotchas (these will bite you)

- **You can't intercept the page's `history.pushState` from a content script** — the
  isolated world has separate function references. Detect SPA route changes by **polling
  `location.pathname`**, not by patching pushState. (But *calling* `pushState` from the
  content script does affect the real URL — that's why `openInApp` works.)
- **`chrome.runtime.sendMessage` throws *synchronously*** ("Extension context
  invalidated") if the extension is reloaded/updated while a tab stays open — a trailing
  `.catch()` can't stop it. All content→background messaging goes through `bg()`, which
  guards the call and goes quiet on first loss. This happens in production too (Chrome
  auto-updates), not just dev reloads.
- **Content scripts only inject into pages loaded *after* the extension is enabled.** A
  tab that was already open gets nothing until it reloads — which is why the background
  calls `injectIntoOpenTabs()` (`chrome.scripting`) on install / startup / worker wake to
  attach both worlds to already-open x.com tabs. (Capture itself doesn't depend on this —
  `webRequest` sees the request regardless.)
- **`requestAnimationFrame` is paused on hidden/unfocused tabs** — count-up animations can
  look frozen during headless verification; not a real bug.

## Testing

- `node --check src/*.js` for syntax; validate `manifest.json` parses.
- **UI** (cards/pill/popup) can be verified headless with a throwaway HTML page that loads
  `src/mixer.css` and renders `buildCard()`'s markup, served over `http://` (file:// is
  blocked by drivers). The real TwitterChirp font only exists on x.com — judge layout, not
  the font.
- **Capture/collect** needs a logged-in X session. Verify capture from the service-worker
  console: a template appears in `chrome.storage.local.templates` once you visit your
  Bookmarks/Likes page. (Runtime `console` logging was removed, so the consoles stay clean.)

## Vocabulary

User-facing words are Encore's own: **Collected / Liked / Saved**, **Replay in my feed**,
**Spacing** / **Depth**, **Collect everything / Likes only / Saves only / Empty the
library**, **Bring back**, **No repeats per visit**, **Appearance**. In-feed context line:
**You liked this / You bookmarked this**. ("Bookmarks" is X's internal name; users see
"saves".) Internal code prefix stays `xhm-`.
