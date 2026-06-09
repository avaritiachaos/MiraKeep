// ============================================================
// MiraKeep — background.js  (v5 — onDeterminingFilename 方案)
// Service Worker (Manifest V3)
//
// ★ 核心问题：
//   Chrome 对直接 URL 下载会做 content sniffing，
//   如果检测到 JPEG 中的 EXIF 元数据，会把扩展名覆盖成 .exif。
//   filename 参数在这种情况下被忽略。
//
// ★ 解决方案：
//   1. 直接使用原始 URL + saveAs: true（Chrome 记住上次的文件夹）
//   2. chrome.downloads.onDeterminingFilename 监听器强制覆盖文件名
//      在 Chrome content sniff 之前把扩展名改回正确的值
// ============================================================

const KNOWN_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif",
  "svg", "bmp", "tiff", "tif", "ico",
]);

// ============================================================
// 1. 安装
// ============================================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "mirakeep-save",
    title: "MiraKeep: Save Original",
    contexts: ["image", "link", "page", "all"],
  });
  console.log("[MiraKeep] Installed v5 (data URL + onDeterminingFilename).");
});

// ============================================================
// ★ 强制覆盖文件名：拦截 Chrome 的文件名推断
//
// Chrome 会对下载内容做 content sniffing，如果检测到 EXIF 元数据，
// 会把扩展名覆盖成 .exif。这个监听器在 Chrome 推断文件名时强制覆盖。
// ============================================================
const pendingFilenames = new Map(); // downloadId → filename

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  console.log("[MiraKeep] onDeterminingFilename:");
  console.log("[MiraKeep]   id =", item.id);
  console.log("[MiraKeep]   suggestedFilename =", item.suggestedFilename);
  console.log("[MiraKeep]   url =", item.url.substring(0, 80));

  // 从 pendingFilenames 获取我们设置的文件名
  const customName = pendingFilenames.get(item.id);
  if (customName) {
    console.log("[MiraKeep]   → FORCE overriding with:", customName);
    pendingFilenames.delete(item.id);
    suggest({ filename: customName });
    return;
  }

  // 非我们的下载，不干预
  suggest();
});

// ============================================================
// 2. 右键菜单点击
// ============================================================
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "mirakeep-save") return;

  console.log("[MiraKeep] ========== MENU CLICK ==========");

  // ---- A. 获取图片 URL ----
  const imageUrl = await resolveImageUrl(info, tab);
  if (!imageUrl) {
    console.warn("[MiraKeep] No image URL found.");
    return;
  }
  console.log("[MiraKeep] imageUrl =", imageUrl);

  // ---- B. 规范化 URL ----
  const norm = normalizeUrl(imageUrl);
  console.log("[MiraKeep] normalized =", norm.url, "| ext =", norm.ext, "(" + norm.extSource + ")");

  // ---- C. 生成文件名 ----
  const filename = buildFilename(norm.url, norm.ext);
  console.log("[MiraKeep] filename =", filename);

  // ---- D. 直接下载原始 URL（onDeterminingFilename 会强制覆盖文件名）----
  await downloadDirect(norm.url, filename);
});

// ============================================================
// 3. 获取图片 URL（降级链）
// ============================================================
async function resolveImageUrl(info, tab) {
  // A. content.js 记录的右键图片
  const fromContent = await queryContentScript(tab);
  if (fromContent) return fromContent;

  // B. info.srcUrl
  if (info.srcUrl && isRealUrl(info.srcUrl)) return info.srcUrl;

  // C. info.linkUrl
  if (info.linkUrl && isRealUrl(info.linkUrl) && looksLikeImage(info.linkUrl))
    return info.linkUrl;

  // D. 注入脚本兜底
  if (tab && tab.id) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: findImageInPage,
      });
      if (res && res.result && isRealUrl(res.result)) return res.result;
    } catch (_) {}
  }

  return null;
}

// ============================================================
// 4. 向 content.js 查询
// ============================================================
async function queryContentScript(tab) {
  if (!tab || !tab.id) return null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 800);
    chrome.tabs.sendMessage(tab.id, { type: "getLastImage" }, (resp) => {
      clearTimeout(timer);
      resolve(resp && resp.url ? resp.url : null);
    });
  });
}

// ============================================================
// 5. 注入兜底
// ============================================================
function findImageInPage() {
  var imgs = Array.from(document.querySelectorAll("img"));
  for (var i = 0; i < imgs.length; i++) {
    var s = imgs[i].currentSrc || imgs[i].src || "";
    if (s.indexOf("pbs.twimg.com/media/") > -1) return s;
  }
  var best = null;
  var bestArea = 0;
  for (var j = 0; j < imgs.length; j++) {
    var img = imgs[j];
    if (img.naturalWidth > 50 && img.naturalHeight > 50) {
      var url = img.currentSrc || img.src;
      if (url && url.indexOf("blob:") !== 0 && url.indexOf("data:") !== 0) {
        var area = img.naturalWidth * img.naturalHeight;
        if (area > bestArea) {
          bestArea = area;
          best = url;
        }
      }
    }
  }
  return best;
}

// ============================================================
// 6. 规范化 URL
// ============================================================
function normalizeUrl(srcUrl) {
  var url;
  try {
    url = new URL(srcUrl);
  } catch (_) {
    return { url: srcUrl, ext: "jpg", extSource: "fallback" };
  }

  // Twitter/X：name → orig
  if (url.hostname.indexOf("twimg.com") !== -1 && url.searchParams.has("name")) {
    url.searchParams.set("name", "orig");
  }

  // 优先级 1：format 参数
  var fmt = url.searchParams.get("format");
  if (fmt) {
    var ext1 = normalizeExt(fmt);
    if (ext1) return { url: url.toString(), ext: ext1, extSource: "format" };
  }

  // 优先级 2：pathname 后缀
  var ext2 = getExtFromPath(url.pathname);
  if (ext2) return { url: url.toString(), ext: ext2, extSource: "path" };

  // 优先级 3：fallback
  return { url: url.toString(), ext: "jpg", extSource: "fallback" };
}

// ============================================================
// 7. 生成文件名
// ============================================================
function buildFilename(imageUrl, ext) {
  var url;
  try {
    url = new URL(imageUrl);
  } catch (_) {
    return sanitize("image_" + Date.now() + "." + ext);
  }

  var base = null;

  // Twitter/X
  if (url.hostname.indexOf("twimg.com") !== -1) {
    var m = url.pathname.match(/\/media\/([A-Za-z0-9_\-]+)/);
    if (m) base = m[1];
  }

  // 通用
  if (!base) {
    var segs = url.pathname.split("/").filter(Boolean);
    if (segs.length > 0) {
      var last = segs[segs.length - 1];
      var dot = last.lastIndexOf(".");
      if (dot > 0) last = last.substring(0, dot);
      if (last.length > 0) base = last;
    }
  }

  if (!base) base = "image_" + Date.now();
  return sanitize(base + "." + ext);
}

// ============================================================
// 8. ★ 核心：直接下载原始 URL
//
//    使用原始 URL + saveAs: true → Chrome 记住上次的文件夹
//    onDeterminingFilename 监听器会强制覆盖文件名，防止 content sniff
// ============================================================
async function downloadDirect(imageUrl, filename) {
  console.log("[MiraKeep] Downloading:", imageUrl.substring(0, 80));
  console.log("[MiraKeep] Filename:", filename);

  try {
    var id = await chrome.downloads.download({
      url: imageUrl,
      filename: filename,
      saveAs: true,
      conflictAction: "uniquify",
    });
    console.log("[MiraKeep] Download started, id =", id);

    // 注册到 onDeterminingFilename 以强制覆盖
    if (id) {
      pendingFilenames.set(id, filename);
      setTimeout(() => pendingFilenames.delete(id), 5000);
    }

  } catch (err) {
    console.error("[MiraKeep] Download error:", err.message);
  }
}

// ============================================================
// 工具函数
// ============================================================

function isRealUrl(url) {
  return url && !/^(blob:|data:|about:|chrome:|chrome-extension:|edge:)/i.test(url);
}

function looksLikeImage(s) {
  try {
    var u = new URL(s);
    if (/\.(jpg|jpeg|png|gif|webp|avif|svg|bmp|tiff|ico)(\?|$)/i.test(u.pathname)) return true;
    if (u.hostname.indexOf("twimg.com/media") !== -1) return true;
    if (u.searchParams.has("format")) return true;
  } catch (_) {}
  return false;
}

function getExtFromPath(pathname) {
  var dot = pathname.lastIndexOf(".");
  if (dot < 0) return null;
  var ext = pathname.substring(dot + 1).toLowerCase();
  if (KNOWN_EXTS.has(ext)) return ext === "jpeg" ? "jpg" : ext;
  return null;
}

function normalizeExt(raw) {
  if (!raw) return null;
  var ext = raw.toLowerCase().trim();
  if (ext.charAt(0) === ".") ext = ext.substring(1);
  if (ext === "jpeg") ext = "jpg";
  if (ext === "exif") ext = "jpg";
  return KNOWN_EXTS.has(ext) ? ext : null;
}

function guessMime(filename) {
  var ext = filename.split(".").pop().toLowerCase();
  var map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", avif: "image/avif",
  };
  return map[ext] || "image/jpeg";
}

function sanitize(name) {
  var s = name.replace(/[\\/:*?"<>|]/g, "_");
  s = s.replace(/[\x00-\x1f]/g, "");
  s = s.replace(/[. ]+$/, "");
  if (s.length > 200) s = s.substring(0, 200);
  return s;
}
