"""知识库语义搜索工具 — 向量 KNN + JOIN 主表

供 Re-Act 循环中的 KnowledgeRagTool 使用。

策略：
1. 用 bge-small-zh-v1.5 对查询文本做 embedding
2. vec0 KNN 搜索 top 8 相似向量
3. JOIN 主表获取完整信息 + 过滤 is_visible
4. 返回格式化结果（与 knowledge_grep 风格一致）

与 knowledge_grep 的关系：
- knowledge_grep：关键词精确匹配（SQL LIKE + difflib 排序）
- knowledge_rag：语义相似搜索（向量 KNN）
- 建议 AI 先 grep → 无结果再 rag（降级链）
- 两个工具属于同一"kb"组，连续调用算重复（不重复弹泡/不计次）
"""

import json
import logging
from ..database import get_db
from ..services.embedding_service import get_embedding_service

logger = logging.getLogger("lubia.knowledge_rag")


async def knowledge_rag(query: str) -> str:
    """在 knowledge_infos 中语义搜索

    Args:
        query: 自然语言查询文本（完整句子，不需要拆成关键词）

    Returns:
        格式化后的搜索结果文本（供 AI 阅读）
    """
    # ── 0. 检查 embedding 服务可用性 ──
    svc = get_embedding_service()
    if not svc.is_available:
        return (
            "语义搜索服务未启动。\n"
            f"原因：{svc.load_error or 'embedding 模型加载失败'}\n"
            "建议：请使用 knowledge_grep（关键词搜索）代替，或联系用户安装依赖。"
        )

    # ── 1. Embedding 查询文本 ──
    query_vec = svc.embed_query(query)
    if query_vec is None:
        return "语义搜索失败：无法对查询文本生成向量。请改用 knowledge_grep。"

    # ── 2. 序列化向量 ──
    try:
        from sqlite_vec import serialize_float32
        query_blob = serialize_float32(query_vec)
    except ImportError:
        return "语义搜索组件未安装（sqlite-vec）。请改用 knowledge_grep。"

    # ── 3. KNN 搜索 + JOIN 主表过滤 is_visible ──
    conn = get_db()
    try:
        # vec0 MATCH 触发 KNN 扫描，JOIN 后过滤 is_visible
        rows = conn.execute(
            """SELECT v.info_id, v.distance, k.category, k.content, k.keywords
               FROM vec_knowledge v
               INNER JOIN knowledge_infos k ON v.info_id = k.id
               WHERE v.embedding MATCH ? AND k.is_visible = 1 AND k = 8""",
            (query_blob,),
        ).fetchall()

        if not rows:
            return (
                "知识库语义搜索也没有找到匹配信息。\n"
                "可能原因：知识库中确实没有相关内容，或者信息尚未导入。\n"
                "建议：换个完全不同的表述描述你要找的内容再试一次，如果仍无结果就诚实告诉用户。"
            )

        # ── 4. 格式化输出（与 knowledge_grep 风格一致）──
        lines = []
        for r in rows:
            kw = []
            try:
                kw = json.loads(r["keywords"] or "[]")
            except (json.JSONDecodeError, TypeError):
                pass
            cat = f"[{r['category']}] " if r["category"] else ""
            kw_str = f" | 标签: {', '.join(kw)}" if kw else ""
            # 距离越小越相似（cosine distance），转相似度便于理解
            sim = max(0.0, 1.0 - float(r["distance"])) if r["distance"] is not None else 0.0
            sim_str = f" (相似度: {sim:.0%})" if sim > 0 else ""
            lines.append(f"{cat}{r['content']}{kw_str}{sim_str}")

        return "\n".join(lines)
    except Exception as e:
        logger.error(f"RAG 搜索异常: {e}")
        return f"语义搜索出错: {str(e)}。请改用 knowledge_grep。"
    finally:
        conn.close()
