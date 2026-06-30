# Guidance for Claude Code (and other AI agents)

Orientation for working in this repo. For humans, start with [`README.md`](README.md) and
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## What this is

**Refeed** is a Manifest V3 browser extension that archives the user's own X (Twitter)
liked/saved posts locally and replays them into the Home timeline. Vanilla JS, **no build
step, no dependencies.**

## Where things live

| Path | Role |
| --- | --- |
| `src/page-hook.js` | page MAIN world â€” replays X's GraphQL requests (also a secondary capture path). **No `chrome.*` APIs.** |
| `src/content.js` | ISOLATED world â€” bridge to the worker + weaves cards into the timeline. |
| `src/background.js` | service worker â€” IndexedDB archive, settings, collect orchestration, **primary request capture (`webRequest`)**. |
| `src/mixer.css` | styles for the woven-in cards. |
| `src/popup/` | the control panel (has a mock backend for standalone preview). |
| `docs/ARCHITECTURE.md` | **the deep dive** â€” read this before non-trivial changes. |

## Conventions

- No dependencies, no bundler. Plain ES modules + DOM + Chrome extension APIs.
- User-facing strings use Refeed's vocabulary (Collected/Liked/Saved, Replay, Spacing,
  Depthâ€¦). Internal CSS/JS prefix is `xhm-` â€” leave it.
- `classify()` in `page-hook.js` (mirrored as `classifyOp()` in `background.js`) matches X
  op-names by substring; always guard against look-alikes (e.g. `BookmarkFoldersSlice`,
  `CreateBookmark`). Keep the two in sync.
- Privacy is non-negotiable: nothing leaves the machine. No analytics, no remote calls
  beyond what X already makes for the user.

## Verifying changes

```bash
node --check src/background.js && node --check src/content.js && node --check src/page-hook.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

- After editing: reload the extension at `chrome://extensions`, then hard-refresh the
  x.com tab (content scripts re-inject on load).
- UI can be verified headless via a throwaway HTML page that loads `src/mixer.css` and
  renders `buildCard()`'s markup (served over `http://`). The TwitterChirp font only
  exists on x.com â€” judge layout, not the font.
- Capture/collect needs a logged-in X session. Runtime `console` logging was removed (keep
  it that way); confirm capture via `chrome.storage.local.templates` in the worker console.

## Gotchas (full list in `docs/ARCHITECTURE.md`)

- Can't intercept the page's `history.pushState` from a content script â†’ poll
  `location.pathname` for SPA route changes.
- `chrome.runtime.sendMessage` throws **synchronously** on an invalidated context â†’ route
  all messaging through `bg()`.
- Content scripts only inject into tabs loaded **after** the extension is enabled â†’ the
  worker calls `injectIntoOpenTabs()` (`chrome.scripting`) to attach to already-open x.com
  tabs. (Capture doesn't depend on it â€” `webRequest` sees the request anyway.)
