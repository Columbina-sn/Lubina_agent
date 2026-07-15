"""知识导入工具 — 模型提取文本 → 后台 AI 拆解 → RAG 合并 → 原子存储

供 Re-Act 循环中的 KnowledgeImportTool 使用。

设计理念：
- 模型只做"提取"：发现用户说了训练数据里没有的信息 → 摘出原文 → 调用此工具
- 分类、拆分、关键词这些是后台 AI 的活，模型不管
- 存入前 RAG 检索近似条目 → 相似则合并 → 原子写入（SQL+向量同一事务）
- 模型不用等结果，fire-and-forget

策略：
1. 接收原始文本 → 调 AI 拆解为结构化条目
2. 每条：SHA256 精确去重 → RAG 语义搜索近似条目
3. 近似条目 → 合并（内容拼接 + 关键词集合去重）
4. 原子事务：主表 + 向量表 一次性提交
"""

import json
import hashlib
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from ..database import get_db
from ..services.embedding_service import get_embedding_service
from ..services.llm_caller import LLMCaller

logger = logging.getLogger("lubia.knowledge_import")

# RAG 合并阈值：cosine distance < 0.70 直接合并（宽松——同文件提取的条目语义高度相近）
_RAG_MERGE_THRESHOLD = 0.70
# KNN 候选数
_KNN_K = 5


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _compute_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


# ── AI 拆解提示词 ──

_EXTRACTION_PROMPT = """你是一个知识提取助手。用户给了一段文本，请从中提取所有**AI 训练数据中可能不包含的**个人信息或项目细节。

返回严格的 JSON 数组格式（不要包含任何其他文字），每个元素包含三个字段：
- category: 信息分类（≤8 字，如"个人""学习""项目""偏好"）
- content: 提取的信息，**必须控制在 120 字以内**，一句讲完，去掉"用户""他"等主语
- keywords: 3~5 个搜索关键词，每个 ≤8 字，写上位概念/同义词

**关键词规则**：
- 写上位概念、同义词，不要写 content 里已有的字
- content="就读于清华大学计算机系" → 关键词用 ["学校","大学","学历","985"]

**拆分规则**：
- 一条知识一句讲完，多事实拆多条
- 去掉时间地点修饰，除非是核心信息
- 每条总字数控制在 200 字以内（embedding 上限 250 token）

示例：
[
  {"category": "个人", "content": "就读于清华大学计算机系", "keywords": ["学校","大学","学历","985"]},
  {"category": "项目", "content": "在开发桌面AI助手Lubia", "keywords": ["编程","AI","桌面应用","Python"]}
]

无可提取信息时返回 []。只输出 JSON 数组，不要任何其他文字。"""


async def knowledge_import(content: str) -> str:
    """模型提取文本 → 后台 AI 拆解 → RAG 合并 → 原子存储

    模型只需把对话中发现的、训练数据里没有的信息原文传进来，
    分类、拆分、去重、合并全部由后台处理。

    Args:
        content: 模型从对话中提取的原始文本

    Returns:
        简短确认文本
    """
    content = (content or "").strip()
    if not content:
        return "未找到可记忆的信息（内容为空）。"

    # ── 1. 调 AI 拆解为结构化条目 ──
    items = await _ai_extract(content)
    if not items:
        return "未找到可记忆的信息（AI 拆解后无可提取内容）。"

    # ── 2. 逐条处理：精确去重 → RAG 检索 → 合并/新增 → 原子写入 ──
    stored, merged, skipped = 0, 0, 0

    for item in items:
        cat = (item.get("category") or "").strip()[:15]
        txt = (item.get("content") or "").strip()
        kws = item.get("keywords") or []
        kws = [k.strip()[:8] for k in kws if k.strip()][:5]

        if not txt:
            skipped += 1
            continue

        content_hash = _compute_hash(txt)

        conn = get_db()
        try:
            # Layer 1: 精确去重
            exist = conn.execute(
                "SELECT id FROM knowledge_infos WHERE content_hash = ?",
                (content_hash,),
            ).fetchone()
            if exist:
                skipped += 1
                continue

            # Layer 2: RAG 语义搜索近似条目
            match = await _rag_find_similar(txt, conn)

            if match:
                # 合并：内容拼接 + 关键词集合去重
                _merge_item(conn, match, txt, kws)
                merged += 1
            else:
                # 新条目：原子写入主表 + 向量表
                _insert_item(conn, cat, txt, kws, content_hash)
                stored += 1

            conn.commit()
        except Exception as e:
            logger.warning(f"知识导入条目处理异常: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            skipped += 1
        finally:
            conn.close()

    parts = []
    if stored > 0:
        parts.append(f"新增 {stored} 条")
    if merged > 0:
        parts.append(f"合并 {merged} 条")
    if skipped > 0:
        parts.append(f"跳过 {skipped} 条")
    return "知识导入完成：" + "，".join(parts)


# ── AI 拆解 ──

async def _ai_extract(text: str) -> list[dict]:
    """调用 AI 将原始文本拆解为结构化知识条目"""
    from ..database import get_db as _get_db

    # 读取 KB 模型配置
    conn = _get_db()
    try:
        kb_provider = conn.execute(
            "SELECT value FROM user_config WHERE key = 'kb_provider'"
        ).fetchone()
        kb_model = conn.execute(
            "SELECT value FROM user_config WHERE key = 'kb_model'"
        ).fetchone()
    finally:
        conn.close()

    provider_id = kb_provider["value"] if kb_provider else ""
    model = kb_model["value"] if kb_model else ""

    if not provider_id or not model:
        logger.warning("知识导入：未配置 KB 模型，无法调用 AI 拆解")
        return []

    conn2 = _get_db()
    try:
        provider = conn2.execute(
            "SELECT * FROM providers WHERE id = ? AND is_enabled = 1",
            (provider_id,),
        ).fetchone()
    finally:
        conn2.close()

    if not provider:
        logger.warning(f"知识导入：KB 供应商不存在或已停用: {provider_id}")
        return []

    try:
        caller = LLMCaller(dict(provider), model)
        raw = await caller.call([
            {"role": "system", "content": _EXTRACTION_PROMPT},
            {"role": "user", "content": f"请从以下文本中提取有用信息：\n\n{text}"},
        ])
    except Exception as e:
        logger.warning(f"知识导入 AI 拆解失败: {e}")
        return []

    return _parse_items(raw)


def _parse_items(raw: str) -> list[dict]:
    """从 AI 响应中解析 JSON 数组"""
    raw = raw.strip()
    try:
        result = json.loads(raw)
        if isinstance(result, list):
            return result
        if isinstance(result, dict) and "items" in result:
            return result["items"]
        return []
    except json.JSONDecodeError:
        pass

    import re
    m = re.search(r'```(?:json)?\s*([\s\S]*?)```', raw)
    if m:
        try:
            result = json.loads(m.group(1).strip())
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass

    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            result = json.loads(raw[start:end + 1])
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass

    return []


# ── RAG 检索近似条目 ──

async def _rag_find_similar(content: str, conn) -> Optional[dict]:
    """只用 content embedding 做 RAG 比对，阈值 0.50

    两边都用 content-only embedding，语义匹配干净，
    不再需要字符串兜底（子串 / difflib）。

    Returns:
        匹配到的 knowledge_infos 行（dict），无匹配返回 None
    """
    svc = get_embedding_service()
    if not svc.is_available:
        return None

    vec = svc.embed_content(content)
    if vec is None:
        return None

    try:
        from sqlite_vec import serialize_float32
        blob = serialize_float32(vec)
    except ImportError:
        return None

    try:
        rows = conn.execute(
            """SELECT v.distance, ki.id, ki.category, ki.content, ki.keywords
               FROM (
                 SELECT rowid, distance
                 FROM vec_knowledge
                 WHERE embedding MATCH ? AND k = ?
               ) v
               INNER JOIN vec_knowledge v2 ON v.rowid = v2.rowid
               INNER JOIN knowledge_infos ki ON v2.info_id = ki.id AND ki.is_visible = 1""",
            (blob, _KNN_K),
        ).fetchall()
    except Exception as e:
        logger.warning(f"RAG 近似检索异常: {e}")
        return None

    if not rows:
        return None

    for row in rows:
        if row["distance"] is None:
            continue
        dist = float(row["distance"])

        if dist < _RAG_MERGE_THRESHOLD:
            logger.debug(f"RAG合并 | dist={dist:.4f} | content={content[:50]}…")
            return _row_to_match(row)

    return None


def _row_to_match(row) -> dict:
    return {
        "id": row["id"],
        "category": row["category"] or "",
        "content": row["content"] or "",
        "keywords": row["keywords"] or "[]",
    }


# ── 合并 & 插入（原子化）──

def _merge_item(conn, existing: dict, new_content: str, new_keywords: list):
    """合并近似条目：内容拼接 + 关键词集合去重 → UPDATE → 替换向量"""
    try:
        old_kw = json.loads(existing["keywords"] or "[]")
    except (json.JSONDecodeError, TypeError):
        old_kw = []

    merged_content = existing["content"] + "；" + new_content
    merged_kw = list(set(old_kw + new_keywords))
    merged_kw_json = json.dumps(merged_kw, ensure_ascii=False)
    info_id = existing["id"]
    now = _now_iso()

    # 更新主表
    conn.execute(
        "UPDATE knowledge_infos SET content = ?, keywords = ?, updated_at = ? WHERE id = ?",
        (merged_content, merged_kw_json, now, info_id),
    )

    # 更新向量：DELETE + INSERT（vec0 不支持 UPDATE）
    vec_blob = _embed_item(merged_content)
    if vec_blob is not None:
        try:
            conn.execute("DELETE FROM vec_knowledge WHERE info_id = ?", (info_id,))
            conn.execute(
                "INSERT INTO vec_knowledge(embedding, info_id, is_visible) VALUES (?, ?, 1)",
                (vec_blob, info_id),
            )
        except Exception as e:
            logger.warning(f"合并向量更新失败: {info_id} - {e}")


def _insert_item(conn, category: str, content: str, keywords: list, content_hash: str):
    """原子写入新条目：主表 + 向量表"""
    kid = f"ki_{uuid.uuid4().hex[:12]}"
    kw_json = json.dumps(keywords, ensure_ascii=False)
    now = _now_iso()

    conn.execute(
        """INSERT INTO knowledge_infos
           (id, category, content, keywords, source_file, content_hash, is_visible, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'AI 导入', ?, 1, ?, ?)""",
        (kid, category, content, kw_json, content_hash, now, now),
    )

    vec_blob = _embed_item(content)
    if vec_blob is not None:
        try:
            conn.execute(
                "INSERT INTO vec_knowledge(embedding, info_id, is_visible) VALUES (?, ?, 1)",
                (vec_blob, kid),
            )
        except Exception as e:
            logger.warning(f"向量写入失败: {kid} - {e}")


def _embed_item(content: str):
    """生成向量 BLOB（失败返回 None）"""
    try:
        from sqlite_vec import serialize_float32
        svc = get_embedding_service()
        if not svc.is_available:
            return None
        vec = svc.embed_content(content)
        if vec is None:
            return None
        return serialize_float32(vec)
    except ImportError:
        return None
    except Exception as e:
        logger.warning(f"Embedding 失败: {e}")
        return None
