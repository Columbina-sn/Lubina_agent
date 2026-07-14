"""Lubia 后端配置

所有配置项都可以通过环境变量覆盖。
桌面应用场景：127.0.0.1 绑定，不对外暴露端口。
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# ── 加载 .env 文件 ──
# 从项目根目录加载（backend 的父目录）
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)

# ── 服务器 ──
HOST = os.getenv("LUBIA_HOST", "127.0.0.1")       # 只监听本机，安全
PORT = int(os.getenv("LUBIA_PORT", "19800"))       # 前端 api.js 的 API_BASE 与此一致
DEBUG = os.getenv("LUBIA_DEBUG", "true").lower() == "true"

# ── 第三方 API Keys ──
# 百度 AI 搜索（千帆平台）
BAIDU_AI_SEARCH_KEY = os.getenv("BAIDU_AI_SEARCH_KEY", "")
# Tavily 搜索 API
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")

# ── 将来扩展 ──
# DEFAULT_MODEL: 默认模型
# MAX_TURNS: 最大对话轮数
