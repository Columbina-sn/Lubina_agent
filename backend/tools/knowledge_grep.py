"""知识库搜索工具 — SQLite 粗筛 + difflib 精排

供 Re-Act 循环中的 KnowledgeGrepTool 使用。

策略：
1. SQL LIKE 在 content/keywords/category 上做粗筛（最多 30 条候选）
2. difflib 对每条候选计算与 query 的相似度
3. 按相似度降序排列，返回 top 10
"""

import json
import difflib
from ..database import get_db


async def knowledge_grep(query: str) -> str:
    """在 knowledge_infos 中模糊搜索

    Args:
        query: 搜索关键词（可以是多个词，空格分隔）

    Returns:
        格式化后的搜索结果文本（供 AI 阅读）
    """
    conn = get_db()
    try:
        # ── 1. SQL 粗筛：每个词独立 LIKE 匹配，OR 连接 ──
        terms = [t.strip() for t in query.split() if t.strip()]
        if not terms:
            terms = [query.strip()]

        # 构建 WHERE 子句：每个 term 分别匹配 content、keywords、category
        clauses = []
        params = []
        for term in terms:
            pattern = f"%{term}%"
            clauses.append("(content LIKE ? OR keywords LIKE ? OR category LIKE ?)")
            params.extend([pattern, pattern, pattern])

        where_clause = " OR ".join(clauses)
        sql = f"""SELECT id, category, content, keywords FROM knowledge_infos
                   WHERE is_visible = 1 AND ({where_clause})
                   ORDER BY updated_at DESC LIMIT 30"""

        rows = conn.execute(sql, params).fetchall()

        if not rows:
            return "知识库中没有找到相关信息。"

        # ── 2. difflib 精排 ──
        query_lower = query.lower()
        scored = []
        for r in rows:
            content = r["content"] or ""
            kw_str = r["keywords"] or "[]"
            category = r["category"] or ""

            # 计算与 query 的相似度（content 权重 ×2 + keywords 权重 ×1.5 + category ×1）
            content_score = difflib.SequenceMatcher(None, query_lower, content.lower()).ratio()
            kw_score = difflib.SequenceMatcher(None, query_lower, kw_str.lower()).ratio()
            cat_score = difflib.SequenceMatcher(None, query_lower, category.lower()).ratio()

            # 检查是否有 term 精确出现在内容中（加分）
            bonus = 0
            content_lower = content.lower()
            for term in terms:
                if term.lower() in content_lower:
                    bonus += 0.3

            total = content_score * 2.0 + kw_score * 1.5 + cat_score * 1.0 + bonus
            scored.append((total, r))

        # 按总分降序
        scored.sort(key=lambda x: x[0], reverse=True)

        # ── 3. 格式化输出 ──
        lines = []
        for score, r in scored[:10]:
            kw = []
            try:
                kw = json.loads(r["keywords"] or "[]")
            except (json.JSONDecodeError, TypeError):
                pass
            cat = f"[{r['category']}] " if r["category"] else ""
            kw_str = f" | 标签: {', '.join(kw)}" if kw else ""
            lines.append(f"{cat}{r['content']}{kw_str}")

        return "\n".join(lines)
    finally:
        conn.close()
