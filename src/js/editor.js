/* ============================================================
   editor.js —— CodeMirror 6 编辑器

   npm CM6 · CSS 换行（Vite 会树摇 Facet 静态属性）· Ctrl+S · 自定义弹窗
   ============================================================ */

const Editor = (() => {
  let openFiles = [];
  let activeFileIndex = -1;
  let cmView = null;
  let previewMode = false;  // .md/.html 预览模式

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

  async function mount() { refreshUI(); }
  function destroy() { _saveCurrentContent(); _hideToolbar(); if (cmView) { cmView.destroy(); cmView = null; } const pw = document.getElementById('editorPreviewWrapper'); if (pw) pw.remove(); openFiles = []; activeFileIndex = -1; previewMode = false; }

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
    openFiles.push(f); activeFileIndex = openFiles.length - 1; previewMode = false;
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

  function switchFile(index) { if (index < 0 || index >= openFiles.length) return; _saveCurrentContent(); activeFileIndex = index; previewMode = false; refreshUI(); }

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
    // 仅将编辑器当前内容同步回 openFiles[i].content（切换回来时恢复用）
    // modified 标记只由 CM6 updateListener 控制，不在此处设置
    if (!f.isBinary) f.content = cmView.state.doc.toString();
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
  // CM6 加载（npm → Vite node_modules 解析）
  // ================================================================

  let _cmCache = null;
  async function _loadCM6() {
    if (_cmCache) return _cmCache;
    const [view, cm, lang, lezer] = await Promise.all([
      import('@codemirror/view'),
      import('codemirror'),
      import('@codemirror/language'),
      import('@lezer/highlight'),
    ]);
    _cmCache = { ...view, basicSetup: cm.basicSetup, syntaxHighlighting: lang.syntaxHighlighting, HighlightStyle: lang.HighlightStyle, tags: lezer.tags };
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
    const pw = document.getElementById('editorPreviewWrapper');
    if (cmView) { cmView.destroy(); cmView = null; }
    if (pw) pw.remove();
    if (activeFileIndex < 0 || openFiles.length === 0) {
      if (w) { w.classList.add('hidden'); w.innerHTML = ''; }
      if (bin) bin.classList.add('hidden'); if (empty) empty.classList.remove('hidden');
      _hideToolbar(); return;
    }
    const f = openFiles[activeFileIndex];
    if (f.isBinary) {
      if (w) { w.classList.add('hidden'); w.innerHTML = ''; }
      if (empty) empty.classList.add('hidden');
      if (bin) { bin.classList.remove('hidden'); if (binExt) binExt.textContent = `文件类型: .${f.ext} (${f.name})`; }
      _hideToolbar();
    } else if (previewMode && (f.ext === 'md' || f.ext === 'html')) {
      if (bin) bin.classList.add('hidden'); if (empty) empty.classList.add('hidden');
      if (w) { w.classList.add('hidden'); w.innerHTML = ''; }
      _renderPreview(f);
      _showToolbar(true);  // 预览模式工具栏
    } else {
      if (bin) bin.classList.add('hidden'); if (empty) empty.classList.add('hidden');
      if (w) { w.classList.remove('hidden'); w.innerHTML = ''; await _mk(w, f); }
      _showToolbar(f.ext === 'md' || f.ext === 'html');  // 可预览文件显示工具栏
    }
  }

  // ── 预览 ──

  async function _renderPreview(file) {
    const container = document.getElementById('editorContainer');
    if (!container) return;
    let pw = document.getElementById('editorPreviewWrapper');
    if (!pw) {
      pw = document.createElement('div');
      pw.id = 'editorPreviewWrapper';
      pw.className = 'editor-preview-wrapper';
      container.appendChild(pw);
    }
    pw.innerHTML = '';

    if (file.ext === 'md') {
      try {
        const marked = await import('marked');
        const html = marked.marked ? marked.marked(file.content) : marked.parse(file.content);
        const d = document.documentElement.getAttribute('data-theme') === 'dark';
        pw.innerHTML = `<div class="markdown-body" style="padding:20px 28px;max-width:860px;margin:0 auto;color:${d?'#dcd9ed':'#3a3650'};line-height:1.75;font-size:0.92rem;">${html}</div>`;
      } catch (e) {
        pw.innerHTML = `<div class="editor-preview-error">Markdown 渲染失败: ${_esc(e.message)}</div>`;
      }
    } else if (file.ext === 'html') {
      const iframe = document.createElement('iframe');
      iframe.className = 'editor-html-preview';
      iframe.sandbox = 'allow-scripts allow-same-origin';
      iframe.style.cssText = 'width:100%;height:100%;border:none;flex:1;';
      pw.appendChild(iframe);
      iframe.srcdoc = file.content;
    }
  }

  let _toolbarEl = null;
  function _showToolbar(showPreview) {
    _hideToolbar();
    if (!showPreview) return;
    const tabs = document.getElementById('editorTabs');
    if (!tabs) return;
    _toolbarEl = document.createElement('div');
    _toolbarEl.className = 'editor-preview-toolbar';
    _toolbarEl.innerHTML = `<button class="btn btn-ghost btn-sm" id="btnPreviewToggle">${previewMode ? '编辑源码' : '预览'}</button>`;
    tabs.parentNode.insertBefore(_toolbarEl, tabs.nextSibling);
    _toolbarEl.querySelector('#btnPreviewToggle').onclick = () => togglePreview();
  }
  function _hideToolbar() {
    if (_toolbarEl) { _toolbarEl.remove(); _toolbarEl = null; }
  }

  function togglePreview() {
    if (activeFileIndex < 0) return;
    const f = openFiles[activeFileIndex];
    if (f.ext !== 'md' && f.ext !== 'html') return;
    // 保存当前编辑内容
    _saveCurrentContent();
    previewMode = !previewMode;
    _renderContent();
  }

  async function _mk(parent, file) {
    try {
      const { EditorView, basicSetup, keymap, syntaxHighlighting, HighlightStyle, tags } = await _loadCM6();

      const saveBinding = keymap.of([{ key: 'Mod-s', run: () => { saveFile(); return true; }, preventDefault: true }]);

      // 显式绑定 Ctrl+C 复制，解决 Tauri 2 webview 中某些情况下复制不生效的问题
      const copyBinding = keymap.of([{
        key: 'Mod-c',
        run: (view) => {
          const range = view.state.selection.main;
          const text = view.state.sliceDoc(range.from, range.to);
          if (text) {
            navigator.clipboard.writeText(text).catch(() => {
              const ta = document.createElement('textarea');
              ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
              document.body.appendChild(ta); ta.select();
              try { document.execCommand('copy'); } catch (_) {}
              document.body.removeChild(ta);
            });
          }
          return true;
        }
      }]);

      // CM6 初始化阶段会触发多次 docChanged（语言扩展、缩进规范化等）
      let _cmSettled = false;
      setTimeout(() => { _cmSettled = true; }, 300);

      const ext = [...[].concat(basicSetup), saveBinding, copyBinding,
        EditorView.updateListener.of(u => {
          if (u.docChanged && _cmSettled) {
            if (activeFileIndex >= 0 && activeFileIndex < openFiles.length) {
              openFiles[activeFileIndex].modified = true;
              _renderTabs();
            }
          }
        }),
      ];

      // ═══ 语法高亮：深色模式用中等亮度 + 高饱和度，拉开色相差异 ═══
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const hlStyle = HighlightStyle.define([
        {tag:tags.keyword,                      color:isDark?'#7ea8d8':'#5c4e8a'},
        {tag:tags.string,                       color:isDark?'#ce9878':'#3d7c47'},
        {tag:tags.number,                       color:isDark?'#b5cea8':'#8a6a9e'},
        {tag:tags.comment,                      color:isDark?'#6a6a78':'#9999a8', fontStyle:'italic'},
        {tag:tags.variableName,                 color:isDark?'#d4d4d8':'#3a3650'},
        {tag:tags.definition(tags.variableName),color:isDark?'#d4d4d8':'#4a4270'},
        {tag:tags.function(tags.variableName),  color:isDark?'#dcd0a0':'#604888'},
        {tag:tags.typeName,                     color:isDark?'#58b8a8':'#4e6088'},
        {tag:tags.tagName,                      color:isDark?'#6ea0d0':'#5e7498'},
        {tag:tags.attributeName,                color:isDark?'#9cd0f0':'#6e5898'},
        {tag:tags.literal,                      color:isDark?'#7ea8d8':'#8a5e4e'},
        {tag:tags.operator,                     color:isDark?'#b8b8c0':'#5a5580'},
        {tag:tags.bracket,                      color:isDark?'#a0a0a8':'#6e6a88'},
        {tag:tags.heading,                      color:isDark?'#d8c898':'#3a3650', fontWeight:'600'},
        {tag:tags.quote,                        color:isDark?'#9898a8':'#7a768e'},
        {tag:tags.link,                         color:isDark?'#6ea8d8':'#406888', textDecoration:'underline'},
        {tag:tags.meta,                         color:isDark?'#a0a0a8':'#7a768e'},
        {tag:tags.strong,                       color:isDark?'#d8c898':'#3a3650', fontWeight:'600'},
        {tag:tags.emphasis,                     color:isDark?'#d4c8b0':'#3a3650', fontStyle:'italic'},
        {tag:tags.monospace,                    color:isDark?'#a0b898':'#5a6848'},
        {tag:tags.content,                      color:isDark?'#d0d0d4':'#3a3650'},
      ]);
      ext.push(syntaxHighlighting(hlStyle));

      const lang = await _lang(file.ext || ''); if (lang) ext.push(lang);
      ext.push(_theme(EditorView));

      cmView = new EditorView({ doc: file.content, extensions: ext, parent });
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

  function _theme(EditorView) { const d = document.documentElement.getAttribute('data-theme') === 'dark';
    // 外壳样式：背景、行号区、光标、选中。语法高亮走 HighlightStyle.define()
    return EditorView.theme({
      '&':{
        backgroundColor:d?'#1e1e2a':'#fafafc',
        color:d?'#d0d0d4':'#3a3650',
        fontSize:'0.96rem',
        fontWeight:d?'480':'400',    // 深色模式稍粗，提升可读性
        fontFamily:'"Cascadia Code","Fira Code","JetBrains Mono","SF Mono",Consolas,monospace',
        height:'100%'
      },
      '.cm-gutters':{
        backgroundColor:d?'#22222e':'#f3f1fb',
        color:d?'#6a6a7a':'#a8a2c2',
        borderRight:d?'1px solid #2e2e3a':'1px solid #e6e3f2'
      },
      '.cm-activeLineGutter':{backgroundColor:d?'#282836':'#ebe9f5',color:d?'#a0a0b0':'#5058A8'},
      '.cm-activeLine':{backgroundColor:d?'rgba(255,255,255,0.04)':'rgba(80,88,168,0.04)'},
      '.cm-cursor':{borderLeftColor:d?'#b0b0b8':'#5058A8'},
      '.cm-selectionBackground':{backgroundColor:d?'rgba(120,140,200,0.30)':'rgba(80,88,168,0.14)'},
      '.cm-line':{fontWeight:d?'480':'400'},              // 每行文字稍粗
      '.cm-gutterElement':{fontWeight:d?'400':'400'},      // 行号不加粗
    },{dark:d});}

  function _bindCtx(parent) { parent.addEventListener('contextmenu', e => { e.preventDefault(); _ctxMenu(e.clientX, e.clientY); }); }

  function _ctxMenu(x, y) {
    document.querySelectorAll('.context-menu.editor-menu').forEach(m => m.remove());
    const f = activeFileIndex >= 0 ? openFiles[activeFileIndex] : null;
    const canPreview = f && (f.ext === 'md' || f.ext === 'html');
    const m = document.createElement('div'); m.className = 'context-menu editor-menu visible'; m.style.left = x + 'px'; m.style.top = y + 'px';
    m.innerHTML = `<div class="context-menu-item" data-a="save">保存</div>`
      + (canPreview ? `<div class="context-menu-item" data-a="preview">${previewMode ? '返回编辑' : '预览'}</div>` : '')
      + `<div class="context-menu-separator"></div><div class="context-menu-item" data-a="close">关闭文件</div>`;
    document.body.appendChild(m);
    m.querySelector('[data-a="save"]').onclick = () => { saveFile(); m.remove(); };
    if (canPreview) m.querySelector('[data-a="preview"]').onclick = () => { togglePreview(); m.remove(); };
    m.querySelector('[data-a="close"]').onclick = () => { closeFile(activeFileIndex); m.remove(); };
    function h(e) { if (!m.parentNode) { document.removeEventListener('click', h, true); return; } if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', h, true); } }
    setTimeout(() => document.addEventListener('click', h, true), 0);
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function _toast(msg, type) { if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type); }

  return { mount, destroy, openFile, openBinary, switchFile, closeFile, saveFile, togglePreview, refresh, refreshUI, getOpenFiles: () => openFiles, getActiveFile: () => activeFileIndex >= 0 ? openFiles[activeFileIndex] : null };
})();
