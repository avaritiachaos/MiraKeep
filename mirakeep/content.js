// ============================================================
// 原封 (YuanFeng) — content.js  (v2.1.0)
// 注入到所有页面（含 iframe），捕获右键点击的真实图片 / 动图 URL
//
// 新增特性：
//   - 支持 Twitter/X 及网页动图（<video> / 播放器遮罩层 / tweet_video 探测）
//   - 识别 tweet_video_thumb 缩略图与 tweet_video 直链
//   - 本地基于 gifenc 纯 JS 将视频解码转码为真实 .gif 动图
//   - 转码进度浮动 Toast 提示
//   - 保留原有的 srcset / 背景图 / 查看器蒙层就近抓大图能力
// ============================================================

(() => {
  "use strict";

  // 本 frame 最近一次右键的图片/动图信息；每次右键都覆盖（可能为 null）
  let lastMedia = null;

  // ==========================================================
  // 1. 监听右键，捕获真实图片 / 动图信息
  // ==========================================================
  document.addEventListener("contextmenu", (e) => {
    lastMedia = extractMediaInfo(e.target);
  }, true);

  // ==========================================================
  // 2. 响应 background 的查询与转码请求
  // ==========================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === "getLastImage") {
      sendResponse(lastMedia && lastMedia.url ? lastMedia : null);
      return false;
    }

    if (msg.type === "convertVideoToGif") {
      handleGifConversion(msg.url, msg.options || {})
        .then((dataUrl) => sendResponse({ success: true, dataUrl: dataUrl }))
        .catch((err) => {
          console.warn("[原封] 动图转码失败:", err);
          sendResponse({ success: false, error: (err && err.message) || String(err) });
        });
      return true; // 保持异步消息通道
    }
  });

  // ==========================================================
  // 3. 从事件目标提取媒体信息（图片 / 动图）
  // ==========================================================
  function extractMediaInfo(target) {
    if (!(target instanceof Element)) return null;

    // A. 目标本身是 <img>（优先检查是否为 Twitter GIF 缩略图）
    if (target instanceof HTMLImageElement) {
      const twGif = checkTwitterGifThumb(target);
      if (twGif) return twGif;
      return buildInfoFromImg(target);
    }

    // B. 目标本身是 <video>
    if (target instanceof HTMLVideoElement) {
      return buildInfoFromVideo(target);
    }

    // C. 目标是 <source>
    if (target.tagName === "SOURCE") {
      const picture = target.closest("picture");
      const img = picture && picture.querySelector("img");
      if (img) {
        const twGif = checkTwitterGifThumb(img);
        if (twGif) return twGif;
        return buildInfoFromImg(img);
      }
      const video = target.closest("video");
      if (video) return buildInfoFromVideo(video);
    }

    // D. 目标在视频播放器内部（Twitter / 通用视频播放器常在 video 上覆盖透明 div）
    const nearbyVideo = findNearbyVideo(target);
    if (nearbyVideo) {
      const vInfo = buildInfoFromVideo(nearbyVideo);
      if (vInfo) return vInfo;
    }

    // E. 目标带 CSS 背景图
    const bgUrl = getBackgroundImageUrl(target);
    if (bgUrl) return makeInfo(bgUrl, target);

    // F. 就近向上找媒体：逐级向上在祖先容器里找大图或视频
    return findNearbyMedia(target);
  }

  // ==========================================================
  // 4. 检查是否为 Twitter GIF 缩略图
  //    (pbs.twimg.com/tweet_video_thumb/KEY.jpg -> video.twimg.com/tweet_video/KEY.mp4)
  // ==========================================================
  function checkTwitterGifThumb(img) {
    const src = img.currentSrc || img.src || img.getAttribute("src") || "";
    const m = src.match(/tweet_video_thumb\/([a-zA-Z0-9_\-]+)/);
    if (m) {
      const key = m[1];
      const videoUrl = "https://video.twimg.com/tweet_video/" + key + ".mp4";
      return makeInfo(videoUrl, img, {
        isGif: true,
        isTwitterGif: true,
        mediaKey: key,
        posterUrl: src,
      });
    }
    return null;
  }

  // ==========================================================
  // 5. 从 <video> 元素构建媒体信息
  // ==========================================================
  function buildInfoFromVideo(video) {
    if (!video || !(video instanceof HTMLVideoElement)) return null;

    let url = null;
    let isTwitterGif = false;
    let mediaKey = null;

    // 1. 检查 poster 是否为 Twitter tweet_video_thumb
    const poster = video.getAttribute("poster") || video.poster || "";
    const twMatch = poster.match(/tweet_video_thumb\/([a-zA-Z0-9_\-]+)/);
    if (twMatch) {
      mediaKey = twMatch[1];
      url = "https://video.twimg.com/tweet_video/" + mediaKey + ".mp4";
      isTwitterGif = true;
    }

    // 2. 检查 video.src / currentSrc 是否为 tweet_video 直链
    if (!url) {
      const cur = video.currentSrc || video.src || "";
      const m = cur.match(/tweet_video\/([a-zA-Z0-9_\-]+)\.mp4/);
      if (m) {
        mediaKey = m[1];
        url = cur;
        isTwitterGif = true;
      }
    }

    // 3. 检查 <source> 标签
    if (!url) {
      for (const source of video.querySelectorAll("source")) {
        const src = source.getAttribute("src") || source.src || "";
        const m = src.match(/tweet_video\/([a-zA-Z0-9_\-]+)\.mp4/);
        if (m) {
          mediaKey = m[1];
          url = toAbsolute(src);
          isTwitterGif = true;
          break;
        }
        if (src && !isInternalUrl(src)) {
          url = toAbsolute(src);
          break;
        }
      }
    }

    // 4. Twitter MSE blob 播放模式兜底：从父级容器里找带 tweet_video_thumb 的 img
    if (!url) {
      const container = video.closest(
        '[data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="tweetPhoto"], [data-testid="tweet"], article'
      );
      if (container) {
        const thumbImg = container.querySelector('img[src*="tweet_video_thumb"]');
        if (thumbImg) {
          const m = thumbImg.src.match(/tweet_video_thumb\/([a-zA-Z0-9_\-]+)/);
          if (m) {
            mediaKey = m[1];
            url = "https://video.twimg.com/tweet_video/" + mediaKey + ".mp4";
            isTwitterGif = true;
          }
        }
      }
    }

    // 5. 其它非 blob 直链
    if (!url) {
      const cur = video.currentSrc || video.src || "";
      if (cur && !isInternalUrl(cur)) {
        url = toAbsolute(cur);
      }
    }

    if (!url) return null;

    // 是否视为动图：Twitter GIF 必定是；或者带有 loop 属性且静音循环播放的短视频
    const isGif = isTwitterGif || Boolean(video.hasAttribute("loop") && (video.muted || video.hasAttribute("muted")));

    return makeInfo(url, video, {
      isGif: isGif,
      isTwitterGif: isTwitterGif,
      isVideo: true,
      mediaKey: mediaKey,
      posterUrl: poster || null,
    });
  }

  // ==========================================================
  // 6. 查找目标附近的 <video> 元素
  // ==========================================================
  function findNearbyVideo(target) {
    if (!target || !(target instanceof Element)) return null;

    if (target instanceof HTMLVideoElement) return target;

    const inside = target.querySelector("video");
    if (inside) return inside;

    // Twitter 常见的播放器容器
    const player = target.closest(
      '[data-testid="videoPlayer"], [data-testid="videoComponent"], ' +
      '[data-testid="tweetPhoto"], div[data-testid="swipe-to-dismiss"], ' +
      '.video-player, .html5-video-player, .video-js, div[class*="video"]'
    );
    if (player) {
      const v = player.querySelector("video");
      if (v) return v;
    }

    // 向上查父级（最多 5 层），看同级或父级内是否有紧邻的 video
    let el = target.parentElement;
    for (let depth = 0; depth < 5 && el && el !== document.documentElement; depth++) {
      const v = el.querySelector("video");
      if (v) {
        const rect = v.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 40) return v;
      }
      el = el.parentElement;
    }

    return null;
  }

  // ==========================================================
  // 7. 从 <img> 元素构建图片信息
  // ==========================================================
  function buildInfoFromImg(img) {
    let url = pickBestUrl(img);

    // blob: 等拿不到直链时，在附近找可下载的真实 URL
    if (!url) url = findRealUrlNear(img);
    if (!url) return null;

    const isGif = /\.gif(\?|$)/i.test(url);
    return makeInfo(url, img, { isGif: isGif });
  }

  // ==========================================================
  // 8. 从 <img> 中选最佳 URL
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
  // 9. 解析 srcset，返回最大分辨率的绝对 URL
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
    if (entries[0].size === 0) return null;
    return entries[0].url;
  }

  // ==========================================================
  // 10. blob:/data: 拿不到直链时，在附近找真实 URL
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
  // 11. 就近向上找媒体（大图或视频，最多向上 6 层）
  // ==========================================================
  function findNearbyMedia(target) {
    let el = target;
    for (let depth = 0; depth < 6 && el && el !== document.documentElement; depth++) {
      // 优先看同级/容器内是否有 video
      const v = el.querySelector("video");
      if (v) {
        const vInfo = buildInfoFromVideo(v);
        if (vInfo) return vInfo;
      }

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
      // 优先探测推特 GIF 缩略图
      const twGif = checkTwitterGifThumb(img);
      if (twGif) return twGif;

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
  // 12. 获取元素的 CSS 背景图 URL
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
  // 13. 构建媒体信息对象
  // ==========================================================
  function makeInfo(url, el, extra) {
    const isVideo = el instanceof HTMLVideoElement;
    return {
      url: url,
      pageUrl: location.href,
      alt: (el && (el.alt || el.getAttribute("aria-label"))) || "",
      width: (el && (el.naturalWidth || el.videoWidth || el.width)) || 0,
      height: (el && (el.naturalHeight || el.videoHeight || el.height)) || 0,
      timestamp: Date.now(),
      isGif: Boolean(extra && extra.isGif),
      isTwitterGif: Boolean(extra && extra.isTwitterGif),
      isVideo: isVideo || Boolean(extra && extra.isVideo),
      mediaKey: (extra && extra.mediaKey) || null,
      posterUrl: (extra && extra.posterUrl) || null,
    };
  }

  // ==========================================================
  // 14. 动图转码调度与 Toast 状态提示
  // ==========================================================
  async function handleGifConversion(videoUrl, options) {
    showToast("正在准备转码 GIF 动图...", 0);
    try {
      const dataUrl = await convertVideoToGif(videoUrl, options, (progress) => {
        showToast("正在转码 GIF 动图 (" + progress + "%)...", 0);
      });
      showToast("GIF 动图转码完成，准备保存！", 2500);
      return dataUrl;
    } catch (err) {
      showToast("GIF 转码异常: " + ((err && err.message) || err) + "，将下载原件", 3000);
      throw err;
    }
  }

  // ==========================================================
  // 15. 核心转码引擎：视频解帧 → gifenc 量化与编码 → GIF Data URL
  // ==========================================================
  async function convertVideoToGif(videoUrl, options, onProgress) {
    const maxDim = options.maxWidth === 0 ? 99999 : (options.maxWidth || 640);
    const targetFps = options.fps || 20;

    // 1. 获取视频 Blob（优先直接 fetch，若遇 CORS 限制则求助 background）
    let blob;
    try {
      const resp = await fetch(videoUrl, { credentials: "omit" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      blob = await resp.blob();
    } catch (fetchErr) {
      // 降级由 background.js fetch（拥有 host 权限，无 CORS 限制）
      blob = await fetchBlobViaBackground(videoUrl);
    }

    const blobUrl = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = blobUrl;

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("视频元数据加载超时")), 12000);
        video.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(timer);
          reject(new Error("视频解析失败"));
        };
      });

      const duration = video.duration || 1;
      let w = video.videoWidth || 480;
      let h = video.videoHeight || 360;

      // 按比例缩放，防止 GIF 尺寸与内存过大
      if (w > maxDim || h > maxDim) {
        if (w >= h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }
      if (w % 2 !== 0) w--;
      if (h % 2 !== 0) h--;

      // 帧数限制：上限 150 帧，防止过长视频卡顿
      let fps = Math.min(targetFps, 30);
      let totalFrames = Math.max(1, Math.floor(duration * fps));
      if (totalFrames > 150) {
        fps = Math.max(10, Math.floor(150 / duration));
        totalFrames = Math.max(1, Math.floor(duration * fps));
      }

      const frameInterval = duration / totalFrames;
      const delay = Math.round(1000 / fps);

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      const encLib = window.gifenc || globalThis.gifenc;
      if (!encLib || !encLib.GIFEncoder) {
        throw new Error("gifenc 动图编码库未就绪");
      }
      const { GIFEncoder, quantize, applyPalette } = encLib;
      const gif = GIFEncoder();

      const seekTo = (time) => {
        return new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              video.removeEventListener("seeked", finish);
              resolve();
            }
          };
          const timer = setTimeout(finish, 800); // 800ms 防卡死超时
          video.addEventListener("seeked", () => {
            clearTimeout(timer);
            finish();
          });
          video.currentTime = time;
        });
      };

      for (let i = 0; i < totalFrames; i++) {
        const targetTime = Math.min(i * frameInterval, Math.max(0, duration - 0.02));
        await seekTo(targetTime);

        ctx.drawImage(video, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);

        // 每帧使用 PnnQuant 高速量化 256 色，色彩丰富细腻
        const palette = quantize(imgData.data, 256, { format: "rgb565" });
        const index = applyPalette(imgData.data, palette, "rgb565");

        gif.writeFrame(index, w, h, {
          palette: palette,
          delay: delay,
          repeat: 0, // 0 = 无限循环
        });

        if (onProgress && (i % 3 === 0 || i === totalFrames - 1)) {
          const pct = Math.round(((i + 1) / totalFrames) * 100);
          onProgress(pct);
        }
      }

      gif.finish();
      const gifBytes = gif.bytes();

      // 转为 base64 data URL
      let binary = "";
      const len = gifBytes.byteLength;
      const CHUNK = 0x8000;
      for (let i = 0; i < len; i += CHUNK) {
        binary += String.fromCharCode.apply(null, gifBytes.subarray(i, i + CHUNK));
      }
      return "data:image/gif;base64," + btoa(binary);
    } finally {
      URL.revokeObjectURL(blobUrl);
      video.remove();
    }
  }

  // 通过 background fetch 兜底防盗链或 CORS 严格的视频
  function fetchBlobViaBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "fetchVideoBlob", url: url }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.success || !resp.dataUrl) {
          return reject(new Error((resp && resp.error) || "Background fetch 失败"));
        }
        fetch(resp.dataUrl)
          .then((r) => r.blob())
          .then(resolve)
          .catch(reject);
      });
    });
  }

  // ==========================================================
  // 16. 轻量悬浮 Toast 提示
  // ==========================================================
  function showToast(text, duration = 3000) {
    let toast = document.getElementById("yuanfeng-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "yuanfeng-toast";
      toast.style.cssText = [
        "position: fixed",
        "bottom: 24px",
        "right: 24px",
        "z-index: 2147483647",
        "background: rgba(15, 20, 25, 0.92)",
        "backdrop-filter: blur(10px)",
        "color: #ffffff",
        "padding: 10px 16px",
        "border-radius: 10px",
        "font-size: 13px",
        "line-height: 1.4",
        "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        "box-shadow: 0 4px 20px rgba(0,0,0,0.35)",
        "border: 1px solid rgba(255,255,255,0.18)",
        "transition: opacity 0.25s ease, transform 0.25s ease",
        "pointer-events: none",
        "display: flex",
        "align-items: center",
        "gap: 8px",
      ].join(";");
      document.body.appendChild(toast);
    }

    toast.innerText = text;
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";

    clearTimeout(toast._timer);
    if (duration > 0) {
      toast._timer = setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(8px)";
      }, duration);
    }
  }

  // ==========================================================
  // 17. 工具函数
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
