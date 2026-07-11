/* ============================================================
   editor.js —— CodeMirror 6 编辑器

   npm CM6 · CSS 换行（Vite 会树摇 Facet 静态属性）· Ctrl+S · 自定义弹窗
   ============================================================ */

const Editor = (() => {
  let openFiles = [];
  let activeFileIndex = -1;
  let cmView = null;

  let wordWrapEnabled = (() => {
    try { return localStorage.getItem('lubina_word_wrap') === 'true'; }
    catch (_) { return false; }
  })();

  const TEXT_EXTS = new Set([
    'txt','md','py','js','ts','jsx','tsx','html','css','scss','less',
    'json','xml','yaml','yml','toml','ini','cfg','sh','bash','zsh',
    'c','cpp','h','hpp','java','go','rs','rb','php','swift','kt',
    'r','m','sql','vue','svelte','astro','tex','csv','log','svg',
    'gitignore','env','dockerfile','makefile','cmake','bat','ps1',
    'conf','config','editorconfig','eslintrc','prettierrc',
  ]);

  // ================================================================
  // 自定义弹窗（替代 window.confirm，Tauri v2 禁用了原生 confirm）
  // ================================================================

  function _modal(title, msg, onOk, onCancel) {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-dialog" style="max-width:400px;">
      <h3>${title}</h3><p>${msg}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="_mCancel">取消</button>
        <button class="btn btn-primary" id="_mOk">确认</button>
      </div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('#_mOk').onclick = () => { ov.remove(); if (onOk) onOk(); };
    ov.querySelector('#_mCancel').onclick = () => { ov.remove(); if (onCancel) onCancel(); };
    ov.addEventListener('click', e => { if (e.target === ov) { ov.remove(); if (onCancel) onCancel(); } });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); if (onCancel) onCancel(); } });
  }

  // ================================================================
  // mount / destroy
  // ================================================================

  async function mount() { refreshUI(); _applyWordWrap(); }
  function destroy() { _saveCurrentContent(); if (cmView) { cmView.destroy(); cmView = null; } openFiles = []; activeFileIndex = -1; }

  // ================================================================
  // 打开文件
  // ================================================================

  async function openFile(filePath, fileName) {
    const existing = openFiles.findIndex(f => f.path === filePath);
    if (existing >= 0) { switchFile(existing); return; }
    _saveCurrentContent();
    const ext = filePath.split('.').pop()?.toLowerCase();
    const f = { path: filePath, name: fileName || filePath.split(/[/\\]/).pop(), content: '', isBinary: !TEXT_EXTS.has(ext), ext, modified: false };
    if (!f.isBinary) {
      try { if (typeof Bridge !== 'undefined' && Bridge.isTauri()) f.content = await Bridge.readTextFile(filePath) || ''; }
      catch (err) { f.content = '// 无法读取文件: ' + err.message; }
    }
    openFiles.push(f); activeFileIndex = openFiles.length - 1;
    await refreshUI();
  }

  function openBinary(fileName, ext) {
    const existing = openFiles.findIndex(f => f.path === fileName && f.isBinary);
    if (existing >= 0) { switchFile(existing); return; }
    openFiles.push({ path: fileName, name: fileName, content: '', isBinary: true, ext, modified: false });
    activeFileIndex = openFiles.length - 1;
    refreshUI();
  }

  // ================================================================
  // 切换 / 关闭
  // ================================================================

  function switchFile(index) { if (index < 0 || index >= openFiles.length) return; _saveCurrentContent(); activeFileIndex = index; refreshUI(); }

  function closeFile(index) {
    if (index < 0 || index >= openFiles.length) return;
    const f = openFiles[index];
    if (f.modified && !f.isBinary) {
      _modal('未保存的修改', `文件 "${f.name}" 有未保存的修改，确定关闭？`, () => _doClose(index));
    } else {
      _doClose(index);
    }
  }

  function _doClose(index) {
    openFiles.splice(index, 1);
    if (openFiles.length === 0) activeFileIndex = -1;
    else if (activeFileIndex >= openFiles.length) activeFileIndex = openFiles.length - 1;
    else if (index < activeFileIndex) activeFileIndex--;
    refreshUI();
  }

  function _saveCurrentContent() {
    if (activeFileIndex < 0 || activeFileIndex >= openFiles.length || !cmView) return;
    const f = openFiles[activeFileIndex];
    if (!f.isBinary) { const v = cmView.state.doc.toString(); if (v !== f.content) { f.content = v; f.modified = true; } }
  }

  // ================================================================
  // 保存文件 (Ctrl+S)
  // ================================================================

  async function saveFile() {
    if (activeFileIndex < 0 || !cmView) return;
    const f = openFiles[activeFileIndex];
    if (f.isBinary) return;
    const content = cmView.state.doc.toString();
    if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
      try {
        await Bridge.writeTextFile(f.path, content);
        f.content = content; f.modified = false;
        _renderTabs();
        _toast('已保存', 'success');
      } catch (err) {
        _toast('保存失败: ' + err.message, 'error');
      }
    }
  }

  // ================================================================
  // 自动换行（CSS 控制，Vite 会树摇掉 CM6 的 Facet 静态属性故不用）
  // ================================================================

  function toggleWordWrap() {
    wordWrapEnabled = !wordWrapEnabled;
    try { localStorage.setItem('lubina_word_wrap', String(wordWrapEnabled)); } catch (_) {}
    _applyWordWrap();
  }

  function setWordWrap(on) {
    if (wordWrapEnabled === on) return;
    wordWrapEnabled = on;
    try { localStorage.setItem('lubina_word_wrap', String(on)); } catch (_) {}
    _applyWordWrap();
  }

  function _applyWordWrap() {
    const w = document.getElementById('editorCmWrapper');
    if (!w) return;
    w.classList.toggle('cm-word-wrap', wordWrapEnabled);
    // 直接设 DOM style，确保覆盖 CM6 内部的 white-space
    const content = w.querySelector('.cm-content');
    if (content) {
      content.style.setProperty('white-space', wordWrapEnabled ? 'pre-wrap' : 'pre', 'important');
      content.style.setProperty('word-break', wordWrapEnabled ? 'break-word' : 'normal');
    }
  }

  // ================================================================
  // CM6 加载（npm → Vite node_modules 解析）
  // ================================================================

  let _cmCache = null;
  async function _loadCM6() {
    if (_cmCache) return _cmCache;
    // codemirror 包只导出 basicSetup，EditorView/keymap 在 @codemirror/view
    const [view, cm] = await Promise.all([
      import('@codemirror/view'),
      import('codemirror'),
    ]);
    _cmCache = { ...view, basicSetup: cm.basicSetup };
    return _cmCache;
  }

  // 语言包
  const _L = {
    js: ()=>import('@codemirror/lang-javascript'), json:()=>import('@codemirror/lang-json'),
    html:()=>import('@codemirror/lang-html'), css:()=>import('@codemirror/lang-css'),
    md:()=>import('@codemirror/lang-markdown'), xml:()=>import('@codemirror/lang-xml'),
    py:()=>import('@codemirror/lang-python'), sql:()=>import('@codemirror/lang-sql'),
    rust:()=>import('@codemirror/lang-rust'), java:()=>import('@codemirror/lang-java'),
    cpp:()=>import('@codemirror/lang-cpp'),
  };

  const LANG = {
    js:async()=>{const m=await _L.js();return m.javascript();}, jsx:async()=>{const m=await _L.js();return m.javascript({jsx:true});},
    ts:async()=>{const m=await _L.js();return m.javascript({typescript:true});}, tsx:async()=>{const m=await _L.js();return m.javascript({jsx:true,typescript:true});},
    json:async()=>{const m=await _L.json();return m.json();}, html:async()=>{const m=await _L.html();return m.html();},
    css:async()=>{const m=await _L.css();return m.css();}, scss:async()=>{const m=await _L.css();return m.css();}, less:async()=>{const m=await _L.css();return m.css();},
    md:async()=>{const m=await _L.md();return m.markdown();}, xml:async()=>{const m=await _L.xml();return m.xml();},
    py:async()=>{const m=await _L.py();return m.python();}, sql:async()=>{const m=await _L.sql();return m.sql();},
    rust:async()=>{const m=await _L.rust();return m.rust();}, java:async()=>{const m=await _L.java();return m.java();},
    cpp:async()=>{const m=await _L.cpp();return m.cpp();}, c:async()=>{const m=await _L.cpp();return m.cpp();}, h:async()=>{const m=await _L.cpp();return m.cpp();}, hpp:async()=>{const m=await _L.cpp();return m.cpp();},
  };

  const _langCache = {};
  async function _lang(ext) {
    if (_langCache[ext] !== undefined) return _langCache[ext];
    const fn = LANG[ext]; if (!fn) { _langCache[ext] = null; return null; }
    try { _langCache[ext] = await fn(); return _langCache[ext]; }
    catch (_) { _langCache[ext] = null; return null; }
  }

  // ================================================================
  // UI
  // ================================================================

  async function refreshUI() { _renderTabs(); await _renderContent(); }
  function refresh() { if (cmView) cmView.requestMeasure(); }

  function _renderTabs() {
    const el = document.getElementById('editorTabs'); if (!el) return;
    el.innerHTML = openFiles.map((f, i) => `
      <div class="editor-tab ${i === activeFileIndex ? 'active' : ''}" onclick="Editor.switchFile(${i})">
        <span>${_esc(f.name)}</span>${f.modified ? '<span class="tab-modified" title="未保存"></span>' : ''}
        <span class="tab-close" onclick="event.stopPropagation();Editor.closeFile(${i})"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
      </div>`).join('');
  }

  async function _renderContent() {
    const w = document.getElementById('editorCmWrapper'), bin = document.getElementById('editorBinaryNotice'), binExt = document.getElementById('editorBinaryExt'), empty = document.getElementById('editorEmptyState');
    if (cmView) { cmView.destroy(); cmView = null; }
    if (activeFileIndex < 0 || openFiles.length === 0) { if (w) { w.classList.add('hidden'); w.innerHTML = ''; } if (bin) bin.classList.add('hidden'); if (empty) empty.classList.remove('hidden'); return; }
    const f = openFiles[activeFileIndex];
    if (f.isBinary) { if (w) { w.classList.add('hidden'); w.innerHTML = ''; } if (empty) empty.classList.add('hidden'); if (bin) { bin.classList.remove('hidden'); if (binExt) binExt.textContent = `文件类型: .${f.ext} (${f.name})`; } }
    else { if (bin) bin.classList.add('hidden'); if (empty) empty.classList.add('hidden'); if (w) { w.classList.remove('hidden'); w.innerHTML = ''; await _mk(w, f); } }
  }

  async function _mk(parent, file) {
    try {
      const { EditorView, basicSetup, keymap } = await _loadCM6();

      const saveBinding = keymap.of([{ key: 'Mod-s', run: () => { saveFile(); return true; }, preventDefault: true }]);

      let initial = true;

      const ext = [...[].concat(basicSetup), saveBinding,
        EditorView.updateListener.of(u => {
          if (u.docChanged) {
            if (initial) { initial = false; return; }
            if (activeFileIndex >= 0 && activeFileIndex < openFiles.length) {
              openFiles[activeFileIndex].modified = true;
              _renderTabs();
            }
          }
        }),
      ];

      const lang = await _lang(file.ext || ''); if (lang) ext.push(lang);
      ext.push(_theme(EditorView));

      cmView = new EditorView({ doc: file.content, extensions: ext, parent });
      _applyWordWrap();
      _bindCtx(parent);
    } catch (e) {
      console.error('[Editor] CM6 失败:', e);
      _fallback(parent, file.content);
    }
  }

  function _fallback(parent, content) {
    parent.innerHTML = `<div class="editor-body"><div class="editor-gutter" id="editorGutter"></div><textarea class="editor-textarea" id="editorTextarea" spellcheck="false">${_esc(content)}</textarea></div>`;
    const ta = parent.querySelector('#editorTextarea'), g = parent.querySelector('#editorGutter');
    if (!ta) return;
    const up = () => { if (activeFileIndex >= 0) { const f = openFiles[activeFileIndex]; f.content = ta.value; f.modified = true; } if (g) { const n = ta.value.split('\n').length; let h = ''; for (let i = 1; i <= n; i++) h += `<div class="editor-gutter-line">${i}</div>`; g.innerHTML = h; g.scrollTop = ta.scrollTop; } };
    ta.addEventListener('input', up); ta.addEventListener('scroll', () => { if (g) g.scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); _toast('保存功能仅 CM6 模式支持', 'warning'); } });
    up();
  }

  function _theme(EditorView) { const d = document.documentElement.getAttribute('data-theme') === 'dark'; return EditorView.theme({
    '&':{backgroundColor:d?'#1a1a24':'#fafafc',color:d?'#d4d2e0':'#3a3650',fontSize:'0.85rem',fontFamily:'"Cascadia Code","Fira Code","JetBrains Mono","SF Mono",Consolas,monospace',height:'100%'},
    '.cm-gutters':{backgroundColor:d?'#1e1d28':'#f3f1fb',color:d?'#5a5580':'#a8a2c2',borderRight:d?'1px solid #2a2838':'1px solid #e6e3f2'},
    '.cm-activeLineGutter':{backgroundColor:d?'#252435':'#ebe9f5',color:d?'#c0b3e6':'#5058A8'},
    '.cm-activeLine':{backgroundColor:d?'rgba(80,88,168,0.06)':'rgba(80,88,168,0.04)'},
    '.cm-cursor':{borderLeftColor:d?'#c0b3e6':'#5058A8'},
    '.cm-selectionBackground':{backgroundColor:d?'rgba(80,88,168,0.22)':'rgba(80,88,168,0.14)'},
  },{dark:d});}

  function _bindCtx(parent) { parent.addEventListener('contextmenu', e => { e.preventDefault(); _ctxMenu(e.clientX, e.clientY); }); }

  function _ctxMenu(x, y) {
    document.querySelectorAll('.context-menu.editor-menu').forEach(m => m.remove());
    const m = document.createElement('div'); m.className = 'context-menu editor-menu visible'; m.style.left = x + 'px'; m.style.top = y + 'px';
    m.innerHTML = `<div class="context-menu-item" data-a="wrap">${wordWrapEnabled?'自动换行：开':'自动换行：关'}</div><div class="context-menu-item" data-a="save">保存</div><div class="context-menu-separator"></div><div class="context-menu-item" data-a="close">关闭文件</div>`;
    document.body.appendChild(m);
    m.querySelector('[data-a="wrap"]').onclick = () => { toggleWordWrap(); m.remove(); };
    m.querySelector('[data-a="save"]').onclick = () => { saveFile(); m.remove(); };
    m.querySelector('[data-a="close"]').onclick = () => { closeFile(activeFileIndex); m.remove(); };
    function h(e) { if (!m.parentNode) { document.removeEventListener('click', h, true); return; } if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', h, true); } }
    setTimeout(() => document.addEventListener('click', h, true), 0);
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function _toast(msg, type) { if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type); }

  return { mount, destroy, openFile, openBinary, switchFile, closeFile, saveFile, toggleWordWrap, setWordWrap, refresh, refreshUI, getWordWrap: () => wordWrapEnabled, getOpenFiles: () => openFiles, getActiveFile: () => activeFileIndex >= 0 ? openFiles[activeFileIndex] : null };
})();
