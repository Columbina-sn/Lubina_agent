/* ============================================================
   editor.js v5 —— CodeMirror 6 双面板编辑器

   左右分屏 · 持久化 · MD/HTML 预览 · Ctrl+S · 自定义弹窗
   ============================================================ */

const Editor = (() => {
  // ── 双面板状态 ──
  let panels = [
    { openFiles: [], activeFileIndex: -1, cmView: null, previewMode: false },
    { openFiles: [], activeFileIndex: -1, cmView: null, previewMode: false }
  ];
  let activePanel = 0;      // 当前聚焦的面板
  let splitActive = false;  // 右侧面板是否可见
  let _savedState = null;   // 页面切换时持久化状态
  let _tabOrderCounter = 0; // 选项卡打开顺序序号（用于 FIFO 关闭策略）
  let _syncingCM = false;   // 跨面板 CM6 同步锁（防递归触发）

  const TEXT_EXTS = new Set([
    'txt','md','py','js','ts','jsx','tsx','html','css','scss','less',
    'json','xml','yaml','yml','toml','ini','cfg','sh','bash','zsh',
    'c','cpp','h','hpp','java','go','rs','rb','php','swift','kt',
    'r','m','sql','vue','svelte','astro','tex','csv','log','svg',
    'gitignore','env','dockerfile','makefile','cmake','bat','ps1',
    'conf','config','editorconfig','eslintrc','prettierrc',
  ]);

  // ── 辅助：获取面板专属 DOM 元素 ──
  function _el(suffix, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    return document.getElementById(`editor${suffix}${pi}`);
  }

  // ── 辅助：获取面板数据 ──
  function _p(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    return panels[pi];
  }

  // ── 辅助：另一个面板索引 ──
  function _otherPanel() { return activePanel === 0 ? 1 : 0; }

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

  async function mount() {
    if (_savedState) {
      // 恢复持久化的双面板状态
      panels = _savedState.panels.map(p => ({
        openFiles: p.openFiles.map(f => ({...f, modified: false})),  // 清除修改标记
        activeFileIndex: p.activeFileIndex,
        cmView: null,
        previewMode: p.previewMode,
      }));
      activePanel = _savedState.activePanel;
      splitActive = _savedState.splitActive;
      _savedState = null;
    }
    // 同步 DOM 中的分屏状态（pageHTML 默认 panel1 隐藏，需根据 splitActive 恢复）
    const p1 = document.getElementById('editorPanel1');
    const handle = document.getElementById('editorSplitHandle');
    if (p1) p1.classList.toggle('hidden', !splitActive);
    if (handle) handle.classList.toggle('hidden', !splitActive);
    // 刷新（分屏时两个面板都要刷新）
    await refreshUI(0);
    if (splitActive) await refreshUI(1);
    _bindSplitHandle();
  }

  function destroy() {
    _teardownScrollSync();
    // 保存两个面板的最新内容 + 滚动位置
    for (let i = 0; i < 2; i++) {
      _saveCurrentContent(i);
      // 保存预览模式的滚动位置
      if (panels[i].previewMode && panels[i].activeFileIndex >= 0) {
        const pw = document.getElementById(`editorPreviewWrapper${i}`);
        const f = panels[i].openFiles[panels[i].activeFileIndex];
        if (pw && f) { f._scrollTop = pw.scrollTop; f._scrollLeft = pw.scrollLeft; }
      }
      if (panels[i].cmView) { panels[i].cmView.destroy(); panels[i].cmView = null; }
      // 清理预览 wrapper（注意面板专属 ID）
      const pw = document.getElementById(`editorPreviewWrapper${i}`);
      if (pw) pw.remove();
    }
    // 持久化
    const hasFiles = panels.some(p => p.openFiles.length > 0);
    if (hasFiles) {
      _savedState = {
        panels: panels.map(p => ({
          openFiles: p.openFiles.map(f => ({...f})),  // 深拷贝
          activeFileIndex: p.activeFileIndex,
          previewMode: p.previewMode,
        })),
        activePanel,
        splitActive,
      };
    } else {
      _savedState = null;
    }
    // 清空
    panels = [
      { openFiles: [], activeFileIndex: -1, cmView: null, previewMode: false },
      { openFiles: [], activeFileIndex: -1, cmView: null, previewMode: false }
    ];
    activePanel = 0;
    splitActive = false;
  }

  // ================================================================
  // 分屏控制
  // ================================================================

  function toggleSplit(keepPanel) {
    const srcP = (keepPanel !== undefined) ? keepPanel : activePanel;
    const otherP = srcP === 0 ? 1 : 0;
    if (splitActive) {
      // 合并：将对侧面板的标签页合并到 srcP
      _saveCurrentContent(0);
      _saveCurrentContent(1);
      _mergePanels(srcP, otherP);
      // 若存活方是右侧面板，把数据搬回左侧（左侧始终是单面板时的展示面板）
      if (srcP === 1) {
        panels[0] = panels[1];
        panels[1] = { openFiles: [], activeFileIndex: -1, cmView: null, previewMode: false };
        if (activePanel === 1) activePanel = 0;
      }
    }
    splitActive = !splitActive;
    const p1 = document.getElementById('editorPanel1');
    const handle = document.getElementById('editorSplitHandle');
    if (p1) p1.classList.toggle('hidden', !splitActive);
    if (handle) handle.classList.toggle('hidden', !splitActive);
    if (!splitActive) {
      // 清除面板 1（已搬空或本就是被合并方）
      if (panels[1].cmView) { panels[1].cmView.destroy(); panels[1].cmView = null; }
      panels[1].openFiles = []; panels[1].activeFileIndex = -1; panels[1].previewMode = false;
      if (activePanel === 1) focusPanel(0);
      const p0 = document.getElementById('editorPanel0');
      if (p0) { p0.style.flex = ''; p0.style.width = ''; }
    }
    _teardownScrollSync();
    _renderAllTabs();
    if (splitActive) { refreshUI(0); refreshUI(1); }
    else { refreshUI(0); }
  }

  function _mergePanels(srcP, otherP) {
    const src = panels[srcP], other = panels[otherP];
    if (other.openFiles.length === 0) return;
    for (const f of other.openFiles) {
      const existIdx = src.openFiles.findIndex(sf => sf.path === f.path);
      if (existIdx >= 0) {
        // 同一文件：两侧 modified 取 OR
        if (f.modified) src.openFiles[existIdx].modified = true;
        // 如果对侧内容更新且已修改，使用对侧内容
        if (f.modified && !src.openFiles[existIdx].modified) {
          src.openFiles[existIdx].content = f.content;
        }
      } else {
        src.openFiles.push({ ...f });
      }
    }
    other.openFiles = [];
    other.activeFileIndex = -1;
    other.previewMode = false;
  }

  function focusPanel(pIdx) {
    if (activePanel === pIdx) return;
    activePanel = pIdx;
    // 视觉上高亮活跃面板
    _renderAllTabs();
  }

  function openFileInSide(filePath, fileName) {
    const targetPanel = _otherPanel();
    // 如果分屏未激活，先激活
    if (!splitActive) toggleSplit();
    openFileInPanel(targetPanel, filePath, fileName);
  }

  // ================================================================
  // 打开文件
  // ================================================================

  async function openFile(filePath, fileName, pIdx) {
    await openFileInPanel(pIdx !== undefined ? pIdx : activePanel, filePath, fileName);
  }

  async function openFileInPanel(pIdx, filePath, fileName) {
    const p = panels[pIdx];
    const existing = p.openFiles.findIndex(f => f.path === filePath);
    if (existing >= 0) { switchFile(existing, pIdx); return; }

    // 同一文件在另一面板已打开 → 复用对象引用，实现跨面板状态同步
    const otherP = panels[1 - pIdx];
    const otherIdx = otherP.openFiles.findIndex(f => f.path === filePath);
    if (otherIdx >= 0) {
      const shared = otherP.openFiles[otherIdx];
      // 上限检查（不会重复计数，因为同一个对象）
      const allowed = await _makeRoomForNewFile();
      if (!allowed) return;
      p.openFiles.push(shared); p.activeFileIndex = p.openFiles.length - 1; p.previewMode = false;
      await refreshUI(pIdx);
      return;
    }

    _saveCurrentContent(pIdx);

    // 上限预检：若超标，先腾位置再打开
    const allowed = await _makeRoomForNewFile();
    if (!allowed) return; // 用户取消

    const ext = filePath.split('.').pop()?.toLowerCase();
    const now = Date.now();
    const f = { path: filePath, name: fileName || filePath.split(/[/\\]/).pop(), content: '', isBinary: !TEXT_EXTS.has(ext), ext, modified: false, _saved: '', lastAccess: now, openOrder: ++_tabOrderCounter };
    if (!f.isBinary) {
      try { if (typeof Bridge !== 'undefined' && Bridge.isTauri()) { f.content = await Bridge.readTextFile(filePath) || ''; f._saved = f.content; } }
      catch (err) { f.content = '// 无法读取文件: ' + err.message; f._saved = f.content; }
    }
    p.openFiles.push(f); p.activeFileIndex = p.openFiles.length - 1; p.previewMode = false;
    await refreshUI(pIdx);
  }

  function openBinary(fileName, ext) {
    return openBinaryInPanel(activePanel, fileName, ext);
  }

  async function openBinaryInPanel(pIdx, fileName, ext) {
    const p = panels[pIdx];
    const existing = p.openFiles.findIndex(f => f.path === fileName && f.isBinary);
    if (existing >= 0) { switchFile(existing, pIdx); return; }

    const allowed = await _makeRoomForNewFile();
    if (!allowed) return;

    const now = Date.now();
    p.openFiles.push({ path: fileName, name: fileName, content: '', isBinary: true, ext, modified: false, lastAccess: now, openOrder: ++_tabOrderCounter });
    p.activeFileIndex = p.openFiles.length - 1;
    refreshUI(pIdx);
  }

  // ================================================================
  // 切换 / 关闭
  // ================================================================

  function switchFile(index, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    if (index < 0 || index >= p.openFiles.length) return;
    _saveCurrentContent(pi);
    p.activeFileIndex = index; p.previewMode = false;
    if (p.openFiles[index]) p.openFiles[index].lastAccess = Date.now();
    refreshUI(pi);
  }

  function closeFile(index, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    if (index < 0 || index >= p.openFiles.length) return;
    const f = p.openFiles[index];
    if (f.modified && !f.isBinary) {
      _modal('未保存的修改', `文件 "${f.name}" 有未保存的修改，确定关闭？`, () => _doClose(index, pi));
    } else {
      _doClose(index, pi);
    }
  }

  function _doClose(index, pIdx) {
    const p = panels[pIdx];
    p.openFiles.splice(index, 1);
    if (p.openFiles.length === 0) p.activeFileIndex = -1;
    else if (p.activeFileIndex >= p.openFiles.length) p.activeFileIndex = p.openFiles.length - 1;
    else if (index < p.activeFileIndex) p.activeFileIndex--;
    _teardownScrollSync();
    refreshUI(pIdx);
  }

  function _getTotalTabCount() {
    return panels[0].openFiles.length + panels[1].openFiles.length;
  }

  function _getMaxTabCount() {
    const v = localStorage.getItem('lubia_editor_tab_max_count');
    return v ? Math.max(5, Math.min(20, parseInt(v) || 10)) : 10;
  }

  // 在打开新文件前调用。返回 true 表示可以继续打开，false 表示用户取消。
  async function _makeRoomForNewFile() {
    const max = _getMaxTabCount();
    if (_getTotalTabCount() < max) return true; // 还没满，直接放行

    // 找候选：已保存的、非当前活跃的文件
    const all = [];
    for (let pi = 0; pi < 2; pi++) {
      const actIdx = panels[pi].activeFileIndex;
      for (let fi = 0; fi < panels[pi].openFiles.length; fi++) {
        if (fi === actIdx) continue; // 不关当前正在看的
        all.push({ pi, fi, f: panels[pi].openFiles[fi] });
      }
    }

    const policy = localStorage.getItem('lubia_editor_tab_close_policy') || 'lru';
    const saved = all.filter(x => !x.f.modified);
    if (policy === 'fifo') saved.sort((a, b) => (a.f.openOrder || 0) - (b.f.openOrder || 0));
    else saved.sort((a, b) => (a.f.lastAccess || 0) - (b.f.lastAccess || 0));

    if (saved.length > 0) {
      // 有已保存的 → 直接关掉，腾位置
      const target = saved[0];
      _doClose(target.fi, target.pi);
      return true;
    }

    // 全部未保存 → 弹窗让用户选择
    // 找最旧的那个（按策略）作为建议关闭的对象
    const unsaved = [...all];
    if (policy === 'fifo') unsaved.sort((a, b) => (a.f.openOrder || 0) - (b.f.openOrder || 0));
    else unsaved.sort((a, b) => (a.f.lastAccess || 0) - (b.f.lastAccess || 0));
    const candidate = unsaved[0];
    const candidateName = candidate.f.name;

    return new Promise((resolve) => {
      _modal('标签页已达上限',
        `当前已打开 ${max} 个文件（上限），且所有文件均未保存。\n\n是否保存并关闭「${candidateName}」，然后打开新文件？`,
        async () => {
          // 确定 → 保存候选文件 + 关闭
          _saveCurrentContent(candidate.pi);
          if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
            try {
              await Bridge.writeTextFile(candidate.f.path, candidate.f.content);
              candidate.f.modified = false;
            } catch (_) { /* 保存失败也继续关闭 */ }
          }
          _doClose(candidate.fi, candidate.pi);
          resolve(true);
        },
        () => { resolve(false); } // 取消 → 不打开
      );
    });
  }

  // 滚动同步 —— 同 MD 文件在两侧分屏（一源码一预览）时同步滚动百分比
  let _scrollSyncCleanup = null;

  function _teardownScrollSync() {
    if (_scrollSyncCleanup) { _scrollSyncCleanup(); _scrollSyncCleanup = null; }
  }

  function _setupScrollSync() {
    _teardownScrollSync();
    if (!splitActive) return;

    const f0 = panels[0].activeFileIndex >= 0 ? panels[0].openFiles[panels[0].activeFileIndex] : null;
    const f1 = panels[1].activeFileIndex >= 0 ? panels[1].openFiles[panels[1].activeFileIndex] : null;
    if (!f0 || !f1 || f0.path !== f1.path || f0.ext !== 'md') return;
    if (panels[0].previewMode === panels[1].previewMode) return; // 需要一源码一预览

    const srcPi = panels[0].previewMode ? 1 : 0;  // 源码面板
    const prvPi = panels[0].previewMode ? 0 : 1;  // 预览面板
    if (!panels[srcPi].cmView) return;

    const prvWrapper = document.getElementById(`editorPreviewWrapper${prvPi}`);
    if (!prvWrapper) return;

    const srcScroller = panels[srcPi].cmView.scrollDOM;
    let _syncing = false;

    function srcToPrv() {
      if (_syncing) return; _syncing = true;
      const pct = srcScroller.scrollTop / Math.max(1, srcScroller.scrollHeight - srcScroller.clientHeight);
      prvWrapper.scrollTop = pct * Math.max(0, prvWrapper.scrollHeight - prvWrapper.clientHeight);
      _syncing = false;
    }
    function prvToSrc() {
      if (_syncing) return; _syncing = true;
      const pct = prvWrapper.scrollTop / Math.max(1, prvWrapper.scrollHeight - prvWrapper.clientHeight);
      srcScroller.scrollTop = pct * Math.max(0, srcScroller.scrollHeight - srcScroller.clientHeight);
      _syncing = false;
    }

    srcScroller.addEventListener('scroll', srcToPrv, { passive: true });
    prvWrapper.addEventListener('scroll', prvToSrc, { passive: true });

    _scrollSyncCleanup = () => {
      srcScroller.removeEventListener('scroll', srcToPrv);
      prvWrapper.removeEventListener('scroll', prvToSrc);
      _scrollSyncCleanup = null;
    };
  }

  function _saveCurrentContent(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    if (p.activeFileIndex < 0 || p.activeFileIndex >= p.openFiles.length || !p.cmView) return;
    const f = p.openFiles[p.activeFileIndex];
    if (!f.isBinary) f.content = p.cmView.state.doc.toString();
    // 保存滚动位置（用于标签切换和页面切换后恢复）
    f._scrollTop = p.cmView.scrollDOM?.scrollTop || 0;
    f._scrollLeft = p.cmView.scrollDOM?.scrollLeft || 0;
  }

  // ================================================================
  // 保存文件 (Ctrl+S)
  // ================================================================

  async function saveFile(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    if (p.activeFileIndex < 0 || !p.cmView) return;
    const f = p.openFiles[p.activeFileIndex];
    if (f.isBinary) return;
    const content = p.cmView.state.doc.toString();
    if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
      try {
        await Bridge.writeTextFile(f.path, content);
        f.content = content; f._saved = content; f.modified = false;
        _renderTabs(pi);
        // 若同一文件在另一面板也开着，同步刷新其标签页
        const otherP = panels[1 - pi];
        if (otherP.openFiles.some(of => of === f)) _renderTabs(1 - pi);
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

  async function refreshUI(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    _renderTabs(pi);
    await _renderContent(pi);
    // 刷新两个面板的 tabs（因为右侧面板可能有预览/分屏按钮变化）
    _renderAllTabs();
    _setupScrollSync();
  }

  function refresh() {
    for (let i = 0; i < 2; i++) {
      if (panels[i].cmView) panels[i].cmView.requestMeasure();
    }
  }

  function _renderAllTabs() {
    _renderTabs(0);
    if (splitActive) _renderTabs(1);
  }

  // 同名文件加父目录前缀以区分："src/index.js" vs "test/index.js"
  function _disambiguateNames(openFiles) {
    // 收集所有文件的 path → name 映射（按路径去重，同一文件不参与区分）
    const byName = {};
    const seen = new Set();
    for (const f of openFiles) {
      if (seen.has(f.path)) continue; // 同一文件（分屏两边同对象引用），跳过
      seen.add(f.path);
      if (!byName[f.name]) byName[f.name] = [];
      byName[f.name].push(f);
    }
    const result = {};
    for (const [name, files] of Object.entries(byName)) {
      if (files.length === 1) { result[files[0].path] = name; continue; }
      // 多个同名文件：从路径末尾往上找，直到能区分
      const paths = files.map(f => f.path.replace(/\\/g, '/').split('/').filter(Boolean));
      const maxLen = Math.min(...paths.map(p => p.length));
      let minNeed = 1;
      for (let d = 2; d <= maxLen; d++) {
        const suffixes = paths.map(p => p.slice(-d).join('/'));
        if (new Set(suffixes).size === suffixes.length) { minNeed = d; break; }
        if (d === maxLen) minNeed = maxLen;
      }
      for (let idx = 0; idx < files.length; idx++) {
        result[files[idx].path] = paths[idx].slice(-minNeed).join('/');
      }
    }
    return result;
  }

  function _tabDisplayNames(pIdx) {
    const p = panels[pIdx];
    // 汇总两侧所有文件用于去重判断
    const allFiles = [...panels[0].openFiles, ...panels[1].openFiles];
    const names = _disambiguateNames(allFiles);
    // 只返回当前面板文件的名字
    return p.openFiles.map(f => names[f.path] || f.name);
  }

  function _renderTabs(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    const el = _el('Tabs', pi); if (!el) return;

    const f = p.activeFileIndex >= 0 ? p.openFiles[p.activeFileIndex] : null;
    const canPreview = f && (f.ext === 'md' || f.ext === 'html');
    const hasFiles = p.openFiles.length > 0;
    const displayNames = _tabDisplayNames(pi);

    // 只有当前面板有文件时才显示分屏/合并按钮
    const showSplitBtn = hasFiles;
    const btnLabel = splitActive ? '合并' : '分屏';
    const btnTitle = splitActive ? '关闭分屏' : '分屏';

    el.innerHTML =
      `<div class="editor-tabs-wrap">${p.openFiles.map((f, i) => {
        const dn = displayNames[i] || f.name;
        return `
        <div class="editor-tab ${i === p.activeFileIndex ? 'active' : ''} ${pi === activePanel ? '' : 'inactive-panel'}"
             onclick="Editor.switchFile(${i},${pi})" title="${_esc(f.path)}${f.modified ? ' (未保存)' : ''}">
          <span>${_esc(dn)}</span>
          <span class="tab-indicator">
            ${f.modified ? '<span class="tab-modified" title="未保存"></span>' : ''}
            <span class="tab-close" onclick="event.stopPropagation();Editor.closeFile(${i},${pi})"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
          </span>
        </div>`;
      }).join('')}</div>
      <div class="editor-tabs-actions">
        ${canPreview ? `<button class="editor-action-btn" id="btnPreviewToggle${pi}" title="${p.previewMode ? '编辑源码' : '预览'}">${p.previewMode ? '编辑源码' : '预览'}</button>` : ''}
        ${showSplitBtn ? `<button class="editor-action-btn" id="btnSplitToggle${pi}" title="${btnTitle}">${btnLabel}</button>` : ''}
      </div>`;

    // 绑定事件
    el.querySelector('#btnPreviewToggle' + pi)?.addEventListener('click', () => togglePreview(pi));
    el.querySelector('#btnSplitToggle' + pi)?.addEventListener('click', () => toggleSplit(pi));
  }

  async function _renderContent(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    const w = _el('CmWrapper', pi), bin = _el('BinaryNotice', pi),
          binExtEl = bin ? bin.querySelector('p[id]') || bin.querySelector('p:last-child') : null,
          empty = _el('EmptyState', pi);
    const pw = document.getElementById(`editorPreviewWrapper${pi}`);

    // 保存当前预览的滚动位置（如有）
    if (pw && p.previewMode && p.activeFileIndex >= 0) {
      const activeFile = p.openFiles[p.activeFileIndex];
      if (activeFile) { activeFile._scrollTop = pw.scrollTop; activeFile._scrollLeft = pw.scrollLeft; }
    }
    if (p.cmView) { p.cmView.destroy(); p.cmView = null; }
    if (pw) pw.remove();

    if (p.activeFileIndex < 0 || p.openFiles.length === 0) {
      if (w) { w.classList.add('hidden'); w.innerHTML = ''; }
      if (bin) bin.classList.add('hidden');
      if (empty) empty.classList.remove('hidden');
      return;
    }
    const f = p.openFiles[p.activeFileIndex];
    if (f.isBinary) {
      if (w) { w.classList.add('hidden'); w.innerHTML = ''; }
      if (empty) empty.classList.add('hidden');
      if (bin) { bin.classList.remove('hidden'); if (binExtEl) binExtEl.textContent = `文件类型: .${f.ext} (${f.name})`; }
    } else if (p.previewMode && (f.ext === 'md' || f.ext === 'html')) {
      if (bin) bin.classList.add('hidden'); if (empty) empty.classList.add('hidden');
      if (w) { w.classList.add('hidden'); w.innerHTML = ''; }
      _renderPreview(f, pi);
    } else {
      if (bin) bin.classList.add('hidden'); if (empty) empty.classList.add('hidden');
      if (w) { w.classList.remove('hidden'); w.innerHTML = ''; await _mk(w, f, pi); }
    }
  }

  // ── 预览 ──

  async function _renderPreview(file, pIdx) {
    const container = _el('Container', pIdx);
    if (!container) return;
    let pw = document.getElementById(`editorPreviewWrapper${pIdx}`);
    if (!pw) {
      pw = document.createElement('div');
      pw.id = `editorPreviewWrapper${pIdx}`;
      pw.className = 'editor-preview-wrapper';
      container.appendChild(pw);
    }
    pw.innerHTML = '';

    if (file.ext === 'md') {
      try {
        const m = await import('marked');
        // 兼容 marked 不同版本的导出方式
        const parseFn = typeof m.marked === 'function' ? m.marked
                      : typeof m.parse === 'function' ? m.parse
                      : typeof m.default?.marked === 'function' ? m.default.marked
                      : typeof m.default?.parse === 'function' ? m.default.parse
                      : typeof m.default === 'function' ? m.default
                      : null;
        if (!parseFn) throw new Error('无法找到 marked 解析函数');
        let html = parseFn(file.content);
        // 为代码块添加 data-lang 属性，供 CSS ::before 显示语言标签
        html = html.replace(/<pre><code class="language-(\w+)">/g, '<pre data-lang="$1"><code>');
        html = html.replace(/<pre><code>/g, '<pre data-lang="code"><code>');
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
    // 恢复预览滚动位置
    if (file._scrollTop !== undefined || file._scrollLeft !== undefined) {
      const st = file._scrollTop || 0, sl = file._scrollLeft || 0;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (pw) {
            if (st) pw.scrollTop = st;
            if (sl) pw.scrollLeft = sl;
          }
        });
      });
    }
  }

  let _previewVersion = 0; // 版本号，丢弃过时的异步结果（自增到 1e6 回绕，永不溢出）

  // 增量更新预览（不闪烁），用于内容实时同步场景
  async function _refreshPreview(file, pIdx) {
    const pw = document.getElementById(`editorPreviewWrapper${pIdx}`);
    if (!pw) return;
    if (++_previewVersion > 1_000_000) _previewVersion = 1;
    const ver = _previewVersion;
    if (file.ext === 'md') {
      const body = pw.querySelector('.markdown-body');
      if (!body) { _renderPreview(file, pIdx); return; }
      try {
        const m = await import('marked');
        // 过时检查：快速连续输入时丢弃旧版本的异步结果
        if (ver !== _previewVersion) return;
        const parseFn = typeof m.marked === 'function' ? m.marked
                      : typeof m.parse === 'function' ? m.parse
                      : typeof m.default?.marked === 'function' ? m.default.marked
                      : typeof m.default?.parse === 'function' ? m.default.parse
                      : typeof m.default === 'function' ? m.default
                      : null;
        if (!parseFn) throw new Error('无法找到 marked 解析函数');
        let html = parseFn(file.content);
        if (ver !== _previewVersion) return;
        html = html.replace(/<pre><code class="language-(\w+)">/g, '<pre data-lang="$1"><code>');
        html = html.replace(/<pre><code>/g, '<pre data-lang="code"><code>');
        if (ver !== _previewVersion) return;
        body.innerHTML = html;
      } catch (_) { if (ver === _previewVersion) _renderPreview(file, pIdx); }
    } else if (file.ext === 'html') {
      const iframe = pw.querySelector('iframe');
      if (iframe) { iframe.srcdoc = file.content; }
      else { _renderPreview(file, pIdx); }
    }
  }

  function togglePreview(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    if (p.activeFileIndex < 0) return;
    const f = p.openFiles[p.activeFileIndex];
    if (f.ext !== 'md' && f.ext !== 'html') return;
    // 未保存文件不允许切换到预览
    if (!p.previewMode && f.modified) {
      _toast('请先保存文件再预览（Ctrl+S）', 'warning');
      return;
    }
    _saveCurrentContent(pi);
    p.previewMode = !p.previewMode;
    _renderContent(pi);
    _renderTabs(pi);
    _setupScrollSync();
  }

  async function _mk(parent, file, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    try {
      const { EditorView, basicSetup, keymap, syntaxHighlighting, HighlightStyle, tags } = await _loadCM6();

      const saveBinding = keymap.of([{ key: 'Mod-s', run: () => { saveFile(pi); return true; }, preventDefault: true }]);

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
          if (u.docChanged && _cmSettled && !_syncingCM) {
            const panel = panels[pi];
            if (panel.activeFileIndex >= 0 && panel.activeFileIndex < panel.openFiles.length) {
              const ff = panel.openFiles[panel.activeFileIndex];
              const cur = u.state.doc.toString();
              ff.content = cur;
              ff.modified = (cur !== (ff._saved ?? ''));
              _renderTabs(pi);
              // 若同一文件在另一面板也开着，推送内容到对侧 CM6 + 刷新对侧预览
              const otherP = panels[1 - pi];
              const otherHasFile = otherP.activeFileIndex >= 0 && otherP.openFiles[otherP.activeFileIndex] === ff;
              if (otherHasFile) {
                if (otherP.cmView) {
                  const otherCur = otherP.cmView.state.doc.toString();
                  if (cur !== otherCur) {
                    _syncingCM = true;
                    otherP.cmView.dispatch({
                      changes: { from: 0, to: otherP.cmView.state.doc.length, insert: cur }
                    });
                    _syncingCM = false;
                  }
                }
                // 对侧若是预览模式，增量刷新预览
                if (otherP.previewMode) _refreshPreview(ff, 1 - pi);
                _renderTabs(1 - pi);
              }
              // 本侧若是预览模式也增量刷新
              if (panel.previewMode) _refreshPreview(ff, pi);
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
      if (_getWordWrap()) ext.push(EditorView.lineWrapping);
      ext.push(_theme(EditorView));

      p.cmView = new EditorView({ doc: file.content, extensions: ext, parent });
      // 恢复滚动位置（双 rAF 确保 CM6 完成布局后再滚动）
      if (file._scrollTop !== undefined || file._scrollLeft !== undefined) {
        const st = file._scrollTop || 0, sl = file._scrollLeft || 0;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const v = p.cmView;
            if (v && v.scrollDOM) {
              if (st) v.scrollDOM.scrollTop = st;
              if (sl) v.scrollDOM.scrollLeft = sl;
            }
          });
        });
      }
      _bindCtx(parent, pi);
    } catch (e) {
      console.error('[Editor] CM6 失败:', e);
      _fallback(parent, file.content, pi);
    }
  }

  function _fallback(parent, content, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const wrapCls = _getWordWrap() ? ' wrap' : '';
    parent.innerHTML = `<div class="editor-body"><div class="editor-gutter" id="editorGutter${pi}"></div><textarea class="editor-textarea${wrapCls}" id="editorTextarea${pi}" spellcheck="false">${_esc(content)}</textarea></div>`;
    const ta = parent.querySelector('#editorTextarea' + pi), g = parent.querySelector('#editorGutter' + pi);
    if (!ta) return;
    const up = () => {
      const panel = panels[pi];
      if (panel.activeFileIndex >= 0) { const f = panel.openFiles[panel.activeFileIndex]; f.content = ta.value; f.modified = true; }
      if (g) { const n = ta.value.split('\n').length; let h = ''; for (let i = 1; i <= n; i++) h += `<div class="editor-gutter-line">${i}</div>`; g.innerHTML = h; g.scrollTop = ta.scrollTop; }
    };
    ta.addEventListener('input', up); ta.addEventListener('scroll', () => { if (g) g.scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); _toast('保存功能仅 CM6 模式支持', 'warning'); } });
    up();
  }

  function _theme(EditorView) { const d = document.documentElement.getAttribute('data-theme') === 'dark';
    return EditorView.theme({
      '&':{
        backgroundColor:d?'#1e1e2a':'#fafafc',
        color:d?'#d0d0d4':'#3a3650',
        fontSize:'0.96rem',
        fontWeight:d?'480':'400',
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
      '.cm-line':{fontWeight:d?'480':'400'},
      '.cm-gutterElement':{fontWeight:d?'400':'400'},
    },{dark:d});}

  function _bindCtx(parent, pIdx) {
    parent.addEventListener('contextmenu', e => { e.preventDefault(); _ctxMenu(e.clientX, e.clientY, pIdx); });
  }

  function _ctxMenu(x, y, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    const f = p.activeFileIndex >= 0 ? p.openFiles[p.activeFileIndex] : null;
    const canPreview = f && (f.ext === 'md' || f.ext === 'html');
    const wrapOn = _getWordWrap();

    const items = [];
    items.push({ label: '保存', action: () => saveFile(pi) });
    if (canPreview) items.push({ label: p.previewMode ? '返回编辑' : '预览', action: () => togglePreview(pi) });
    items.push({ sep: true });
    items.push({ label: wrapOn ? '自动换行 ✓' : '自动换行', action: () => toggleWordWrap(pi) });
    items.push({ label: '关闭文件', action: () => closeFile(p.activeFileIndex, pi) });

    App.showContextMenu(x, y, items);
  }

  // ── 分屏拖拽手柄 ──
  function _bindSplitHandle() {
    const handle = document.getElementById('editorSplitHandle');
    if (!handle || handle.dataset.bound) return;
    handle.dataset.bound = '1';
    handle.addEventListener('mousedown', e => {
      e.preventDefault(); handle.classList.add('dragging');
      const sx = e.clientX;
      const p0 = document.getElementById('editorPanel0');
      if (!p0) return;
      const sw = p0.offsetWidth;
      function mv(ev) {
        const w = Math.max(200, Math.min(sw + (ev.clientX - sx), window.innerWidth - 260));
        p0.style.flex = 'none'; p0.style.width = w + 'px';
      }
      function up() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        refresh();
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  function _getWordWrap() {
    return localStorage.getItem('lubia_editor_word_wrap') !== 'false'; // 默认开启
  }

  function toggleWordWrap(pIdx) {
    const current = _getWordWrap();
    localStorage.setItem('lubia_editor_word_wrap', current ? 'false' : 'true');
    _toast(current ? '已关闭自动换行' : '已开启自动换行', 'info');
    refreshUI(pIdx);
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function _toast(msg, type) { if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type); }

  // ── 公开 API ──
  return {
    mount, destroy,
    openFile, openFileInSide, openBinary, openFileInPanel,
    switchFile, closeFile, saveFile, togglePreview, toggleWordWrap,
    toggleSplit, focusPanel,
    refresh, refreshUI,
    getOpenFiles: () => panels[activePanel].openFiles,
    getAllOpenFiles: () => [...panels[0].openFiles, ...panels[1].openFiles],
    getActiveFile: () => {
      const p = panels[activePanel];
      return p.activeFileIndex >= 0 ? p.openFiles[p.activeFileIndex] : null;
    },
    getSplitActive: () => splitActive,
    getActivePanel: () => activePanel,
    saveAllFiles: async () => {
      for (let i = 0; i < 2; i++) await saveFile(i);
    },
  };
})();
