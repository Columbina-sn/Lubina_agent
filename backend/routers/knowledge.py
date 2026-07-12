"""知识库 API

旧版（knowledge_items）:
  GET    /api/knowledge/items?visible=1/0  — 列出显式/隐藏条目
  GET    /api/knowledge/items/{id}         — 获取单条详情
  POST   /api/knowledge/upload             — 上传文本文件创建条目
  PUT    /api/knowledge/items/{id}         — 编辑条目
  PUT    /api/knowledge/items/{id}/toggle  — 切换显式/隐藏
  DELETE /api/knowledge/items/{id}         — 删除条目

新版（knowledge_infos）:
  POST   /api/knowledge/ai-upload          — AI 提取上传（文件 → AI → 去重 → 存储）
  GET    /api/knowledge/infos?visible=1/0  — 列出结构化信息
  GET    /api/knowledge/infos/{id}         — 获取单条
  PUT    /api/knowledge/infos/{id}         — 编辑
  PUT    /api/knowledge/infos/{id}/toggle  — 切换显隐
  DELETE /api/knowledge/infos/{id}         — 删除
  GET    /api/knowledge/infos/search?q=    — 关键词搜索（供 GrepTool 使用）
"""

import json
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, UploadFile, File, Form, Query
from ..database import get_db
from ..schemas.knowledge import KnowledgeCreate, KnowledgeUpdate, InfoUpdate, InfoUploadResult
from ..utils import ok, fail

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ═══════════════════════════════════════════════════════
# 旧版 knowledge_items（保留兼容）
# ═══════════════════════════════════════════════════════

def _row_to_item(row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "content": row["content"],
        "source_file": row["source_file"] or "",
        "is_visible": bool(row["is_visible"]),
        "chunk_count": row["chunk_count"] or 0,
        "created_at": row["created_at"] or "",
        "updated_at": row["updated_at"] or "",
    }


@router.get("/items")
async def list_items(visible: int = 1):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM knowledge_items WHERE is_visible = ? ORDER BY updated_at DESC",
            (visible,),
        ).fetchall()
        return ok(data=[_row_to_item(r) for r in rows])
    finally:
        conn.close()


@router.get("/items/{item_id}")
async def get_item(item_id: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            return fail(message="条目不存在", code=404)
        return ok(data=_row_to_item(row))
    finally:
        conn.close()


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """旧版上传：直接存储文件原始内容"""
    try:
        raw = await file.read()
        content = raw.decode("utf-8", errors="replace")
    except Exception as e:
        return fail(message=f"无法读取文件: {str(e)}", code=400)

    if not content.strip():
        return fail(message="文件内容为空", code=400)

    title = file.filename or "未命名"
    if "." in title:
        title = title.rsplit(".", 1)[0]

    conn = get_db()
    try:
        kid = f"k_{uuid.uuid4().hex[:12]}"
        now = _now_iso()
        conn.execute(
            """INSERT INTO knowledge_items (id, title, content, source_file, is_visible, chunk_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, 1, 0, ?, ?)""",
            (kid, title, content, file.filename or "", now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (kid,)).fetchone()
        return ok(data=_row_to_item(row))
    finally:
        conn.close()


@router.put("/items/{item_id}")
async def update_item(item_id: str, data: KnowledgeUpdate):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            return fail(message="条目不存在", code=404)

        updates = {}
        if data.title is not None:
            updates["title"] = data.title
        if data.content is not None:
            updates["content"] = data.content
        if data.is_visible is not None:
            updates["is_visible"] = data.is_visible

        if updates:
            updates["updated_at"] = _now_iso()
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            values = list(updates.values()) + [item_id]
            conn.execute(f"UPDATE knowledge_items SET {set_clause} WHERE id = ?", values)
            conn.commit()

        row = conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (item_id,)).fetchone()
        return ok(data=_row_to_item(row))
    finally:
        conn.close()


@router.put("/items/{item_id}/toggle")
async def toggle_item(item_id: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            return fail(message="条目不存在", code=404)
        new_state = 0 if row["is_visible"] else 1
        now = _now_iso()
        conn.execute(
            "UPDATE knowledge_items SET is_visible = ?, updated_at = ? WHERE id = ?",
            (new_state, now, item_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (item_id,)).fetchone()
        return ok(data=_row_to_item(row))
    finally:
        conn.close()


@router.delete("/items/{item_id}")
async def delete_item(item_id: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM knowledge_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            return fail(message="条目不存在", code=404)
        conn.execute("DELETE FROM knowledge_items WHERE id = ?", (item_id,))
        conn.commit()
        return ok(message="已删除")
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════
# 新版 knowledge_infos（AI 提取 + 去重）
# ═══════════════════════════════════════════════════════

def _row_to_info(row) -> dict:
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


@router.post("/ai-upload")
async def ai_upload_file(file: UploadFile = File(...)):
    """新版上传：文件 → AI 提取结构化信息 → 两层去重 → 存入 knowledge_infos

    需要先在设置中选择"知识库存储文件模型"。不从请求参数传 model，而是从 user_config 读取。
    """
    from ..services.ai_extractor import process_file_for_knowledge

    # 读取 user_config 获取 KB 模型
    conn = get_db()
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
        return fail(message="请先在设置 → 默认模型中选择知识库存储文件模型", code=400)

    # 读取文件
    try:
        raw = await file.read()
        content = raw.decode("utf-8", errors="replace")
    except Exception as e:
        return fail(message=f"无法读取文件: {str(e)}", code=400)

    if not content.strip():
        return fail(message="文件内容为空", code=400)

    # AI 提取 + 去重 + 存储
    try:
        result = await process_file_for_knowledge(
            file_content=content,
            filename=file.filename or "未命名",
            provider_id=provider_id,
            model=model,
        )
    except Exception as e:
        return fail(message=f"AI 提取失败: {str(e)}", code=500)

    return ok(data=InfoUploadResult(
        stored_count=result["stored_count"],
        skipped_count=result["skipped_count"],
        merged_count=result["merged_count"],
        items=result["items"],
    ).model_dump())


@router.get("/infos")
async def list_infos(visible: int = 1):
    """列出结构化信息条目"""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM knowledge_infos WHERE is_visible = ? ORDER BY updated_at DESC",
            (visible,),
        ).fetchall()
        return ok(data=[_row_to_info(r) for r in rows])
    finally:
        conn.close()


@router.get("/infos/search")
async def search_infos(q: str = Query(..., min_length=1)):
    """关键词搜索知识库（供 KnowledgeGrepTool 使用）"""
    conn = get_db()
    try:
        pattern = f"%{q}%"
        rows = conn.execute(
            """SELECT * FROM knowledge_infos
               WHERE is_visible = 1
                 AND (content LIKE ? OR keywords LIKE ? OR category LIKE ?)
               ORDER BY updated_at DESC LIMIT 10""",
            (pattern, pattern, pattern),
        ).fetchall()
        result = [_row_to_info(r) for r in rows]
        return ok(data={"items": result, "query": q, "total": len(result)})
    finally:
        conn.close()


@router.get("/infos/{info_id}")
async def get_info(info_id: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM knowledge_infos WHERE id = ?", (info_id,)).fetchone()
        if not row:
            return fail(message="条目不存在", code=404)
        return ok(data=_row_to_info(row))
    finally:
        conn.close()


@router.put("/infos/{info_id}")
async def update_info(info_id: str, data: InfoUpdate):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM knowledge_infos WHERE id = ?", (info_id,)).fetchone()
        if not row:
            return fail(message="条目不存在", code=404)

        updates = {}
        if data.category is not None:
            updates["category"] = data.category
        if data.content is not None:
            updates["content"] = data.content
        if data.keywords is not None:
            updates["keywords"] = json.dumps(data.keywords, ensure_ascii=False)
        if data.is_visible is not None:
            updates["is_visible"] = data.is_visible

        if updates:
            updates["updated_at"] = _now_iso()
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            values = list(updates.values()) + [info_id]
            conn.execute(f"UPDATE knowledge_infos SET {set_clause} WHERE id = ?", values)
            conn.commit()

        row = conn.execute("SELECT * FROM knowledge_infos WHERE id = ?", (info_id,)).fetchone()
        return ok(data=_row_to_info(row))
    finally:
        conn.close()


@router.put("/infos/{info_id}/toggle")
async def toggle_info(info_id: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM knowledge_infos WHERE id = ?", (info_id,)).fetchone()
        if not row:
            return fail(message="条目不存在", code=404)
        new_state = 0 if row["is_visible"] else 1
        now = _now_iso()
        conn.execute(
            "UPDATE knowledge_infos SET is_visible = ?, updated_at = ? WHERE id = ?",
            (new_state, now, info_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM knowledge_infos WHERE id = ?", (info_id,)).fetchone()
        return ok(data=_row_to_info(row))
    finally:
        conn.close()


@router.delete("/infos/{info_id}")
async def delete_info(info_id: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM knowledge_infos WHERE id = ?", (info_id,)).fetchone()
        if not row:
            return fail(message="条目不存在", code=404)
        conn.execute("DELETE FROM knowledge_infos WHERE id = ?", (info_id,))
        conn.commit()
        return ok(message="已删除")
    finally:
        conn.close()
