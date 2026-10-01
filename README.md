# 原封 (YuanFeng)

> Chrome / Edge extension to save images and Twitter GIFs in their original or converted format without quality loss.
> Formerly known as **MiraKeep** (the repo keeps the old directory name).

Right-click any image or Twitter GIF → **保存原图** (Save Original). What lands on disk is either:
- **Images**: the exact byte stream the server returned — no canvas, no re-encoding, no recompression — with the correct filename and extension (no more `.exif` / `.jfif`).
- **Twitter GIFs**: automatically converted in-browser to a real `.gif` animation (or saved directly as the server's original `.mp4` video, configurable via the popup).

## Install

1. Download or clone this repo
2. Open `chrome://extensions/` or `edge://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the `mirakeep` folder

After updating from an older version: hit **Reload** on the extension, then
**refresh open tabs** so the new content script takes over.

## Features

- **Zero quality loss for static images** — original bytes only, byte-identical to the server response
- **Twitter/X GIF & Animation Support (New in v2.1.0)** — captures Twitter GIF player overlays, converts to real `.gif` files using pure JS `gifenc`, or saves as original `.mp4`
- **Popup Settings** — toggle between `.gif` animation export and original `.mp4` video with one click, with customizable resolution and FPS limits
- **Original-quality upgrades** — Twitter/X `name=orig`, Weibo `/large/`, pixiv `img-master → img-original`
- **Resilient download chain** — candidate URLs tried in order with a `Referer` header (hotlink-protected CDNs work); on failure falls back to a service-worker `fetch`; visual badge and toast indicators
- **Forced correct extension** — `onDeterminingFilename` beats Chrome's content sniffing, so EXIF-bearing JPEGs stay `.jpg`
- **Works inside iframes** — content script injected into all frames, queried by `frameId`
- **Fresh capture per right-click** — stale state from a previous click is cleared, so you never save yesterday's image by accident

## How it works

1. The content script captures the real media URL at the exact element you right-clicked:
   - Twitter GIF: recognizes `<video>`, video player overlays, `tweet_video` links, and `tweet_video_thumb` posters
   - Images: largest `srcset` entry, CSS background images, image-viewer overlays, resolving relative URLs
2. For Twitter GIFs:
   - If set to `.gif` (default): decodes video frames client-side and encodes them into a vibrant 256-color animated GIF using `gifenc`
   - If set to `.mp4`: downloads the server's original `.mp4` video directly
3. For regular images:
   - The background service worker builds a candidate chain (original → large → as-clicked), picks the extension (`format` param → path → HEAD `Content-Type`), and downloads with `chrome.downloads.download` + `Referer`
4. `onDeterminingFilename` forces the correct filename on whatever succeeds.

## License

MIT
