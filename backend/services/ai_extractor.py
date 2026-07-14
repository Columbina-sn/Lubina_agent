"""AI 信息提取服务

上传文件 → 调 AI 提取结构化信息 → 两层去重 → 存入 knowledge_infos + 同步写入 vec_knowledge 向量表
"""

import json
import hashlib
import difflib
import logging
from typing import Optional
from ..database import get_db
from ..config import DEBUG
from .llm_caller import LLMCaller
from .embedding_service import get_embedding_service

logger = logging.getLogger("lubia.ai_extractor")

# 模糊匹配阈值
FUZZY_THRESHOLD = 0.85


def _compute_hash(content: str) -> str:
    """SHA256 哈希 → 第一层精确去重"""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _fuzzy_match_ratio(a: str, b: str) -> float:
    """difflib 相似度 → 第二层模糊去重"""
    return difflib.SequenceMatcher(None, a, b).ratio()


_EXTRACTION_PROMPT = """你是一个知识提取助手。用户上传了一个文件，请从中提取所有可能有用的信息，
尤其是 AI 模型训练数据中可能不包含的、对用户个人有价值的信息。

返回严格的 JSON 数组格式（不要包含任何其他文字），每个元素包含三个字段：
- category: 信息分类（≤8 字，如"个人""学习""项目"）
- content: 提取的信息，**必须控制在 120 字以内**，一句讲完，不要修饰
- keywords: 3~5 个搜索关键词，每个 ≤8 字

**关键词规则**：
- 写上位概念、同义词，不要写 content 里已有的字
- content="我就读于清华大学计算机系" → 关键词用 ["学校","大学","学历","985"]，不用 ["清华大学","计算机系"]

**精简规则**：
- 一条知识一句讲完，多事实拆多条
- 不要写"用户""他"等主语
- 去掉时间地点修饰，除非是核心信息

**每条知识总字数（category + content + keywords 合计）控制在 200 字以内**，
因为后台 embedding 会把它们拼接成一条，上限 250 字。

示例：
[
  {"category": "个人", "content": "就读于清华大学计算机系", "keywords": ["学校","大学","学历","985"]},
  {"category": "项目", "content": "开发桌面AI助手Lubia", "keywords": ["编程","AI","桌面应用","Python"]}
]

不要合并不同主题。无可提取信息时返回 []。"""


async def call_ai_non_streaming(
    provider_id: str,
    model: str,
    messages: list[dict],
) -> str:
    """非流式 AI 调用 → 返回完整响应文本

    供知识提取等不需要流式的场景使用。
    """
    from ..database import get_db as _get_db

    conn = _get_db()
    try:
        provider = conn.execute(
            "SELECT * FROM providers WHERE id = ? AND is_enabled = 1",
            (provider_id,),
        ).fetchone()
    finally:
        conn.close()

    if not provider:
        raise ValueError(f"供应商不存在或已停用: {provider_id}")

    caller = LLMCaller(dict(provider), model)
    return await caller.call(messages)


async def process_file_for_knowledge(
    file_content: str,
    filename: str,
    provider_id: str,
    model: str,
) -> dict:
    """核心流程：1. AI 提取 → 2. 解析 JSON → 3. 两层去重 → 4. 存储

    Returns:
        dict with {stored_count, skipped_count, merged_count, items}
    """
    # ── 1. AI 提取 ──
    messages = [
        {"role": "system", "content": _EXTRACTION_PROMPT},
        {"role": "user", "content": f"文件名：{filename}\n\n文件内容：\n{file_content}"},
    ]

    try:
        raw_response = await call_ai_non_streaming(provider_id, model, messages)
    except Exception as e:
        raise RuntimeError(f"AI 提取失败: {str(e)}")

    # ── 2. 解析 JSON ──
    items = _parse_extraction_json(raw_response)
    if not items:
        return {"stored_count": 0, "skipped_count": 0, "merged_count": 0, "items": []}

    # ── 3. 去重 + 存储 ──
    conn = get_db()
    try:
        stored = 0
        skipped = 0
        merged = 0
        result_items = []

        for item in items:
            category = (item.get("category") or "").strip()
            content = (item.get("content") or "").strip()
            keywords = item.get("keywords") or []

            if not content:
                skipped += 1
                continue

            # 后端长度验证：拼接后 token 数超限则跳过
            if not _check_knowledge_length(category, content, keywords):
                skipped += 1
                continue

            content_hash = _compute_hash(content)

            # Layer 1: 精确去重
            existing = conn.execute(
                "SELECT * FROM knowledge_infos WHERE content_hash = ? AND is_visible = 1",
                (content_hash,),
            ).fetchone()

            if existing:
                skipped += 1
                continue

            # Layer 2: 模糊去重
            all_items = conn.execute(
                "SELECT id, content, keywords FROM knowledge_infos WHERE is_visible = 1"
            ).fetchall()

            fuzzy_match = None
            for row in all_items:
                ratio = _fuzzy_match_ratio(content, row["content"])
                if ratio >= FUZZY_THRESHOLD:
                    fuzzy_match = row
                    break

            if fuzzy_match:
                # 合并关键词（set union）
                try:
                    old_kw = json.loads(fuzzy_match["keywords"] or "[]")
                except (json.JSONDecodeError, TypeError):
                    old_kw = []
                merged_kw = list(set(old_kw + keywords))
                conn.execute(
                    "UPDATE knowledge_infos SET keywords = ?, updated_at = datetime('now') WHERE id = ?",
                    (json.dumps(merged_kw, ensure_ascii=False), fuzzy_match["id"]),
                )
                merged += 1
                continue

            # 新条目
            import uuid
            kid = f"ki_{uuid.uuid4().hex[:12]}"
            kw_json = json.dumps(keywords, ensure_ascii=False)

            # 生成 embedding（先于 INSERT，失败不影响主流程）
            vec_blob = _embed_knowledge_item(category, content, keywords)

            conn.execute(
                """INSERT INTO knowledge_infos
                   (id, category, content, keywords, source_file, content_hash, is_visible, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))""",
                (kid, category, content, kw_json, filename, content_hash),
            )
            stored += 1

            # 写入向量表
            if vec_blob is not None:
                try:
                    conn.execute(
                        "INSERT INTO vec_knowledge(embedding, info_id, is_visible) VALUES (?, ?, 1)",
                        (vec_blob, kid),
                    )
                except Exception as e:
                    logger.warning(f"向量写入失败: {kid} - {e}")

            # 获取刚插入的条目用于返回
            new_row = conn.execute(
                "SELECT * FROM knowledge_infos WHERE id = ?", (kid,)
            ).fetchone()
            if new_row:
                result_items.append(_row_to_info(new_row))

        conn.commit()
        return {
            "stored_count": stored,
            "skipped_count": skipped,
            "merged_count": merged,
            "items": result_items,
        }
    finally:
        conn.close()


def _check_knowledge_length(category: str, content: str, keywords: list) -> bool:
    """检查知识条目拼接后是否超 250 token。True=通过。"""
    from .embedding_service import EMBED_TEMPLATE, get_embedding_service
    kw_str = ", ".join(keywords) if keywords else ""
    full = EMBED_TEMPLATE.format(category=category or "", content=content or "", keywords=kw_str)
    try:
        svc = get_embedding_service()
        if svc.is_available:
            return svc._count_tokens(full) <= 250
    except Exception:
        pass
    return len(full) <= 250  # 降级：按字符数估算


def _embed_knowledge_item(category: str, content: str, keywords: list) -> Optional[bytes]:
    """生成知识条目向量（返回序列化后的 BLOB，失败返回 None）"""
    try:
        svc = get_embedding_service()
        if not svc.is_available:
            return None
        vec = svc.embed_knowledge(category, content, keywords)
        if vec is None:
            return None
        from sqlite_vec import serialize_float32
        return serialize_float32(vec)
    except ImportError:
        return None
    except Exception as e:
        logger.warning(f"Embedding 失败: {e}")
        return None


def _parse_extraction_json(raw: str) -> list[dict]:
    """从 AI 响应中解析 JSON 数组"""
    raw = raw.strip()
    # 尝试直接解析
    try:
        result = json.loads(raw)
        if isinstance(result, list):
            return result
        if isinstance(result, dict) and "items" in result:
            return result["items"]
        return []
    except json.JSONDecodeError:
        pass

    # 尝试提取 ```json ... ``` 代码块
    import re
    m = re.search(r'```(?:json)?\s*([\s\S]*?)```', raw)
    if m:
        try:
            result = json.loads(m.group(1).strip())
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass

    # 尝试找到第一个 [ 和最后一个 ]
    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            result = json.loads(raw[start:end + 1])
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass

    if DEBUG:
        print(f"[ai_extractor] 无法解析 AI 响应为 JSON: {raw[:300]}...")
    return []


def _row_to_info(row) -> dict:
    """将 SQLite Row 转为 InfoOut 字典"""
    try:
        kw = json.loads(row["keywords"] or "[]")
    except (json.JSONDecodeError, TypeError):
        kw = []
    return {
        "id": row["id"],
        "category": row["category"] or "",
        "content": row["content"] or "",
        "keywords": kw,
        "source_file": row["source_file"] or "",
        "content_hash": row["content_hash"] or "",
        "is_visible": bool(row["is_visible"]),
        "created_at": row["created_at"] or "",
        "updated_at": row["updated_at"] or "",
    }
