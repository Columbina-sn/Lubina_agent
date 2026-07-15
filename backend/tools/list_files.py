"""文件树读取工具 — 逐层懒加载工作区目录

供 Re-Act 循环中的 ListFilesTool 使用。

策略：
1. 检查 sandbox_root 是否已设置
2. 只列出指定目录的**直接子项**（一层），目录后带 / 标记
3. AI 可传 path 参数逐层深入，像用文件树一样层层展开
4. 防路径穿越（禁止 ..）、上限 100 条目、隐藏文件过滤
"""

import os

MAX_ENTRIES = 100  # 单层最多列出的条目数


async def list_files(sandbox_root: str = None, path: str = "") -> str:
    """读取工作区某一层目录内容

    Args:
        sandbox_root: 工作区根目录绝对路径（由前端传入）
        path: 要查看的子目录路径，相对于 sandbox_root。空字符串 = 根目录。

    Returns:
        格式化后的目录列表文本（供 AI 阅读）
    """
    if not sandbox_root or not os.path.isdir(sandbox_root):
        return (
            '用户还没有设置工作区文件夹。\n'
            '请告诉用户：在左侧文件树点击「打开文件夹」按钮，选择一个文件夹作为工作区。\n'
            '之后你就可以读取、创建和修改这个文件夹里的文件了。'
        )

    # 安全检查：禁止路径穿越
    p = (path or "").replace("\\", "/").strip("/")
    if p.startswith("..") or "/.." in ("/" + p):
        return "路径包含不安全字符（..），仅允许在工作区内访问。"

    target = os.path.join(sandbox_root, p) if p else sandbox_root
    target = os.path.normpath(target)

    # 确保 target 在 sandbox_root 内
    if not target.startswith(os.path.normpath(sandbox_root)):
        return f"路径越界：{path} 不在工作区内。"

    if not os.path.isdir(target):
        return f"路径不是目录：{path or '（根）'}\n提示：如果要读取文件内容，请使用编辑器打开。"

    rel_display = path if path else os.path.basename(sandbox_root)
    lines = [f"工作区: {sandbox_root}", f"当前目录: {rel_display or '/'}", ""]

    try:
        entries = sorted(os.scandir(target), key=lambda e: (not e.is_dir(), e.name.lower()))
    except PermissionError:
        return f"没有权限读取目录: {path or '根目录'}"

    dirs, files = [], []
    for entry in entries:
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            dirs.append(entry.name)
        else:
            files.append(entry.name)

    shown = 0
    for name in dirs:
        if shown >= MAX_ENTRIES:
            break
        lines.append(f"  {name}/")
        shown += 1

    for name in files:
        if shown >= MAX_ENTRIES:
            break
        lines.append(f"  {name}")
        shown += 1

    total = len(dirs) + len(files)
    if shown < total:
        lines.append(f"…（共 {total} 项，仅显示前 {MAX_ENTRIES} 项。用 path 参数进入子目录查看更多）")

    if not dirs and not files:
        lines.append("（空目录）")
    elif dirs:
        lines.append(f"\n{len(dirs)} 个子目录（标 / 的），用 path 参数传入路径名即可深入查看。")

    return "\n".join(lines)
