// ============================================================
// 原封 (YuanFeng) — background.js  (v2.1.0)
// Service Worker (Manifest V3)
//
// ★ 核心特性：
//   1. 原图无损保存：直接保存原始字节流，纠正 .exif / .jfif 扩展名。
//   2. 动图扩展支持（v2.1.0 新增）：
//      - 识别 Twitter/X 动图（tweet_video_thumb / tweet_video / <video>）。
//      - 默认在 content.js 中通过 gifenc 转码为真实 .gif 动图文件，方便作为表情包。
//      - 可在弹出设置中一键切换为保存 MP4 原始无损视频。
//      - 转码失败自动降级到直接下载 MP4 原件，确保绝不丢失内容。
//   3. 逐级兜底策略：
//      候选链直接下载（带 Referer）→ 换候选 → SW fetch 兜底 → 状态徽章反馈。
// ============================================================

const MENU_ID = "yuanfeng-save";

const KNOWN_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif",
  "svg", "bmp", "tiff", "tif", "ico",
  "mp4", "webm",
]);

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", bmp: "image/bmp", tiff: "image/tiff",
  tif: "image/tiff", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm",
};

// ============================================================
// 1. 安装：注册右键菜单
// ============================================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "保存原图",
      contexts: ["all"],
    });
  });
});

// ============================================================
// 2. 消息监听：处理跨域 Blob 代理请求
// ============================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "fetchVideoBlob") {
    fetch(msg.url)
      .then((r) => r.blob())
      .then((b) => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ success: true, dataUrl: reader.result });
        reader.onerror = () => sendResponse({ success: false, error: "FileReader 读取失败" });
        reader.readAsDataURL(b);
      })
      .catch((e) => sendResponse({ success: false, error: (e && e.message) || String(e) }));
    return true;
  }
});

// ============================================================
// 3. 强制覆盖文件名：拦截 Chrome 的文件名推断
// ============================================================
const pendingById = new Map();   // downloadId → filename
const pendingByUrl = new Map();  // url → filename（download() 调用前预注册）
let expectedDataName = null;     // data: URL 下载的单槽文件名

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let name = pendingById.get(item.id);

  if (!name && item.byExtensionId === chrome.runtime.id) {
    name = pendingByUrl.get(item.url) || pendingByUrl.get(item.finalUrl);
    if (!name && expectedDataName && item.url && (item.url.startsWith("data:") || item.url.startsWith("blob:"))) {
      name = expectedDataName;
      expectedDataName = null;
    }
  }

  if (name) {
    pendingById.delete(item.id);
    suggest({ filename: name, conflictAction: "uniquify" });
  } else {
    suggest(); // 不是我们的下载，不干预
  }
});

// ============================================================
// 4. 右键菜单点击
// ============================================================
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;

  const media = await resolveMedia(info, tab);
  if (!media || !media.url) {
    console.warn("[原封] 未在点击位置找到图片或动图");
    flashBadge(tab, "✕", "#D93025");
    return;
  }

  const src = media.url;
  console.log("[原封] 目标媒体:", src.slice(0, 120), "isGif:", media.isGif, "isVideo:", media.isVideo);

  // 页面内嵌的 data: URL 直接下载
  if (/^data:(image|video)\//i.test(src)) {
    await downloadDataUrl(src, tab);
    return;
  }

  // 读取用户偏好配置
  const settings = await getSettings();

  // 若为动图（Twitter GIF 或带有循环播放的短视频），且用户设置为转存 .gif 动图
  if (media.isGif && settings.gifFormat === "gif" && !src.endsWith(".gif")) {
    const success = await handleGifDownload(media, info, tab, settings);
    if (success) return;
    console.warn("[原封] 动图转码失败，自动降级为直接下载原格式");
  }

  // 正常媒体下载链路（图片 或 MP4 原视频）
  const referer = info.frameUrl || info.pageUrl || (tab && tab.url) || "";
  const candidates = buildCandidates(src);
  await startDownload({ candidates, index: 0, referer, tab });
});

// ============================================================
// 5. 动图转码下载调度
// ============================================================
async function handleGifDownload(media, info, tab, settings) {
  if (!tab || tab.id == null || tab.id < 0) return false;

  flashBadge(tab, "GIF", "#1DA1F2", 60000);

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (val) => {
      if (!resolved) {
        resolved = true;
        resolve(val);
      }
    };

    // 45 秒超时保护
    const timer = setTimeout(() => {
      flashBadge(tab, "✕", "#D93025", 2500);
      finish(false);
    }, 45000);

    try {
      chrome.tabs.sendMessage(
        tab.id,
        {
          type: "convertVideoToGif",
          url: media.url,
          mediaKey: media.mediaKey,
          options: {
            maxWidth: settings.gifMaxWidth === 0 ? 0 : (settings.gifMaxWidth || 640),
            fps: settings.gifFps || 20,
          },
        },
        { frameId: info.frameId || 0 },
        async (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !resp || !resp.success || !resp.dataUrl) {
            const errStr = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message);
            console.warn("[原封] GIF 转码未能完成:", errStr);
            flashBadge(tab, "✕", "#D93025", 2500);
            finish(false);
            return;
          }

          try {
            const filename = buildFilename(
              media.mediaKey ? "https://video.twimg.com/tweet_video/" + media.mediaKey + ".gif" : media.url,
              "gif"
            );
            expectedDataName = filename;
            const id = await chrome.downloads.download({
              url: resp.dataUrl,
              filename: filename,
              saveAs: true,
              conflictAction: "uniquify",
            });
            pendingById.set(id, filename);
            setTimeout(() => pendingById.delete(id), 60000);
            flashBadge(tab, "✓", "#00BA7C", 2000);
            finish(true);
          } catch (dlErr) {
            if (/cancel/i.test((dlErr && dlErr.message) || "")) {
              flashBadge(tab, "", "#1DA1F2", 100);
              finish(true);
            } else {
              console.error("[原封] GIF 下载出错:", dlErr);
              flashBadge(tab, "✕", "#D93025", 2500);
              finish(false);
            }
          }
        }
      );
    } catch (_) {
      clearTimeout(timer);
      finish(false);
    }
  });
}

// ============================================================
// 6. 获取媒体信息（降级链）
// ============================================================
async function resolveMedia(info, tab) {
  // A. content.js 捕获的信息
  const fromContent = await queryContentScript(tab, info.frameId);
  if (fromContent && isDownloadableUrl(fromContent.url)) {
    return fromContent;
  }

  // B. Chrome 自带的 info.srcUrl
  if (isDownloadableUrl(info.srcUrl)) {
    const isG = /\.gif(\?|$)/i.test(info.srcUrl) || /tweet_video/.test(info.srcUrl);
    return { url: info.srcUrl, isGif: isG };
  }

  // C. 指向媒体的 info.linkUrl
  if (info.linkUrl && isDownloadableUrl(info.linkUrl) && looksLikeMedia(info.linkUrl)) {
    const isG = /\.gif(\?|$)/i.test(info.linkUrl) || /tweet_video/.test(info.linkUrl);
    return { url: info.linkUrl, isGif: isG };
  }

  // D. 注入脚本兜底找页面中最大的图或视频
  if (tab && tab.id != null && tab.id >= 0) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [info.frameId || 0] },
        func: findMediaInPage,
      });
      if (res && res.result && isDownloadableUrl(res.result.url)) {
        return res.result;
      }
    } catch (_) {}
  }

  return null;
}

// ============================================================
// 7. 向 content.js 查询（定向到被右键的那个 frame）
// ============================================================
function queryContentScript(tab, frameId) {
  if (!tab || tab.id == null || tab.id < 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), 500);
    try {
      chrome.tabs.sendMessage(
        tab.id,
        { type: "getLastImage" },
        { frameId: frameId || 0 },
        (resp) => {
          clearTimeout(timer);
          void chrome.runtime.lastError;
          finish(resp && resp.url ? resp : null);
        }
      );
    } catch (_) {
      clearTimeout(timer);
      finish(null);
    }
  });
}

// ============================================================
// 8. 注入兜底：找页面里最大的一张图或视频
// ============================================================
function findMediaInPage() {
  // 1. 查找推特视频 / GIF
  var videos = document.querySelectorAll("video");
  for (var v = 0; v < videos.length; v++) {
    var vid = videos[v];
    var poster = vid.getAttribute("poster") || vid.poster || "";
    var m = poster.match(/tweet_video_thumb\/([a-zA-Z0-9_\-]+)/);
    if (m) {
      return {
        url: "https://video.twimg.com/tweet_video/" + m[1] + ".mp4",
        isGif: true,
        isTwitterGif: true,
        mediaKey: m[1],
      };
    }
    var vSrc = vid.currentSrc || vid.src || "";
    if (vSrc && vSrc.indexOf("tweet_video") > -1) {
      var m2 = vSrc.match(/tweet_video\/([a-zA-Z0-9_\-]+)\.mp4/);
      return {
        url: vSrc,
        isGif: true,
        isTwitterGif: true,
        mediaKey: m2 ? m2[1] : null,
      };
    }
  }

  // 2. 查找最大图片
  var best = null;
  var bestScore = 0;
  var imgs = document.querySelectorAll("img");
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    var url = img.currentSrc || img.src || "";
    if (!url || url.indexOf("blob:") === 0 || url.indexOf("data:") === 0) continue;

    var twThumb = url.match(/tweet_video_thumb\/([a-zA-Z0-9_\-]+)/);
    if (twThumb) {
      return {
        url: "https://video.twimg.com/tweet_video/" + twThumb[1] + ".mp4",
        isGif: true,
        isTwitterGif: true,
        mediaKey: twThumb[1],
      };
    }

    var area = (img.naturalWidth || 0) * (img.naturalHeight || 0);
    var score = area;
    if (url.indexOf("pbs.twimg.com/media/") > -1) score += 1e9;
    if (score > bestScore && (area > 3600 || score >= 1e9)) {
      bestScore = score;
      best = url;
    }
  }
  return best ? { url: best, isGif: /\.gif(\?|$)/i.test(best) } : null;
}

// ============================================================
// 9. 生成候选 URL 链（原图/原视频优先，逐级降级）
// ============================================================
function buildCandidates(srcUrl) {
  let u;
  try {
    u = new URL(srcUrl);
  } catch (_) {
    return [{ url: srcUrl, ext: null }];
  }

  const list = [];
  const push = (urlObj, extra) => {
    const href = urlObj.toString();
    if (!list.some((c) => c.url === href)) {
      list.push(Object.assign({ url: href, ext: extOf(urlObj) }, extra || {}));
    }
  };
  const host = u.hostname;

  // --- Twitter / X 动图 (tweet_video) ---
  if (host.endsWith("twimg.com") && u.pathname.startsWith("/tweet_video/")) {
    push(u, { ext: "mp4" });
    return list;
  }

  // --- Twitter / X 动图缩略图直接升级为 MP4 ---
  if (host.endsWith("twimg.com") && u.pathname.startsWith("/tweet_video_thumb/")) {
    const m = u.pathname.match(/^\/tweet_video_thumb\/([A-Za-z0-9_\-]+)/);
    if (m) {
      const v = new URL("https://video.twimg.com/tweet_video/" + m[1] + ".mp4");
      push(v, { ext: "mp4" });
    }
    push(u);
    return list;
  }

  // --- Twitter / X 普通静态图 ---
  if (host.endsWith("twimg.com") && u.pathname.startsWith("/media/")) {
    const m = u.pathname.match(/^\/media\/([A-Za-z0-9_\-]+)/);
    if (m) {
      const served = extOf(u);
      const fmts = served === "png" ? ["png", "jpg"] : ["jpg", "png"];
      for (const f of fmts) {
        const o = new URL("https://" + host + "/media/" + m[1]);
        o.searchParams.set("format", f);
        o.searchParams.set("name", "orig");
        push(o, f === served ? null : { preflight: true });
      }
      const large = new URL(u);
      large.searchParams.set("name", "large");
      push(large);
    }
    push(u);
    return list;
  }

  // --- 微博 ---
  if (/\.sinaimg\.(cn|com)$/.test(host)) {
    const m = u.pathname.match(
      /^\/(orj360|orj480|orj960|orj1080|bmiddle|mw390|mw690|mw1024|mw2000|small|thumbnail|thumb150|thumb180|thumb300|square|wap180|wap360|wap720)\//
    );
    if (m) {
      const lg = new URL(u);
      lg.pathname = "/large/" + u.pathname.slice(m[0].length);
      push(lg);
    }
    push(u);
    return list;
  }

  // --- pixiv：img-master 缩略图 → img-original 原图 ---
  if (host === "i.pximg.net" && u.pathname.indexOf("/img-master/") > -1) {
    const base = u.pathname
      .replace(/^\/c\/[^/]+/, "")
      .replace("/img-master/", "/img-original/")
      .replace(/_(master|square)1200(?=\.\w+$)/, "");
    for (const e of ["jpg", "png"]) {
      const o = new URL(u);
      o.pathname = base.replace(/\.\w+$/, "." + e);
      push(o);
    }
    push(u);
    return list;
  }

  push(u);
  return list;
}

function extOf(urlObj) {
  const fmt = urlObj.searchParams ? urlObj.searchParams.get("format") : null;
  const e1 = normalizeExt(fmt);
  if (e1) return e1;
  return getExtFromPath(urlObj.pathname);
}

// ============================================================
// 10. 下载引擎：逐个候选直接下载，失败自动换下一个
// ============================================================
const watching = new Map(); // downloadId → { candidates, index, referer, tab }

async function startDownload(job) {
  const { candidates, index, referer, tab } = job;

  if (index >= candidates.length) {
    console.warn("[原封] 直接下载全部失败，尝试 fetch 兜底");
    await fetchFallback(job);
    return;
  }

  const cand = candidates[index];

  // 标记了 preflight 的候选先 HEAD 预检：404 直接换下一个
  if (cand.preflight && !(await headOk(cand.url))) {
    console.log("[原封] 预检未通过，跳过候选:", cand.url.slice(0, 120));
    return startDownload({ ...job, index: index + 1 });
  }

  const ext = cand.ext || (await headExt(cand.url)) || "jpg";
  const filename = buildFilename(cand.url, ext);

  // 竞态修复：download() 之前先按 URL 预注册文件名
  pendingByUrl.set(cand.url, filename);
  setTimeout(() => pendingByUrl.delete(cand.url), 30000);

  const opts = {
    url: cand.url,
    filename: filename,
    saveAs: true,
    conflictAction: "uniquify",
  };
  if (referer && /^https?:/i.test(cand.url)) {
    opts.headers = [{ name: "Referer", value: referer }];
  }

  let id;
  try {
    id = await chrome.downloads.download(opts);
  } catch (err) {
    const msg = (err && err.message) || "";
    if (/cancel/i.test(msg)) return; // 用户取消
    console.warn("[原封] download() 失败:", msg);
    if (opts.headers) {
      delete opts.headers;
      try {
        id = await chrome.downloads.download(opts);
      } catch (err2) {
        if (/cancel/i.test((err2 && err2.message) || "")) return;
        return startDownload({ ...job, index: index + 1 });
      }
    } else {
      return startDownload({ ...job, index: index + 1 });
    }
  }

  console.log("[原封] 开始下载 #" + id + " (候选 " + (index + 1) + "/" + candidates.length + "):", cand.url.slice(0, 120));
  pendingById.set(id, filename);
  setTimeout(() => pendingById.delete(id), 60000);
  watching.set(id, job);
}

// 监听下载结果：中断换下一个候选
chrome.downloads.onChanged.addListener((delta) => {
  const job = watching.get(delta.id);
  if (!job || !delta.state) return;

  if (delta.state.current === "complete") {
    watching.delete(delta.id);
    console.log("[原封] 下载完成 #" + delta.id);
    flashBadge(job.tab, "✓", "#00BA7C", 1800);
    return;
  }

  if (delta.state.current === "interrupted") {
    watching.delete(delta.id);
    const err = (delta.error && delta.error.current) || "";
    console.warn("[原封] 下载中断 #" + delta.id + ":", err);
    if (/^USER_/.test(err)) return; // 用户主动取消
    chrome.downloads.erase({ id: delta.id });
    startDownload({ ...job, index: job.index + 1 });
  }
});

// ============================================================
// 11. fetch 兜底：SW 抓字节 → data URL → 下载
// ============================================================
async function fetchFallback(job) {
  for (const cand of job.candidates) {
    if (!/^https?:/i.test(cand.url)) continue;
    try {
      const resp = await fetch(cand.url, { credentials: "include" });
      if (!resp.ok) continue;

      const ct = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const buf = await resp.arrayBuffer();
      if (!buf.byteLength) continue;

      const ext = EXT_BY_MIME[ct] || cand.ext || "jpg";
      const filename = buildFilename(cand.url, ext);
      const mime = ct || MIME_BY_EXT[ext] || "application/octet-stream";
      const dataUrl = "data:" + mime + ";base64," + toBase64(buf);

      expectedDataName = filename;
      const id = await chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: true,
        conflictAction: "uniquify",
      });
      pendingById.set(id, filename);
      setTimeout(() => pendingById.delete(id), 60000);
      console.log("[原封] fetch 兜底成功:", filename);
      flashBadge(job.tab, "✓", "#00BA7C", 1800);
      return;
    } catch (_) {
      continue;
    }
  }
  console.error("[原封] 所有下载方式均失败");
  flashBadge(job.tab, "✕", "#D93025");
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ============================================================
// 12. data: URL 直接下载
// ============================================================
async function downloadDataUrl(src, tab) {
  const m = src.match(/^data:(?:image|video)\/([a-z0-9.+-]+)/i);
  let ext = "png";
  if (m) {
    const rawFmt = m[1].toLowerCase();
    const mapped = EXT_BY_MIME["image/" + rawFmt] || EXT_BY_MIME["video/" + rawFmt];
    ext = mapped || normalizeExt(rawFmt) || "png";
  }
  const filename = sanitize("media_" + Date.now() + "." + ext);
  expectedDataName = filename;
  try {
    const id = await chrome.downloads.download({
      url: src,
      filename: filename,
      saveAs: true,
      conflictAction: "uniquify",
    });
    pendingById.set(id, filename);
    flashBadge(tab, "✓", "#00BA7C", 1800);
  } catch (err) {
    if (!/cancel/i.test((err && err.message) || "")) {
      console.error("[原封] data URL 下载失败:", err && err.message);
      flashBadge(tab, "✕", "#D93025");
    }
  }
}

// ============================================================
// 13. HEAD 预检
// ============================================================
async function headOk(url) {
  if (!/^https?:/i.test(url)) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return resp.ok;
  } catch (_) {
    return true;
  }
}

async function headExt(url) {
  if (!/^https?:/i.test(url)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const ct = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    return EXT_BY_MIME[ct] || null;
  } catch (_) {
    return null;
  }
}

// ============================================================
// 14. 生成文件名
// ============================================================
function buildFilename(mediaUrl, ext) {
  let url;
  try {
    url = new URL(mediaUrl);
  } catch (_) {
    return sanitize("media_" + Date.now() + "." + ext);
  }

  let base = null;

  // Twitter/X：提取 media ID 或 tweet_video ID
  if (url.hostname.endsWith("twimg.com")) {
    let m = url.pathname.match(/\/media\/([A-Za-z0-9_\-]+)/);
    if (m) base = m[1];
    if (!base) {
      m = url.pathname.match(/\/tweet_video\/([A-Za-z0-9_\-]+)/);
      if (m) base = m[1];
    }
    if (!base) {
      m = url.pathname.match(/\/tweet_video_thumb\/([A-Za-z0-9_\-]+)/);
      if (m) base = m[1];
    }
  }

  // 通用：路径最后一段去掉扩展名
  if (!base) {
    const segs = url.pathname.split("/").filter(Boolean);
    if (segs.length > 0) {
      let last = segs[segs.length - 1];
      const dot = last.lastIndexOf(".");
      if (dot > 0) last = last.substring(0, dot);
      if (last.length > 0) base = last;
    }
  }

  if (!base) base = "media_" + Date.now();

  try { base = decodeURIComponent(base); } catch (_) {}
  if (base.length > 120) base = base.substring(0, 120);

  return sanitize(base + "." + ext);
}

// ============================================================
// 15. 读取设置
// ============================================================
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {
        gifFormat: "gif", // "gif" | "mp4"
        gifMaxWidth: 640, // 480 | 640 | 0 (original)
        gifFps: 20,       // 15 | 20 | 25
      },
      (res) => resolve(res)
    );
  });
}

// ============================================================
// 16. 提示徽章
// ============================================================
function flashBadge(tab, text, color = "#D93025", duration = 2500) {
  try {
    const opts = tab && tab.id != null && tab.id >= 0 ? { tabId: tab.id } : {};
    chrome.action.setBadgeBackgroundColor({ ...opts, color: color }).catch(() => {});
    chrome.action.setBadgeText({ ...opts, text: text }).catch(() => {});
    if (duration > 0) {
      setTimeout(() => {
        chrome.action.setBadgeText({ ...opts, text: "" }).catch(() => {});
      }, duration);
    }
  } catch (_) {}
}

// ============================================================
// 17. 工具函数
// ============================================================
function isDownloadableUrl(u) {
  return typeof u === "string" && (/^https?:\/\//i.test(u) || /^data:(image|video)\//i.test(u));
}

function looksLikeMedia(s) {
  try {
    const u = new URL(s);
    if (/\.(jpg|jpeg|png|gif|webp|avif|svg|bmp|tiff|ico|mp4|webm)(\?|$)/i.test(u.pathname)) return true;
    if (u.hostname.endsWith("twimg.com") && (u.pathname.startsWith("/media/") || u.pathname.startsWith("/tweet_video/"))) return true;
    if (u.searchParams.has("format")) return true;
  } catch (_) {}
  return false;
}

function getExtFromPath(pathname) {
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = pathname.substring(dot + 1).toLowerCase();
  if (KNOWN_EXTS.has(ext)) return ext === "jpeg" ? "jpg" : ext;
  return null;
}

function normalizeExt(raw) {
  if (!raw) return null;
  let ext = String(raw).toLowerCase().trim();
  if (ext.charAt(0) === ".") ext = ext.substring(1);
  if (ext === "jpeg") ext = "jpg";
  if (ext === "exif") ext = "jpg";
  return KNOWN_EXTS.has(ext) ? ext : null;
}

function sanitize(name) {
  let s = String(name).replace(/[\\/:*?"<>|]/g, "_");
  s = s.replace(/[\x00-\x1f\x7f]/g, "");
  s = s.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  if (!s) s = "media_" + Date.now();
  return s;
}
