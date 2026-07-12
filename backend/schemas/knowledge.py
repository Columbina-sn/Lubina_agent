"""知识库 Pydantic 模型"""

from pydantic import BaseModel, Field
from typing import Optional


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
