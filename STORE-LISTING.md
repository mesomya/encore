# Refeed Chrome Web Store Listing Kit

Use this file when updating the Chrome Web Store listing for Refeed.

## Package

Upload package: `refeed-webstore-1.2.0.zip`

Important: the zip must have `manifest.json` at the root. Do not upload a zip that contains a nested `refeed/` folder.

## Store Listing

### Name

Refeed - X Bookmarks in Your Feed

### Category

Tools

### Language

English (United States)

### Summary

Bring your saved X bookmarks back into your timeline. Likes are optional. Private, on-device, and read-only.

### Detailed Description

Refeed brings your saved X bookmarks back into your Home timeline.

You bookmark posts on X because you want to come back to them. Refeed puts those saved posts back into the place you already scroll: your feed. Run Collect from the popup, choose how often saved posts should appear, and Refeed mixes them between normal posts as you scroll.

What it does:
- Collects your X bookmarks into a private library on your device.
- Shows saved posts back in your Home timeline every few posts.
- Tags resurfaced posts so you know why they appeared.
- Lets you control spacing, collection depth, and appearance.
- Can also include liked posts if you choose, but bookmarks are the main focus.

Privacy:
- Everything stays on your device.
- No account, no server, no analytics, no tracking.
- Read-only: Refeed never likes, follows, posts, replies, reposts, bookmarks, unbookmarks, or messages on your behalf.
- Refeed never stores your X login.

Open source: https://github.com/mesomya/refeed

Refeed is independent and is not affiliated with, endorsed by, or sponsored by X Corp.

## Additional Fields

Homepage URL: https://github.com/mesomya/refeed

Support URL: https://github.com/mesomya/refeed/issues

Mature content: Off

## Privacy Practices

### Single Purpose

Refeed brings the user's own saved X bookmarks back into their Home timeline and keeps a private, on-device archive of those saved posts. Liked posts can optionally be collected too, but bookmarks are the primary purpose.

### Permission Justifications

#### storage
Stores user settings and the local index of collected posts in the browser's own storage on the user's device.

#### unlimitedStorage
Allows the local archive to hold a full personal history of saved X bookmarks, which may contain thousands of posts.

#### scripting
Attaches Refeed's content script to an x.com tab that was already open when the extension was enabled, so the extension works without forcing a disruptive reload.

#### webRequest
Reads, on a read-only basis, the shape of the x.com GraphQL requests the browser already makes for Bookmarks and Likes. Refeed uses that request shape to collect the user's own saved posts when the user clicks Collect. It never blocks, modifies, redirects, or transmits requests.

#### Host permission
Refeed runs only on X. It needs access to x.com / twitter.com to read the user's own bookmarks and weave saved posts back into the Home timeline.

### Remote Code

Select: No, I am not using remote code.

### Data Usage

Check exactly one data category:

- Website content

Leave every other data category unchecked.

Tick all three certification checkboxes:

- I do not sell or transfer user data to third parties.
- I do not use or transfer user data for purposes unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending.

### Privacy Policy URL

https://github.com/mesomya/refeed/blob/main/PRIVACY.md

## Access / Test Instructions

Refeed only acts on x.com while the reviewer is logged into an X account. To test it:

1. Enable the extension; it appears in the toolbar as Refeed.
2. Go to https://x.com and log in to an X account that already has some bookmarked posts. Liked posts are optional.
3. Open the Bookmarks page once. If testing likes too, open the profile's Likes tab once. This lets Refeed observe, read-only, the request it later replays. Nothing is uploaded.
4. Click the Refeed toolbar icon and press Collect everything. The Collected / Liked / Saved counts climb as it gathers saved posts into local storage.
5. Go to the Home timeline and scroll. Every few posts, one of the user's saved posts is woven in and tagged with why it appeared.
6. If nothing appears after Collect, hard-refresh the Home tab with Ctrl/Cmd+Shift+R and scroll again.

All data stays in the browser's local storage on the device. The only network requests Refeed makes go to X's own API, using the user's existing session.

## Assets Status

Logo and final store screenshots are pending. Current logo exploration sheets are in this folder:

- `refeed-logo-options-2x2.png`
- `refeed-logo-options-3x3.png`

After the logo is chosen, regenerate:

- 128x128 store icon
- 1280x800 screenshots
- 1400x560 marquee promo tile
- 440x280 small promo tile


