"""聊天相关 Pydantic 模型"""

from typing import List, Optional
from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    """单条消息"""
    role: str = Field(..., description="user / assistant / system")
    content: str = Field(..., description="消息内容")


class ChatRequest(BaseModel):
    """聊天请求（流式 + 非流式统一）"""
    messages: List[ChatMessage] = Field(..., min_length=1)
    provider_id: str = Field(..., description="供应商 ID")
    model: str = Field(..., description="模型名称，如 deepseek-v4-flash")
    mode: str = Field(default="ask", description="ask / plan / agent")
    stream: bool = Field(default=True)
    max_tokens: Optional[int] = Field(default=None)
    temperature: Optional[float] = Field(default=None)
