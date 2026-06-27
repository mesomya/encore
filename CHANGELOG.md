# Changelog

All notable changes to Encore are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-06-27

### Added
- **Automatic collection** when you open your Bookmarks or Likes page — it pulls in
  anything new on its own, shown by a small on-page status pill.
- **Incremental collect:** collecting now stops as soon as it reaches posts already in
  your archive instead of re-walking your whole history every time.
- **Open in place:** clicking a resurfaced post opens it in the same tab, and Back
  returns you to the exact spot in your feed.
- Resurfaced cards now show **filled like/bookmark states** and a subtle "like" burst.

### Fixed
- Reload open x.com tabs on install/update so the capture hook is active immediately
  (content scripts otherwise skip tabs that were already open).
- Ignore X's `BookmarkFoldersSlice` request — it shares the "bookmark" name but carries
  no posts, and was overwriting the real collect recipe (collecting returned 0).
- Only learn the collect recipe from GraphQL **reads** (GET), never from
  bookmark/unbookmark mutations.
- Guard all messaging against "Extension context invalidated" after a reload/update.
- Match X's native post styling exactly (font, dividers, action-bar layout, theme grays).

## [1.0.0] — 2026-06-22

### Added
- Initial release. Collect your liked and saved posts into a private local archive
  (IndexedDB) and replay them into your X Home timeline, styled to read as native posts.
- Minimal popup: master switch, spacing/depth sliders, per-source collect, appearance,
  and a two-tap "empty the library".
