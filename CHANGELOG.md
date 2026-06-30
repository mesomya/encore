# Changelog

All notable changes to Refeed are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] â€” 2026-06-27

### Changed
- **Reworked request capture to the browser's network layer** (`webRequest`, read-only).
  The old approach relied on a page-side `window.fetch` hook, which could silently miss
  X's request depending on the browser/page state â€” the cause of "Open your bookmarks page
  onceâ€¦ and then try again" appearing *while already on the bookmarks page* on some
  machines. Capture now works consistently across platforms and Chromium browsers.

### Removed
- **Automatic collection and the on-page status pill.** Collecting now runs only when you
  press **Collect** in the popup â€” nothing collects or pops up on its own. (Removed the
  route-poll auto-collect, the background hourly top-up, and the `alarms` permission.)
- All `console` logging from the extension's runtime, so the page and service-worker
  consoles stay clean.

### Fixed
- Attach to x.com tabs that were already open when the extension loaded (via `scripting`),
  without a disruptive full reload â€” fixes capture failing on a fresh install.
- Injected scripts are now idempotent, so double-injection can't duplicate listeners.

## [1.0.1] â€” 2026-06-27

### Added
- **Automatic collection** when you open your Bookmarks or Likes page â€” it pulls in
  anything new on its own, shown by a small on-page status pill.
- **Incremental collect:** collecting now stops as soon as it reaches posts already in
  your archive instead of re-walking your whole history every time.
- **Open in place:** clicking a resurfaced post opens it in the same tab, and Back
  returns you to the exact spot in your feed.
- Resurfaced cards now show **filled like/bookmark states** and a subtle "like" burst.

### Fixed
- Reload open x.com tabs on install/update so the capture hook is active immediately
  (content scripts otherwise skip tabs that were already open).
- Ignore X's `BookmarkFoldersSlice` request â€” it shares the "bookmark" name but carries
  no posts, and was overwriting the real collect recipe (collecting returned 0).
- Only learn the collect recipe from GraphQL **reads** (GET), never from
  bookmark/unbookmark mutations.
- Guard all messaging against "Extension context invalidated" after a reload/update.
- Match X's native post styling exactly (font, dividers, action-bar layout, theme grays).

## [1.0.0] â€” 2026-06-22

### Added
- Initial release. Collect your liked and saved posts into a private local archive
  (IndexedDB) and replay them into your X Home timeline, styled to read as native posts.
- Minimal popup: master switch, spacing/depth sliders, per-source collect, appearance,
  and a two-tap "empty the library".
