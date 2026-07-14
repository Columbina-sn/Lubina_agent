"""Embedding 服务 — bge-small-zh-v1.5 单例加载

职责：
1. 单例加载 SentenceTransformer 模型，避免每次请求重载
2. 知识条目 embedding：{category} | {content} | 关键词: {kw1, kw2, ...}
   （文档侧不加检索前缀）
3. 查询 embedding：检索前缀 + 用户原始查询
   （查询侧自动加前缀）
4. 超长截断保护：拼接后 token > 480 则按比例截断 content

使用方式：
  from .embedding_service import get_embedding_service
  svc = get_embedding_service()
  vec = svc.embed_knowledge("个人信息", "用户就读于清华", ["学校", "学历"])
  vec = svc.embed_query("用户在哪里上学")
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
_MAX_TOKENS = 250  # 知识条目总 token 上限（category + content + keywords 合计）
_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："

# 拼接模板（供外部验证长度使用）
EMBED_TEMPLATE = "{category} | {content} | 关键词: {keywords}"

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

    def embed_knowledge(
        self,
        category: str = "",
        content: str = "",
        keywords: List[str] = None,
    ) -> Optional[List[float]]:
        """对知识条目做 embedding（文档侧，不加检索前缀）

        Args:
            category: 信息类别
            content:  信息内容
            keywords: 关键词列表

        Returns:
            512 维 float 列表（L2 归一化），失败返回 None
        """
        self._ensure_loaded()
        if not self._loaded:
            return None

        kw_str = ", ".join(keywords) if keywords else ""
        text = EMBED_TEMPLATE.format(
            category=category or "",
            content=content or "",
            keywords=kw_str,
        )

        # 截断保护
        token_count = self._count_tokens(text)
        if token_count > _MAX_TOKENS:
            # 计算 content 需要缩减多少
            template_without_content = EMBED_TEMPLATE.format(
                category=category or "", content="", keywords=kw_str,
            )
            template_tokens = self._count_tokens(template_without_content)
            available = _MAX_TOKENS - template_tokens
            if available > 10:
                truncated = self._truncate_content(content or "", available)
                text = EMBED_TEMPLATE.format(
                    category=category or "", content=truncated, keywords=kw_str,
                )
            else:
                # 模板本身就超了 → 只取 category + 截断 content，不放关键词
                text = self._truncate_content(f"{category} | {content}", _MAX_TOKENS)

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

    def embed_query(self, query: str) -> Optional[List[float]]:
        """对查询文本做 embedding（查询侧，加检索前缀）

        Args:
            query: 用户查询文本（原始自然语言）

        Returns:
            512 维 float 列表（L2 归一化），失败返回 None
        """
        self._ensure_loaded()
        if not self._loaded:
            return None

        # 加检索前缀
        text = _QUERY_PREFIX + query

        # 截断保护
        if self._count_tokens(text) > _MAX_TOKENS:
            # 前缀约 15-20 tokens，剩余给 query
            prefix_tokens = self._count_tokens(_QUERY_PREFIX)
            available = _MAX_TOKENS - prefix_tokens
            if available > 10:
                text = _QUERY_PREFIX + self._truncate_content(query, available)
            else:
                text = self._truncate_content(text, _MAX_TOKENS)

        try:
            emb = self._model.encode(
                text,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            return emb.tolist()
        except Exception as e:
            logger.error(f"Query embedding 失败: {e}")
            return None
