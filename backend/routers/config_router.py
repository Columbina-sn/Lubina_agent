"""用户配置 API

GET  /api/config       — 获取所有配置
GET  /api/config/{key}  — 获取单个配置
PUT  /api/config/{key}  — 设置配置
"""

from fastapi import APIRouter
from pydantic import BaseModel
from ..database import get_db
from ..utils import ok, fail

router = APIRouter(prefix="/api/config", tags=["config"])


class ConfigSetRequest(BaseModel):
    value: str


@router.get("")
async def get_all_config():
    """获取所有配置"""
    conn = get_db()
    try:
        rows = conn.execute("SELECT key, value FROM user_config").fetchall()
        result = {r["key"]: r["value"] for r in rows}
        return ok(data=result)
    finally:
        conn.close()


@router.get("/{key}")
async def get_config(key: str):
    """获取单个配置"""
    conn = get_db()
    try:
        row = conn.execute("SELECT value FROM user_config WHERE key = ?", (key,)).fetchone()
        if not row:
            return fail(message=f"配置项 '{key}' 不存在", code=404)
        return ok(data={"key": key, "value": row["value"]})
    finally:
        conn.close()


@router.put("/{key}")
async def set_config(key: str, data: ConfigSetRequest):
    """设置配置"""
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO user_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
            (key, data.value, data.value),
        )
        conn.commit()
        return ok(data={"key": key, "value": data.value})
    finally:
        conn.close()
