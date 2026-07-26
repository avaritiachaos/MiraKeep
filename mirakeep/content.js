// ============================================================
// 原封 (YuanFeng) — content.js
// 注入到所有页面（含 iframe），捕获右键点击的真实图片 URL
//
// v6 修复：
//   - 每次右键都重新捕获，找不到就清空（不再把上一次的旧图
//     错当成这一次的目标 —— 旧版"有时候没效果/存错图"的主因）
//   - srcset 最大分辨率优先于 currentSrc，且相对路径解析成绝对 URL
//   - 删除从未生效的 storage.session 兜底（content script 默认无权访问）
//   - 就近向上找大图，替代旧版"全页面乱抓第一张 Twitter 图"
// ============================================================

(() => {
  "use strict";

  // 本 frame 最近一次右键的图片信息；每次右键都覆盖（可能为 null）
  let lastImage = null;

  // ==========================================================
  // 1. 监听右键，捕获真实图片 URL
  // ==========================================================
  document.addEventListener("contextmenu", (e) => {
    lastImage = extractImageInfo(e.target);
  }, true);

  // ==========================================================
  // 2. 响应 background 的查询（background 按 frameId 定向发来）
  // ==========================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "getLastImage") {
      sendResponse(lastImage && lastImage.url ? lastImage : null);
    }
  });

  // ==========================================================
  // 3. 从事件目标提取图片信息
  // ==========================================================
  function extractImageInfo(target) {
    if (!(target instanceof Element)) return null;

    // A. 目标本身是 <img>
    if (target instanceof HTMLImageElement) {
      return buildInfoFromImg(target);
    }

    // B. 目标是 <picture> 里的 <source>
    if (target.tagName === "SOURCE") {
      const picture = target.closest("picture");
      const img = picture && picture.querySelector("img");
      if (img) return buildInfoFromImg(img);
    }

    // C. 目标带 CSS 背景图
    const bgUrl = getBackgroundImageUrl(target);
    if (bgUrl) return makeInfo(bgUrl, target);

    // D. 就近向上找：图片查看器常用透明层盖在 <img> 上，
    //    逐级向上在祖先容器里找面积最大的图（太小的图标/头像不算）
    return findNearbyLargestImage(target);
  }

  // ==========================================================
  // 4. 从 <img> 元素构建图片信息
  // ==========================================================
  function buildInfoFromImg(img) {
    let url = pickBestUrl(img);

    // blob: 等拿不到直链时，在附近找可下载的真实 URL
    if (!url) url = findRealUrlNear(img);
    if (!url) return null;

    return makeInfo(url, img);
  }

  // ==========================================================
  // 5. 从 <img> 中选最佳 URL
  //    srcset 最大项 → currentSrc → src（全部解析为绝对 URL）
  // ==========================================================
  function pickBestUrl(img) {
    // srcset 里的最大分辨率通常优于 currentSrc（浏览器按视口选的小图）
    const fromSrcset = parseSrcset(img);
    if (fromSrcset) return fromSrcset;

    if (img.currentSrc && !isInternalUrl(img.currentSrc)) return img.currentSrc;
    if (img.src && !isInternalUrl(img.src)) return img.src;

    // 懒加载占位场景：真实大图往往在 data-src 等属性里
    for (const attr of ["data-src", "data-original", "data-lazy-src", "data-hi-res-src", "data-large-src"]) {
      const v = img.getAttribute(attr);
      if (v) {
        const abs = toAbsolute(v.trim());
        if (abs && !isInternalUrl(abs)) return abs;
      }
    }

    const raw = img.getAttribute("src");
    if (raw) {
      const abs = toAbsolute(raw);
      if (abs && !isInternalUrl(abs)) return abs;
    }

    // 页面内嵌 data:image 也允许保存（background 会原样落盘）
    const cur = img.currentSrc || img.src || "";
    if (/^data:image\//i.test(cur)) return cur;

    return null;
  }

  // ==========================================================
  // 6. 解析 srcset，返回最大分辨率的绝对 URL
  // ==========================================================
  function parseSrcset(img) {
    const srcset = img.getAttribute("srcset");
    if (!srcset) return null;

    const entries = [];
    for (const part of srcset.split(",")) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      const abs = toAbsolute(bits[0]);
      if (!abs || isInternalUrl(abs)) continue;

      let size = 0;
      const d = bits[1] || "";
      if (d.endsWith("w")) size = parseInt(d, 10) || 0;
      else if (d.endsWith("x")) size = (parseFloat(d) || 1) * 1000;
      entries.push({ url: abs, size });
    }
    if (entries.length === 0) return null;

    entries.sort((a, b) => b.size - a.size);
    // 全都没有尺寸描述符时无从比较，交给 currentSrc
    if (entries[0].size === 0) return null;
    return entries[0].url;
  }

  // ==========================================================
  // 7. blob:/data: 拿不到直链时，在附近找真实 URL
  // ==========================================================
  function findRealUrlNear(img) {
    // <picture> 的 <source srcset>
    const picture = img.closest("picture");
    if (picture) {
      for (const source of picture.querySelectorAll("source")) {
        const srcset = source.getAttribute("srcset");
        if (srcset) {
          const first = toAbsolute(srcset.split(",")[0].trim().split(/\s+/)[0]);
          if (first && !isInternalUrl(first)) return first;
        }
      }
    }

    // 同级容器里的其他 img
    const near = img.parentElement && bestImgUnder(img.parentElement);
    return near ? near.url : null;
  }

  // ==========================================================
  // 8. 就近向上找面积最大的图（最多向上 6 层）
  // ==========================================================
  function findNearbyLargestImage(target) {
    let el = target;
    for (let depth = 0; depth < 6 && el && el !== document.documentElement; depth++) {
      const found = bestImgUnder(el);
      if (found) return found;

      const bg = getBackgroundImageUrl(el);
      if (bg) return makeInfo(bg, el);

      el = el.parentElement;
    }
    return null;
  }

  function bestImgUnder(root) {
    const imgs = root.querySelectorAll("img");
    let bestUrl = null;
    let bestEl = null;
    let bestScore = 0;

    for (const img of imgs) {
      const url = pickBestUrl(img);
      if (!url) continue;
      const area = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
      let score = area;
      if (url.indexOf("pbs.twimg.com/media/") > -1) score += 1e9; // Twitter 正文图优先
      if (score > bestScore) {
        bestScore = score;
        bestUrl = url;
        bestEl = img;
      }
    }

    // 面积太小（图标/头像级别）不算数，让调用方继续向上找
    if (bestUrl && bestScore >= 100 * 100) return makeInfo(bestUrl, bestEl);
    return null;
  }

  // ==========================================================
  // 9. 获取元素的 CSS 背景图 URL
  // ==========================================================
  function getBackgroundImageUrl(el) {
    try {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (bg && bg !== "none") {
        const match = bg.match(/url\(["']?(.*?)["']?\)/);
        if (match && match[1]) {
          const abs = toAbsolute(match[1]);
          if (abs && !isInternalUrl(abs)) return abs;
        }
      }
    } catch (_) {}
    return null;
  }

  // ==========================================================
  // 10. 构建图片信息对象
  // ==========================================================
  function makeInfo(url, el) {
    return {
      url: url,
      pageUrl: location.href,
      alt: (el && el.alt) || "",
      width: (el && el.naturalWidth) || (el && el.width) || 0,
      height: (el && el.naturalHeight) || (el && el.height) || 0,
      timestamp: Date.now(),
    };
  }

  // ==========================================================
  // 11. 工具
  // ==========================================================
  function toAbsolute(raw) {
    try {
      return new URL(raw, document.baseURI).href;
    } catch (_) {
      return null;
    }
  }

  function isInternalUrl(url) {
    return /^(blob:|data:|about:|javascript:|chrome:|chrome-extension:|edge:)/i.test(url);
  }

})();
