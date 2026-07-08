/* ============================================================
   chat.js v4 — 基于 chat-design.html 设计稿落地
   紧凑 · 连续AI消息不重复头像 · 长间隔 · 删除确认模态框
   ============================================================ */

const Chat = (() => {
  let conversations = [];
  let activeConversationId = null;
  let isGenerating = false;
  let demoRunning = false;
  let lastRole = null; // 用于判断是否连续 AI 消息

  function mount() {
    _loadFromStorage();
    if (conversations.length === 0) _createConversation('新对话');
    _renderConversationList();
    _switchConversation(activeConversationId || conversations[0]?.id);
  }

  function destroy() { _saveToStorage(); demoRunning = false; lastRole = null; }

  // ===== 对话 CRUD =====
  function _createConversation(title = '新对话') {
    const conv = { id: `c_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, title, messages: [], model: localStorage.getItem('lubina_model')||'deepseek-chat', createdAt: new Date().toISOString() };
    conversations.unshift(conv); _saveToStorage(); return conv;
  }

  function deleteConversation(id) {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    const name = conv.title || '此对话';
    _showConfirmModal(`确定要删除「${name}」吗？`, '删除后无法恢复。', () => {
      conversations = conversations.filter(c => c.id !== id);
      if (activeConversationId === id) activeConversationId = conversations[0]?.id || null;
      _saveToStorage(); _renderConversationList();
      if (activeConversationId) _switchConversation(activeConversationId);
      else { const nc = _createConversation('新对话'); _renderConversationList(); _switchConversation(nc.id); }
    });
  }

  function _showConfirmModal(title, desc, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-dialog"><h3>${title}</h3><p>${desc}</p><div class="modal-actions"><button class="btn btn-ghost" id="modalCancel">取消</button><button class="btn btn-accent" id="modalConfirm">确认删除</button></div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#modalCancel').onclick = () => overlay.remove();
    overlay.querySelector('#modalConfirm').onclick = () => { overlay.remove(); onConfirm(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); } });
  }

  function _getActiveConversation() { return conversations.find(c => c.id === activeConversationId) || null; }
  function _switchConversation(id) {
    activeConversationId = id; lastRole = null;
    const conv = _getActiveConversation();
    if (!conv) return;
    _renderMessages(conv.messages); _renderConversationList(); _scrollToBottom();
  }

  // ===== 发送消息（演示 Agent 流程）=====
  async function sendMessage(content) {
    if (isGenerating || !content?.trim()) return;
    const conv = _getActiveConversation();
    if (!conv) return;

    conv.messages.push({ role:'user', type:'user', content:content.trim(), timestamp:Date.now() });
    if (conv.messages.filter(m=>m.role==='user').length === 1) {
      conv.title = content.trim().slice(0,20) + (content.trim().length>20?'…':'');
    }
    _renderMessages(conv.messages); _renderConversationList(); _scrollToBottom();
    isGenerating = true; demoRunning = true; _updateInputState(true);
    const taskName = content.trim().slice(0,15);

    const steps = [
      { delay:3500, type:'info',    content:`了解了，我来处理这个任务：**${taskName}**。让我先读取相关文件…`, action:'正在分析任务' },
      { delay:4000, type:'action',  content:`正在读取文件 \`src/config.json\`、\`src/utils.py\` …`, action:'正在读取文件' },
      { delay:4000, type:'options', content:`分析完成。关于 **${taskName}**，我找到了以下几种处理方案：`,
        options:[
          { label:'方案 A：自动优化（推荐）', value:'方案A：自动优化' },
          { label:'方案 B：手动逐步修改', value:'方案B：手动逐步修改' },
          { label:'方案 C：仅生成修改建议', value:'方案C：仅生成修改建议' },
        ]},
    ];

    for (const s of steps) { if (!demoRunning) break; await _sleep(s.delay); if (!demoRunning) break;
      conv.messages.push({ role:'assistant', type:s.type, content:s.content, timestamp:Date.now(), action:s.action, options:s.options });
      _renderMessages(conv.messages); _scrollToBottom(); _notifyIfAway(); }
  }

  function selectOption(value) {
    if (!demoRunning) return; const conv = _getActiveConversation(); if (!conv) return;
    conv.messages.push({ role:'user', type:'user', content:`选择：${value}`, timestamp:Date.now() });
    _runDemoSteps([
      { delay:3500, type:'warning', content:`你选择了 **${value}**。我将修改文件 \`src/utils.py\` 来实现这个方案，是否确认？` },
    ], () => {
      _runDemoSteps([
        { delay:4000, type:'action', content:'正在修改文件 `src/utils.py` … 在第 42 行插入新函数 …', action:'正在编辑文件' },
        { delay:4000, type:'success', content:'文件 `src/utils.py` 已成功修改（+15 行，-3 行）。' },
        { delay:3500, type:'action', content:'正在执行验证命令 `python -m pytest tests/` …', action:'正在执行命令' },
        { delay:4500, type:'success', content:'命令执行完成。全部 12 个测试通过，无报错。\n\n---\n**任务已完成。** 你可以打开 `src/utils.py` 查看修改内容。' },
        { delay:3000, type:'info', content:'还有其他需要帮助的吗？' },
      ], () => { isGenerating=false; demoRunning=false; _updateInputState(false); _saveToStorage(); });
    });
  }

  function confirmAction(allow) {
    if (!demoRunning) return; const conv = _getActiveConversation(); if (!conv) return;
    conv.messages.push({ role:'user', type:'user', content:allow?'确认执行':'取消操作', timestamp:Date.now() });
    if (!allow) {
      conv.messages.push({ role:'assistant', type:'error', content:'操作已取消。', timestamp:Date.now() });
      _renderMessages(conv.messages); isGenerating=false; demoRunning=false; _updateInputState(false); _saveToStorage(); return;
    }
    _runDemoSteps([
      { delay:4000, type:'action', content:'正在修改文件 `src/utils.py` … 在第 42 行插入新函数 …', action:'正在编辑文件' },
      { delay:4000, type:'success', content:'文件 `src/utils.py` 已成功修改（+15 行，-3 行）。' },
      { delay:3500, type:'action', content:'正在执行验证命令 `python -m pytest tests/` …', action:'正在执行命令' },
      { delay:4500, type:'success', content:'命令执行完成。全部 12 个测试通过。\n\n---\n**任务已完成。**' },
      { delay:3000, type:'info', content:'还有其他需要帮助的吗？' },
    ], () => { isGenerating=false; demoRunning=false; _updateInputState(false); _saveToStorage(); });
  }

  async function _runDemoSteps(steps, done) {
    const conv = _getActiveConversation(); if (!conv) { done(); return; }
    for (const s of steps) { if (!demoRunning) break; await _sleep(s.delay); if (!demoRunning) break;
      conv.messages.push({ role:'assistant', type:s.type, content:s.content, timestamp:Date.now(), action:s.action, options:s.options });
      _renderMessages(conv.messages); _scrollToBottom(); _notifyIfAway(); }
    done();
  }

  function stopGenerating() {
    demoRunning=false; isGenerating=false;
    const conv=_getActiveConversation(); if(conv){const l=conv.messages[conv.messages.length-1];if(l?.streaming){l.streaming=false;if(!l.content)l.content='（已停止）';}}
    _updateInputState(false); _saveToStorage();
  }

  function _notifyIfAway() {
    if (typeof App !== 'undefined' && App.getState().activePage !== 'home') App.addUnread(1);
  }

  // ===== 渲染消息（连续AI不重复头像）=====
  function _renderMessages(messages) {
    const container = document.getElementById('messageContainer');
    if (!container) return;
    container.innerHTML = '';
    if (messages.length === 0) { container.innerHTML = _welcomeHTML(); lastRole = null; return; }

    let prevRole = null;
    messages.forEach((msg, index) => {
      const isUser = msg.role === 'user';
      const row = document.createElement('div');
      row.className = `message-row ${isUser ? 'user' : 'assistant'}`;
      row.setAttribute('data-index', index);

      const showAvatar = isUser || (prevRole !== 'assistant'); // 只在用户消息或 AI 消息组第一条显示头像
      const avatarCls = showAvatar ? (isUser ? 'user' : 'ai') : 'ghost';
      const avatarLabel = isUser ? '你' : 'AI';

      if (isUser) {
        row.innerHTML = `<div class="msg-avatar ${avatarCls}">${avatarLabel}</div><div class="msg-bubble user-bubble">${_esc(msg.content)}</div>`;
      } else {
        row.innerHTML = `<div class="msg-avatar ${avatarCls}">${avatarLabel}</div><div class="msg-body">${_renderAIBubble(msg)}</div>`;
      }
      container.appendChild(row);
      prevRole = msg.role;
    });
    lastRole = messages[messages.length - 1]?.role || null;
    _scrollToBottom();
  }

  function _renderAIBubble(msg) {
    const type = msg.type || 'info';
    const typeLabels = {
      info:{label:'',cls:'ai-info'},
      action:{label:msg.action||'正在执行操作…',cls:'ai-action'},
      warning:{label:'需要你的确认',cls:'ai-warning'},
      success:{label:'操作完成',cls:'ai-success'},
      error:{label:'操作失败',cls:'ai-error'},
      options:{label:'请选择一个选项',cls:'ai-option'},
    };
    const tl = typeLabels[type]||typeLabels.info;
    let extra = '';
    if (tl.label) extra += `<div class="action-label">${tl.label}</div>`;

    // Markdown 内容
    let mdContent = msg.content || '';
    if (typeof marked !== 'undefined') {
      mdContent = marked.parse(msg.content||'')||'';
    }

    if (type==='warning') extra += `<div class="confirm-actions"><button class="confirm-btn confirm-btn-allow" onclick="Chat.confirmAction(true)">确认执行</button><button class="confirm-btn confirm-btn-deny" onclick="Chat.confirmAction(false)">取消</button></div>`;
    if (type==='options' && msg.options) {
      const btns = msg.options.map(o => `<button class="option-btn" onclick="Chat.selectOption('${_escAttr(o.value)}')">${_esc(o.label)}</button>`).join('');
      extra += `<div class="option-buttons">${btns}</div>`;
    }

    return `<div class="msg-bubble ai-bubble ${tl.cls}">${extra}<div class="markdown-body">${mdContent}</div></div>`;
  }

  function _renderConversationList() {
    const list = document.getElementById('conversationList');
    if (!list) return;
    list.innerHTML = conversations.map(conv => `
      <div class="conv-item ${conv.id===activeConversationId?'active':''}" onclick="Chat.switchTo('${conv.id}')">
        <svg class="conv-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span class="conv-item-title">${_esc(conv.title)}</span>
        <button class="conv-item-delete" onclick="event.stopPropagation();Chat.deleteConversation('${conv.id}')" title="删除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    `).join('');
  }

  function _welcomeHTML() {
    return `<div class="welcome-screen">
      <img class="welcome-logo" src="static/Lubina.svg" alt="Lubina" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" style="width:64px;height:64px;border-radius:18px;object-fit:contain;background:var(--primary-gradient);padding:10px;box-shadow:0 6px 24px var(--primary-glow);animation:floatLogo 3s ease-in-out infinite;">
      <div class="welcome-logo" style="display:none;">AI</div>
      <h2>Lubina</h2>
      <p>你的桌面学习伙伴 — 写论文 · 整笔记 · 做PPT · 查错题</p>
      <div class="welcome-hints">
        <div class="hint-chip" onclick="document.getElementById('chatInput').value='帮我写一篇关于人工智能的课程论文大纲';document.getElementById('chatInput').focus()">写论文大纲</div>
        <div class="hint-chip" onclick="document.getElementById('chatInput').value='解释一下什么是快速排序，并给出Python实现';document.getElementById('chatInput').focus()">解释算法</div>
        <div class="hint-chip" onclick="document.getElementById('chatInput').value='测试';document.getElementById('chatInput').focus()">测试 Agent 演示</div>
        <div class="hint-chip" onclick="document.getElementById('chatInput').value='帮我总结一下这篇文章的要点';document.getElementById('chatInput').focus()">总结文档</div>
      </div></div>`;
  }

  function _updateInputState(disabled) {
    const sb = document.getElementById('sendBtn');
    const tb = document.getElementById('stopBtn');
    const inp = document.getElementById('chatInput');
    if (sb) { sb.classList.toggle('hidden', disabled); sb.disabled = disabled; }
    if (tb) { tb.classList.toggle('hidden', !disabled); tb.disabled = !disabled; }
    if (inp) inp.disabled = disabled;
  }

  // ===== 辅助 =====
  function _sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
  function _scrollToBottom() { requestAnimationFrame(()=>{const c=document.getElementById('messageContainer');if(c)c.scrollTop=c.scrollHeight;}); }
  function _esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
  function _escAttr(s) { return s.replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  function _loadFromStorage() {
    try { const d=localStorage.getItem('lubina_conversations'); if(d){conversations=JSON.parse(d);conversations.forEach(c=>c.messages.forEach(m=>m.streaming=false));if(conversations.length>0)activeConversationId=conversations[0].id;} } catch(_){conversations=[];}
  }
  function _saveToStorage() {
    try {
      const cleaned = conversations.map(function(c) {
        return { id: c.id, title: c.title, model: c.model, createdAt: c.createdAt,
          messages: c.messages.map(function(m) {
            return { role: m.role, type: m.type, content: m.content, timestamp: m.timestamp, action: m.action, options: m.options, streaming: false };
          })
        };
      });
      localStorage.setItem('lubina_conversations', JSON.stringify(cleaned));
    } catch(_) {}
  }

  return {
    mount, destroy,
    sendMessage, stopGenerating, confirmAction, selectOption,
    switchTo: _switchConversation,
    deleteConversation,
    newConversation: () => {
      const conv = _createConversation('新对话'); _renderConversationList(); _switchConversation(conv.id);
      const inp = document.getElementById('chatInput'); if (inp) inp.focus();
    },
  };
})();
