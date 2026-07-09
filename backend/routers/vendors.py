"""厂商预设信息 API

GET /api/vendors — 返回所有支持的厂商默认值
用于前端"添加供应商"时自动填充占位值。
"""

from fastapi import APIRouter
from ..utils import ok

router = APIRouter(prefix="/api/vendors", tags=["vendors"])

# 厂商预设数据（与 database.py 中 DEFAULT_PROVIDERS 保持一致）
VENDOR_DEFAULTS = [
    {
        "key": "deepseek",
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "api_path": "/v1/chat/completions",
        "default_models": ["deepseek-v4-pro", "deepseek-v4-flash"],
    },
    {
        "key": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "api_path": "/chat/completions",
        "default_models": ["gpt-4o", "gpt-4o-mini"],
    },
    {
        "key": "qwen",
        "name": "Qwen",
        "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "api_path": "/chat/completions",
        "default_models": ["qwen-plus", "qwen-max", "qwen-flash"],
    },
    {
        "key": "kimi",
        "name": "Kimi",
        "base_url": "https://api.moonshot.ai/v1",
        "api_path": "/chat/completions",
        "default_models": ["kimi-k2.6", "kimi-k2.5", "moonshot-v1-128k"],
    },
]


@router.get("")
async def list_vendors():
    """返回所有厂商预设"""
    return ok(data=VENDOR_DEFAULTS)
