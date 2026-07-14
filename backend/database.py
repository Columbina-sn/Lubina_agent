"""Lubia 数据库层

SQLite 连接管理、建表、种子数据。
数据库文件路径通过环境变量 LUBIA_DB_PATH 控制：
  - 开发：项目根目录 lubia_dev.db
  - 生产：用户数据目录（由 Rust 传入）
"""

import os
import sqlite3
import uuid
from datetime import datetime, timezone

# ── 数据库路径 ──
# 默认在 backend 同级目录（项目根目录）
_DEFAULT_DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lubia_dev.db")
DB_PATH = os.getenv("LUBIA_DB_PATH", _DEFAULT_DB)


def get_db() -> sqlite3.Connection:
    """获取数据库连接"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ── 建表 SQL ──

CREATE_TABLES_SQL = """
-- 供应商表
CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL DEFAULT 'custom',
    api_key TEXT DEFAULT '',
    base_url TEXT NOT NULL,
    api_path TEXT DEFAULT '/v1/chat/completions',
    is_enabled INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- 模型表
CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    is_enabled INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

-- 用户配置表
CREATE TABLE IF NOT EXISTS user_config (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- 知识库条目表（旧版，已废弃，保留兼容）
CREATE TABLE IF NOT EXISTS knowledge_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    source_file TEXT DEFAULT '',
    is_visible INTEGER DEFAULT 1,
    chunk_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- 结构化知识信息表（新版：AI 提取的去重信息条目）
CREATE TABLE IF NOT EXISTS knowledge_infos (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '',
    source_file TEXT DEFAULT '',
    content_hash TEXT DEFAULT '',
    is_visible INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
"""

# ── 默认供应商种子数据 ──

DEFAULT_PROVIDERS = [
    {
        "id": "p_deepseek",
        "name": "DeepSeek",
        "provider_type": "deepseek",
        "api_key": "",
        "base_url": "https://api.deepseek.com",
        "api_path": "/v1/chat/completions",
        "is_enabled": 1,
        "sort_order": 0,
        "models": [
            {"id": "pm_ds_pro", "model_name": "deepseek-v4-pro", "display_name": "DeepSeek V4 Pro", "is_enabled": 1, "sort_order": 0},
            {"id": "pm_ds_flash", "model_name": "deepseek-v4-flash", "display_name": "DeepSeek V4 Flash", "is_enabled": 1, "sort_order": 1},
        ],
    },
    {
        "id": "p_openai",
        "name": "OpenAI",
        "provider_type": "openai",
        "api_key": "",
        "base_url": "https://api.openai.com/v1",
        "api_path": "/chat/completions",
        "is_enabled": 0,
        "sort_order": 1,
        "models": [
            {"id": "pm_o_4o", "model_name": "gpt-4o", "display_name": "GPT-4o", "is_enabled": 1, "sort_order": 0},
            {"id": "pm_o_4omini", "model_name": "gpt-4o-mini", "display_name": "GPT-4o Mini", "is_enabled": 1, "sort_order": 1},
        ],
    },
    {
        "id": "p_qwen",
        "name": "Qwen",
        "provider_type": "qwen",
        "api_key": "",
        "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "api_path": "/chat/completions",
        "is_enabled": 0,
        "sort_order": 2,
        "models": [
            {"id": "pm_q_plus", "model_name": "qwen-plus", "display_name": "Qwen Plus", "is_enabled": 1, "sort_order": 0},
            {"id": "pm_q_max", "model_name": "qwen-max", "display_name": "Qwen Max", "is_enabled": 1, "sort_order": 1},
            {"id": "pm_q_flash", "model_name": "qwen-flash", "display_name": "Qwen Flash", "is_enabled": 1, "sort_order": 2},
        ],
    },
    {
        "id": "p_kimi",
        "name": "Kimi",
        "provider_type": "kimi",
        "api_key": "",
        "base_url": "https://api.moonshot.ai/v1",
        "api_path": "/chat/completions",
        "is_enabled": 0,
        "sort_order": 3,
        "models": [
            {"id": "pm_k_k26", "model_name": "kimi-k2.6", "display_name": "Kimi K2.6", "is_enabled": 1, "sort_order": 0},
            {"id": "pm_k_k25", "model_name": "kimi-k2.5", "display_name": "Kimi K2.5", "is_enabled": 1, "sort_order": 1},
            {"id": "pm_k_v1", "model_name": "moonshot-v1-128k", "display_name": "Moonshot V1 128K", "is_enabled": 1, "sort_order": 2},
        ],
    },
]


def _now_iso() -> str:
    """当前 UTC 时间 ISO 字符串"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def init_db():
    """初始化数据库：建表 + 插入默认数据（仅在首次运行时）"""
    # 确保目录存在
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = get_db()
    try:
        # 建表
        conn.executescript(CREATE_TABLES_SQL)

        # 检查是否已有数据（首次运行）
        count = conn.execute("SELECT COUNT(*) FROM providers").fetchone()[0]
        if count == 0:
            _seed_providers(conn)

        conn.commit()
    finally:
        conn.close()


def _seed_providers(conn: sqlite3.Connection):
    """插入默认供应商和模型数据"""
    now = _now_iso()
    for p in DEFAULT_PROVIDERS:
        conn.execute(
            """INSERT INTO providers (id, name, provider_type, api_key, base_url, api_path, is_enabled, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (p["id"], p["name"], p["provider_type"], p["api_key"], p["base_url"], p["api_path"], p["is_enabled"], p["sort_order"], now, now),
        )
        for m in p.get("models", []):
            conn.execute(
                "INSERT INTO models (id, provider_id, model_name, display_name, is_enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
                (m["id"], p["id"], m["model_name"], m.get("display_name", m["model_name"]), m["is_enabled"], m["sort_order"]),
            )

    # 默认配置
    defaults = [
        ("theme", "auto"),
        ("default_model", "deepseek-v4-flash"),
        ("default_provider", "p_deepseek"),
        ("max_turns", "15"),
        ("max_loop_rounds", "8"),
        ("chat_mode", "ask"),
        ("kb_model", ""),
        ("kb_provider", ""),
    ]
    for key, value in defaults:
        conn.execute("INSERT OR IGNORE INTO user_config (key, value) VALUES (?, ?)", (key, value))
