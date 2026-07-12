/* ============================================================
   knowledge.js — 知识库 v1

   双视图：显式知识（AI 可读）/ 隐藏知识（仅存储）
   上传文本文件 · 条目卡片列表 · 详情编辑 · AI 工作时锁定
   ============================================================ */

const Knowledge = (() => {
  let _view = 'visible';     // 'visible' | 'hidden'
  let _items = [];
  let _selectedId = null;   // 当前展开详情的条目 id
  let _delegatedBound = false;  // 防止每次 _render 重复绑定事件

  // ================================================================
  // mount / destroy
  // ================================================================

  async function mount() {
    _view = 'visible';
    _selectedId = null;
    await _loadItems();
    _render();
  }

  function destroy() {
    _items = [];
    _selectedId = null;
    _delegatedBound = false;
    _deleting = false;
  }

  // ================================================================
  // 数据加载
  // ================================================================

  async function _loadItems() {
    try {
      const visible = _view === 'visible' ? 1 : 0;
      _items = await knowledgeAPI.listItems(visible);
    } catch (e) {
      console.error('[Knowledge] 加载失败:', e);
      _items = [];
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('加载知识库失败: ' + (e.message || '网络错误'), 'error');
      }
    }
  }

  // ================================================================
  // 操作（含 AI 工作锁定检查）
  // ================================================================

  function _checkLocked() {
    if (typeof Chat !== 'undefined' && Chat.isGenerating) {
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('Lubina 工作时可能频繁读写知识库，不要随意操作哦', 'warning');
      }
      return true;
    }
    return false;
  }

  async function _upload() {
    if (_checkLocked()) return;

    // 创建隐藏的 file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,.py,.js,.ts,.html,.css,.json,.yaml,.yml,.xml,.csv,.log,.sh,.bat,.ini,.cfg,.conf,.toml,.rst,.tex';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        await knowledgeAPI.upload(file);
        await _loadItems();
        _render();
        if (typeof App !== 'undefined' && App.showToast) {
          App.showToast('已导入: ' + file.name, 'success');
        }
      } catch (e) {
        if (typeof App !== 'undefined' && App.showToast) {
          App.showToast('上传失败: ' + (e.message || '网络错误'), 'error');
        }
      }
    };
    input.click();
  }

  async function _toggleVisibility(id) {
    if (_checkLocked()) return;
    try {
      await knowledgeAPI.toggleItem(id);
      await _loadItems();
      _selectedId = null;
      _render();
    } catch (e) {
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('操作失败: ' + (e.message || ''), 'error');
      }
    }
  }

  let _deleting = false;  // 防止重复弹删除确认窗

  async function _deleteItem(id) {
    if (_checkLocked()) return;
    if (_deleting) return;  // 已有确认窗在显示中
    const item = _items.find(i => i.id === id);
    if (!item) return;

    _deleting = true;

    // 自定义确认弹窗（用 class 而非 id 避免重复 DOM 时冲突）
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay k-del-overlay';
    overlay.innerHTML = `
      <div class="modal-dialog" style="max-width:380px;">
        <h3>删除知识条目</h3>
        <p>确定要删除「${_esc(item.title || '未命名')}」吗？此操作不可撤销。</p>
        <div class="modal-actions">
          <button class="btn btn-ghost k-del-cancel">取消</button>
          <button class="btn btn-accent k-del-confirm">确认删除</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = () => { overlay.remove(); _deleting = false; };

    overlay.querySelector('.k-del-cancel').onclick = cleanup;
    overlay.querySelector('.k-del-confirm').onclick = async () => {
      overlay.remove();
      _deleting = false;
      try {
        await knowledgeAPI.deleteItem(id);
        await _loadItems();
        _selectedId = null;
        _render();
        if (typeof App !== 'undefined' && App.showToast) {
          App.showToast('已删除', 'success');
        }
      } catch (e) {
        if (typeof App !== 'undefined' && App.showToast) {
          App.showToast('删除失败: ' + (e.message || ''), 'error');
        }
      }
    };
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', esc); }
    });
  }

  async function _saveEdit(id) {
    if (_checkLocked()) return;
    const titleEl = document.getElementById(`kTitle_${id}`);
    const contentEl = document.getElementById(`kContent_${id}`);
    if (!titleEl || !contentEl) return;
    try {
      await knowledgeAPI.updateItem(id, {
        title: titleEl.value.trim(),
        content: contentEl.value,
      });
      await _loadItems();
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('已保存', 'success');
      }
    } catch (e) {
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('保存失败: ' + (e.message || ''), 'error');
      }
    }
  }

  // ================================================================
  // 渲染
  // ================================================================

  function _render() {
    const el = document.getElementById('knowledgePage');
    if (!el) return;
    el.innerHTML = `
      ${_renderToolbar()}
      ${_renderHeader()}
      ${_renderList()}
      ${_renderDetail()}`;
    _bindEvents();
  }

  function _renderToolbar() {
    return `
      <div class="knowledge-toolbar">
        <button class="btn btn-primary btn-sm" id="kUploadBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
          导入文本
        </button>
        <div class="knowledge-tabs">
          <button class="knowledge-tab ${_view === 'visible' ? 'active' : ''}" data-view="visible">显式知识</button>
          <button class="knowledge-tab ${_view === 'hidden' ? 'active' : ''}" data-view="hidden">隐藏知识</button>
        </div>
      </div>`;
  }

  function _renderHeader() {
    const label = _view === 'visible' ? '显式知识 · AI 可以检索和引用' : '隐藏知识 · 仅存储，AI 不会看到';
    return `<div class="knowledge-view-hint">${label} &middot; ${_items.length} 条</div>`;
  }

  function _renderList() {
    if (_items.length === 0) {
      return `<div class="knowledge-empty">
        <p>${_view === 'visible' ? '还没有显式知识条目' : '没有隐藏条目'}</p>
        <span style="font-size:0.78rem;color:var(--text-tip);">上传文本文件或从显式知识中移入条目</span>
      </div>`;
    }

    const cards = _items.map(item => _renderCard(item)).join('');
    return `<div class="knowledge-list">${cards}</div>`;
  }

  function _renderCard(item) {
    const preview = (item.content || '').replace(/\n/g, ' ').slice(0, 120);
    const dateStr = (item.updated_at || item.created_at || '').slice(0, 10);
    const isExpanded = _selectedId === item.id;

    return `
      <div class="knowledge-card ${isExpanded ? 'expanded' : ''}" id="kCard_${item.id}">
        <div class="knowledge-card-main" data-kid="${item.id}">
          <div class="knowledge-card-info">
            <div class="knowledge-card-title">${_esc(item.title || '未命名')}</div>
            <div class="knowledge-card-meta">
              ${item.source_file ? `<span class="knowledge-card-source">${_esc(item.source_file)}</span>` : ''}
              <span class="knowledge-card-date">${dateStr}</span>
            </div>
            <div class="knowledge-card-preview">${_esc(preview) || '(空内容)'}</div>
          </div>
          <div class="knowledge-card-actions">
            <button class="btn btn-ghost btn-sm" data-action="toggle" data-kid="${item.id}" title="${_view === 'visible' ? '移入隐藏' : '移入显式'}">
              ${_view === 'visible' ? '隐藏' : '显示'}
            </button>
            <button class="btn btn-ghost btn-sm" data-action="delete" data-kid="${item.id}" title="删除" style="color:var(--accent);">删除</button>
          </div>
        </div>
        ${isExpanded ? _renderDetailPanel(item) : ''}
      </div>`;
  }

  function _renderDetailPanel(item) {
    return `
      <div class="knowledge-detail">
        <div class="form-group">
          <label>标题</label>
          <input class="input" id="kTitle_${item.id}" value="${_escAttr(item.title || '')}" placeholder="输入标题…">
        </div>
        <div class="form-group">
          <label>内容</label>
          <textarea class="input knowledge-detail-textarea" id="kContent_${item.id}" rows="10" placeholder="输入内容…">${_esc(item.content || '')}</textarea>
        </div>
        ${item.source_file ? `<div class="form-group"><label>来源文件</label><p style="font-size:0.8rem;color:var(--text-tip);margin:0;">${_esc(item.source_file)}</p></div>` : ''}
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" data-action="save" data-kid="${item.id}">保存</button>
        </div>
      </div>`;
  }

  function _renderDetail() {
    // 详情在卡片内渲染，此处为空
    return '';
  }

  // ================================================================
  // 事件绑定
  // ================================================================

  function _bindEvents() {
    const el = document.getElementById('knowledgePage');
    if (!el) return;

    // === 仅绑定一次：操作按钮的事件委托（隐藏/显示、删除、保存）===
    if (!_delegatedBound) {
      _delegatedBound = true;
      el.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        e.stopPropagation();  // 阻止冒泡，防止重复触发
        const action = btn.dataset.action;
        const kid = btn.dataset.kid;

        if (action === 'toggle') _toggleVisibility(kid);
        if (action === 'delete') _deleteItem(kid);
        if (action === 'save') _saveEdit(kid);
      });
    }

    // === 每次 render 重新绑定：DOM 元素引用 ===
    // 上传按钮
    el.querySelector('#kUploadBtn')?.addEventListener('click', _upload);

    // 视图切换标签
    el.querySelectorAll('.knowledge-tab').forEach(btn => {
      btn.addEventListener('click', async () => {
        const v = btn.dataset.view;
        if (v === _view) return;
        _view = v;
        _selectedId = null;
        await _loadItems();
        _render();
      });
    });

    // 卡片点击（展开/收起详情）
    el.querySelectorAll('.knowledge-card-main').forEach(row => {
      row.addEventListener('click', (e) => {
        // 如果点击的是按钮，不触发详情展开
        if (e.target.closest('button')) return;
        const kid = row.dataset.kid;
        _selectedId = (_selectedId === kid) ? null : kid;
        _render();
      });
    });
  }

  // ================================================================
  // 辅助
  // ================================================================

  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function _escAttr(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ================================================================
  // 公开 API
  // ================================================================

  return { mount, destroy };
})();
