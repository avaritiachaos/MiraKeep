// ============================================================
// MiraKeep — content.js
// 注入到所有页面，捕获右键点击的真实图片 URL
// ============================================================

(() => {
  "use strict";

  // 最近一次右键图片信息
  let lastImage = null;

  // ==========================================================
  // 1. 监听右键菜单事件，捕获真实图片 URL
  // ==========================================================
  document.addEventListener("contextmenu", (e) => {
    const info = extractImageInfo(e.target);
    if (info && info.url) {
      lastImage = info;
      // 同步写入 storage.session，background 可直接读取
      try {
        chrome.storage.session.set({ lastRightClickedImage: info });
      } catch (_) {
        // session storage 可能不可用，忽略
      }
      console.log("[MiraKeep content] Captured image:", info.url);
    }
  }, true);

  // ==========================================================
  // 2. 监听 background 的消息请求（获取最近右键图片）
  // ==========================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "getLastImage") {
      // 优先返回内存中的，其次从 session storage 读
      if (lastImage && lastImage.url) {
        sendResponse(lastImage);
      } else {
        try {
          chrome.storage.session.get("lastRightClickedImage", (data) => {
            sendResponse(data.lastRightClickedImage || null);
          });
        } catch (_) {
          sendResponse(null);
        }
        return true; // 异步 sendResponse
      }
    }
  });

  // ==========================================================
  // 3. 从事件目标提取图片信息
  // ==========================================================
  function extractImageInfo(target) {
    if (!target) return null;

    // --- 情况 A：目标本身就是 <img> ---
    if (target.tagName === "IMG") {
      return buildInfoFromImg(target);
    }

    // --- 情况 B：目标是 <picture> 的 <source> ---
    if (target.tagName === "SOURCE") {
      const picture = target.closest("picture");
      if (picture) {
        const img = picture.querySelector("img");
        if (img) return buildInfoFromImg(img);
      }
    }

    // --- 情况 C：目标是背景图的 div / a / span 等 ---
    const bgUrl = getBackgroundImageUrl(target);
    if (bgUrl) {
      return makeInfo(bgUrl, target);
    }

    // --- 情况 D：向上找最近的 <img> 祖先 ---
    const ancestorImg = target.closest("img");
    if (ancestorImg) {
      return buildInfoFromImg(ancestorImg);
    }

    // --- 情况 E：向下找子元素中的 <img> ---
    const childImg = target.querySelector("img");
    if (childImg) {
      return buildInfoFromImg(childImg);
    }

    // --- 情况 F：在附近兄弟节点中找 <img> ---
    const parent = target.parentElement;
    if (parent) {
      const nearbyImg = parent.querySelector("img");
      if (nearbyImg) {
        return buildInfoFromImg(nearbyImg);
      }
    }

    // --- 情况 G：Twitter 特殊处理 ---
    // Twitter 有时用 div[background-image] 或 canvas，尝试全局找 pbs.twimg.com 图片
    const twitterImg = findTwitterImage(target);
    if (twitterImg) {
      return twitterImg;
    }

    return null;
  }

  // ==========================================================
  // 4. 从 <img> 元素构建图片信息
  // ==========================================================
  function buildInfoFromImg(img) {
    let url = pickBestUrl(img);
    if (!url) return null;

    // 如果是 blob: 或 data:，尝试找真实 URL
    if (url.startsWith("blob:") || url.startsWith("data:")) {
      const realUrl = findRealUrlNear(img);
      if (realUrl) url = realUrl;
    }

    return makeInfo(url, img);
  }

  // ==========================================================
  // 5. 从 <img> 中选最佳 URL
  //    优先 currentSrc → srcset 最大项 → src
  // ==========================================================
  function pickBestUrl(img) {
    // 优先 currentSrc（浏览器实际加载的）
    if (img.currentSrc && !isInternalUrl(img.currentSrc)) {
      return img.currentSrc;
    }

    // 解析 srcset，取最大分辨率
    const srcsetMax = parseSrcset(img);
    if (srcsetMax) return srcsetMax;

    // src 属性
    if (img.src && !isInternalUrl(img.src)) {
      return img.src;
    }

    // 从属性直接读（绕过相对路径解析）
    const rawSrc = img.getAttribute("src");
    if (rawSrc && rawSrc.startsWith("http")) {
      return rawSrc;
    }

    return null;
  }

  // ==========================================================
  // 6. 解析 srcset，返回最大分辨率的 URL
  // ==========================================================
  function parseSrcset(img) {
    const srcset = img.getAttribute("srcset");
    if (!srcset) return null;

    const entries = srcset.split(",").map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      let size = 0;
      if (parts[1]) {
        // "400w" → 400, "2x" → 2
        if (parts[1].endsWith("w")) {
          size = parseInt(parts[1], 10) || 0;
        } else if (parts[1].endsWith("x")) {
          size = (parseFloat(parts[1]) || 1) * 1000;
        }
      }
      return { url, size };
    }).filter((e) => e.url && !isInternalUrl(e.url));

    if (entries.length === 0) return null;

    // 按 size 降序，取最大的
    entries.sort((a, b) => b.size - a.size);
    return entries[0].url;
  }

  // ==========================================================
  // 7. 在附近寻找真实 URL（排除 blob:/data:）
  // ==========================================================
  function findRealUrlNear(img) {
    // 检查同级所有 img
    const parent = img.parentElement;
    if (parent) {
      for (const sibling of parent.querySelectorAll("img")) {
        if (sibling !== img) {
          const url = pickBestUrl(sibling);
          if (url && !isInternalUrl(url)) return url;
        }
      }
    }

    // 检查 picture > source
    const picture = img.closest("picture");
    if (picture) {
      for (const source of picture.querySelectorAll("source")) {
        const srcset = source.getAttribute("srcset");
        if (srcset) {
          const first = srcset.split(",")[0].trim().split(/\s+/)[0];
          if (first && first.startsWith("http")) return first;
        }
      }
    }

    // 全局搜索 pbs.twimg.com 图片
    return findTwitterGlobal();
  }

  // ==========================================================
  // 8. Twitter 专用：在页面中搜索 pbs.twimg.com 图片
  // ==========================================================
  function findTwitterImage(target) {
    // 检查目标的父级容器中是否有 Twitter 图片
    let el = target;
    for (let i = 0; i < 5 && el; i++) {
      const imgs = el.querySelectorAll("img");
      for (const img of imgs) {
        const url = pickBestUrl(img);
        if (url && url.includes("pbs.twimg.com/media/")) {
          return makeInfo(url, img);
        }
      }
      el = el.parentElement;
    }

    // 全局搜索
    return findTwitterGlobal() ? makeInfo(findTwitterGlobal(), target) : null;
  }

  function findTwitterGlobal() {
    // 在所有 img 中找 pbs.twimg.com
    const allImgs = document.querySelectorAll("img");
    for (const img of allImgs) {
      const url = pickBestUrl(img);
      if (url && url.includes("pbs.twimg.com/media/")) {
        return url;
      }
    }

    // 在所有 a[href] 中找
    const allLinks = document.querySelectorAll("a[href]");
    for (const a of allLinks) {
      if (a.href.includes("pbs.twimg.com/media/")) {
        return a.href;
      }
    }

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
        if (match && match[1] && match[1].startsWith("http")) {
          return match[1];
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
  // 11. 判断是否为内部 URL（blob:, data:, about:, chrome:）
  // ==========================================================
  function isInternalUrl(url) {
    return /^(blob:|data:|about:|chrome:|chrome-extension:|edge:)/i.test(url);
  }

})();
