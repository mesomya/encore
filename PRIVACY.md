# Refeed Privacy Policy

_Last updated: June 2026_

Refeed is a browser extension that brings your saved X bookmarks back into your Home timeline. It can also collect liked posts if you choose to include them, but bookmarks are the primary use case.

## Short Version

Refeed works locally on your device. It has no server, no account system, no analytics, and no advertising. It does not sell, share, or upload your data.

## Data Refeed Accesses

- **Your X bookmarks**: post text, author, media URL, counts, timestamp, and original post link.
- **Your liked posts, if you choose to collect them**: the same post fields listed above.
- **Request shape for X Bookmarks/Likes**: Refeed observes, read-only, the X GraphQL request your browser already makes so it can later fetch your own saved posts when you press Collect.

## Data Refeed Does Not Access

Refeed does not access your X password, your `auth_token` session cookie, payment information, location, personal communications, or any website outside x.com / twitter.com.

## Storage

Collected posts and settings are stored locally in the browser using IndexedDB and `chrome.storage.local`, on the extension's private origin. Removing the extension or using **Empty the library** deletes the local archive.

## Network Requests

The only network requests Refeed makes go to X's own API, using your existing logged-in browser session, to fetch your own bookmarks or liked posts. Refeed does not send your data to any third-party server.

## Account Actions

Refeed is read-only. It never likes, follows, posts, replies, reposts, bookmarks, unbookmarks, or sends messages on your behalf.

## Permissions

- `storage` / `unlimitedStorage`: keep your local archive and settings.
- `scripting`: attach Refeed to an x.com tab that was already open when the extension was enabled.
- `webRequest`: read-only; identify the Bookmarks/Likes request your browser already makes. Refeed never blocks, modifies, or redirects requests.
- Host access to `x.com` / `twitter.com`: Refeed runs only on X.

## Open Source

Source code: https://github.com/mesomya/refeed

Questions or concerns: https://github.com/mesomya/refeed/issues

Refeed is independent and is not affiliated with, endorsed by, or sponsored by X Corp.
