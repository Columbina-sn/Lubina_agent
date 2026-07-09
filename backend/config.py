"""Lubina 后端配置

所有配置项都可以通过环境变量覆盖。
桌面应用场景：127.0.0.1 绑定，不对外暴露端口。
"""
import os

# ── 服务器 ──
HOST = os.getenv("LUBINA_HOST", "127.0.0.1")       # 只监听本机，安全
PORT = int(os.getenv("LUBINA_PORT", "19800"))       # 前端 api.js 的 API_BASE 与此一致
DEBUG = os.getenv("LUBINA_DEBUG", "true").lower() == "true"

# ── 将来扩展 ──
# API_KEYS: DeepSeek / OpenAI / Claude 的 Key
# DEFAULT_MODEL: 默认模型
# MAX_TURNS: 最大对话轮数
# CHROMA_DB_PATH: 向量数据库路径
