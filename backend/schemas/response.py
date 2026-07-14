"""统一响应模型

所有 API 响应都遵循此格式：
  { "code": 200, "message": "ok", "data": { ... } }

  - code=200     → 成功
  - code≠200     → 失败（值为 HTTP 状态码：400/404/422/500 等）
  - message      → 人类可读的提示信息
  - data         → 实际数据，失败时为 null

为什么 code=200 而不是 code=0？
  和 HTTP 协议保持一致——200 在 HTTP 中就是"成功"的含义，不需要额外记忆规则。
  错误时直接用 HTTP 状态码（404、422、500），整个系统统一用一套数字体系。
"""
from typing import Any, Optional
from pydantic import BaseModel


class ApiResponse(BaseModel):
    """Lubia 后端统一响应"""
    code: int = 200                  # 200=成功，非200=错误（对齐 HTTP 状态码语义）
    message: str = "ok"              # 人类可读的提示信息
    data: Optional[Any] = None       # 实际数据，失败时为 null
