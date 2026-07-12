/* ============================================================
   knowledge.js v2 — 知识库（结构化信息条目 + AI 提取）

   新版使用 knowledge_infos 表（category / content / keywords）
   上传时调 AI 提取结构化信息，两层去重后存储
   双视图：显式知识 / 隐藏知识
   AI 工作时锁定所有操作
   ============================================================ */

const Knowledge = (() => {
  let _view = 'visible';     // 'visible' | 'hidden'
  let _items = [];
  let _selectedId = null;
  let _delegatedBound = false;
  let _deleting = false;
  let _uploading = false;   // AI 提取进行中

  // ===== mount / destroy =====

  async function mount() {
    _view = 'visible';
    _selectedId = null;
    _delegatedBound = false;
    _deleting = false;
    _uploading = false;
    await _loadItems();
    _render();
  }

  function destroy() {
    _items = [];
    _selectedId = null;
    _delegatedBound = false;
    _deleting = false;
    _uploading = false;
  }

  // ===== 数据加载 =====

  async function _loadItems() {
    try {
      const visible = _view === 'visible' ? 1 : 0;
      _items = await knowledgeAPI.listInfos(visible);
    } catch (e) {
      console.error('[Knowledge] 加载失败:', e);
      _items = [];
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('加载知识库失败: ' + (e.message || '网络错误'), 'error');
      }
    }
  }

  // ===== 锁定检查 =====

  function _checkLocked() {
    if (typeof Chat !== 'undefined' && Chat.isGenerating) {
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('Lubina 工作时可能频繁读写知识库，禁止随意操作哦', 'warning');
      }
      return true;
    }
    if (_uploading) {
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('AI 正在提取信息中，请稍候再操作', 'warning');
      }
      return true;
    }
    return false;
  }

  // ===== AI 上传 =====

  async function _aiUpload() {
    if (_checkLocked()) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,.py,.js,.ts,.html,.css,.json,.yaml,.yml,.xml,.csv,.log,.sh,.bat,.ini,.cfg,.conf,.toml,.rst,.tex';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;

      _uploading = true;
      _render();  // 显示进度

      try {
        const result = await knowledgeAPI.aiUpload(file);
        _uploading = false;
        await _loadItems();
        _render();
        const msg = `AI 提取完成：新增 ${result.stored_count} 条，合并 ${result.merged_count} 条，跳过 ${result.skipped_count} 条`;
        if (typeof App !== 'undefined' && App.showToast) {
          App.showToast(msg, 'success');
        }
      } catch (e) {
        _uploading = false;
        _render();
        if (typeof App !== 'undefined' && App.showToast) {
          App.showToast('AI 提取失败: ' + (e.message || '网络错误'), 'error');
        }
      }
    };
    input.click();
  }

  // ===== 操作 =====

  async function _toggleVisibility(id) {
    if (_checkLocked()) return;
    try {
      await knowledgeAPI.toggleInfo(id);
      await _loadItems();
      _selectedId = null;
      _render();
    } catch (e) {
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('操作失败: ' + (e.message || ''), 'error');
      }
    }
  }

  async function _deleteInfo(id) {
    if (_checkLocked()) return;
    if (_deleting) return;
    const item = _items.find(i => i.id === id);
    if (!item) return;

    _deleting = true;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay k-del-overlay';
    overlay.innerHTML = `
      <div class="modal-dialog" style="max-width:380px;">
        <h3>删除知识条目</h3>
        <p>确定要删除此信息吗？此操作不可撤销。</p>
        <p style="font-size:0.82rem;color:var(--text-tip);">${_esc(item.content || '空内容').slice(0, 80)}</p>
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
        await knowledgeAPI.deleteInfo(id);
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
    const categoryEl = document.getElementById(`kCat_${id}`);
    const contentEl = document.getElementById(`kContent_${id}`);
    const keywordsEl = document.getElementById(`kKw_${id}`);
    if (!contentEl) return;
    try {
      const data = {
        content: contentEl.value,
      };
      if (categoryEl) data.category = categoryEl.value.trim();
      if (keywordsEl) {
        const kw = keywordsEl.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        data.keywords = kw;
      }
      await knowledgeAPI.updateInfo(id, data);
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

  // ===== 渲染 =====

  function _render() {
    const el = document.getElementById('knowledgePage');
    if (!el) return;
    el.innerHTML = `
      ${_renderToolbar()}
      ${_renderHeader()}
      ${_uploading ? _renderUploadProgress() : ''}
      ${_renderList()}`;
    _bindEvents();
  }

  function _renderToolbar() {
    return `
      <div class="knowledge-toolbar">
        <button class="btn btn-primary btn-sm" id="kUploadBtn" ${_uploading ? 'disabled' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
          ${_uploading ? 'AI 提取中…' : 'AI 导入'}
        </button>
        <div class="knowledge-tabs">
          <button class="knowledge-tab ${_view === 'visible' ? 'active' : ''}" data-view="visible">显式知识</button>
          <button class="knowledge-tab ${_view === 'hidden' ? 'active' : ''}" data-view="hidden">隐藏知识</button>
        </div>
      </div>`;
  }

  function _renderUploadProgress() {
    return `<div class="knowledge-upload-progress">
      <div class="thinking-state" style="margin:0 8px 0 0;"></div>
      <span>正在调用 AI 提取信息，请稍候…</span>
    </div>`;
  }

  function _renderHeader() {
    const label = _view === 'visible' ? '显式知识 · AI 可以检索和引用' : '隐藏知识 · 仅存储，AI 不会看到';
    return `<div class="knowledge-view-hint">${label} · ${_items.length} 条</div>`;
  }

  function _renderList() {
    if (_items.length === 0) {
      return `<div class="knowledge-empty">
        <p>${_view === 'visible' ? '还没有显式知识条目' : '没有隐藏条目'}</p>
        <span style="font-size:0.78rem;color:var(--text-tip);">上传文本文件，AI 将自动提取结构化信息</span>
      </div>`;
    }

    const cards = _items.map(item => _renderCard(item)).join('');
    return `<div class="knowledge-list">${cards}</div>`;
  }

  function _renderCard(item) {
    const isExpanded = _selectedId === item.id;
    const kw = item.keywords || [];

    return `
      <div class="knowledge-card ${isExpanded ? 'expanded' : ''}" id="kCard_${item.id}">
        <div class="knowledge-card-main" data-kid="${item.id}">
          <div class="knowledge-card-info">
            ${item.category ? `<span class="category-tag">${_esc(item.category)}</span>` : ''}
            <div class="knowledge-card-content">${_esc((item.content || '').slice(0, 150))}${(item.content || '').length > 150 ? '…' : ''}</div>
            <div class="knowledge-card-meta">
              ${item.source_file ? `<span class="knowledge-card-source">来自: ${_esc(item.source_file)}</span>` : ''}
              <span class="knowledge-card-date">${(item.updated_at || item.created_at || '').slice(0, 10)}</span>
            </div>
            ${kw.length > 0 ? `<div class="keyword-tags">${kw.map(k => `<span class="keyword-chip">${_esc(k)}</span>`).join('')}</div>` : ''}
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
    const kw = (item.keywords || []).join(', ');
    return `
      <div class="knowledge-detail">
        <div class="form-group">
          <label>信息类别</label>
          <input class="input" id="kCat_${item.id}" value="${_escAttr(item.category || '')}" placeholder="如：个人信息、学习资料…">
        </div>
        <div class="form-group">
          <label>信息内容</label>
          <textarea class="input knowledge-detail-textarea" id="kContent_${item.id}" rows="6" placeholder="输入内容…">${_esc(item.content || '')}</textarea>
        </div>
        <div class="form-group">
          <label>关键词（逗号分隔）</label>
          <input class="input" id="kKw_${item.id}" value="${_escAttr(kw)}" placeholder="关键词1, 关键词2">
        </div>
        ${item.source_file ? `<div class="form-group"><label>来源文件</label><p style="font-size:0.8rem;color:var(--text-tip);margin:0;">${_esc(item.source_file)}</p></div>` : ''}
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" data-action="save" data-kid="${item.id}">保存</button>
        </div>
      </div>`;
  }

  // ===== 事件绑定 =====

  function _bindEvents() {
    const el = document.getElementById('knowledgePage');
    if (!el) return;

    if (!_delegatedBound) {
      _delegatedBound = true;
      el.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        e.stopPropagation();
        const action = btn.dataset.action;
        const kid = btn.dataset.kid;

        if (action === 'toggle') _toggleVisibility(kid);
        if (action === 'delete') _deleteInfo(kid);
        if (action === 'save') _saveEdit(kid);
      });
    }

    el.querySelector('#kUploadBtn')?.addEventListener('click', _aiUpload);

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

    el.querySelectorAll('.knowledge-card-main').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const kid = row.dataset.kid;
        _selectedId = (_selectedId === kid) ? null : kid;
        _render();
      });
    });
  }

  // ===== 辅助 =====

  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function _escAttr(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { mount, destroy };
})();
