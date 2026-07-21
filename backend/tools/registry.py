"""工具注册中心

所有工具的唯一定义源。每个工具在此注册后，自动生成：
- TOOL_MAP：工具名 → 异步函数
- TOOL_META：工具名 → 元数据（type, label, group, category）
- TOOL_LABELS：工具名 → 中文标签
- build_tools_prompt()：生成注入系统提示词的工具描述段

新增工具只需在此文件的 _TOOLS 列表中添加注册项即可。
"""

from .safe.knowledge_grep import knowledge_grep
from .safe.knowledge_rag import knowledge_rag
from .safe.web_search import web_search
from .safe.web_fetch import web_fetch
from .safe.list_files import list_files
from .dangerous.knowledge_import import knowledge_import

# ── 工具注册表（唯一数据源）────────────────────────────────────────

_TOOLS = [
    # ── 安全 / 只读工具 ──
    {
        "name": "web_search",
        "category": "safe",
        "type": "read",
        "label": "联网搜索",
        "group": "web_search",
        "func": web_search,
        "schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词，用空格分隔多个词"}
            },
            "required": ["query"],
        },
        "description": (
            "web_search — 联网搜索，获取公开网页信息。\n"
            "参数：{\"query\": \"<搜索词>\"}\n"
            "• 这是你获取外部信息的首要渠道。中文内容用百度，英文/技术内容用 Google。\n"
            "• 搜索词的写法决定结果质量：用简洁的关键词组合，不要写整句。\n"
            "• 搜索结果仅提供标题和摘要片段，信息量极少。\n"
            "• **铁律**：web_search 返回后，你必须立刻调用 web_fetch 抓取 1~2 个最相关的 URL，"
            "获取页面完整内容后才能真正回答用户。只根据摘要回答 = 编造信息。\n"
            "• 如果 web_search 返回空，换一组关键词重试一次，仍空则诚实告诉用户未找到。"
        ),
    },
    {
        "name": "web_fetch",
        "category": "safe",
        "type": "read",
        "label": "网页抓取",
        "group": "web_fetch",
        "func": web_fetch,
        "schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "要抓取内容的网页完整 URL"}
            },
            "required": ["url"],
        },
        "description": (
            "web_fetch — 抓取网页完整内容，提取正文文本。\n"
            "参数：{\"url\": \"https://...\"}\n"
            "• web_search 之后必须调用此工具获取至少 1 个网页的完整内容。\n"
            "• 搜索结果摘要不等于信息——你只有读完网页正文才能引用其中的具体内容。\n"
            "• 抓取结果可能很长，只提取与用户问题相关的部分进行回答。\n"
            "• URL 必须来自 web_search 返回的结果链接，禁止自行编造 URL。\n"
            "• 如果页面无法访问（404/超时/需要登录），尝试抓取搜索结果中的下一个 URL。"
        ),
    },
    {
        "name": "knowledge_grep",
        "category": "safe",
        "type": "read",
        "label": "知识库检索",
        "group": "kb",
        "func": knowledge_grep,
        "schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "空格分隔的关键词，每词 2~3 字为佳"}
            },
            "required": ["query"],
        },
        "description": (
            "knowledge_grep — 在用户私有知识库中做关键词精确搜索。\n"
            "参数：{\"query\": \"<空格分隔的关键词，每词 2~3 字>\"}\n"
            "• 用户询问个人信息（姓名、学校、偏好、项目、过往对话中提到的事）时优先使用。\n"
            "• 关键词尽量简短（2 字最佳），拆成多个方向分别搜索效果更好。\n"
            "• 如果返回空结果，换几个简短同义词重试一次。仍为空则尝试 knowledge_rag（语义搜索）。\n"
            "• 两次都无结果就诚实告诉用户知识库中没有相关信息，不要反复重试。"
        ),
    },
    {
        "name": "knowledge_rag",
        "category": "safe",
        "type": "read",
        "label": "知识库语义搜索",
        "group": "kb",
        "func": knowledge_rag,
        "schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "自然语言描述的查询，完整句子即可"}
            },
            "required": ["query"],
        },
        "description": (
            "knowledge_rag — 用语义理解搜索知识库，匹配含义相近的内容。\n"
            "参数：{\"query\": \"<自然语言描述>\"}\n"
            "• knowledge_grep（关键词搜索）无结果时的降级方案。\n"
            "• 用完整的自然语言句子描述你想找什么，不需要拆成关键词。\n"
            "• 与 knowledge_grep 属于同一组，连续调用不额外消耗循环次数。\n"
            "• 如果语义搜索也无结果，换个完全不同的表述方式再试一次。仍为空则如实告知用户。"
        ),
    },
    {
        "name": "list_files",
        "category": "safe",
        "type": "read",
        "label": "读取文件树",
        "group": "list_files",
        "func": list_files,
        "schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要查看的子目录路径（相对于工作区根目录）。空字符串 = 根目录"
                }
            },
            "required": [],
        },
        "description": (
            "list_files — 浏览用户工作区的目录结构（每次一层）。\n"
            "参数：{\"path\": \"<子目录路径，可选>\"}\n"
            "• 工作区是用户打开的文件夹，路径已经在上下文中提供。\n"
            "• 每次只列出一层目录内容，目录名末尾带 / 标记。\n"
            "• 如需深入子目录，传入 path 参数逐层展开。\n"
            "• 这是纯浏览工具，不消耗循环计数，可以多次连续调用。\n"
            "• 需要读取具体文件内容时，告诉用户从文件树中打开该文件即可在编辑器中查看。"
        ),
    },
    # ── 写入 / 危险工具 ──
    {
        "name": "knowledge_import",
        "category": "dangerous",
        "type": "write",
        "label": "知识导入",
        "group": "knowledge_import",
        "func": knowledge_import,
        "schema": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "要存储的用户信息原文。直接从对话中摘录，不要改写。"
                }
            },
            "required": ["content"],
        },
        "description": (
            "knowledge_import — 将用户透露的个人信息存入知识库，这是你记住事情的唯一方式。\n"
            "参数：{\"content\": \"<从对话中摘录的原文>\"}\n"
            "• **主动发现**：用户在对话中透露的任何个人信息（姓名、学校、年级、专业、项目、偏好、计划、"
            "社交关系等），你都应该立刻调用这个工具存下来。不要等到对话结束才处理。\n"
            "• **原文摘录**：直接摘录用户的原话，不需要改写或总结。后台会自动拆解、分类、去重。\n"
            "• **没有记忆就没有个性化**：你不存储信息 = 下次对话你什么都不知道。\n"
            "• 工具返回简短确认（如「知识导入完成：新增 2 条」）。\n"
            "• 如果用户说「记住……」「帮我记一下……」，这是明确的存储指令，必须调用此工具。"
        ),
    },
]

# ── 自动派生 ────────────────────────────────────────────────────────

TOOL_MAP: dict = {t["name"]: t["func"] for t in _TOOLS}

TOOL_META: dict = {
    t["name"]: {
        "type": t["type"],
        "label": t["label"],
        "group": t["group"],
        "category": t["category"],
    }
    for t in _TOOLS
}

TOOL_LABELS: dict = {t["name"]: t["label"] for t in _TOOLS}


def build_tools_prompt() -> str:
    """生成注入系统提示词的工具描述段

    将每个工具的 description 拼接为提示词中的「可用工具」部分。
    描述已包含参数格式、使用时机、铁律和注意事项。
    """
    safe_tools = [t for t in _TOOLS if t["category"] == "safe"]
    dangerous_tools = [t for t in _TOOLS if t["category"] == "dangerous"]

    lines = ["## 可用工具\n"]

    lines.append("### 查询与搜索（安全操作，自动执行）\n")
    for t in safe_tools:
        lines.append(f"#### {t['name']}\n{t['description']}\n")

    if dangerous_tools:
        lines.append("### 写入与修改（每次独立展示，用户随时可见）\n")
        for t in dangerous_tools:
            lines.append(f"#### {t['name']}\n{t['description']}\n")

    return "\n".join(lines)
