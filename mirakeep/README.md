# MiraKeep — Original Image Saver

> 一个 Chrome / Edge 浏览器右键菜单图片保存插件，专为解决 Twitter / X 图片被错误保存为 `.exif` 的问题而设计。

---

## 核心特性

- **零画质损失**：不转 PNG、不用 Canvas 重编码、不截图、不重新压缩
- **原始格式保存**：下载的是服务器返回的原始字节流，像素级一致
- **智能扩展名识别**：URL `format` 参数 → Content-Type → URL 路径扩展名 → fallback `.jpg`
- **Twitter/X 专用优化**：正确处理 `pbs.twimg.com/media/` 链接

---

## 文件结构

```
mirakeep/
├── manifest.json          # Manifest V3 配置
├── background.js          # Service Worker 主逻辑
├── icons/
│   ├── icon16.png         # 16×16 图标
│   ├── icon48.png         # 48×48 图标
│   └── icon128.png        # 128×128 图标
└── README.md              # 本文件
```

---

## 安装方法

### Chrome

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `mirakeep` 文件夹
5. 插件出现在扩展列表中，安装完成

### Edge

1. 打开 Edge，地址栏输入 `edge://extensions/`
2. 左下角开启 **开发人员模式**
3. 点击 **加载解压缩**
4. 选择 `mirakeep` 文件夹
5. 安装完成

---

## 使用方法

1. 在任意网页上右键点击一张图片
2. 选择 **MiraKeep：保存原始图片**
3. 图片自动下载，文件名和扩展名已正确处理

---

## 测试方法

### 测试 1：Twitter / X 图片

打开以下 URL（在推文中找到图片，右键保存）：

```
https://pbs.twimg.com/media/HKVwXVLa0AAwuyM?format=jpg&name=large
```

**预期结果**：下载为 `HKVwXVLa0AAwuyM.jpg`

**不应出现**：`.exif`、`.png`（除非原始格式确实是 PNG）

### 测试 2：带 format=png 的 Twitter 图片

```
https://pbs.twimg.com/media/ABCDEF123456?format=png&name=orig
```

**预期结果**：`ABCDEF123456.png`

### 测试 3：普通网站图片

任意网站上的 `.jpg` / `.png` / `.webp` 图片，右键保存后应保留原始扩展名。

### 测试 4：无扩展名的图片 URL

一些 CDN 图片 URL 没有扩展名，插件会通过 Content-Type 判断，失败时 fallback 为 `.jpg`。

---

## 扩展名判断优先级

| 优先级 | 来源 | 示例 |
|--------|------|------|
| 1 | URL `format` 参数 | `?format=jpg` → `.jpg` |
| 2 | HTTP `Content-Type` 头 | `image/webp` → `.webp` |
| 3 | URL 路径中的扩展名 | `/photo.png` → `.png` |
| 4 | Fallback | 默认 `.jpg` |

---

## 为什么不会造成画质损失

1. **不使用 Canvas**：没有任何 `canvas.toBlob()` 或 `canvas.toDataURL()` 调用
2. **不转格式**：不会把 JPEG 转成 PNG 或反过来
3. **不重新压缩**：`chrome.downloads.download` 直接下载 URL 原始字节
4. **字节级一致**：下载的文件与服务器返回的 HTTP 响应体完全相同
5. **仅改文件名**：插件唯一做的事是给下载文件一个正确的名字和扩展名

这和你在浏览器里"另存为"的效果一样，但文件名更准确。

---

## 权限说明

| 权限 | 用途 |
|------|------|
| `contextMenus` | 添加右键菜单项 |
| `downloads` | 调用浏览器下载 API |
| `activeTab` | 获取当前标签信息（用于 Content-Type 探测） |
| `<all_urls>` | 允许对任意域名的图片发起 HEAD 请求探测 Content-Type |

---

## 已知限制

- Content-Type 探测依赖 HEAD 请求，如果目标服务器拒绝 HEAD 或 CORS 不允许，会降级到 URL 路径扩展名或 fallback
- 占位图标是纯色方块，可替换为正式设计
- 不处理需要登录/认证的图片（如私密推文的图片）

---

## License

MIT
