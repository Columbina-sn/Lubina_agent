/* ============================================================
   file-explorer.js —— 文件树浏览器 v3
   打开文件夹 · 真实文件系统 · 懒加载子目录 · 工作区根目录
   ============================================================ */

const FileExplorer = (() => {
  let containerEl = null;
  let treeEl = null;
  let searchInput = null;
  let rootPath = null;
  let treeData = null;        // { name, path, isDir, children }
  let searchQuery = '';
  let loadedDirs = new Set(); // 已展开/加载过的目录路径（懒加载用）

  // 文件图标映射
  const FILE_ICONS = {
    js:   { icon: 'JS',   cls: 'file-js' },
    ts:   { icon: 'TS',   cls: 'file-js' },
    jsx:  { icon: 'JSX',  cls: 'file-js' },
    tsx:  { icon: 'TSX',  cls: 'file-js' },
    py:   { icon: 'PY',   cls: 'file-py' },
    html: { icon: '⬡',   cls: 'file-html' },
    css:  { icon: '#',    cls: 'file-css' },
    scss: { icon: '#',    cls: 'file-css' },
    less: { icon: '#',    cls: 'file-css' },
    json: { icon: '{}',   cls: 'file-json' },
    md:   { icon: 'MD',   cls: 'file-md' },
    txt:  { icon: '¶',    cls: 'file-default' },
    svg:  { icon: '◉',    cls: 'file-img' },
    png:  { icon: '▦',    cls: 'file-img' },
    jpg:  { icon: '▦',    cls: 'file-img' },
    jpeg: { icon: '▦',    cls: 'file-img' },
    gif:  { icon: '▦',    cls: 'file-img' },
    ico:  { icon: '▦',    cls: 'file-img' },
    xml:  { icon: '⬡',   cls: 'file-html' },
    yaml: { icon: '{}',   cls: 'file-json' },
    yml:  { icon: '{}',   cls: 'file-json' },
    toml: { icon: '{}',   cls: 'file-json' },
    rs:   { icon: 'RS',   cls: 'file-js' },
    go:   { icon: 'GO',   cls: 'file-js' },
    java: { icon: 'JV',   cls: 'file-js' },
    c:    { icon: 'C',    cls: 'file-js' },
    cpp:  { icon: 'C++',  cls: 'file-js' },
    h:    { icon: 'H',    cls: 'file-js' },
    hpp:  { icon: 'H',    cls: 'file-js' },
    vue:  { icon: '⬡',   cls: 'file-html' },
    sql:  { icon: 'DB',   cls: 'file-json' },
    sh:   { icon: '>_',   cls: 'file-json' },
    bat:  { icon: '>_',   cls: 'file-json' },
    ps1:  { icon: '>_',   cls: 'file-json' },
    lock: { icon: '{}',   cls: 'file-json' },
  };

  const TEXT_EXTS = new Set([
    'txt','md','py','js','ts','jsx','tsx','html','css','scss','less',
    'json','xml','yaml','yml','toml','ini','cfg','sh','bash','zsh',
    'c','cpp','h','hpp','java','go','rs','rb','php','swift','kt',
    'r','m','sql','vue','svelte','astro','tex','csv','log','svg',
    'gitignore','env','dockerfile','makefile','cmake','bat','ps1',
    'conf','config','editorconfig','eslintrc','prettierrc',
  ]);

  function init(el) {
    containerEl = el;
    treeEl = containerEl.querySelector('.explorer-tree');
    searchInput = containerEl.querySelector('.explorer-search input');

    // 打开文件夹按钮
    containerEl.querySelector('[data-action="open-folder"]')
      ?.addEventListener('click', openFolder);

    // 搜索
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        renderTree();
      });
    }

    // 空状态按钮
    containerEl.querySelector('[data-action="open-folder-empty"]')
      ?.addEventListener('click', openFolder);
  }

  async function openFolder() {
    if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
      const result = await Bridge.openFolderDialog();
      if (result) {
        rootPath = typeof result === 'string' ? result : result.path || result;
        window.__lubina_workspace_root = rootPath;
        loadedDirs = new Set();
        await loadDirectory(rootPath);
      }
    } else {
      showToast('请使用 Lubina 桌面版打开文件夹', 'warning');
    }
  }

  async function loadDirectory(dirPath) {
    try {
      treeEl.innerHTML = '<div class="explorer-loading"><div class="spinner"></div><p>加载中…</p></div>';

      // 第一层：加载根目录内容
      const entries = await Bridge.listDir(dirPath);
      // 只加载第一层子节点，更深层的目录标记为懒加载
      const children = entries.map(e => {
        const ext = e.name.split('.').pop()?.toLowerCase();
        return {
          name: e.name,
          path: e.path,
          isDir: e.isDir,
          ext: ext,
          children: e.isDir ? [] : undefined,
          lazy: e.isDir,  // 目录默认懒加载
        };
      });

      treeData = {
        name: dirPath.split(/[/\\]/).pop() || dirPath,
        path: dirPath,
        isDir: true,
        children: children,
      };

      renderTree();
    } catch (err) {
      console.error('读取目录失败:', err);
      treeData = null;
      treeEl.innerHTML = `
        <div class="explorer-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <p>无法读取目录</p>
          <p style="font-size:0.75rem;color:var(--text-tip);">${esc(err.message)}</p>
          <button class="btn btn-ghost btn-sm" data-action="open-folder-empty">重新选择</button>
        </div>`;
      treeEl.querySelector('[data-action="open-folder-empty"]')
        ?.addEventListener('click', openFolder);
    }
  }

  /** 懒加载：展开目录时才加载其子节点 */
  async function lazyLoadChildren(node) {
    if (!node.isDir || node.lazy === false) return;
    if (loadedDirs.has(node.path)) return; // 已加载过

    try {
      const entries = await Bridge.listDir(node.path);
      node.children = entries.map(e => {
        const ext = e.name.split('.').pop()?.toLowerCase();
        return {
          name: e.name,
          path: e.path,
          isDir: e.isDir,
          ext: ext,
          children: e.isDir ? [] : undefined,
          lazy: e.isDir,
        };
      });
      node.lazy = false;
      loadedDirs.add(node.path);
    } catch (_) {
      // 无权限读取的目录：保持空 children
      node.lazy = false;
      node.children = [];
      loadedDirs.add(node.path);
    }
  }

  // ===== 渲染 =====
  function renderTree() {
    if (!treeEl) return;

    if (!treeData) {
      treeEl.innerHTML = `
        <div class="explorer-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <p>尚未打开文件夹</p>
          <button class="btn btn-ghost btn-sm" data-action="open-folder-empty">打开文件夹</button>
        </div>`;
      treeEl.querySelector('[data-action="open-folder-empty"]')
        ?.addEventListener('click', openFolder);
      return;
    }

    // 保留展开状态（记录当前展开的目录路径）
    const expandedPaths = new Set();
    treeEl.querySelectorAll('.tree-children:not(.collapsed)').forEach(c => {
      const row = c.previousElementSibling;
      const pathEl = row?.querySelector?.('.tree-node-path');
      if (pathEl) expandedPaths.add(pathEl.dataset.path);
    });

    treeEl.innerHTML = '';
    renderNode(treeData, treeEl, 0, expandedPaths);

    // 展开第一层（默认打开根目录的第一层）
    treeEl.querySelectorAll(':scope > .tree-node + .tree-children').forEach(c => {
      c.classList.remove('collapsed');
    });
    treeEl.querySelectorAll(':scope > .tree-node .tree-node-arrow').forEach(a => {
      a.classList.add('expanded');
    });
  }

  function renderNode(node, parent, depth, expandedPaths) {
    const matchesSearch = !searchQuery || node.name.toLowerCase().includes(searchQuery);

    // 搜索模式下：只显示匹配项（包括其父路径在渲染时自然展开）
    if (searchQuery && !matchesSearch && node.isDir) {
      // 目录不匹配但子节点可能匹配 → 仍渲染目录但折叠
      if (!node.children || node.children.length === 0) return;
    }
    if (searchQuery && !matchesSearch && !node.isDir) return;

    if (node.isDir) {
      const wasExpanded = expandedPaths.has(node.path);

      const row = document.createElement('div');
      row.className = 'tree-node';
      row.style.setProperty('--depth', depth);
      row.innerHTML = `
        <span class="tree-node-arrow ${wasExpanded ? 'expanded' : ''}">▶</span>
        <span class="tree-node-icon folder"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>
        <span class="tree-node-name">${esc(node.name)}</span>`;
      parent.appendChild(row);

      const childrenContainer = document.createElement('div');
      childrenContainer.className = `tree-children${wasExpanded ? '' : ' collapsed'}`;
      parent.appendChild(childrenContainer);

      // 展开/折叠 + 懒加载
      row.querySelector('.tree-node-arrow').addEventListener('click', async (e) => {
        e.stopPropagation();
        await _toggleDir(row, childrenContainer, node);
      });
      row.addEventListener('click', async () => {
        await _toggleDir(row, childrenContainer, node);
      });

      // 渲染子节点（可能为空但已标记 lazy）
      if (node.children && node.children.length > 0) {
        node.children.forEach(child => renderNode(child, childrenContainer, depth + 1, expandedPaths));
      } else if (node.lazy && wasExpanded) {
        // 之前展开过但未加载 → 触发懒加载
        lazyLoadChildren(node).then(() => {
          childrenContainer.innerHTML = '';
          if (node.children) {
            node.children.forEach(child => renderNode(child, childrenContainer, depth + 1, expandedPaths));
          }
        });
      }
    } else {
      // 文件节点
      const ext = node.ext || node.name.split('.').pop()?.toLowerCase();
      const iconInfo = FILE_ICONS[ext] || { cls: 'file-default' };

      const row = document.createElement('div');
      row.className = 'tree-node';
      row.style.setProperty('--depth', depth);
      row.innerHTML = `
        <span class="tree-node-arrow" style="visibility:hidden">▶</span>
        <span class="tree-node-icon ${iconInfo.cls}">${iconInfo.icon || ''}</span>
        <span class="tree-node-name">${esc(node.name)}</span>`;
      parent.appendChild(row);

      row.addEventListener('click', () => openFile(node));
    }
  }

  async function _toggleDir(row, childrenContainer, node) {
    const arrow = row.querySelector('.tree-node-arrow');
    const isExpanding = childrenContainer.classList.contains('collapsed');

    if (isExpanding && node.lazy) {
      // 懒加载子节点
      await lazyLoadChildren(node);
      if (node.children && node.children.length > 0) {
        childrenContainer.innerHTML = '';
        node.children.forEach(child => renderNode(child, childrenContainer, parseInt(row.style.getPropertyValue('--depth')) + 1, new Set()));
      }
    }

    arrow.classList.toggle('expanded');
    childrenContainer.classList.toggle('collapsed');
  }

  function openFile(node) {
    const ext = node.ext || node.name.split('.').pop()?.toLowerCase();

    if (TEXT_EXTS.has(ext) || ext === 'svg') {
      App.showPage('editor');
      setTimeout(() => {
        if (typeof Editor !== 'undefined' && Editor.openFile) {
          Editor.openFile(node.path, node.name);
        }
      }, 150);
    } else {
      App.showPage('editor');
      setTimeout(() => {
        if (typeof Editor !== 'undefined' && Editor.openBinary) {
          Editor.openBinary(node.name, ext);
        }
      }, 150);
    }
  }

  function esc(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function showToast(msg, type) {
    if (typeof App !== 'undefined' && App.showToast) {
      App.showToast(msg, type || 'info');
    }
  }

  // ===== 公开 API =====
  return {
    init,
    openFolder,
    getRootPath: () => rootPath,
    getTreeData: () => treeData,
    /** 编程式设置工作区（供拖拽/右键打开等外部入口使用） */
    setWorkspace: async (dirPath) => {
      rootPath = dirPath;
      window.__lubina_workspace_root = dirPath;
      loadedDirs = new Set();
      await loadDirectory(dirPath);
    },
  };
})();
