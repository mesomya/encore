<div align="center">

<img src="icons/icon-128.png" width="84" height="84" alt="Refeed icon" />

# Refeed

**Bring your saved X bookmarks back into your timeline.**

Refeed collects your own X bookmarks into a private, on-device archive, then mixes those saved posts back into your Home timeline as you scroll. Liked posts are supported too, but bookmarks are the main idea: the posts you saved should not disappear into a list you never revisit.

<p>
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-1d9bf0" />
  <img alt="Chromium browsers" src="https://img.shields.io/badge/Chrome%20·%20Edge%20·%20Brave%20·%20Arc-supported-555" />
  <img alt="100% local" src="https://img.shields.io/badge/data-100%25%20local-2ea44f" />
  <img alt="No tracking" src="https://img.shields.io/badge/tracking-none-2ea44f" />
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue" /></a>
</p>

</div>

---

## What It Does

You bookmark posts on X because you want to come back to them. Then they sit in Bookmarks, out of sight.

Refeed brings them back into the place you already scroll: your Home timeline. Run Collect from the popup, choose how often saved posts should appear, and Refeed quietly weaves them between normal posts. Each resurfaced post is tagged so you know why it appeared, with a link back to the original.

## Features

- **Bookmark-first collecting** - collect your X bookmarks into a private local library.
- **Timeline resurfacing** - saved posts appear back in Home as you scroll.
- **Likes as an extra** - optionally collect liked posts too, if you want them included.
- **Simple controls** - choose spacing, collection depth, sources, and appearance.
- **Native feel** - resurfaced posts match X's spacing, typography, actions, and theme.
- **Private by design** - no account, no server, no analytics, no tracking.

## How It Works

X's web app already asks X for your Bookmarks and Likes when you open those pages. Refeed observes the shape of those requests on a read-only basis, then replays the same request when you click Collect so it can fetch your own saved posts.

Nothing is uploaded to Refeed. The archive lives in your browser's local storage on the extension's own origin. The only network requests go to X's own API, using your existing logged-in session.

## Install From Source

```bash
git clone https://github.com/mesomya/refeed.git
```

Then open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the repository folder containing `manifest.json`.

## First Run

1. Log in to x.com.
2. Open your Bookmarks page once. If you want liked posts too, open your Likes tab once.
3. Open the Refeed popup and click **Collect everything**.
4. Go to Home and scroll. Saved posts will appear between normal posts.
5. If nothing appears after collecting, hard-refresh the X tab with Ctrl/Cmd+Shift+R and scroll again.

## Configuration

| Control | What it does |
| --- | --- |
| **Replay in my feed** | Turns timeline resurfacing on or off. |
| **Spacing** | Controls how often a saved post appears. |
| **Depth** | Controls how far back Collect walks. |
| **Collect everything** | Collects bookmarks and, if enabled, likes. |
| **Likes only / Saves only** | Collects one source at a time. |
| **Empty the library** | Deletes the local archive. |

## Privacy

- Refeed stores collected posts locally in IndexedDB and `chrome.storage.local`.
- Refeed does not have a server and does not upload your archive anywhere.
- Refeed never likes, follows, posts, replies, or sends messages for you.
- Host access is limited to `x.com` and `twitter.com`.
- The `webRequest` permission is used read-only to identify the Bookmarks/Likes request your browser already makes. Refeed does not block, modify, redirect, or transmit requests.

See [PRIVACY.md](PRIVACY.md) for the full policy.

## Development

No build step and no dependencies. Edit files, reload the extension in `chrome://extensions`, then hard-refresh x.com.

```text
refeed/
├─ manifest.json
├─ src/
│  ├─ background.js
│  ├─ content.js
│  ├─ page-hook.js
│  ├─ mixer.css
│  └─ popup/
├─ icons/
├─ docs/
└─ tools/
```

## License

[MIT](LICENSE) © 2026 Somya

---

<sub>Refeed is an independent project and is not affiliated with, endorsed by, or sponsored by X Corp. X and related marks belong to their respective owners.</sub>
