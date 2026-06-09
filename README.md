# MiraKeep

> Chrome / Edge extension to save images in their original format without quality loss.

Solves the problem of Twitter/X images being saved as `.exif` by the browser or download managers.

## Install

1. Download or clone this repo
2. Open `chrome://extensions/` or `edge://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the `mirakeep` folder

## Usage

Right-click any image → **MiraKeep: Save Original**

## Features

- **Zero quality loss** — no canvas, no re-encoding, no recompression
- **Smart extension detection** — `format` param → Content-Type → URL path → fallback `.jpg`
- **Twitter/X optimized** — extracts image ID, upgrades to original quality (`name=orig`)
- **Forces correct extension** — uses `onDeterminingFilename` to prevent `.exif` overwrite
- **Clean filenames** — `HKVwXVLa0AAwuyM.jpg` instead of random server names

## How it works

1. Content script captures the real image URL on right-click (including `srcset` parsing)
2. Background script normalizes the URL and determines the correct file extension
3. Downloads the image with `chrome.downloads.download` and forces the correct filename via `onDeterminingFilename`

No canvas. No PNG conversion. Just the original bytes with the right name.

## License

MIT
