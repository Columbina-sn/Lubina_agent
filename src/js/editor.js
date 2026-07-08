/* ============================================================
   editor.js —— 简易代码编辑器 v2
   行号（自动换行时按视觉行显示）· 二进制检测 · 文件标签
   ============================================================ */

const Editor = (() => {
  let openFiles = [];
  let activeFileIndex = -1;
  let wordWrapEnabled = false;

  const TEXT_EXTS = new Set([
    'txt','md','py','js','ts','jsx','tsx','html','css','scss','less',
    'json','xml','yaml','yml','toml','ini','cfg','sh','bash','zsh',
    'c','cpp','h','hpp','java','go','rs','rb','php','swift','kt',
    'r','m','sql','vue','svelte','astro','tex','csv','log','svg',
    'gitignore','env','dockerfile','makefile','cmake','bat','ps1',
    'conf','config','editorconfig','eslintrc','prettierrc',
  ]);

  function mount() {
    wordWrapEnabled = false;
    _bindEditorEvents();
    refreshUI();
  }

  function destroy() {
    _saveCurrentContent();
    openFiles = []; activeFileIndex = -1;
  }

  // ===== 打开文件 =====
  async function openFile(filePath, fileName) {
    const existing = openFiles.findIndex(f => f.path === filePath);
    if (existing >= 0) { switchFile(existing); return; }

    // 有未保存修改 → 开新标签
    _saveCurrentContent();
    const ext = filePath.split('.').pop()?.toLowerCase();
    const file = {
      path: filePath, name: fileName || filePath.split(/[/\\]/).pop(),
      content: '', isBinary: !TEXT_EXTS.has(ext), ext, modified: false,
    };

    if (!file.isBinary) {
      try {
        if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
          file.content = await Bridge.readTextFile(filePath) || '';
        } else {
          file.content = _readDemoContent(filePath, ext);
        }
      } catch (err) { file.content = `// 无法读取文件: ${err.message}`; }
    }

    openFiles.push(file); activeFileIndex = openFiles.length - 1;
    refreshUI();
  }

  function openBinary(fileName, ext) {
    const existing = openFiles.findIndex(f => f.path === fileName && f.isBinary);
    if (existing >= 0) { switchFile(existing); return; }
    openFiles.push({ path: fileName, name: fileName, content: '', isBinary: true, ext, modified: false });
    activeFileIndex = openFiles.length - 1;
    refreshUI();
  }

  function _readDemoContent(filePath, ext) {
    const name = filePath.split(/[/\\]/).pop();
    // 更长的演示内容，能展示自动换行效果
    if (ext === 'py') {
      return `# ${name}\n# Python 演示文件 — 包含足够长的行来展示自动换行效果\n\nimport os\nimport sys\nimport json\nfrom pathlib import Path\nfrom typing import Optional, List, Dict, Any\n\n\nclass ConfigManager:\n    """配置管理器：负责读取、合并和验证应用配置。支持从 JSON 文件和环境变量加载配置，并提供默认值回退机制。"""\n\n    DEFAULT_CONFIG = {\n        "api": {"base_url": "http://localhost:19800", "timeout": 30, "max_retries": 3},\n        "ui": {"theme": "auto", "font_size": 14, "language": "zh-CN"},\n        "agent": {"model": "deepseek-chat", "max_turns": 15, "temperature": 0.7},\n    }\n\n    def __init__(self, config_path: Optional[str] = None):\n        self.config_path = config_path or os.path.join(os.path.expanduser("~"), ".agent_config.json")\n        self._config = self.DEFAULT_CONFIG.copy()\n        self._load_from_file()\n        self._load_from_env()\n\n    def _load_from_file(self) -> None:\n        """从 JSON 配置文件加载设置，如果文件不存在或格式错误则使用默认值并创建新文件。"""\n        try:\n            if Path(self.config_path).exists():\n                with open(self.config_path, "r", encoding="utf-8") as f:\n                    user_config = json.load(f)\n                    self._merge_config(self._config, user_config)\n        except (json.JSONDecodeError, PermissionError) as e:\n            print(f"警告：无法读取配置文件 {self.config_path}: {e}", file=sys.stderr)\n\n    def _load_from_env(self) -> None:\n        """从环境变量加载配置覆盖。环境变量以 AGENT_ 为前缀，如 AGENT_API_BASE_URL 对应 api.base_url。"""\n        for key, value in os.environ.items():\n            if key.startswith("AGENT_"):\n                config_key = key[6:].lower().replace("__", ".")\n                self._set_nested(self._config, config_key, value)\n\n    def _merge_config(self, base: dict, override: dict) -> None:\n        for key, value in override.items():\n            if key in base and isinstance(base[key], dict) and isinstance(value, dict):\n                self._merge_config(base[key], value)\n            else:\n                base[key] = value\n\n    def _set_nested(self, d: dict, key_path: str, value: Any) -> None:\n        keys = key_path.split(".")\n        for key in keys[:-1]:\n            if key not in d: d[key] = {}\n            d = d[key]\n        d[keys[-1]] = value\n\n    def get(self, key_path: str, default: Any = None) -> Any:\n        keys = key_path.split(".")\n        current = self._config\n        for key in keys:\n            if isinstance(current, dict) and key in current:\n                current = current[key]\n            else:\n                return default\n        return current\n\n    def save(self) -> bool:\n        try:\n            os.makedirs(os.path.dirname(self.config_path), exist_ok=True)\n            with open(self.config_path, "w", encoding="utf-8") as f:\n                json.dump(self._config, f, indent=2, ensure_ascii=False)\n            return True\n        except Exception as e:\n            print(f"保存配置失败: {e}", file=sys.stderr)\n            return False\n\n\nif __name__ == "__main__":\n    config = ConfigManager()\n    print(f"当前模型: {config.get('agent.model')}")\n    print(f"API 地址: {config.get('api.base_url')}")\n    print(f"主题设置: {config.get('ui.theme')}")\n`;
    }
    if (ext === 'js') {
      return `// ${name}\n// JavaScript 演示文件 — 包含长行来测试自动换行\n\n/**\n * EventEmitter — 一个轻量级的事件发布/订阅实现\n * 支持通配符监听、一次性订阅和异步事件处理\n */\nclass EventEmitter {\n  constructor() {\n    this._listeners = new Map();\n    this._onceListeners = new Map();\n    this._maxListeners = 50;\n  }\n\n  on(event, callback, options = {}) {\n    if (!this._listeners.has(event)) this._listeners.set(event, []);\n    const listeners = this._listeners.get(event);\n    if (listeners.length >= this._maxListeners) {\n      console.warn(\`EventEmitter: 事件 "\${event}" 的监听器数量已达到上限 \${this._maxListeners}，可能存在内存泄漏\`);\n    }\n    const wrapper = options.once\n      ? (...args) => { this.off(event, wrapper); callback.apply(this, args); }\n      : callback;\n    wrapper._original = callback;\n    listeners.push(wrapper);\n    return () => this.off(event, wrapper);\n  }\n\n  once(event, callback) { return this.on(event, callback, { once: true }); }\n\n  off(event, callback) {\n    const listeners = this._listeners.get(event);\n    if (!listeners) return;\n    const idx = listeners.findIndex(fn => fn === callback || fn._original === callback);\n    if (idx >= 0) listeners.splice(idx, 1);\n    if (listeners.length === 0) this._listeners.delete(event);\n  }\n\n  emit(event, ...args) {\n    const listeners = this._listeners.get(event) || [];\n    const wildcardListeners = this._listeners.get('*') || [];\n    for (const fn of [...listeners, ...wildcardListeners]) {\n      try { fn(...args); } catch (err) { console.error(\`EventEmitter: 事件 "\${event}" 的回调出错\`, err); }\n    }\n  }\n\n  removeAllListeners(event) {\n    if (event) this._listeners.delete(event);\n    else this._listeners.clear();\n  }\n\n  listenerCount(event) { return (this._listeners.get(event) || []).length; }\n}\n\n// 使用示例\nconst bus = new EventEmitter();\nconst unsubscribe = bus.on('file:changed', (path, content) => {\n  console.log(\`文件已修改: \${path} (\${content.length} 字符)\`);\n});\nbus.emit('file:changed', '/src/app.js', 'console.log("hello world");');\n`;
    }
    if (ext === 'css') {
      return `/* ${name} */\n/* CSS 演示文件 — 包含较长的属性值以测试自动换行 */\n\n:root {\n  --color-primary: #5058A8;\n  --color-secondary: #B8B2D8;\n  --color-accent: #8C2E50;\n  --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans SC", sans-serif;\n  --shadow-card: 0 4px 16px rgba(80, 88, 168, 0.10), 0 1px 3px rgba(0, 0, 0, 0.05);\n}\n\n.card {\n  background: linear-gradient(135deg, #FFFFFF 0%, #F8FAFF 100%);\n  border: 1px solid var(--border-light);\n  border-radius: 14px;\n  padding: 20px 24px;\n  box-shadow: var(--shadow-card);\n  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s cubic-bezier(0.16, 1, 0.3, 1);\n}\n\n.card:hover {\n  transform: translateY(-2px);\n  box-shadow: 0 8px 32px rgba(80, 88, 168, 0.14), 0 2px 6px rgba(0, 0, 0, 0.08);\n}\n\n.btn-primary {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  padding: 10px 22px;\n  background: linear-gradient(135deg, #5058A8 0%, #727BC9 100%);\n  color: #ffffff;\n  font-weight: 600;\n  font-size: 0.92rem;\n  border: none;\n  border-radius: 10px;\n  cursor: pointer;\n  box-shadow: 0 2px 8px rgba(80, 88, 168, 0.20);\n  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);\n}\n\n.btn-primary:hover {\n  background: linear-gradient(135deg, #5C65BC 0%, #848DD6 100%);\n  transform: translateY(-1px);\n  box-shadow: 0 4px 16px rgba(80, 88, 168, 0.25);\n}\n\n.btn-primary:active {\n  transform: translateY(0);\n  box-shadow: none;\n}\n`;
    }
    if (ext === 'md') {
      return `# ${name.replace(/\.[^.]+$/, '')}\n\n## 项目概述\n\n这是一个桌面 AI Agent 工具，面向大学生群体，旨在提供论文写作辅助、代码学习、知识库问答和错题管理等功能。项目采用 Tauri 2.0 + HTML/CSS/JS 前端 + Python FastAPI 后端的混合架构。\n\n## 技术栈\n\n| 层 | 技术 | 说明 |\n|---|------|------|\n| 桌面壳 | Tauri 2.0 + Rust | 提供原生窗口、系统托盘、全局快捷键，安装包仅 3-5MB |\n| 前端 | HTML/CSS/JS（纯原生） | IDE 风格四区布局，无框架依赖 |\n| 后端 | Python 3.11 + FastAPI | Agent 调度核心、模型路由、工具调用 |\n| 存储 | SQLite + ChromaDB | 聊天历史 + 知识库向量索引 |\n\n## 核心功能\n\n1. **AI 对话 Agent**：支持多种消息类型（信息/操作/警告/成功/选项），Agent 可读文件、编辑文件、执行命令\n2. **文件编辑器**：行号显示、自动换行、二进制文件检测\n3. **文件浏览器**：本地文件夹浏览、文件搜索、点击打开\n4. **面板分屏**：支持水平/垂直拆分，拖拽调整大小\n5. **深色模式**：完整的「深空月夜」色彩体系\n\n## 配色方案\n\n项目采用「深空月夜」设计系统：\n- **主色调**：蓝紫渐变（#5058A8 → #727BC9）\n- **辅助色**：淡丁香紫（#B8B2D8）\n- **点缀色**：深酒红（#8C2E50）\n- **深色背景**：深空蓝黑渐变（#1A1626 → #1A1E3A → #242A52）\n\n## 开发计划\n\n- [x] P0：前端 IDE 布局\n- [ ] P0：Python FastAPI 后端骨架\n- [ ] P1：知识库 + 错题本\n- [ ] P2：MCP 工具调用\n- [ ] P3：多 Agent 协作\n`;
    }
    if (ext === 'html') {
      return `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${name.replace('.html','')} - 示例页面</title>\n  <link rel="stylesheet" href="styles/theme.css">\n</head>\n<body>\n  <div class="app-container">\n    <header class="app-header">\n      <h1>欢迎使用 Lubina</h1>\n      <p class="subtitle">你的桌面学习伙伴 — 写论文 · 整笔记 · 做PPT · 查错题</p>\n    </header>\n    <main class="app-content">\n      <section class="feature-card">\n        <h2>AI 对话</h2>\n        <p>支持多种消息类型的智能对话，Agent 可以读取文件、编辑代码、执行命令，每一步操作都会先征求你的同意。</p>\n      </section>\n      <section class="feature-card">\n        <h2>文件编辑器</h2>\n        <p>简洁的代码编辑器，支持行号显示、自动换行、多标签页。二进制文件自动检测并提示无法打开。</p>\n      </section>\n      <section class="feature-card">\n        <h2>知识库</h2>\n        <p>导入课件、论文、笔记，基于向量检索的 RAG 问答，让 AI 基于你的资料回答问题。</p>\n      </section>\n    </main>\n  </div>\n</body>\n</html>`;
    }
    return `// ${name}\n// 这是文件 "${name}" 的演示内容。\n// 实际环境中会从本地文件系统读取真实内容。\n//\n// 提示：在左侧文件树点击 "打开文件夹" 按钮浏览本地目录。\n\nconst message = "Hello from ${name}!";\nconsole.log(message);\n`;
  }

  // ===== 文件切换 / 关闭 =====
  function switchFile(index) {
    if (index < 0 || index >= openFiles.length) return;
    _saveCurrentContent();
    activeFileIndex = index;
    refreshUI();
  }

  function closeFile(index) {
    if (index < 0 || index >= openFiles.length) return;
    const file = openFiles[index];
    if (file.modified && !file.isBinary) {
      if (!confirm(`文件 "${file.name}" 有未保存的修改，确定关闭？`)) return;
    }
    openFiles.splice(index, 1);
    if (openFiles.length === 0) activeFileIndex = -1;
    else if (activeFileIndex >= openFiles.length) activeFileIndex = openFiles.length - 1;
    else if (index < activeFileIndex) activeFileIndex--;
    refreshUI();
  }

  function _saveCurrentContent() {
    if (activeFileIndex < 0 || activeFileIndex >= openFiles.length) return;
    const textarea = document.getElementById('editorTextarea');
    if (!textarea) return;
    const file = openFiles[activeFileIndex];
    if (!file.isBinary && textarea.value !== file.content) {
      file.content = textarea.value;
      file.modified = true;
    }
  }

  // ===== 自动换行 =====
  function toggleWordWrap() {
    wordWrapEnabled = !wordWrapEnabled;
    const textarea = document.getElementById('editorTextarea');
    if (textarea) textarea.classList.toggle('wrap', wordWrapEnabled);
    _updateGutter();
  }

  // ===== UI =====
  function refreshUI() { _renderTabs(); _renderContent(); _updateGutter(); }
  function refresh() { _updateGutter(); }

  function _renderTabs() {
    const tabs = document.getElementById('editorTabs');
    if (!tabs) return;
    tabs.innerHTML = openFiles.map((f, i) => `
      <div class="editor-tab ${i === activeFileIndex ? 'active' : ''}" onclick="Editor.switchFile(${i})">
        <span>${_esc(f.name)}</span>
        ${f.modified ? '<span class="tab-modified" title="未保存"></span>' : ''}
        <span class="tab-close" onclick="event.stopPropagation(); Editor.closeFile(${i})"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
      </div>
    `).join('');
  }

  function _renderContent() {
    const textarea = document.getElementById('editorTextarea');
    const binaryNotice = document.getElementById('editorBinaryNotice');
    const binaryExt = document.getElementById('editorBinaryExt');
    const emptyState = document.getElementById('editorEmptyState');
    const gutter = document.getElementById('editorGutter');

    if (activeFileIndex < 0 || openFiles.length === 0) {
      if (textarea) textarea.classList.add('hidden');
      if (binaryNotice) binaryNotice.classList.add('hidden');
      if (emptyState) emptyState.classList.remove('hidden');
      if (gutter) gutter.classList.add('hidden');
      return;
    }

    const file = openFiles[activeFileIndex];
    if (file.isBinary) {
      if (textarea) textarea.classList.add('hidden');
      if (emptyState) emptyState.classList.add('hidden');
      if (binaryNotice) { binaryNotice.classList.remove('hidden'); if (binaryExt) binaryExt.textContent = `文件类型: .${file.ext} (${file.name})`; }
      if (gutter) gutter.classList.add('hidden');
    } else {
      if (binaryNotice) binaryNotice.classList.add('hidden');
      if (emptyState) emptyState.classList.add('hidden');
      if (gutter) gutter.classList.remove('hidden');
      if (textarea) { textarea.classList.remove('hidden'); textarea.value = file.content; textarea.classList.toggle('wrap', wordWrapEnabled); textarea.focus(); }
    }
  }

  // ===== 行号（自动换行时按视觉行计算）=====
  function _updateGutter() {
    const textarea = document.getElementById('editorTextarea');
    const gutter = document.getElementById('editorGutter');
    if (!textarea || !gutter || textarea.classList.contains('hidden')) return;

    const lines = textarea.value.split('\n');

    if (wordWrapEnabled) {
      // 估算每行能容纳的字符数
      const charWidth = 8.4; // 等宽字体近似字符宽度 px
      const containerWidth = textarea.clientWidth - 20; // padding
      const charsPerLine = Math.max(20, Math.floor(containerWidth / charWidth));

      const visualLineEntries = [];
      lines.forEach((line, i) => {
        if (line.length === 0) {
          visualLineEntries.push({ num: i + 1, isCont: false });
          return;
        }
        const visualCount = Math.max(1, Math.ceil(line.length / charsPerLine));
        for (let v = 0; v < visualCount; v++) {
          visualLineEntries.push({ num: i + 1, isCont: v > 0 });
        }
      });

      gutter.innerHTML = visualLineEntries.map(e =>
        `<div class="editor-gutter-line${e.isCont ? ' cont' : ''}">${e.isCont ? '·' : e.num}</div>`
      ).join('');
    } else {
      gutter.innerHTML = lines.map((_, i) =>
        `<div class="editor-gutter-line">${i + 1}</div>`
      ).join('');
    }

    gutter.scrollTop = textarea.scrollTop;
  }

  // ===== 事件 =====
  function _bindEditorEvents() {
    const textarea = document.getElementById('editorTextarea');
    if (!textarea || textarea.dataset.bound) return;
    textarea.dataset.bound = '1';

    textarea.addEventListener('input', () => {
      if (activeFileIndex >= 0 && activeFileIndex < openFiles.length) {
        const file = openFiles[activeFileIndex];
        if (!file.isBinary) file.modified = (textarea.value !== file.content);
      }
      _updateGutter(); _renderTabs();
    });

    textarea.addEventListener('scroll', () => {
      const gutter = document.getElementById('editorGutter');
      if (gutter) gutter.scrollTop = textarea.scrollTop;
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart, end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 4;
        _updateGutter();
      }
    });

    textarea.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showEditorContextMenu(e.clientX, e.clientY);
    });
  }

  function showEditorContextMenu(x, y) {
    document.querySelectorAll('.context-menu.editor-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'context-menu editor-menu visible';
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    menu.innerHTML = `
      <div class="context-menu-item" data-action="toggleWrap">${wordWrapEnabled ? '自动换行：开' : '自动换行：关'}</div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="closeFile">关闭文件</div>
    `;
    document.body.appendChild(menu);
    menu.querySelector('[data-action="toggleWrap"]').onclick = () => { toggleWordWrap(); menu.remove(); };
    menu.querySelector('[data-action="closeFile"]').onclick = () => { closeFile(activeFileIndex); menu.remove(); };

    // 持久化关闭（不依赖 once）
    function hide(e) {
      if (!menu.parentNode) { document.removeEventListener('click', hide, true); return; }
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', hide, true); }
    }
    // 用捕获阶段避免被 stopPropagation 拦截
    setTimeout(() => document.addEventListener('click', hide, true), 0);
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  return {
    mount, destroy, openFile, openBinary,
    switchFile, closeFile, toggleWordWrap, refresh, refreshUI,
    getOpenFiles: () => openFiles,
    getActiveFile: () => activeFileIndex >= 0 ? openFiles[activeFileIndex] : null,
  };
})();
