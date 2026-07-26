# 原封 (YuanFeng) — 原图无损保存

> 一个 Chrome / Edge 右键菜单图片保存插件：原封不动保存原始文件字节，
> 专治 Twitter / X 图片被错误保存为 `.exif` / `.jfif`、防盗链站点存不下来等问题。

> 曾用名 MiraKeep（仓库目录沿用旧名）。

---

## 核心特性

- **零画质损失**：不转 PNG、不用 Canvas 重编码、不截图、不重新压缩，落盘的就是服务器返回的原始字节流
- **原图优先**：Twitter/X 自动升级 `name=orig`，微博缩略图自动换 `/large/`，pixiv `img-master` 自动尝试 `img-original`
- **逐级兜底，能存就存**：候选 URL 依次直接下载（带 Referer 反防盗链）→ 失败自动换下一个 → 全失败后由后台 fetch 抓字节再存 → 仍失败在工具栏图标闪 ✕ 提示
- **扩展名强制纠正**：`onDeterminingFilename` 拦截 Chrome 的 content sniffing，杜绝 `.exif` / `.jfif`
- **智能扩展名识别**：URL `format` 参数 → URL 路径后缀 → HEAD 请求探测 `Content-Type` → fallback `.jpg`
- **iframe 内图片可存**：content script 注入所有 frame，按 frameId 定向查询
- **每次右键重新捕获**：找不到图就明确清空，不会把上一次的旧图错存下来

---

## 文件结构

```
mirakeep/
├── manifest.json          # Manifest V3 配置
├── background.js          # Service Worker：候选链下载 / 文件名纠正 / 兜底
├── content.js             # 捕获右键目标的真实图片 URL（srcset / 背景图 / 图片查看器蒙层）
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
> （旧页面里的 content script 不会自动更新；不刷新时插件仍可用，但只能走
> Chrome 自带的 srcUrl 降级路径）。

---

## 使用方法

1. 在任意网页上右键点击图片（普通 `<img>`、CSS 背景图、图片查看器蒙层都可以）
2. 选择 **保存原图**
3. 在保存对话框确认位置，完成

---

## 下载流程

```
右键点击
  → content.js 捕获本次右键的真实图片 URL（srcset 最大项 / 背景图 / 就近大图）
  → background 生成候选链：原图 URL → 大图 URL → 原始 URL
  → 依次 chrome.downloads.download（带 Referer，防盗链站点可用）
      ├─ 某候选 403/404/中断 → 自动换下一个候选
      └─ 全部失败 → Service Worker fetch（带 Cookie）→ data URL 落盘
  → onDeterminingFilename 强制覆盖文件名，防 .exif/.jfif
  → 全部方式失败 → 工具栏图标闪红色 ✕
```

### 站点专项优化

| 站点 | 处理 |
|------|------|
| Twitter / X (`pbs.twimg.com`) | 探测 jpg / png 的 `name=orig` 原件（实测 orig 仅存在于 X 存储的真实格式，请求错格式是 404 而非转码，因此绝不会存到转码图；webp 缩略图会自动换回真实格式）→ `name=large` → 原 URL；文件名取 media ID |
| 微博 (`*.sinaimg.cn`) | `orj360` / `mw690` 等缩略路径 → `/large/` |
| pixiv (`i.pximg.net`) | `img-master` → `img-original`（jpg / png 依次尝试） |

---

## 扩展名判断优先级

| 优先级 | 来源 | 示例 |
|--------|------|------|
| 1 | URL `format` 参数 | `?format=jpg` → `.jpg` |
| 2 | URL 路径中的扩展名 | `/photo.png` → `.png` |
| 3 | HEAD 请求的 `Content-Type` | `image/webp` → `.webp` |
| 4 | Fallback | 默认 `.jpg` |

---

## 测试方法

### 测试 1：Twitter / X 图片

在推文中右键图片 → 保存原图。

**预期**：下载 `name=orig` 原图，文件名形如 `HKVwXVLa0AAwuyM.jpg`；
**不应出现** `.exif` / `.jfif`。

### 测试 2：微博图片

右键正文缩略图 → 保存原图。**预期**：下载 `/large/` 大图。

### 测试 3：iframe 里的图片

嵌在 iframe 中的图片右键保存应正常工作。

### 测试 4：连续在不同图片上右键

先右键图片 A（不保存），再右键空白处点「保存原图」——
**预期**：不会把图片 A 存下来（旧版 bug：残留上一次的图）。

### 测试 5：无扩展名的 CDN 图片

URL 无扩展名时通过 HEAD 的 Content-Type 判断，失败 fallback `.jpg`。

---

## 为什么不会造成画质损失

1. **不使用 Canvas**：没有任何 `canvas.toBlob()` / `canvas.toDataURL()` 调用
2. **不转格式、不重新压缩**：`chrome.downloads.download` 直接下载 URL 原始字节
3. **字节级一致**：落盘文件与服务器返回的 HTTP 响应体完全相同
4. **仅改文件名**：插件唯一做的事是给文件一个正确的名字和扩展名

fetch 兜底路径同样只做「字节 → base64 → 落盘」，不经过任何图像解码。

---

## 权限说明

| 权限 | 用途 |
|------|------|
| `contextMenus` | 添加右键菜单项 |
| `downloads` | 调用浏览器下载 API、纠正文件名、失败时清理下载条目 |
| `scripting` | 注入兜底脚本（在页面里找最大的图） |
| `<all_urls>` | content script 注入、HEAD 探测 Content-Type、fetch 兜底 |

---

## 已知限制

- 需要登录态 + 防盗链双重校验且拒绝扩展请求的图片可能仍然失败（会有 ✕ 提示）
- Canvas 绘制的图片（无真实 URL）无法保存
- 极少数环境不允许下载请求携带自定义 Referer 头，此时自动退回无 Referer 重试

---

## License

MIT
