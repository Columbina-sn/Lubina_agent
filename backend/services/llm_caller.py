"""LLM 调用封装 — 统一的 AI API 调用层

职责：
1. 封装所有与 AI 供应商的 HTTP 通信
2. 对流式/非流式调用做统一处理
3. JSON 输出自动修复 + 重试（兜底）
4. 错误重试（指数退避，上限 3 次）

使用方式：
  from .llm_caller import LLMCaller
  caller = LLMCaller(provider_config, model)
  text = await caller.call(messages)           # 非流式，收集完整文本
  text = await caller.call_json(messages)      # 要求 JSON 输出，失败则修复+重试
  async for delta in caller.stream(messages):  # 流式迭代
      ...
"""

import json
import re
import httpx
from typing import AsyncIterator, Optional, Callable


class LLMCaller:
    """统一的 AI API 调用器"""

    def __init__(self, provider_config: dict, model: str):
        """
        Args:
            provider_config: {api_key, base_url, api_path}
            model: 模型名称
        """
        self._api_key = provider_config.get("api_key", "")
        self._base = provider_config.get("base_url", "").rstrip("/")
        self._path = provider_config.get("api_path", "/v1/chat/completions")
        self._model = model

        if not self._path.startswith("/"):
            self._path = "/" + self._path
        if not self._api_key:
            raise ValueError("API Key 未配置")

    @property
    def url(self) -> str:
        return f"{self._base}{self._path}"

    @property
    def auth_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    # ── 非流式调用 ──

    async def call(
        self,
        messages: list[dict],
        *,
        max_retries: int = 2,
        abort_check: Optional[Callable] = None,
    ) -> str:
        """非流式调用 AI → 返回完整响应文本

        Args:
            messages: 消息列表
            max_retries: 网络错误最大重试次数
            abort_check: 可选的终止检查

        Returns:
            AI 返回的完整文本

        Raises:
            RuntimeError: API 返回错误或重试耗尽
        """
        body = {
            "model": self._model,
            "messages": messages,
            "stream": False,
        }

        last_error = None
        for attempt in range(max_retries + 1):
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(120.0, connect=10.0)
                ) as client:
                    resp = await client.post(
                        self.url, headers=self.auth_headers, json=body
                    )

                    if resp.status_code >= 400:
                        err_msg = self._parse_error(resp)
                        # 4xx 错误不重试（客户端错误）
                        if 400 <= resp.status_code < 500:
                            raise RuntimeError(err_msg)
                        # 5xx 可重试
                        last_error = RuntimeError(err_msg)
                        if attempt < max_retries:
                            await self._backoff(attempt)
                            continue
                        raise last_error

                    data = resp.json()
                    content = (
                        data.get("choices", [{}])[0]
                        .get("message", {})
                        .get("content", "")
                    )
                    return content

            except (httpx.ConnectError, httpx.TimeoutException, httpx.RemoteProtocolError) as e:
                last_error = RuntimeError(f"网络连接失败: {str(e)}")
                if attempt < max_retries:
                    await self._backoff(attempt)
                    continue
                raise last_error

        raise last_error or RuntimeError("未知错误")

    # ── 流式调用 ──

    async def stream(
        self,
        messages: list[dict],
        *,
        abort_check: Optional[Callable] = None,
    ) -> AsyncIterator[str]:
        """流式调用 AI → 逐 chunk 迭代 delta 文本

        Args:
            messages: 消息列表
            abort_check: 可选的终止检查（返回 True 时中断流）

        Yields:
            每个 delta 文本片段
        """
        body = {
            "model": self._model,
            "messages": messages,
            "stream": True,
        }

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0)
        ) as client:
            async with client.stream(
                "POST", self.url, headers=self.auth_headers, json=body
            ) as resp:
                if resp.status_code >= 400:
                    err_text = await resp.aread()
                    raise RuntimeError(self._parse_error(resp, err_text))

                async for line in resp.aiter_lines():
                    if abort_check and abort_check():
                        break

                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                        delta = (
                            obj.get("choices", [{}])[0]
                            .get("delta", {})
                            .get("content", "")
                        )
                        if delta:
                            yield delta
                    except json.JSONDecodeError:
                        pass

    # ── JSON 输出（带修复 + 重试）──

    async def call_json(
        self,
        messages: list[dict],
        *,
        max_retries: int = 2,
        abort_check: Optional[Callable] = None,
    ) -> Optional[dict]:
        """要求 AI 输出 JSON，解析失败则自动修复 + 重新要求 AI 输出

        重试策略：
        1. 直接 json.loads 解析
        2. 修复常见错误（单引号、尾部逗号）后重试
        3. 从文本中提取 JSON（找 { } 或 [ ] 边界）
        4. 如果以上都失败 → 在原消息后追加错误提示，重新调用 AI（最多 max_retries 次）

        Args:
            messages: 消息列表
            max_retries: AI 重新输出的最大次数
            abort_check: 可选的终止检查

        Returns:
            解析后的 dict 或 list，失败返回 None
        """
        for attempt in range(max_retries + 1):
            try:
                raw = await self.call(messages, abort_check=abort_check)
            except Exception:
                if attempt < max_retries:
                    await self._backoff(attempt)
                    continue
                return None

            # 尝试解析
            result = self._parse_json(raw)
            if result is not None:
                return result

            # 解析失败 → 追加错误提示，让 AI 重新输出
            if attempt < max_retries:
                messages.append({
                    "role": "assistant",
                    "content": raw[:500],
                })
                messages.append({
                    "role": "user",
                    "content": (
                        "你的上一条回复不是有效的 JSON 格式。请严格按照要求的 JSON 格式重新输出，"
                        "只输出 JSON，不要包含任何解释、注释或代码块标记。"
                    ),
                })
                await self._backoff(attempt)

        return None

    # ── 内部工具 ──

    @staticmethod
    def _parse_json(raw: str) -> Optional[dict | list]:
        """多层 JSON 解析 + 修复

        尝试顺序：
        1. 纯 JSON 解析
        2. 替换单引号
        3. 移除尾部逗号
        4. ```json...``` 代码块提取
        5. 文本中 { } 或 [ ] 边界提取
        """
        raw = raw.strip()

        # 1. 直接解析
        try:
            obj = json.loads(raw)
            if isinstance(obj, (dict, list)):
                return obj
        except json.JSONDecodeError:
            pass

        # 2. 单引号 → 双引号
        try:
            obj = json.loads(raw.replace("'", '"'))
            if isinstance(obj, (dict, list)):
                return obj
        except json.JSONDecodeError:
            pass

        # 3. 移除尾部逗号 (},] 前面的逗号)
        cleaned = re.sub(r',\s*([}\]])', r'\1', raw)
        try:
            obj = json.loads(cleaned)
            if isinstance(obj, (dict, list)):
                return obj
        except json.JSONDecodeError:
            pass

        # 4. ```json ... ``` 代码块
        m = re.search(r'```(?:json)?\s*([\s\S]*?)```', raw)
        if m:
            return LLMCaller._parse_json(m.group(1))

        # 5. 找第一个 { 或 [  和对应的最后一个 } 或 ]
        for open_c, close_c in [("{", "}"), ("[", "]")]:
            start = raw.find(open_c)
            end = raw.rfind(close_c)
            if start != -1 and end != -1 and end > start:
                try:
                    obj = json.loads(raw[start:end + 1])
                    if isinstance(obj, (dict, list)):
                        return obj
                except json.JSONDecodeError:
                    pass

        return None

    @staticmethod
    def _parse_error(resp, raw_body: bytes = None) -> str:
        """从 AI API 错误响应中提取可读消息"""
        try:
            if raw_body:
                err_json = json.loads(raw_body)
            else:
                err_json = resp.json()
            err_msg = (
                err_json.get("error", {}).get("message", "")
                or err_json.get("message", "")
                or resp.reason_phrase
            )
        except Exception:
            err_msg = resp.reason_phrase or f"HTTP {resp.status_code}"
        return f"AI API 返回错误 ({resp.status_code}): {err_msg}"

    @staticmethod
    async def _backoff(attempt: int):
        """指数退避等待"""
        import asyncio
        delay = min(2 ** attempt, 8)  # 1s, 2s, 4s, 8s cap
        await asyncio.sleep(delay)
