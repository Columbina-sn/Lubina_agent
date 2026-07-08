/* ============================================================
   file-explorer.js —— 文件树浏览器
   打开文件夹 · 树形渲染 · 搜索过滤 · 点击打开到编辑器
   ============================================================ */

const FileExplorer = (() => {
  let containerEl = null;
  let treeEl = null;
  let searchInput = null;
  let rootPath = null;
  let treeData = null;        // { name, path, isDir, children }
  let searchQuery = '';

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
    json: { icon: '{}',   cls: 'file-json' },
    md:   { icon: 'MD',   cls: 'file-md' },
    txt:  { icon: '¶',    cls: 'file-default' },
    svg:  { icon: '◉',    cls: 'file-img' },
    png:  { icon: '▦',    cls: 'file-img' },
    jpg:  { icon: '▦',    cls: 'file-img' },
    gif:  { icon: '▦',    cls: 'file-img' },
  };

  const TEXT_EXTS = new Set([
    'txt','md','py','js','ts','jsx','tsx','html','css','scss','less',
    'json','xml','yaml','yml','toml','ini','cfg','sh','bash','zsh',
    'c','cpp','h','hpp','java','go','rs','rb','php','swift','kt',
    'r','m','sql','vue','svelte','astro','tex','csv','log',
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
    // 使用 Tauri 原生对话框或浏览器降级
    if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
      const result = await Bridge.openFileDialog();
      if (result) {
        rootPath = typeof result === 'string' ? result : result.path || result;
        await loadDirectory(rootPath);
      }
    } else {
      // 浏览器环境：使用模拟数据演示
      const demoPath = prompt('输入文件夹路径（演示模式）：', 'D:\\Desktop_agent\\src');
      if (demoPath) {
        rootPath = demoPath;
        await loadDirectoryMock(demoPath);
      }
    }
  }

  async function loadDirectory(dirPath) {
    try {
      // 将来通过 Tauri API 或后端获取目录结构
      // 目前用模拟数据
      await loadDirectoryMock(dirPath);
    } catch (err) {
      console.error('读取目录失败:', err);
      treeData = null;
      renderTree();
    }
  }

  // 模拟目录加载（等后端就绪后替换）
  async function loadDirectoryMock(dirPath) {
    const name = dirPath.split(/[/\\]/).pop() || dirPath;
    // 从 bridge 读取目录（如果可用）
    if (typeof Bridge !== 'undefined') {
      try {
        // 尝试列出目录内容 — 这是占位，等后端 API 就绪
        const files = await listDirFallback(dirPath);
        treeData = buildTree(name, dirPath, files);
      } catch (_) {
        treeData = createDemoTree(name, dirPath);
      }
    } else {
      treeData = createDemoTree(name, dirPath);
    }
    renderTree();
  }

  function listDirFallback(dirPath) {
    // 占位：等 Tauri fs API 或后端端点就绪
    // 目前返回空数组 → 触发 demo tree
    return Promise.reject(new Error('Not implemented'));
  }

  function createDemoTree(name, path) {
    return {
      name,
      path,
      isDir: true,
      children: [
        {
          name: 'src', path: path + '/src', isDir: true,
          children: [
            { name: 'index.html', path: path + '/src/index.html', isDir: false, ext: 'html' },
            { name: 'app.js', path: path + '/src/app.js', isDir: false, ext: 'js' },
            { name: 'chat.js', path: path + '/src/chat.js', isDir: false, ext: 'js' },
            { name: 'style.css', path: path + '/src/style.css', isDir: false, ext: 'css' },
          ]
        },
        {
          name: 'docs', path: path + '/docs', isDir: true,
          children: [
            { name: 'README.md', path: path + '/docs/README.md', isDir: false, ext: 'md' },
            { name: 'CHANGELOG.md', path: path + '/docs/CHANGELOG.md', isDir: false, ext: 'md' },
          ]
        },
        { name: 'package.json', path: path + '/package.json', isDir: false, ext: 'json' },
        { name: 'README.md', path: path + '/README.md', isDir: false, ext: 'md' },
      ]
    };
  }

  function buildTree(name, path, files) {
    // 从文件列表构建树结构（将来用）
    return {
      name, path, isDir: true,
      children: files.map(f => ({
        name: f.name,
        path: f.path,
        isDir: f.isDir || false,
        ext: f.name.split('.').pop()?.toLowerCase(),
        children: f.isDir ? [] : undefined,
      }))
    };
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

    treeEl.innerHTML = '';
    renderNode(treeData, treeEl, 0);

    // 展开第一层
    treeEl.querySelectorAll('.tree-children').forEach(c => {
      c.classList.remove('collapsed');
    });
    treeEl.querySelectorAll('.tree-node-arrow').forEach(a => {
      a.classList.add('expanded');
    });
  }

  function renderNode(node, parent, depth) {
    const matchesSearch = !searchQuery || node.name.toLowerCase().includes(searchQuery);

    if (node.isDir) {
      // 文件夹
      const row = document.createElement('div');
      row.className = 'tree-node';
      row.style.setProperty('--depth', depth);
      row.innerHTML = `
        <span class="tree-node-arrow expanded">▶</span>
        <span class="tree-node-icon folder"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>
        <span class="tree-node-name">${esc(node.name)}</span>`;
      parent.appendChild(row);

      const childrenContainer = document.createElement('div');
      childrenContainer.className = 'tree-children';
      parent.appendChild(childrenContainer);

      row.querySelector('.tree-node-arrow').addEventListener('click', (e) => {
        e.stopPropagation();
        const arrow = row.querySelector('.tree-node-arrow');
        arrow.classList.toggle('expanded');
        childrenContainer.classList.toggle('collapsed');
      });

      row.addEventListener('click', () => {
        const arrow = row.querySelector('.tree-node-arrow');
        arrow.classList.toggle('expanded');
        childrenContainer.classList.toggle('collapsed');
      });

      if (node.children) {
        node.children.forEach(child => renderNode(child, childrenContainer, depth + 1));
      }
    } else {
      // 文件
      if (!matchesSearch) return;

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

  function openFile(node) {
    const ext = node.ext || node.name.split('.').pop()?.toLowerCase();

    // 检测二进制文件
    if (TEXT_EXTS.has(ext) || ext === 'svg') {
      // 纯文本 → 切换到编辑器
      App.showPage('editor');
      setTimeout(() => {
        if (typeof Editor !== 'undefined' && Editor.openFile) {
          Editor.openFile(node.path, node.name);
        }
      }, 150);
    } else {
      // 二进制文件 → 编辑器显示不支持
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

  // ===== 公开 API =====
  return {
    init,
    openFolder,
    getRootPath: () => rootPath,
    getTreeData: () => treeData,
  };
})();
