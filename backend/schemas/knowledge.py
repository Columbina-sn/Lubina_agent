"""知识库 Pydantic 模型"""

from pydantic import BaseModel, Field
from typing import Optional, List


# ── 旧版 knowledge_items（保留兼容）──

class KnowledgeCreate(BaseModel):
    """创建知识条目（手动输入）"""
    title: str = ""
    content: str = ""
    source_file: str = ""


class KnowledgeUpdate(BaseModel):
    """更新知识条目（所有字段可选，只更新传入的）"""
    title: Optional[str] = None
    content: Optional[str] = None
    is_visible: Optional[int] = None


class KnowledgeOut(BaseModel):
    """输出格式"""
    id: str
    title: str
    content: str
    source_file: str
    is_visible: bool
    chunk_count: int
    created_at: str
    updated_at: str


# ── 新版 knowledge_infos（结构化信息条目）──

class InfoCreate(BaseModel):
    """创建结构化信息条目"""
    category: str = ""
    content: str = ""
    keywords: List[str] = Field(default_factory=list)
    source_file: str = ""
    is_visible: int = 1


class InfoUpdate(BaseModel):
    """更新结构化信息条目"""
    category: Optional[str] = Field(None, max_length=15)
    content: Optional[str] = Field(None, max_length=150)
    keywords: Optional[List[str]] = Field(None, max_length=5)
    is_visible: Optional[int] = None


class InfoOut(BaseModel):
    """结构化信息输出"""
    id: str
    category: str
    content: str
    keywords: List[str]
    source_file: str
    content_hash: str
    is_visible: bool
    created_at: str
    updated_at: str


class InfoUploadResult(BaseModel):
    """上传处理结果摘要"""
    stored_count: int = 0
    skipped_count: int = 0
    merged_count: int = 0
    items: List[InfoOut] = Field(default_factory=list)


class InfoSearchResult(BaseModel):
    """知识库搜索结果"""
    items: List[InfoOut] = Field(default_factory=list)
    query: str = ""
    total: int = 0
