# 原封 (YuanFeng)

> Chrome / Edge extension to save images in their original format without quality loss.
> Formerly known as **MiraKeep** (the repo keeps the old directory name).

Right-click any image → **保存原图** (Save Original). What lands on disk is the exact
byte stream the server returned — no canvas, no re-encoding, no recompression —
with the correct filename and extension (no more `.exif` / `.jfif`).

## Install

1. Download or clone this repo
2. Open `chrome://extensions/` or `edge://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the `mirakeep` folder

After updating from an older version: hit **Reload** on the extension, then
**refresh open tabs** so the new content script takes over.

## Features

- **Zero quality loss** — original bytes only, byte-identical to the server response
- **Original-quality upgrades** — Twitter/X `name=orig`, Weibo `/large/`, pixiv `img-master → img-original`
- **Resilient download chain** — candidate URLs tried in order with a `Referer` header
  (hotlink-protected CDNs work); on failure falls back to a service-worker `fetch`;
  a red ✕ badge on the toolbar icon signals total failure instead of silence
- **Forced correct extension** — `onDeterminingFilename` beats Chrome's content
  sniffing, so EXIF-bearing JPEGs stay `.jpg`
- **Works inside iframes** — content script injected into all frames, queried by `frameId`
- **Fresh capture per right-click** — stale state from a previous click is cleared,
  so you never save yesterday's image by accident

## How it works

1. The content script captures the real image URL at the exact element you
   right-clicked (largest `srcset` entry, CSS background images, image-viewer
   overlays), resolving relative URLs
2. The background service worker builds a candidate chain (original → large →
   as-clicked), picks the extension (`format` param → path → HEAD `Content-Type`),
   and downloads with `chrome.downloads.download` + `Referer`
3. Failed candidates advance automatically; `onDeterminingFilename` forces the
   correct filename on whatever succeeds

No canvas. No PNG conversion. Just the original bytes with the right name.

## License

MIT
