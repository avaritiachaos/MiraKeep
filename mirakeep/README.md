# 原封 (YuanFeng) — 原图无损保存

> 一个 Chrome / Edge 右键菜单图片/动图保存插件：原封不动保存原始文件字节，
> 专治 Twitter / X 图片被错误保存为 `.exif` / `.jfif`、推特 GIF 动图无法保存、防盗链站点存不下来等问题。

> 曾用名 MiraKeep（仓库目录沿用旧名）。

---

## 核心特性

- **零画质损失（静态图）**：不转 PNG、不用 Canvas 重编码、不截图、不重新压缩，落盘的就是服务器返回的原始字节流
- **Twitter / X 动图保存（v2.1.0 新增）**：
  - 自动识别 Twitter GIF（推特服务端将所有 GIF 封装为 `tweet_video` 无音轨 MP4）
  - 穿透推特视频播放器遮罩层，精准捕获动图 ID
  - **默认转存为真实 `.gif` 文件**：浏览器本地通过纯 JS `gifenc` 解帧与色彩量化（PnnQuant），生成真实 `.gif` 动图，方便直接导入微信 / QQ 表情包及论坛发布
  - **支持原版 MP4 极速保存**：点击插件图标弹出设置面板，可一键切换为保存 MP4 原视频，零转码、无损原画质、秒级完成
- **原图优先**：Twitter/X 普通图片自动升级 `name=orig`，微博缩略图自动换 `/large/`，pixiv `img-master` 自动尝试 `img-original`
- **逐级兜底，能存就存**：候选 URL 依次直接下载（带 Referer 反防盗链）→ 失败自动换下一个 → 全失败后由后台 fetch 抓字节再存 → 仍失败在工具栏图标闪 ✕ 提示
- **扩展名强制纠正**：`onDeterminingFilename` 拦截 Chrome 的 content sniffing，杜绝 `.exif` / `.jfif`
- **智能扩展名识别**：URL `format` 参数 → URL 路径后缀 → HEAD 请求探测 `Content-Type` → fallback `.jpg`
- **iframe 内图片可存**：content script 注入所有 frame，按 frameId 定向查询
- **每次右键重新捕获**：找不到图就明确清空，不会把上一次的旧图错存下来
- **转码状态与 Toast 提示**：转码动图时展示页面悬浮 Toast 进度，工具栏图标展示 `GIF` / `✓` 徽章状态

---

## 文件结构

```
mirakeep/
├── manifest.json          # Manifest V3 配置
├── background.js          # Service Worker：候选链下载 / 转码调度 / 文件名纠正 / 兜底
├── content.js             # 捕获右键目标的真实媒体 URL / 视频解帧与 gifenc 转码 / Toast
├── lib/
│   └── gifenc.js          # 快速轻量纯 JS GIF 编码库（MIT License）
├── popup.html             # 扩展弹出设置面板（动图保存格式、尺寸与帧率）
├── popup.js               # 设置面板逻辑（chrome.storage.local 持久化）
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## 安装方法

### Chrome

1. 打开 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择 `mirakeep` 文件夹

### Edge

1. 打开 `edge://extensions/`
2. 左下角开启 **开发人员模式**
3. 点击 **加载解压缩**，选择 `mirakeep` 文件夹

> **更新旧版后注意**：在扩展页点一次「重新加载」，并**刷新已打开的标签页**
> （旧页面里的 content script 不会自动更新）。

---

## 使用方法

1. **保存普通图片**：在任意网页上右键点击图片，选择 **保存原图**，原字节无损保存。
2. **保存 Twitter / X 动图**：
   - 在推文的动图（带有 `▶ GIF` 标签的内容）上直接点击鼠标右键，选择 **保存原图**。
   - 页面右下角将出现转码进度提示，转码完成后自动弹出 `.gif` 保存对话框。
   - 如需保存推特服务器原版 `.mp4` 视频，点击浏览器工具栏的「原封」图标，切换为「保存为原始 .mp4 视频」即可。

---

## 动图设置说明（点击工具栏图标）

| 设置项 | 选项 | 说明 |
|--------|------|------|
| **保存格式** | 转存为真实 `.gif` 动图 (默认) | 方便直接发微信/QQ 表情包或各平台发布 |
| | 保存为原始 `.mp4` 视频 | 推特 CDN 原始字节流无损直接下载，体积小速度快 |
| **动图尺寸上限** | 480px / 640px (默认) / 原始尺寸 | 限制生成 GIF 的最大长宽，平衡画质与文件体积 |
| **采样帧率** | 15 fps / 20 fps (默认) / 25 fps | 控制动图流畅度与文件大小 |

---

## 站点专项优化

| 站点 | 处理 |
|------|------|
| Twitter / X 动图 (`tweet_video`) | 穿透播放器遮罩层探测 `tweet_video_thumb` 与 `tweet_video`，按设置转为 `.gif` 或下载 `.mp4` |
| Twitter / X 图片 (`pbs.twimg.com`) | 探测 jpg / png 的 `name=orig` 原件（实测 orig 仅存在于 X 存储的真实格式，请求错格式是 404 而非转码，因此绝不会存到转码图；webp 缩略图会自动换回真实格式）→ `name=large` → 原 URL；文件名取 media ID |
| 微博 (`*.sinaimg.cn`) | `orj360` / `mw690` 等缩略路径 → `/large/` |
| pixiv (`i.pximg.net`) | `img-master` → `img-original`（jpg / png 依次尝试） |

---

## 测试方法

### 测试 1：Twitter / X 动图（GIF）
在推文动图（带有 `▶ GIF` 标识）上右键 → 保存原图。
**预期**：页面提示转码进度，生成并下载 `.gif` 动图，文件名形如 `<mediaKey>.gif`；在设置中切换为 MP4 后可直接秒下原始 `.mp4`。

### 测试 2：Twitter / X 静态图片
在推文中右键图片 → 保存原图。
**预期**：下载 `name=orig` 原图，文件名形如 `HKVwXVLa0AAwuyM.jpg`；不应出现 `.exif` / `.jfif`。

### 测试 3：微博图片
右键正文缩略图 → 保存原图。**预期**：下载 `/large/` 大图。

### 测试 4：设置面板切换
点击插件图标，切换保存格式与参数，修改后即时持久化生效。

---

## 为什么不会造成画质损失

1. **静态图片不使用 Canvas**：直接下载 URL 原始字节，没有任何 `canvas.toBlob()` / `canvas.toDataURL()` 重编码调用。
2. **字节级一致**：静态图落盘文件与服务器返回的 HTTP 响应体完全相同。
3. **推特动图针对性处理**：推特本身并不在 CDN 存储 `.gif`，用户上传的 GIF 在入库时已被推特服务端压制为 H.264/MP4。插件既支持转成表情包专用的 `.gif`，又提供推特 CDN 原版 MP4 直下，满足各种场景需求。

---

## License

MIT
