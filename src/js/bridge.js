/* ============================================================
   bridge.js —— Tauri 原生能力桥接层
   当运行在 Tauri WebView 中时，提供原生 API 调用
   在普通浏览器中打开时，这些调用会静默降级
   ============================================================ */

const Bridge = (() => {
  /** 检测是否在 Tauri 环境中（Tauri v2 注入 __TAURI_INTERNALS__）*/
  const isTauri = () => typeof window !== 'undefined' && window.__TAURI_INTERNALS__ != null;

  /**
   * 安全调用 Tauri API，降级到浏览器行为
   * @param {Function} tauriCall - 实际调用函数
   * @param {*} fallback - 降级返回值
   */
  async function _safeCall(tauriCall, fallback = null) {
    if (!isTauri()) {
      console.debug('[Bridge] 非 Tauri 环境，使用降级策略');
      return fallback;
    }
    try {
      return await tauriCall();
    } catch (e) {
      console.warn('[Bridge] Tauri 调用失败:', e.message);
      return fallback;
    }
  }

  // ===== 文件对话框 =====
  async function openFileDialog(filters = [{ name: '所有文件', extensions: ['*'] }]) {
    return _safeCall(async () => {
      const { open } = window.__TAURI__.dialog;
      return await open({ filters, multiple: false });
    }, null);
  }

  async function saveFileDialog(defaultName = 'untitled') {
    return _safeCall(async () => {
      const { save } = window.__TAURI__.dialog;
      return await save({ defaultPath: defaultName });
    }, null);
  }

  // ===== 剪贴板 =====
  async function readClipboard() {
    return _safeCall(async () => {
      const { readText } = window.__TAURI__.clipboard;
      return await readText();
    }, (await navigator.clipboard?.readText()) || '');
  }

  async function writeClipboard(text) {
    return _safeCall(async () => {
      const { writeText } = window.__TAURI__.clipboard;
      await writeText(text);
      return true;
    }, (() => { navigator.clipboard?.writeText(text); return true; })());
  }

  // ===== 系统通知 =====
  async function sendNotification(title, body) {
    return _safeCall(async () => {
      const { sendNotification: notify } = window.__TAURI__.notification;
      await notify({ title, body });
    }, (() => {
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    })());
  }

  // ===== Shell 打开 =====
  async function openExternal(url) {
    return _safeCall(async () => {
      const { open } = window.__TAURI__.shell;
      await open(url);
    }, (() => { window.open(url, '_blank'); })());
  }

  // ===== 文件系统 =====
  async function readTextFile(path) {
    return _safeCall(async () => {
      const { readTextFile: tauriRead } = window.__TAURI__.fs;
      return await tauriRead(path);
    }, null);
  }

  async function writeTextFile(path, content) {
    return _safeCall(async () => {
      const { writeTextFile: tauriWrite } = window.__TAURI__.fs;
      await tauriWrite(path, content);
      return true;
    }, null);
  }

  // ===== 窗口控制（Tauri v2 直接 IPC — 与 @tauri-apps/api 内部逻辑一致）=====
  /**
   * 直接使用 window.__TAURI_INTERNALS__.invoke() 调用窗口 IPC 命令。
   * 这是 @tauri-apps/api/window.js 内部的实现方式，零依赖、零导入。
   * 命令格式：plugin:window|<操作>，参数：{ label: "窗口标签" }
   */
  function _winLabel() {
    return window.__TAURI_INTERNALS__.metadata.currentWindow.label;
  }

  async function windowMinimize() {
    return _safeCall(() =>
      window.__TAURI_INTERNALS__.invoke('plugin:window|minimize', { label: _winLabel() })
    );
  }

  async function windowToggleMaximize() {
    return _safeCall(() =>
      window.__TAURI_INTERNALS__.invoke('plugin:window|toggle_maximize', { label: _winLabel() })
    );
  }

  async function windowClose() {
    return _safeCall(() =>
      window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: _winLabel() })
    );
  }

  // ===== 公开 API =====
  return {
    isTauri,
    openFileDialog,
    saveFileDialog,
    readClipboard,
    writeClipboard,
    sendNotification,
    openExternal,
    readTextFile,
    writeTextFile,
    windowMinimize,
    windowToggleMaximize,
    windowClose,
  };
})();
