"""知识库 API

GET    /api/knowledge/items?visible=1/0  — 列出显式/隐藏条目
GET    /api/knowledge/items/{id}         — 获取单条详情
POST   /api/knowledge/upload             — 上传文本文件创建条目
PUT    /api/knowledge/items/{id}         — 编辑条目
PUT    /api/knowledge/items/{id}/toggle  — 切换显式/隐藏
DELETE /api/knowledge/items/{id}         — 删除条目
"""

import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, UploadFile, File
from ..database import get_db
from ..schemas.knowledge import KnowledgeCreate, KnowledgeUpdate
from ..utils import ok, fail

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


# ── 列出条目 ──

@router.get("/items")
async def list_items(visible: int = 1):
    """列出显式(visible=1)或隐藏(visible=0)的知识条目"""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM knowledge_items WHERE is_visible = ? ORDER BY updated_at DESC",
            (visible,),
        ).fetchall()
        return ok(data=[_row_to_item(r) for r in rows])
    finally:
        conn.close()


# ── 获取单条 ──

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


# ── 上传文件 ──

@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """上传文本文件，解析内容并创建知识条目"""
    # 读取文件内容
    try:
        raw = await file.read()
        content = raw.decode("utf-8", errors="replace")
    except Exception as e:
        return fail(message=f"无法读取文件: {str(e)}", code=400)

    if not content.strip():
        return fail(message="文件内容为空", code=400)

    # 从文件名推断标题（去扩展名）
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


# ── 编辑条目 ──

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


# ── 切换显隐 ──

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


# ── 删除条目 ──

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
