/* ============================================================
   knowledge.js v3 — 知识库（模态编辑 + AI 提取）

   v3 重构：点击知识条目弹模态框编辑，不再内联展开
   ============================================================ */

const Knowledge = (() => {
  let _view = 'visible';
  let _items = [];
  let _delegatedBound = false;
  let _deleting = false;
  let _uploading = false;

  // ===== mount / destroy =====

  async function mount() {
    _view = 'visible';
    _delegatedBound = false;
    _deleting = false;
    _uploading = false;
    await _loadItems();
    _render();
  }

  function destroy() {
    _items = [];
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
        App.showToast('Lubia 工作时可能频繁读写知识库，禁止随意操作哦', 'warning');
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
      _render();

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

  // ===== 同步向量 =====

  async function _syncVectors() {
    if (_checkLocked()) return;
    if (typeof App !== 'undefined' && App.showToast) {
      App.showToast('正在检查向量同步状态…', 'info');
    }
    try {
      const result = await knowledgeAPI.syncVectors();
      const parts = [];
      if (result.added > 0) parts.push(`补建 ${result.added} 条`);
      if (result.failed > 0) parts.push(`${result.failed} 条失败`);
      if (result.orphans_removed > 0) parts.push(`清理 ${result.orphans_removed} 条孤儿`);
      const msg = parts.length > 0 ? parts.join('，') : '向量已完全同步';
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast(msg, result.failed > 0 ? 'warning' : 'success');
      }
      await _loadItems();
      _render();
    } catch (e) {
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('同步失败: ' + (e.message || ''), 'error');
      }
    }
  }

  // ===== 切换显隐 =====

  async function _toggleVisibility(id) {
    if (_checkLocked()) return;
    try {
      await knowledgeAPI.toggleInfo(id);
      await _loadItems();
      _render();
    } catch (e) {
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('操作失败: ' + (e.message || ''), 'error');
      }
    }
  }

  // ===== 删除 =====

  async function _deleteInfo(id) {
    if (_checkLocked()) return;
    if (_deleting) return;
    const item = _items.find(i => i.id === id);
    if (!item) return;

    _deleting = true;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-dialog" style="max-width:380px;">
        <h3>删除知识条目</h3>
        <p>确定要删除此信息吗？此操作不可撤销。</p>
        <p style="font-size:0.82rem;color:var(--text-tip);">${_esc(item.content || '空内容').slice(0, 80)}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="_kDelCancel">取消</button>
          <button class="btn btn-accent" id="_kDelConfirm">确认删除</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = () => { overlay.remove(); _deleting = false; };
    overlay.querySelector('#_kDelCancel').onclick = cleanup;
    overlay.querySelector('#_kDelConfirm').onclick = async () => {
      overlay.remove();
      _deleting = false;
      try {
        await knowledgeAPI.deleteInfo(id);
        await _loadItems();
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

  // ===== 模态编辑 =====

  function _openEditModal(item) {
    if (_checkLocked()) return;

    const kw = (item.keywords || []).join(', ');
    const MAX_CATEGORY = 15;
    const MAX_CONTENT = 150;
    const MAX_KW_EACH = 8;
    const MAX_KW_COUNT = 5;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-dialog" style="max-width:520px; max-height:85vh; display:flex; flex-direction:column;">
        <h3 style="flex-shrink:0;">编辑知识</h3>
        <div style="flex:1; overflow-y:auto; padding-right:4px;">
          <div class="form-group">
            <label style="display:block;font-size:0.78rem;color:var(--text-sub);margin-bottom:4px;">信息类别 <span class="char-count" id="_kCatCount">${(item.category || '').length}/${MAX_CATEGORY}</span></label>
            <input class="input" id="_kEditCat" value="${_escAttr(item.category || '')}" placeholder="如：个人信息、学习资料…" maxlength="${MAX_CATEGORY}">
          </div>
          <div class="form-group">
            <label style="display:block;font-size:0.78rem;color:var(--text-sub);margin-bottom:4px;">信息内容 <span class="char-count" id="_kContentCount">${(item.content || '').length}/${MAX_CONTENT}</span></label>
            <textarea class="input" id="_kEditContent" rows="8" placeholder="输入内容…（最多 ${MAX_CONTENT} 字）" maxlength="${MAX_CONTENT}" style="resize:vertical;min-height:160px;font-family:inherit;font-size:0.88rem;line-height:1.6;width:100%;box-sizing:border-box;">${_esc(item.content || '')}</textarea>
            <div style="font-size:0.72rem;color:var(--text-tip);margin-top:2px;">类别 + 内容 + 关键词总长限 250 token，超长后台自动截断</div>
          </div>
          <div class="form-group">
            <label style="display:block;font-size:0.78rem;color:var(--text-sub);margin-bottom:4px;">关键词（逗号分隔，每词≤${MAX_KW_EACH}字，最多${MAX_KW_COUNT}个） <span class="char-count" id="_kKwCount">${(item.keywords || []).length}/${MAX_KW_COUNT}</span></label>
            <input class="input" id="_kEditKw" value="${_escAttr(kw)}" placeholder="关键词1, 关键词2">
          </div>
          ${item.source_file ? `<div class="form-group"><label style="display:block;font-size:0.78rem;color:var(--text-sub);margin-bottom:4px;">来源文件</label><p style="font-size:0.8rem;color:var(--text-tip);margin:0;">${_esc(item.source_file)}</p></div>` : ''}
        </div>
        <div style="flex-shrink:0;display:flex;justify-content:flex-end;gap:8px;padding-top:14px;border-top:1px solid var(--border-card);margin-top:10px;">
          <button class="btn btn-ghost" id="_kEditCancel">取消</button>
          <button class="btn btn-primary" id="_kEditSave">保存</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    // 实时字数更新
    const catInput = overlay.querySelector('#_kEditCat');
    const contentInput = overlay.querySelector('#_kEditContent');
    const kwInput = overlay.querySelector('#_kEditKw');
    const catCount = overlay.querySelector('#_kCatCount');
    const contentCount = overlay.querySelector('#_kContentCount');
    const kwCount = overlay.querySelector('#_kKwCount');

    catInput?.addEventListener('input', () => {
      const len = catInput.value.length;
      catCount.textContent = `${len}/${MAX_CATEGORY}`;
      catCount.style.color = len > MAX_CATEGORY ? 'var(--color-error)' : '';
    });
    contentInput?.addEventListener('input', () => {
      const len = contentInput.value.length;
      contentCount.textContent = `${len}/${MAX_CONTENT}`;
      contentCount.style.color = len > MAX_CONTENT ? 'var(--color-error)' : '';
    });
    kwInput?.addEventListener('input', () => {
      const kws = kwInput.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
      kwCount.textContent = `${kws.length}/${MAX_KW_COUNT}`;
      kwCount.style.color = kws.length > MAX_KW_COUNT ? 'var(--color-error)' : '';
    });

    overlay.querySelector('#_kEditCancel').onclick = close;
    overlay.querySelector('#_kEditSave').onclick = () => {
      if (!contentInput) return;

      const catVal = (catInput?.value || '').trim();
      const contentVal = contentInput.value;
      if (!contentVal.trim()) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast('内容不能为空', 'warning');
        return;
      }

      let kws = (kwInput?.value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
      kws = kws.map(k => k.length > MAX_KW_EACH ? k.slice(0, MAX_KW_EACH) : k);
      kws = kws.slice(0, MAX_KW_COUNT);
      kws = [...new Set(kws)];

      const data = { content: contentVal.slice(0, MAX_CONTENT) };
      if (catVal) data.category = catVal.slice(0, MAX_CATEGORY);
      data.keywords = kws;

      // 先关弹窗，还用户自由
      close();
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast('正在保存并生成向量，请勿关闭软件…', 'info');
      }

      // 后台保存
      knowledgeAPI.updateInfo(item.id, data).then(async () => {
        await _loadItems();
        _render();
        if (typeof App !== 'undefined' && App.showToast) {
          App.showToast('已保存，向量已更新', 'success');
        }
      }).catch(e => {
        if (typeof App !== 'undefined' && App.showToast) {
          App.showToast('保存失败: ' + (e.message || ''), 'error');
        }
      });
    };

    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    // 聚焦内容框
    setTimeout(() => {
      const ta = document.getElementById('_kEditContent');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }, 100);
  }

  // ===== 渲染 =====

  function _render() {
    const el = document.getElementById('knowledgePage');
    if (!el) return;
    el.innerHTML = `
      ${_renderToolbar()}
      ${_renderTips()}
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
        <button class="btn btn-ghost btn-sm" id="kSyncBtn" title="检查并修复向量同步">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          同步
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

  function _renderTips() {
    return `<div class="knowledge-tips">
      <div class="knowledge-tips-item">上传文件让 AI 自动提炼信息，或点击已有卡片手动编辑</div>
      <div class="knowledge-tips-item">显式知识会被 AI 搜索引用，隐藏的知识不会出现在回答中</div>
      <div class="knowledge-tips-item">「同步」按钮用于检查并修复搜索索引，日常无需手动操作</div>
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
    const kw = item.keywords || [];
    return `
      <div class="knowledge-card" data-kid="${item.id}">
        <div class="knowledge-card-main">
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
      </div>`;
  }

  // ===== 事件 =====

  function _bindEvents() {
    const el = document.getElementById('knowledgePage');
    if (!el) return;

    // 委托：按钮操作
    if (!_delegatedBound) {
      _delegatedBound = true;
      el.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (btn) {
          e.stopPropagation();
          const action = btn.dataset.action;
          const kid = btn.dataset.kid;
          if (action === 'toggle') _toggleVisibility(kid);
          if (action === 'delete') _deleteInfo(kid);
          return;
        }

        // 点击卡片主体 → 打开编辑模态框
        const card = e.target.closest('.knowledge-card');
        if (card && card.dataset.kid) {
          // 不拦截按钮点击（上面已处理）
          if (e.target.closest('button')) return;
          const item = _items.find(i => i.id === card.dataset.kid);
          if (item) _openEditModal(item);
        }
      });
    }

    el.querySelector('#kUploadBtn')?.addEventListener('click', _aiUpload);
    el.querySelector('#kSyncBtn')?.addEventListener('click', _syncVectors);

    el.querySelectorAll('.knowledge-tab').forEach(btn => {
      btn.addEventListener('click', async () => {
        const v = btn.dataset.view;
        if (v === _view) return;
        _view = v;
        await _loadItems();
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
