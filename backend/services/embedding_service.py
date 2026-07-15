"""Embedding 服务 — bge-small-zh-v1.5 单例加载

职责：
1. 单例加载 SentenceTransformer 模型，避免每次请求重载
2. embed_content()：只编码纯文本，不加模板、不加检索前缀
   — 存储和检索统一用此方法，向量只看内容本身
3. 超长截断保护：超过 250 token 自动截断

使用方式：
  from .embedding_service import get_embedding_service
  svc = get_embedding_service()
  vec = svc.embed_content("用户就读于清华大学计算机系")
"""

import logging
import threading
from typing import List, Optional

logger = logging.getLogger("lubia.embedding")

# bge-small-zh-v1.5 配置
_MODEL_NAME = "BAAI/bge-small-zh-v1.5"

# 本地模型路径（优先）：如果项目目录下有 models/bge-small-zh-v1.5 就用本地的
# 否则走 HuggingFace 远程下载（缓存到 ~/.cache/huggingface/）
import os as _os
_LOCAL_MODEL = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))),
    "backend", "models", "bge-small-zh-v1.5"
)
if _os.path.isdir(_LOCAL_MODEL) and _os.path.isfile(_os.path.join(_LOCAL_MODEL, "config.json")):
    _MODEL_NAME = _LOCAL_MODEL  # 用本地模型，无需联网

_VEC_DIM = 512  # 向量维度
_MAX_TOKENS = 250  # 内容 token 上限

# 全局单例
_service: Optional["EmbeddingService"] = None
_lock = threading.Lock()


def get_embedding_service() -> "EmbeddingService":
    """获取 EmbeddingService 单例"""
    global _service
    if _service is None:
        with _lock:
            if _service is None:
                _service = EmbeddingService()
    return _service


class EmbeddingService:
    """bge-small-zh-v1.5 embedding 服务"""

    def __init__(self):
        self._model = None
        self._tokenizer = None
        self._loaded = False
        self._load_error: Optional[str] = None

    @property
    def is_available(self) -> bool:
        """模型是否加载成功"""
        self._ensure_loaded()
        return self._loaded

    @property
    def load_error(self) -> Optional[str]:
        """加载失败时的错误信息"""
        return self._load_error

    def _ensure_loaded(self):
        """懒加载模型（首次调用时自动加载）"""
        if self._model is not None or self._load_error is not None:
            return
        with _lock:
            if self._model is not None or self._load_error is not None:
                return
            try:
                from sentence_transformers import SentenceTransformer
                logger.info(f"正在加载 embedding 模型: {_MODEL_NAME} ...")
                self._model = SentenceTransformer(
                    _MODEL_NAME,
                    device="cpu",  # 桌面应用用 CPU，避免 GPU 内存占用
                )
                # 同时加载 tokenizer 用于计数
                from transformers import AutoTokenizer
                self._tokenizer = AutoTokenizer.from_pretrained(_MODEL_NAME)
                self._loaded = True
                logger.info(f"Embedding 模型加载完成，维度: {_VEC_DIM}")
            except ImportError:
                self._load_error = "sentence-transformers 未安装。请运行: pip install sentence-transformers"
                logger.warning(self._load_error)
            except Exception as e:
                self._load_error = f"模型加载失败: {e}"
                logger.error(self._load_error)

    # ── Token 计数 ──

    def _count_tokens(self, text: str) -> int:
        """计算文本的 token 数"""
        if self._tokenizer is None:
            # 降级：中文 ~1 char ≈ 1 token
            return len(text)
        try:
            return len(self._tokenizer.encode(text))
        except Exception:
            return len(text)

    # ── 超长截断 ──

    def _truncate_content(self, text: str, max_tokens: int) -> str:
        """按 token 数截断文本（优先保留前面的内容）"""
        if self._count_tokens(text) <= max_tokens:
            return text
        # 二分查找安全截断点（中文 ~1 char ≈ 1-2 tokens，从字符数估计）
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self._count_tokens(text[:mid]) <= max_tokens:
                lo = mid
            else:
                hi = mid - 1
        return text[:lo] + "…"

    # ── 公开 API ──

    def embed_content(self, text: str) -> Optional[List[float]]:
        """只编码纯文本，不加模板、不加检索前缀。

        存储和检索统一用此方法——向量只看内容本身，
        不看分类和关键词（那些是给 SQL LIKE 搜索用的结构化标签）。

        Args:
            text: 纯文本内容（知识条目内容 / 查询文本）

        Returns:
            512 维 float 列表（L2 归一化），失败返回 None
        """
        self._ensure_loaded()
        if not self._loaded:
            return None

        # 截断保护
        token_count = self._count_tokens(text)
        if token_count > _MAX_TOKENS:
            text = self._truncate_content(text, _MAX_TOKENS)

        try:
            emb = self._model.encode(
                text,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            return emb.tolist()
        except Exception as e:
            logger.error(f"Embedding 失败: {e}")
            return None
