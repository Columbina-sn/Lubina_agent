/* ============================================================
   app.js v4 — 简化版主控制器
   修复：右键菜单 / 挂载流程 / 红点徽章
   ============================================================ */

const App = (() => {
  const state = {
    activePage: 'home', splitMode: null,
    fileExplorerOpen: true, theme: 'auto', unreadCount: 0,
  };
  let els = {};

  function init() {
    els.appShell = document.getElementById('appShell');
    els.fileExplorer = document.getElementById('fileExplorer');
    els.activityBar = document.getElementById('activityBar');
    els.mainArea = document.getElementById('mainArea');
    els.panelContainer = document.getElementById('panelContainer');
    els.contextMenu = document.getElementById('contextMenu');

    restoreTheme();
    bindActivityBar();
    bindShellHandles();
    bindGlobalEvents();
    setupContextMenu();
    setupAvatarDropdown();
    setupChatDelegation();
    showPage('home');
    restoreLoginState();
    FileExplorer.init(els.fileExplorer);
  }

  // ===== 主题 =====
  function restoreTheme() {
    const s = localStorage.getItem('lubina_theme') || 'auto';
    applyTheme(s);
  }
  function applyTheme(v) {
    state.theme = v;
    if (v === 'auto') document.documentElement.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
    else if (v === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('lubina_theme', v);
  }

  // ===== 页面 =====
  function showPage(id) {
    if (id === 'home') { state.unreadCount = 0; updateBadge(); }
    state.activePage = id;
    els.activityBar.querySelectorAll('.activity-btn').forEach(b => b.classList.toggle('active', b.dataset.page === id));
    if (state.splitMode) closeSplit();
    renderSingle(id);
  }

  function renderSingle(id) {
    unmountPage(state.activePage);
    state.splitMode = null;
    els.panelContainer.className = 'split-root single';
    els.panelContainer.innerHTML = `<div class="split-panel" data-page="${id}">${pageHTML(id)}</div>`;
    requestAnimationFrame(() => mountPage(id));
  }

  function unmountPage(id) {
    if (id === 'home' && typeof Chat !== 'undefined') Chat.destroy();
    if (id === 'editor' && typeof Editor !== 'undefined') Editor.destroy();
    if (id === 'settings' && typeof Settings !== 'undefined') Settings.destroy();
  }

  function mountPage(id) {
    // 使用 setTimeout 确保 innerHTML 的 DOM 已经完全就绪
    setTimeout(() => {
      if (id === 'home' && typeof Chat !== 'undefined') { Chat.mount(); bindChatSidebarHandle(); }
      if (id === 'editor' && typeof Editor !== 'undefined') Editor.mount();
      if (id === 'settings' && typeof Settings !== 'undefined') Settings.mount();
    }, 50);
  }

  // ===== 分屏 =====
  function splitPage(pageId, dir) {
    if (state.splitMode) closeSplit();
    unmountPage(state.activePage);
    state.splitMode = { direction: dir, pages: [state.activePage, pageId] };
    els.panelContainer.className = `split-root ${dir}`;
    els.panelContainer.innerHTML = '';
    [state.activePage, pageId].forEach((pid, i) => {
      const p = document.createElement('div'); p.className = 'split-panel'; p.style.flex = '1 1 0'; p.dataset.page = pid;
      p.innerHTML = pageHTML(pid); els.panelContainer.appendChild(p);
      if (i === 0) { const h = document.createElement('div'); h.className = 'split-handle'; h.addEventListener('mousedown', startResize); els.panelContainer.appendChild(h); }
    });
    requestAnimationFrame(() => { mountPage(state.activePage); });
  }

  function closeSplit() { state.splitMode = null; renderSingle(state.activePage); }

  // ===== 拖拽 =====
  function bindShellHandles() {
    const h = document.getElementById('shellHandleFE'), fe = document.getElementById('fileExplorer');
    if (!h || !fe) return;
    h.addEventListener('mousedown', e => {
      e.preventDefault(); h.classList.add('dragging');
      const sx = e.clientX, sw = fe.offsetWidth;
      function mv(ev) { const w = Math.max(140, Math.min(sw + (ev.clientX - sx), 500)); fe.style.width = w + 'px'; fe.style.minWidth = w + 'px'; }
      function up() { h.classList.remove('dragging'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); if (typeof Editor!=='undefined'&&Editor.refresh)Editor.refresh(); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  function bindChatSidebarHandle() {
    setTimeout(() => {
      const h = document.getElementById('chatSplitHandle'), sb = document.getElementById('chatSidebar');
      if (!h || !sb || h.dataset.bound) return; h.dataset.bound = '1';
      h.addEventListener('mousedown', e => {
        e.preventDefault(); h.classList.add('dragging');
        const sx = e.clientX, sw = sb.offsetWidth;
        function mv(ev) { const w = Math.max(140, Math.min(sw + (ev.clientX - sx), 400)); sb.style.width = w + 'px'; sb.style.minWidth = w + 'px'; }
        function up() { h.classList.remove('dragging'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      });
    }, 80);
  }

  function startResize(e) {
    e.preventDefault(); const h = e.target, ct = els.panelContainer;
    const isH = ct.classList.contains('horizontal');
    const ps = ct.querySelectorAll('.split-panel'); if (ps.length < 2) return;
    h.classList.add('dragging');
    const sp = isH ? e.clientX : e.clientY;
    const ss = Array.from(ps).map(p => isH ? p.offsetWidth : p.offsetHeight);
    const t = ss.reduce((a, b) => a + b, 0);
    function mv(ev) { const d = (isH ? ev.clientX : ev.clientY) - sp; const r = Math.max(0.12, Math.min(0.88, (ss[0] + d) / t)); ps[0].style.flex = `${r*100} 1 0`; ps[1].style.flex = `${(1-r)*100} 1 0`; }
    function up() { h.classList.remove('dragging'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  // ===== 活动栏事件 =====
  function bindActivityBar() {
    els.activityBar.addEventListener('click', e => {
      const btn = e.target.closest('.activity-btn'); if (!btn) return;
      showPage(btn.dataset.page);
    });
    els.activityBar.addEventListener('contextmenu', e => {
      const btn = e.target.closest('.activity-btn'); if (!btn) return;
      e.preventDefault(); e.stopPropagation(); // 阻止冒泡到 document
      showContextMenu(e.clientX, e.clientY, btn.dataset.page);
    });
  }

  // ===== 右键菜单（修复：e.stopPropagation 防止被 document 监听器立即关闭）=====
  function setupContextMenu() {
    // 点击菜单外部关闭
    document.addEventListener('click', e => {
      const m = els.contextMenu;
      if (!m.classList.contains('visible')) return;
      if (!m.contains(e.target)) m.classList.remove('visible');
    });
    // 按 ESC 关闭
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') els.contextMenu.classList.remove('visible');
    });
  }

  function showContextMenu(x, y, pageId) {
    const m = els.contextMenu;
    m.classList.remove('visible');
    m.innerHTML = `
      <div class="context-menu-item" data-a="open">在此处打开</div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-a="split-h">向右拆分</div>
      <div class="context-menu-item" data-a="split-v">向下拆分</div>`;
    m.querySelectorAll('.context-menu-item').forEach(item => {
      item.onclick = () => {
        const a = item.dataset.a;
        if (a === 'open') showPage(pageId);
        else if (a === 'split-h') splitPage(pageId, 'horizontal');
        else if (a === 'split-v') splitPage(pageId, 'vertical');
        m.classList.remove('visible');
      };
    });
    m.style.left = x + 'px'; m.style.top = y + 'px';
    m.offsetHeight; // 强制回流
    m.classList.add('visible');
  }

  // ===== 聊天区事件委托（一次绑定，永久有效）=====
  function setupChatDelegation() {
    els.panelContainer.addEventListener('click', (e) => {
      const t = e.target;

      // 发送按钮
      if (t.closest('#sendBtn')) {
        const inp = document.getElementById('chatInput');
        if (!inp) return;
        const v = inp.value.trim();
        if (v && typeof Chat !== 'undefined') { Chat.sendMessage(v); inp.value = ''; inp.style.height = 'auto'; }
        return;
      }
      // 停止按钮
      if (t.closest('#stopBtn')) {
        if (typeof Chat !== 'undefined') Chat.stopGenerating();
        return;
      }
      // 新对话按钮
      if (t.closest('#homeNewBtn')) {
        if (typeof Chat !== 'undefined') Chat.newConversation();
        return;
      }
    });

    // textarea 键盘事件
    els.panelContainer.addEventListener('keydown', (e) => {
      if (e.target.id === 'chatInput' && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = e.target.value.trim();
        if (v && typeof Chat !== 'undefined') { Chat.sendMessage(v); e.target.value = ''; e.target.style.height = 'auto'; }
      }
    });

    // textarea 自适应高度
    els.panelContainer.addEventListener('input', (e) => {
      if (e.target.id === 'chatInput') {
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
      }
    });
  }

  // ===== 红点 =====
  function addUnread(n) {
    if (state.activePage !== 'home') { state.unreadCount += n; updateBadge(); }
  }
  function updateBadge() {
    const homeBtn = els.activityBar.querySelector('[data-page="home"]'); if (!homeBtn) return;
    let badge = homeBtn.querySelector('.activity-badge');
    if (state.unreadCount > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'activity-badge'; homeBtn.appendChild(badge); }
      badge.textContent = state.unreadCount > 99 ? '99+' : state.unreadCount;
    } else { if (badge) badge.remove(); }
  }

  // ===== 全局 =====
  function bindGlobalEvents() {
    window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => { if (state.theme === 'auto') applyTheme('auto'); });
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey||e.metaKey) && e.key === 'b') { e.preventDefault(); toggleFileExplorer(); }
      if ((e.ctrlKey||e.metaKey) && e.key === 'k') { e.preventDefault(); const inp = document.getElementById('chatInput'); if (inp) inp.focus(); }
      if ((e.ctrlKey||e.metaKey) && e.key === 'n') { e.preventDefault(); if (typeof Chat!=='undefined'&&Chat.newConversation) Chat.newConversation(); }
      if ((e.ctrlKey||e.metaKey) && e.key === 'w') { e.preventDefault(); if (state.splitMode) closeSplit(); }
    });
    window.addEventListener('resize', () => { if (typeof Editor!=='undefined'&&Editor.refresh) Editor.refresh(); });
  }

  function toggleFileExplorer() {
    state.fileExplorerOpen = !state.fileExplorerOpen;
    els.fileExplorer.classList.toggle('collapsed', !state.fileExplorerOpen);
    const h = document.getElementById('shellHandleFE'); if (h) h.classList.toggle('hidden', !state.fileExplorerOpen);
  }

  // ===== 页面 HTML =====
  function pageHTML(id) {
    switch (id) {
      case 'home': return `
        <div class="page-container page-row" id="homePage">
          <div class="chat-sidebar" id="chatSidebar">
            <div class="chat-sidebar-header"><span class="chat-sidebar-title">对话</span><button class="chat-new-btn" id="homeNewBtn" title="新对话" onclick="Chat.newConversation()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button></div>
            <div class="conv-list" id="conversationList"></div>
          </div>
          <div class="split-handle" id="chatSplitHandle" style="cursor:col-resize;"></div>
          <div class="chat-main">
            <div class="message-container" id="messageContainer"></div>
            <div class="chat-input-area"><div class="chat-input-wrapper"><textarea class="chat-input" id="chatInput" placeholder="输入消息… (Enter 发送，Shift+Enter 换行)" rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();var v=this.value.trim();if(v){Chat.sendMessage(v);this.value='';this.style.height='auto';}}" oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,140)+'px'"></textarea>
            <button class="btn-send" id="sendBtn" onclick="var i=document.getElementById('chatInput');var v=i.value.trim();if(v){Chat.sendMessage(v);i.value='';i.style.height='auto';}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
            <button class="btn-stop hidden" id="stopBtn" onclick="Chat.stopGenerating()">停止</button></div><p class="chat-input-hint">Lubina · 数据仅存储在你本地</p></div>
          </div></div>`;
      case 'editor': return `
        <div class="page-container" id="editorPage">
          <div class="editor-tabs" id="editorTabs"></div>
          <div class="editor-container"><div class="editor-body" id="editorBody"><div class="editor-gutter" id="editorGutter"></div><textarea class="editor-textarea" id="editorTextarea" spellcheck="false" placeholder="从左侧文件树打开文件…"></textarea></div>
          <div class="editor-binary-notice hidden" id="editorBinaryNotice"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg><h3>不支持打开此类二进制文件</h3><p id="editorBinaryExt"></p></div>
          <div class="editor-empty-state" id="editorEmptyState"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg><h3>编辑器</h3><p>从左侧文件树打开一个文件<br>或拖拽文件到此处</p></div></div></div>`;
      case 'exercises': return `<div class="page-container"><div class="placeholder-page"><h2>错题本</h2><p>拍照/截图/粘贴题目 → AI 解答 → 自动归类 → 定期复习</p><span class="placeholder-badge">P1 阶段开发</span></div></div>`;
      case 'knowledge': return `<div class="page-container"><div class="placeholder-page"><h2>知识库</h2><p>导入课件、笔记、论文，AI 基于你的资料回答问题</p><span class="placeholder-badge">P1 阶段开发</span></div></div>`;
      case 'settings': return `
        <div class="page-container" id="settingsPage"><div class="settings-container">
          <h1 class="settings-title">设置</h1><p class="settings-subtitle">配置你的 AI 模型和偏好</p>
          <section class="settings-section"><h3>API Key</h3><p class="section-desc">填入你的 API Key，数据只存在本地</p>
            <div class="form-group"><label>DeepSeek API Key</label><div class="input-row"><input type="password" class="input" id="settingDeepseekKey" placeholder="sk-..." autocomplete="off"><button class="btn btn-ghost btn-sm" onclick="Settings.toggleVisible('settingDeepseekKey')">显示</button></div></div>
            <div class="form-group"><label>OpenAI API Key</label><div class="input-row"><input type="password" class="input" id="settingOpenaiKey" placeholder="sk-..." autocomplete="off"><button class="btn btn-ghost btn-sm" onclick="Settings.toggleVisible('settingOpenaiKey')">显示</button></div></div>
            <div class="form-group"><label>Anthropic (Claude) API Key</label><div class="input-row"><input type="password" class="input" id="settingClaudeKey" placeholder="sk-ant-..." autocomplete="off"><button class="btn btn-ghost btn-sm" onclick="Settings.toggleVisible('settingClaudeKey')">显示</button></div></div>
          </section>
          <section class="settings-section"><h3>默认模型</h3><div class="form-group"><label>模型</label><select class="input" id="settingDefaultModel"><option value="deepseek-chat">DeepSeek V4 Flash（推荐 · 极速响应）</option><option value="deepseek-reasoner">DeepSeek V4 Pro（深度推理）</option><option value="gpt-4o">GPT-4o</option><option value="gpt-4o-mini">GPT-4o Mini</option><option value="claude-sonnet-5">Claude Sonnet 5</option><option value="claude-opus-4-8">Claude Opus 4.8</option></select></div></section>
          <section class="settings-section"><h3>外观</h3><div class="form-group"><label>主题</label><select class="input" id="settingTheme" onchange="App.applyTheme(this.value)"><option value="light">浅色模式</option><option value="dark">深色模式 · 深空月夜</option><option value="auto">跟随系统</option></select></div></section>
          <section class="settings-section"><h3>对话</h3><div class="form-group"><label>最大对话轮数</label><input type="number" class="input" id="settingMaxTurns" value="15" min="5" max="50" style="width:120px;"><span class="form-hint">超过后自动摘要压缩上下文</span></div></section>
          <div class="form-actions"><button class="btn btn-primary btn-lg" onclick="Settings.save()">保存设置</button><button class="btn btn-ghost" onclick="App.showPage('home')">取消</button></div>
        </div></div>`;
      default: return `<div class="page-container"><div class="placeholder-page"><h2>${id}</h2></div></div>`;
    }
  }

  // ===== 顶部导航栏：头像下拉 =====
  function setupAvatarDropdown() {
    document.addEventListener('click', e => {
      const dd = document.getElementById('avatarDropdown');
      const btn = document.getElementById('navbarAvatarBtn');
      if (!dd || !dd.classList.contains('visible')) return;
      if (!dd.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        dd.classList.remove('visible');
      }
    });
  }

  function toggleAvatarDropdown() {
    const dd = document.getElementById('avatarDropdown');
    if (!dd) return;
    dd.classList.toggle('visible');
  }

  // ===== 登录 / 注册 =====
  function showLoginModal() {
    const dd = document.getElementById('avatarDropdown');
    if (dd) dd.classList.remove('visible');
    const overlay = document.getElementById('loginModalOverlay');
    if (overlay) overlay.classList.remove('hidden');
  }

  function closeLoginModal() {
    const overlay = document.getElementById('loginModalOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  let loginMode = 'login'; // 'login' | 'register'
  function switchLoginMode() {
    loginMode = loginMode === 'login' ? 'register' : 'login';
    const title = document.getElementById('loginModalTitle');
    const desc = document.getElementById('loginModalDesc');
    const submit = document.getElementById('loginSubmitBtn');
    const switchBtn = document.getElementById('loginSwitchBtn');
    if (loginMode === 'register') {
      if (title) title.textContent = '注册';
      if (desc) desc.textContent = '创建账号以在多设备间同步设置';
      if (submit) submit.textContent = '注册';
      if (switchBtn) switchBtn.textContent = '已有账号？登录';
    } else {
      if (title) title.textContent = '登录';
      if (desc) desc.textContent = '登录后可在多设备间同步设置和 API Key';
      if (submit) submit.textContent = '登录';
      if (switchBtn) switchBtn.textContent = '还没有账号？注册';
    }
  }

  function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail')?.value?.trim();
    const password = document.getElementById('loginPassword')?.value?.trim();
    if (!email || !password) return;

    // 占位：后续接入真实认证
    const user = { email, name: email.split('@')[0] };
    localStorage.setItem('lubina_user', JSON.stringify(user));
    updateAvatarUI(user);
    closeLoginModal();
    showToast('已登录（本地模拟）', 'info');
  }

  function logout() {
    const dd = document.getElementById('avatarDropdown');
    if (dd) dd.classList.remove('visible');
    localStorage.removeItem('lubina_user');
    updateAvatarUI(null);
    showToast('已退出登录', 'info');
  }

  function restoreLoginState() {
    try {
      const raw = localStorage.getItem('lubina_user');
      if (raw) updateAvatarUI(JSON.parse(raw));
      else updateAvatarUI(null);
    } catch (_) { updateAvatarUI(null); }
  }

  function updateAvatarUI(user) {
    const icon = document.getElementById('navbarAvatarIcon');
    const label = document.getElementById('navbarAvatarLabel');
    const guest = document.getElementById('dropdownGuest');
    const logged = document.getElementById('dropdownLoggedIn');
    if (user) {
      if (icon) icon.textContent = (user.name || 'U')[0].toUpperCase();
      if (label) label.textContent = user.name || user.email;
      if (guest) guest.classList.add('hidden');
      if (logged) logged.classList.remove('hidden');
      const userName = document.getElementById('dropdownUserName');
      const userEmail = document.getElementById('dropdownUserEmail');
      const userIcon = document.getElementById('dropdownUserIcon');
      if (userName) userName.textContent = user.name || user.email;
      if (userEmail) userEmail.textContent = user.email;
      if (userIcon) userIcon.textContent = (user.name || 'U')[0].toUpperCase();
    } else {
      if (icon) icon.textContent = '';
      if (label) label.textContent = '未登录';
      if (guest) guest.classList.remove('hidden');
      if (logged) logged.classList.add('hidden');
    }
  }

  function showToast(msg, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type || 'info'}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 2500);
  }

  return {
    init, showPage, splitPage, closeSplit, toggleFileExplorer, applyTheme,
    addUnread, updateBadge, getState: () => state,
    toggleAvatarDropdown, showLoginModal, closeLoginModal, switchLoginMode, handleLogin, logout,
    showToast, updateAvatarUI
  };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
