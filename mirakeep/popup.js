// ============================================================
// 原封 (YuanFeng) — popup.js
// 管理动图保存格式与转码参数配置
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  const radioGif = document.getElementById("radio-gif");
  const radioMp4 = document.getElementById("radio-mp4");
  const cardGif = document.getElementById("card-gif");
  const cardMp4 = document.getElementById("card-mp4");
  const gifParams = document.getElementById("gif-params");
  const selectMaxWidth = document.getElementById("gifMaxWidth");
  const selectFps = document.getElementById("gifFps");
  const statusBar = document.getElementById("status-bar");

  let statusTimer = null;

  function showStatus(text) {
    statusBar.innerText = text;
    statusBar.style.opacity = "1";
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusBar.style.opacity = "0";
    }, 2000);
  }

  function updateUi(format) {
    if (format === "mp4") {
      radioMp4.checked = true;
      cardMp4.classList.add("active");
      cardGif.classList.remove("active");
      gifParams.style.display = "none";
    } else {
      radioGif.checked = true;
      cardGif.classList.add("active");
      cardMp4.classList.remove("active");
      gifParams.style.display = "block";
    }
  }

  // 读取已保存的设置
  chrome.storage.local.get(
    {
      gifFormat: "gif",
      gifMaxWidth: 640,
      gifFps: 20,
    },
    (settings) => {
      updateUi(settings.gifFormat);
      if (selectMaxWidth) selectMaxWidth.value = String(settings.gifMaxWidth);
      if (selectFps) selectFps.value = String(settings.gifFps);
    }
  );

  function saveSettings() {
    const format = radioMp4.checked ? "mp4" : "gif";
    const maxWidth = parseInt(selectMaxWidth.value, 10) || 0;
    const fps = parseInt(selectFps.value, 10) || 20;

    chrome.storage.local.set(
      {
        gifFormat: format,
        gifMaxWidth: maxWidth,
        gifFps: fps,
      },
      () => {
        showStatus("✓ 设置已保存");
      }
    );
  }

  radioGif.addEventListener("change", () => {
    updateUi("gif");
    saveSettings();
  });

  radioMp4.addEventListener("change", () => {
    updateUi("mp4");
    saveSettings();
  });

  if (selectMaxWidth) {
    selectMaxWidth.addEventListener("change", saveSettings);
  }

  if (selectFps) {
    selectFps.addEventListener("change", saveSettings);
  }
});
