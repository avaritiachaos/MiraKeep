// ============================================================
// 原封 (YuanFeng) — background.js  (v6)
// Service Worker (Manifest V3)
//
// ★ 两个核心问题：
//   1. Chrome 对下载内容做 content sniffing，JPEG 里的 EXIF 元数据
//      会让扩展名被改成 .exif / .jfif。
//      → onDeterminingFilename 强制覆盖文件名。
//   2. "有时候没效果" 的几大元凶（v6 修复）：
//      - content.js 的旧图残留被当成本次目标（优先级/清空问题）
//      - iframe 里的图查不到（没按 frameId 定向）
//      - 防盗链站点（微博/pixiv 等）不带 Referer 直接 403
//      - blob:/相对路径 URL 直接丢给 downloads API 静默失败
//      - onDeterminingFilename 注册晚于事件触发的竞态
//
// ★ 下载策略（逐级兜底）：
//   候选 URL 链（原图 → 大图 → 原始 URL）依次直接下载（带 Referer），
//   某个候选失败自动换下一个；全部失败后在 SW 里 fetch 转 data URL
//   再下载；仍失败则在工具栏图标上闪一个 ✕ 徽章提示。
// ============================================================

const MENU_ID = "yuanfeng-save";

const KNOWN_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif",
  "svg", "bmp", "tiff", "tif", "ico",
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
};

const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", bmp: "image/bmp", tiff: "image/tiff",
  tif: "image/tiff", ico: "image/x-icon",
};

// ============================================================
// 1. 安装：注册右键菜单（先 removeAll，避免更新时重复 id 报错）
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
// 2. 强制覆盖文件名：拦截 Chrome 的文件名推断（防 .exif/.jfif）
//
//    竞态修复：download() 的 Promise resolve 与本事件的先后顺序
//    没有保证，所以除了按 downloadId 注册，还在调用 download()
//    之前就按 URL 预注册一份。
// ============================================================
const pendingById = new Map();   // downloadId → filename
const pendingByUrl = new Map();  // url → filename（download() 调用前预注册）
let expectedDataName = null;     // data: URL 下载的单槽文件名

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let name = pendingById.get(item.id);

  if (!name && item.byExtensionId === chrome.runtime.id) {
    name = pendingByUrl.get(item.url) || pendingByUrl.get(item.finalUrl);
    if (!name && expectedDataName && item.url && item.url.startsWith("data:")) {
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
// 3. 右键菜单点击
// ============================================================
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;

  const src = await resolveImageUrl(info, tab);
  if (!src) {
    console.warn("[原封] 未在点击位置找到图片");
    flashBadge(tab, "✕");
    return;
  }
  console.log("[原封] 目标图片:", src.slice(0, 120));

  // 页面内嵌的 data:image 直接下载（字节原样保存）
  if (/^data:image\//i.test(src)) {
    await downloadDataUrl(src, tab);
    return;
  }

  // Referer：防盗链站点（微博/pixiv 等）没有它会 403
  const referer = info.frameUrl || info.pageUrl || (tab && tab.url) || "";

  const candidates = buildCandidates(src);
  await startDownload({ candidates, index: 0, referer, tab });
});

// ============================================================
// 4. 获取图片 URL（降级链）
//    A. content.js 在本次右键时捕获的图（按 frameId 定向查询）
//    B. Chrome 自带的 info.srcUrl
//    C. 指向图片的 info.linkUrl
//    D. 注入脚本找页面里最大的图
// ============================================================
async function resolveImageUrl(info, tab) {
  const fromContent = await queryContentScript(tab, info.frameId);
  if (isDownloadableUrl(fromContent)) return fromContent;

  if (isDownloadableUrl(info.srcUrl)) return info.srcUrl;

  if (info.linkUrl && isDownloadableUrl(info.linkUrl) && looksLikeImage(info.linkUrl))
    return info.linkUrl;

  if (tab && tab.id != null && tab.id >= 0) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [info.frameId || 0] },
        func: findImageInPage,
      });
      if (res && isDownloadableUrl(res.result)) return res.result;
    } catch (_) {}
  }

  return null;
}

// ============================================================
// 5. 向 content.js 查询（定向到被右键的那个 frame）
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
          void chrome.runtime.lastError; // content script 未注入时静默降级
          finish(resp && resp.url ? resp.url : null);
        }
      );
    } catch (_) {
      clearTimeout(timer);
      finish(null);
    }
  });
}

// ============================================================
// 6. 注入兜底：找页面里最大的一张图（Twitter 原图优先）
// ============================================================
function findImageInPage() {
  var best = null;
  var bestScore = 0;
  var imgs = document.querySelectorAll("img");
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    var url = img.currentSrc || img.src || "";
    if (!url || url.indexOf("blob:") === 0 || url.indexOf("data:") === 0) continue;
    var area = (img.naturalWidth || 0) * (img.naturalHeight || 0);
    var score = area;
    if (url.indexOf("pbs.twimg.com/media/") > -1) score += 1e9;
    if (score > bestScore && (area > 3600 || score >= 1e9)) {
      bestScore = score;
      best = url;
    }
  }
  return best;
}

// ============================================================
// 7. 生成候选 URL 链（原图优先，逐级降级）
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

  // --- Twitter / X ---
  // 实测（pbs.twimg.com）：name=orig 只存在于 X 实际存储的格式，
  // 请求错误的格式直接 404 而不是转码；时间线可能下发 webp 缩略图，
  // 但 webp 没有 orig。所以按「页面格式 → 另一种」的顺序探测 jpg/png
  // 原件；跨格式候选先 HEAD 预检，避免 404 时反复弹保存框。
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

  // --- pixiv：img-master 缩略图 → img-original 原图（jpg/png 都试）---
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
// 8. 下载引擎：逐个候选直接下载，失败自动换下一个
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

  // 标记了 preflight 的候选先 HEAD 预检：404 直接换下一个，
  // 免得弹出保存框、用户确认后才发现下载失败
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
    if (/cancel/i.test(msg)) return; // 用户在保存对话框点了取消，不再打扰
    console.warn("[原封] download() 失败:", msg);
    // 个别环境不接受自定义 Referer 头 → 去掉重试一次
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

// 监听下载结果：中断则换下一个候选（用户主动取消除外）
chrome.downloads.onChanged.addListener((delta) => {
  const job = watching.get(delta.id);
  if (!job || !delta.state) return;

  if (delta.state.current === "complete") {
    watching.delete(delta.id);
    console.log("[原封] 下载完成 #" + delta.id);
    return;
  }

  if (delta.state.current === "interrupted") {
    watching.delete(delta.id);
    const err = (delta.error && delta.error.current) || "";
    console.warn("[原封] 下载中断 #" + delta.id + ":", err);
    if (/^USER_/.test(err)) return; // 用户取消/关机，不重试
    chrome.downloads.erase({ id: delta.id }); // 清掉失败条目，别占着下载栏
    startDownload({ ...job, index: job.index + 1 });
  }
});

// ============================================================
// 9. fetch 兜底：SW 里抓字节 → data URL → 下载
//    （覆盖 downloads API 走不通、但带 Cookie 的 fetch 可以的情况）
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
      return;
    } catch (_) {
      continue;
    }
  }
  console.error("[原封] 所有下载方式均失败");
  flashBadge(job.tab, "✕");
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
// 10. data:image URL 直接下载
// ============================================================
async function downloadDataUrl(src, tab) {
  const m = src.match(/^data:image\/([a-z0-9.+-]+)/i);
  let ext = "png";
  if (m) {
    const mapped = EXT_BY_MIME["image/" + m[1].toLowerCase()];
    ext = mapped || normalizeExt(m[1]) || "png";
  }
  const filename = sanitize("image_" + Date.now() + "." + ext);
  expectedDataName = filename;
  try {
    const id = await chrome.downloads.download({
      url: src,
      filename: filename,
      saveAs: true,
      conflictAction: "uniquify",
    });
    pendingById.set(id, filename);
  } catch (err) {
    if (!/cancel/i.test((err && err.message) || "")) {
      console.error("[原封] data URL 下载失败:", err && err.message);
      flashBadge(tab, "✕");
    }
  }
}

// ============================================================
// 11. HEAD 预检：候选是否存在（预检自身出错时不挡路）
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
    return true; // 网络/CORS 等预检失败不代表下载会失败，放行
  }
}

// ============================================================
// 11b. 扩展名未知时用 HEAD 请求探测 Content-Type
// ============================================================
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
// 12. 生成文件名
// ============================================================
function buildFilename(imageUrl, ext) {
  let url;
  try {
    url = new URL(imageUrl);
  } catch (_) {
    return sanitize("image_" + Date.now() + "." + ext);
  }

  let base = null;

  // Twitter/X：取 media ID
  if (url.hostname.endsWith("twimg.com")) {
    const m = url.pathname.match(/\/media\/([A-Za-z0-9_\-]+)/);
    if (m) base = m[1];
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

  if (!base) base = "image_" + Date.now();

  // URL 编码的中文等解码成可读文件名
  try { base = decodeURIComponent(base); } catch (_) {}
  if (base.length > 120) base = base.substring(0, 120);

  return sanitize(base + "." + ext);
}

// ============================================================
// 13. 失败提示：工具栏图标闪一个红色 ✕ 徽章
// ============================================================
function flashBadge(tab, text) {
  try {
    const opts = tab && tab.id != null && tab.id >= 0 ? { tabId: tab.id } : {};
    chrome.action.setBadgeBackgroundColor({ ...opts, color: "#D93025" }).catch(() => {});
    chrome.action.setBadgeText({ ...opts, text: text }).catch(() => {});
    setTimeout(() => {
      chrome.action.setBadgeText({ ...opts, text: "" }).catch(() => {});
    }, 2500);
  } catch (_) {}
}

// ============================================================
// 工具函数
// ============================================================
function isDownloadableUrl(u) {
  // blob: 在 Service Worker 里下载不了（属于页面上下文），明确排除
  return typeof u === "string" && (/^https?:\/\//i.test(u) || /^data:image\//i.test(u));
}

function looksLikeImage(s) {
  try {
    const u = new URL(s);
    if (/\.(jpg|jpeg|png|gif|webp|avif|svg|bmp|tiff|ico)(\?|$)/i.test(u.pathname)) return true;
    if (u.hostname.endsWith("twimg.com") && u.pathname.startsWith("/media/")) return true;
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
  if (!s) s = "image_" + Date.now();
  return s;
}
