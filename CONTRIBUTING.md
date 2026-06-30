# Contributing to Refeed

Thanks for your interest! Refeed is a small, dependency-free browser extension, so the
loop is quick and there's nothing to compile.

## Ground rules

- **No build step, no dependencies.** Plain ES modules, the DOM, and the Chrome
  extension APIs. Please keep it that way â€” if you reach for a package, open an issue
  first to talk it through.
- **Vanilla, readable code.** Match the surrounding style. Comments explain *why*, not
  *what*.
- **Privacy is the point.** Nothing may leave the user's machine. No network calls
  except the ones X already makes on the user's behalf, no analytics, no remote config.

## Setup

```bash
git clone https://github.com/mesomya/refeed.git
cd refeed
```

Then load it unpacked:

1. Open `chrome://extensions` (Chrome/Edge/Brave/Arc).
2. Turn on **Developer mode**.
3. **Load unpacked** â†’ select the `refeed` folder.

After editing, click the **â†» reload** button on the Refeed card in `chrome://extensions`,
then **hard-refresh** your x.com tab (Cmd/Ctrl + Shift + R) so the content scripts
re-inject. (On install/update Refeed reloads open x.com tabs for you.)

## How it's organized

| File | Runs in | Job |
| --- | --- | --- |
| `src/page-hook.js` | page MAIN world | Sees X's GraphQL requests; captures + replays them. No `chrome.*` APIs. |
| `src/content.js` | ISOLATED world | Bridge to the worker + weaves cards into the timeline. |
| `src/background.js` | service worker | Owns the IndexedDB archive, settings, collect orchestration. |
| `src/mixer.css` | page | Styles for the woven-in cards + status pill. |
| `src/popup/` | popup | The control panel. |

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full picture â€” the data
flows, the cross-world messaging, and the non-obvious decisions (and the gotchas that
will absolutely bite you if you don't know them).

## Conventions

- **User-facing words are Refeed's own vocabulary** (Collected / Liked / Saved, Replay,
  Spacing, Depth, â€¦). Keep them consistent.
- The internal CSS/JS prefix is `xhm-`. It's invisible to users; leave it as-is for
  churn-free diffs.
- X's request op-names are matched by substring in `classify()` (`page-hook.js`). If you
  add a match, add a guard for look-alikes (we've been burned by `BookmarkFoldersSlice`
  and `CreateBookmark`).

## Testing your change

There's no test runner, but do this before opening a PR:

```bash
node --check src/background.js
node --check src/content.js
node --check src/page-hook.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"   # manifest parses
```

- **UI changes** (cards, pill, popup) can be checked with a throwaway HTML page that
  loads `src/mixer.css` and renders the markup `buildCard()` produces. The real
  TwitterChirp font only exists on x.com, so judge layout/spacing/colors, not the font.
- **Capture/collect changes** need a logged-in X session â€” there's no way around it.
  Use the `[Refeed] â€¦` `console.info` breadcrumbs in the page console to see what's
  happening (op classifications, capture, collect counts).

## Reporting a bug

Open an issue with:

- Browser + version, and the Refeed version (from `chrome://extensions`).
- What you did and what happened.
- Any `[Refeed]` lines from the **page** console, and any errors from the **service
  worker** console (`chrome://extensions` â†’ Refeed â†’ *Inspect views: service worker*).

## Pull requests

- One focused change per PR; describe the user-visible effect.
- Update `CHANGELOG.md` (Unreleased section) and `docs/ARCHITECTURE.md` if you change
  behavior or architecture.
- Be kind in reviews and issues. That's the whole code of conduct.
