/* ============================================================
   bridge.js —— Tauri 原生能力桥接层 v3

   全部通过 window.__TAURI_INTERNALS__.invoke() 调用插件 IPC。
   这是 Tauri v2 底层通信通道，窗口控制已验证可用。
   插件 IPC 格式：plugin:<插件名>|<操作>
   ============================================================ */

const Bridge = (() => {
  /** 检测是否在 Tauri 环境中（Tauri v2 注入 __TAURI_INTERNALS__）*/
  const isTauri = () => typeof window !== 'undefined' && window.__TAURI_INTERNALS__ != null;

  /**
   * 安全调用 Tauri IPC，降级到浏览器行为
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
      console.warn('[Bridge] Tauri 调用失败:', e);
      console.warn('[Bridge] 错误详情:', typeof e, JSON.stringify(e));
      return fallback;
    }
  }

  /** 统一 invoke 入口 */
  function _invoke(cmd, args = {}) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args);
  }

  // ===== 文件对话框 =====

  async function openFileDialog(filters = [{ name: '所有文件', extensions: ['*'] }]) {
    return _safeCall(async () => {
      return await _invoke('plugin:dialog|open', { options: { filters, multiple: false } });
    }, null);
  }

  /** 打开文件夹选择对话框（选择工作区根目录） */
  async function openFolderDialog() {
    return _safeCall(async () => {
      const result = await _invoke('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: '选择文件夹作为工作区' }
      });
      return result || null;
    }, null);
  }

  async function saveFileDialog(defaultName = 'untitled') {
    return _safeCall(async () => {
      return await _invoke('plugin:dialog|save', { options: { defaultPath: defaultName } });
    }, null);
  }

  // ===== 剪贴板 =====

  async function readClipboard() {
    return _safeCall(async () => {
      return await _invoke('plugin:clipboard|read_text');
    }, (await navigator.clipboard?.readText()) || '');
  }

  async function writeClipboard(text) {
    return _safeCall(async () => {
      await _invoke('plugin:clipboard|write_text', { data: text });
      return true;
    }, (() => { navigator.clipboard?.writeText(text); return true; })());
  }

  // ===== 系统通知 =====

  async function sendNotification(title, body) {
    return _safeCall(async () => {
      await _invoke('plugin:notification|notify', { title, body });
    }, (() => {
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    })());
  }

  // ===== Shell 打开 =====

  async function openExternal(url) {
    return _safeCall(async () => {
      await _invoke('plugin:shell|open', { path: url });
    }, (() => { window.open(url, '_blank'); })());
  }

  // ===== 文件系统 =====

  /** 读取文本文件内容（自定义 Rust 命令，无 scope 限制） */
  async function readTextFile(path) {
    return _safeCall(async () => {
      return await _invoke('read_file_content', { path });
    }, null);
  }

  /** 列出目录内容（自定义 Rust 命令，单层，目录优先 + 字母排序） */
  async function listDir(dirPath) {
    return _safeCall(async () => {
      const entries = await _invoke('list_dir', { path: dirPath });
      return (entries || []).map(e => ({
        name: e.name,
        path: e.path,
        isDir: e.is_dir,
        children: e.is_dir ? [] : undefined,
      }));
    }, []);
  }

  async function writeTextFile(path, content) {
    return _safeCall(async () => {
      await _invoke('write_file_content', { path, content });
      return true;
    }, null);
  }

  // ===== 窗口控制 =====
  /** 命令格式：plugin:window|<操作>，参数：{ label: "窗口标签" } */

  function _winLabel() {
    return window.__TAURI_INTERNALS__.metadata.currentWindow.label;
  }

  async function windowMinimize() {
    return _safeCall(() =>
      _invoke('plugin:window|minimize', { label: _winLabel() })
    );
  }

  async function windowToggleMaximize() {
    return _safeCall(async () => {
      await _invoke('plugin:window|toggle_maximize', { label: _winLabel() });
      // 切换后更新图标
      setTimeout(() => _updateMaximizeIcon(), 150);
    });
  }

  async function windowIsMaximized() {
    return _safeCall(async () => {
      return await _invoke('plugin:window|is_maximized', { label: _winLabel() });
    }, false);
  }

  async function windowClose() {
    return _safeCall(() =>
      _invoke('plugin:window|close', { label: _winLabel() })
    );
  }

  /** 更新最大化按钮图标 */
  async function _updateMaximizeIcon() {
    const btn = document.querySelector('.win-btn-maximize');
    if (!btn) return;
    const isMax = await windowIsMaximized();
    btn.innerHTML = isMax
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="13" height="13" rx="2"/><path d="M9 3h13v12"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
  }

  /** 初始化窗口状态监听 */
  function initWindowState() {
    if (!isTauri()) return;
    _updateMaximizeIcon();
    // 监听窗口大小变化来更新图标
    window.addEventListener('resize', () => {
      _updateMaximizeIcon();
    });
  }

  // ===== 公开 API =====
  return {
    isTauri,
    openFileDialog,
    openFolderDialog,
    saveFileDialog,
    readClipboard,
    writeClipboard,
    sendNotification,
    openExternal,
    readTextFile,
    listDir,
    writeTextFile,
    windowMinimize,
    windowToggleMaximize,
    windowIsMaximized,
    windowClose,
    initWindowState,
  };
})();
