"""供应商管理 API

GET    /api/providers              — 列出所有供应商（含模型）
POST   /api/providers              — 添加供应商
GET    /api/providers/{id}         — 获取单个供应商
PUT    /api/providers/{id}         — 更新供应商
DELETE /api/providers/{id}         — 删除供应商
PUT    /api/providers/{id}/toggle  — 启用/停用

POST   /api/providers/{id}/models       — 添加模型
PUT    /api/providers/{id}/models/{mid}  — 更新模型
DELETE /api/providers/{id}/models/{mid}  — 删除模型
"""

import uuid
from datetime import datetime, timezone
from fastapi import APIRouter
from ..database import get_db
from ..schemas.provider import ProviderCreate, ProviderUpdate, ProviderOut, ModelCreate, ModelUpdate, ModelOut
from ..utils import ok, fail

router = APIRouter(prefix="/api/providers", tags=["providers"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _row_to_provider(row, models: list) -> dict:
    """将数据库行转为 ProviderOut dict"""
    return {
        "id": row["id"],
        "name": row["name"],
        "provider_type": row["provider_type"],
        "api_key": row["api_key"] or "",
        "base_url": row["base_url"],
        "api_path": row["api_path"] or "/v1/chat/completions",
        "is_enabled": bool(row["is_enabled"]),
        "sort_order": row["sort_order"],
        "created_at": row["created_at"] or "",
        "updated_at": row["updated_at"] or "",
        "models": models,
    }


def _get_models_for_provider(conn, provider_id: str) -> list:
    """获取某供应商的所有模型"""
    rows = conn.execute(
        "SELECT id, provider_id, model_name, display_name, is_enabled, sort_order FROM models WHERE provider_id = ? ORDER BY sort_order",
        (provider_id,),
    ).fetchall()
    return [
        {
            "id": r["id"],
            "provider_id": r["provider_id"],
            "model_name": r["model_name"],
            "display_name": r["display_name"] or r["model_name"],
            "is_enabled": bool(r["is_enabled"]),
            "sort_order": r["sort_order"],
        }
        for r in rows
    ]


# ── 供应商 CRUD ──

@router.get("")
async def list_providers():
    """列出所有供应商（含各自的模型列表）"""
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM providers ORDER BY sort_order, created_at").fetchall()
        result = []
        for row in rows:
            models = _get_models_for_provider(conn, row["id"])
            result.append(_row_to_provider(row, models))
        return ok(data=result)
    finally:
        conn.close()


@router.post("")
async def create_provider(data: ProviderCreate):
    """添加供应商"""
    conn = get_db()
    try:
        pid = f"p_{uuid.uuid4().hex[:12]}"
        now = _now_iso()
        conn.execute(
            """INSERT INTO providers (id, name, provider_type, api_key, base_url, api_path, is_enabled, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (pid, data.name, data.provider_type, data.api_key, data.base_url, data.api_path, int(data.is_enabled), data.sort_order, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM providers WHERE id = ?", (pid,)).fetchone()
        return ok(data=_row_to_provider(row, []))
    finally:
        conn.close()


@router.get("/{provider_id}")
async def get_provider(provider_id: str):
    """获取单个供应商（含模型列表）"""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone()
        if not row:
            return fail(message="供应商不存在", code=404)
        models = _get_models_for_provider(conn, provider_id)
        return ok(data=_row_to_provider(row, models))
    finally:
        conn.close()


@router.put("/{provider_id}")
async def update_provider(provider_id: str, data: ProviderUpdate):
    """更新供应商（只更新传入的字段）"""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone()
        if not row:
            return fail(message="供应商不存在", code=404)

        updates = {}
        if data.name is not None:
            updates["name"] = data.name
        if data.provider_type is not None:
            updates["provider_type"] = data.provider_type
        if data.api_key is not None:
            updates["api_key"] = data.api_key
        if data.base_url is not None:
            updates["base_url"] = data.base_url
        if data.api_path is not None:
            updates["api_path"] = data.api_path
        if data.is_enabled is not None:
            updates["is_enabled"] = int(data.is_enabled)
        if data.sort_order is not None:
            updates["sort_order"] = data.sort_order

        if updates:
            updates["updated_at"] = _now_iso()
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            values = list(updates.values()) + [provider_id]
            conn.execute(f"UPDATE providers SET {set_clause} WHERE id = ?", values)
            conn.commit()

        row = conn.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone()
        models = _get_models_for_provider(conn, provider_id)
        return ok(data=_row_to_provider(row, models))
    finally:
        conn.close()


@router.delete("/{provider_id}")
async def delete_provider(provider_id: str):
    """删除供应商（级联删除模型）"""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone()
        if not row:
            return fail(message="供应商不存在", code=404)
        conn.execute("DELETE FROM providers WHERE id = ?", (provider_id,))
        conn.commit()
        return ok(message="已删除")
    finally:
        conn.close()


@router.put("/{provider_id}/toggle")
async def toggle_provider(provider_id: str):
    """切换供应商启用/停用状态"""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone()
        if not row:
            return fail(message="供应商不存在", code=404)
        new_state = 0 if row["is_enabled"] else 1
        conn.execute("UPDATE providers SET is_enabled = ?, updated_at = ? WHERE id = ?", (new_state, _now_iso(), provider_id))
        conn.commit()
        return ok(data={"is_enabled": bool(new_state)})
    finally:
        conn.close()


# ── 模型 CRUD ──

@router.post("/{provider_id}/models")
async def create_model(provider_id: str, data: ModelCreate):
    """为供应商添加模型"""
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM providers WHERE id = ?", (provider_id,)).fetchone()
        if not row:
            return fail(message="供应商不存在", code=404)

        mid = f"pm_{uuid.uuid4().hex[:12]}"
        conn.execute(
            "INSERT INTO models (id, provider_id, model_name, display_name, is_enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
            (mid, provider_id, data.model_name, data.display_name or data.model_name, int(data.is_enabled), data.sort_order),
        )
        conn.commit()
        mrow = conn.execute("SELECT * FROM models WHERE id = ?", (mid,)).fetchone()
        return ok(data={
            "id": mrow["id"],
            "provider_id": mrow["provider_id"],
            "model_name": mrow["model_name"],
            "display_name": mrow["display_name"] or mrow["model_name"],
            "is_enabled": bool(mrow["is_enabled"]),
            "sort_order": mrow["sort_order"],
        })
    finally:
        conn.close()


@router.put("/{provider_id}/models/{model_id}")
async def update_model(provider_id: str, model_id: str, data: ModelUpdate):
    """更新模型"""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM models WHERE id = ? AND provider_id = ?", (model_id, provider_id)).fetchone()
        if not row:
            return fail(message="模型不存在", code=404)

        updates = {}
        if data.model_name is not None:
            updates["model_name"] = data.model_name
        if data.display_name is not None:
            updates["display_name"] = data.display_name
        if data.is_enabled is not None:
            updates["is_enabled"] = int(data.is_enabled)
        if data.sort_order is not None:
            updates["sort_order"] = data.sort_order

        if updates:
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            values = list(updates.values()) + [model_id]
            conn.execute(f"UPDATE models SET {set_clause} WHERE id = ?", values)
            conn.commit()

        mrow = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
        return ok(data={
            "id": mrow["id"],
            "provider_id": mrow["provider_id"],
            "model_name": mrow["model_name"],
            "display_name": mrow["display_name"] or mrow["model_name"],
            "is_enabled": bool(mrow["is_enabled"]),
            "sort_order": mrow["sort_order"],
        })
    finally:
        conn.close()


@router.delete("/{provider_id}/models/{model_id}")
async def delete_model(provider_id: str, model_id: str):
    """删除模型"""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM models WHERE id = ? AND provider_id = ?", (model_id, provider_id)).fetchone()
        if not row:
            return fail(message="模型不存在", code=404)
        conn.execute("DELETE FROM models WHERE id = ?", (model_id,))
        conn.commit()
        return ok(message="已删除")
    finally:
        conn.close()
