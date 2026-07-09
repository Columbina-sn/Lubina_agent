"""供应商 & 模型 Pydantic 模型"""

from typing import Optional, List
from pydantic import BaseModel, Field


# ── 模型 ──

class ModelCreate(BaseModel):
    """添加模型请求"""
    model_name: str = Field(..., min_length=1, description="模型名称，如 deepseek-v4-pro")
    display_name: str = Field(default="", description="显示名称")
    is_enabled: bool = Field(default=True)
    sort_order: int = Field(default=0)


class ModelUpdate(BaseModel):
    """更新模型请求"""
    model_name: Optional[str] = Field(None, min_length=1)
    display_name: Optional[str] = None
    is_enabled: Optional[bool] = None
    sort_order: Optional[int] = None


class ModelOut(BaseModel):
    """模型响应"""
    id: str
    provider_id: str
    model_name: str
    display_name: str = ""
    is_enabled: bool = True
    sort_order: int = 0


# ── 供应商 ──

class ProviderCreate(BaseModel):
    """添加供应商请求"""
    name: str = Field(..., min_length=1, description="显示名称")
    provider_type: str = Field(default="custom", description="供应商类型: deepseek/openai/qwen/kimi/custom")
    api_key: str = Field(default="", description="API Key")
    base_url: str = Field(..., min_length=1, description="API Base URL")
    api_path: str = Field(default="/v1/chat/completions", description="API Path")
    is_enabled: bool = Field(default=True)
    sort_order: int = Field(default=0)


class ProviderUpdate(BaseModel):
    """更新供应商请求（所有字段可选）"""
    name: Optional[str] = Field(None, min_length=1)
    provider_type: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = Field(None, min_length=1)
    api_path: Optional[str] = None
    is_enabled: Optional[bool] = None
    sort_order: Optional[int] = None


class ProviderOut(BaseModel):
    """供应商响应（含模型列表）"""
    id: str
    name: str
    provider_type: str = "custom"
    api_key: str = ""
    base_url: str
    api_path: str = "/v1/chat/completions"
    is_enabled: bool = True
    sort_order: int = 0
    created_at: str = ""
    updated_at: str = ""
    models: List[ModelOut] = []
