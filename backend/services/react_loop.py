"""Re-Act 循环引擎

将用户消息包装为 Re-Act 提示词 → AI 返回 text 或 tool_call →
执行工具 → 追加结果 → 继续循环 → 最终返回文本答案。

每个 SSE 事件通过 stream_callback 推送给前端：
  {"type": "thinking"}                    — AI 正在思考
  {"type": "tool_start", "tool": "...", "args": {...}, "label": "..."}
  {"type": "tool_result", "tool": "...", "result": "...", "label": "..."}
  {"type": "tool_error", "tool": "...", "error": "..."}
  {"type": "delta", "content": "..."}
  {"type": "done"}
"""

import json
import re
import httpx
from typing import Callable, Optional
from ..database import get_db
from ..tools.web_search import web_search
from ..tools.web_fetch import web_fetch
from ..tools.knowledge_grep import knowledge_grep

MAX_TOOL_CALLS = 5

# ── System Prompt ──

SYSTEM_PROMPT = """你是 Lubina，一款运行在用户个人电脑上的桌面 AI 助手。你的能力包括：

## 可用工具
当你需要超出训练数据之外的信息时，回复以下格式的 JSON 来调用工具：
{"tool": "<工具名>", "parameters": {...}}

你只能调用一个工具。收到工具结果后，再决定是否需要进一步调用。

### 1. knowledge_grep — 搜索用户知识库
搜索用户个人存储的信息（个人信息、学习资料等）。
参数: {"query": "搜索词1 搜索词2 搜索词3"}
**查询技巧：用多个简短同义词/相关词（空格分隔），不要只用一个词。**
例如用户问"在哪上学" → query: "学校 大学 就读 学历 教育"
**优先级最高：涉及用户个人信息时，必须先搜索知识库。**

### 2. web_search — 联网搜索
搜索互联网获取实时或最新信息。
参数: {"query": "搜索查询词"}

### 3. web_fetch — 抓取网页内容
读取指定 URL 的详细内容。
参数: {"url": "https://..."}

## 搜索策略（严格按此顺序）
1. 涉及用户个人信息、存储的资料、用户曾告诉过你的 → **必须先用 knowledge_grep 搜索知识库**
2. 知识库无结果，或需要实时/最新信息 → 使用 web_search 联网搜索
3. 需要阅读搜索结果的详细内容 → 使用 web_fetch 抓取

## 规则
- 每次工具调用后，分析结果并决定是否需要进一步操作
- 工具调用上限：最多 5 轮
- 知识优先：先搜知识库再联网
- 不要编造信息，不确定时用工具查
- 用中文回复用户，回复要简洁有帮助
- 简单的闲聊无需调用工具，直接回复即可"""


# ── 工具调度 ──

TOOL_MAP = {
    "knowledge_grep": knowledge_grep,
    "web_search": web_search,
    "web_fetch": web_fetch,
}

TOOL_LABELS = {
    "knowledge_grep": "知识库检索",
    "web_search": "联网搜索",
    "web_fetch": "网页抓取",
}


def _safe_str(v) -> str:
    """安全转字符串，处理 None / 数字 / 列表等各种 AI 可能输出的奇怪类型"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, (list, tuple)):
        return " ".join(str(x) for x in v if x)
    return str(v)


async def _execute_tool(tool_name: str, params: dict) -> tuple[str, str]:
    """执行工具并返回 (result_text, error_or_empty)

    对 AI 可能输出的各种奇怪参数做兜底处理。
    """
    func = TOOL_MAP.get(tool_name)
    if not func:
        return "", f"未知工具: {tool_name}"

    # 确保 params 是 dict
    if not isinstance(params, dict):
        params = {}

    try:
        if tool_name in ("knowledge_grep", "web_search"):
            query = _safe_str(params.get("query", params.get("q", params.get("search", ""))))
            if not query:
                return "", "搜索词为空，请提供 query 参数"
            result = await func(query=query)
        elif tool_name == "web_fetch":
            url = _safe_str(params.get("url", params.get("link", params.get("address", ""))))
            if not url:
                return "", "URL 为空，请提供 url 参数"
            if not url.startswith("http"):
                url = "https://" + url
            result = await func(url=url)
        else:
            return "", f"工具参数不匹配: {tool_name}"

        return result or "(工具返回空结果)", ""
    except Exception as e:
        return "", f"工具执行出错: {str(e)}"


def _try_parse_json(s: str) -> Optional[dict]:
    """尝试解析 JSON，失败则尝试修复常见 AI 错误后重试"""
    s = s.strip()
    # 直接解析
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass
    # 修复1: 单引号换双引号
    try:
        obj = json.loads(s.replace("'", '"'))
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass
    # 修复2: 去除尾部多余逗号 (},] 等)
    cleaned = re.sub(r',\s*([}\]])', r'\1', s)
    try:
        obj = json.loads(cleaned)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass
    return None


def _parse_tool_call(text: str) -> Optional[dict]:
    """从 AI 响应中解析工具调用 JSON

    支持的格式（按优先级）：
    1. 纯 JSON: {"tool": "...", "parameters": {...}}
    2. ```json ... ``` 代码块
    3. 文本中嵌入的 JSON 对象（找第一个 { 到最后一个 }）
    4. 单引号、尾部逗号等常见 AI 错误的自动修复
    """
    text = text.strip()
    if not text:
        return None

    # 尝试1: 直接解析
    obj = _try_parse_json(text)
    if obj and "tool" in obj:
        return obj

    # 尝试2: ```json ``` 代码块
    m = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if m:
        obj = _try_parse_json(m.group(1))
        if obj and "tool" in obj:
            return obj

    # 尝试3: 找第一个 { 和最后一个 }
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        obj = _try_parse_json(text[start:end + 1])
        if obj and "tool" in obj:
            return obj

    return None


async def _call_ai_buffered(
    provider_config: dict,
    model: str,
    messages: list[dict],
    abort_check: Callable = None,
) -> str:
    """调用 AI → 收集完整响应文本（不流式推送）

    先收集全部文本再返回，由调用方决定：
    - 如果是工具调用 → 不展示给用户
    - 如果是最终回复 → 作为 delta 流式推送
    """
    api_key = provider_config["api_key"] or ""
    if not api_key:
        raise ValueError("请先在设置中填写 API Key")

    base = provider_config["base_url"].rstrip("/")
    path = provider_config["api_path"]
    if not path.startswith("/"):
        path = "/" + path
    url = f"{base}{path}"

    body = {
        "model": model,
        "messages": messages,
        "stream": True,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    full_text = ""

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            if resp.status_code >= 400:
                err_text = await resp.aread()
                try:
                    err_json = json.loads(err_text)
                    err_msg = err_json.get("error", {}).get("message", "") or resp.reason_phrase
                except Exception:
                    err_msg = err_text.decode("utf-8", errors="replace")[:500]
                raise RuntimeError(f"AI API 返回错误 ({resp.status_code}): {err_msg}")

            async for line in resp.aiter_lines():
                if abort_check and abort_check():
                    full_text += "\n\n（用户已停止生成）"
                    return full_text

                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                    delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    if delta:
                        full_text += delta
                except json.JSONDecodeError:
                    pass

    return full_text


# ── 主循环 ──

async def run_react_loop(
    messages: list[dict],
    provider_id: str,
    model: str,
    stream_callback: Callable,
    abort_check: Optional[Callable] = None,
) -> str:
    """Re-Act 主循环

    Args:
        messages: 用户对话历史 [{role, content}, ...]
        provider_id: 供应商 ID
        model: 模型名称
        stream_callback: async callable(event_dict) — SSE 事件推送
        abort_check: callable() → bool — 检查是否被用户中止

    Returns:
        最终 AI 文本回复
    """
    # 获取供应商配置
    conn = get_db()
    try:
        provider = conn.execute(
            "SELECT * FROM providers WHERE id = ? AND is_enabled = 1",
            (provider_id,),
        ).fetchone()
    finally:
        conn.close()

    if not provider:
        await stream_callback({
            "type": "tool_error",
            "tool": "system",
            "error": "供应商不存在或已停用",
        })
        return "错误：AI 供应商不可用。"

    # 构建完整消息历史
    # 检查是否已有 system prompt（从对话历史中）
    has_system = any(m.get("role") == "system" for m in messages)

    full_messages = []
    if not has_system:
        full_messages.append({"role": "system", "content": SYSTEM_PROMPT})
    full_messages.extend(messages)

    tool_call_count = 0

    while tool_call_count < MAX_TOOL_CALLS:
        # 检查中止
        if abort_check and abort_check():
            await stream_callback({"type": "done"})
            return "（已停止）"

        # 通知前端 AI 正在思考
        await stream_callback({"type": "thinking"})

        # ── 调用 AI ──
        try:
            response_text = await _call_ai_buffered(
                provider_config=dict(provider),
                model=model,
                messages=full_messages,
                abort_check=abort_check,
            )
        except Exception as e:
            await stream_callback({
                "type": "tool_error",
                "tool": "system",
                "error": str(e),
            })
            await stream_callback({"type": "done"})
            return f"错误：{str(e)}"

        # ── 检查是否是工具调用 ──
        tool_call = _parse_tool_call(response_text)
        if not tool_call:
            # ✅ 最终回复 — 分块流式推送给前端
            chunk_size = 10
            for i in range(0, len(response_text), chunk_size):
                chunk = response_text[i:i + chunk_size]
                await stream_callback({"type": "delta", "content": chunk})
            await stream_callback({"type": "done"})
            return response_text

        # ── 执行工具 ──
        tool_call_count += 1
        tool_name = tool_call.get("tool", "")
        params = tool_call.get("parameters", {})
        label = TOOL_LABELS.get(tool_name, tool_name)

        await stream_callback({
            "type": "tool_start",
            "tool": tool_name,
            "args": params,
            "label": label,
        })

        result, error = await _execute_tool(tool_name, params)

        if error:
            await stream_callback({
                "type": "tool_error",
                "tool": tool_name,
                "error": error,
            })
            full_messages.append({
                "role": "assistant",
                "content": f"正在使用 {tool_name} 工具{'重试' if tool_call_count > 1 else ''}…",
            })
            full_messages.append({
                "role": "user",
                "content": f"[系统通知] 工具 {tool_name} 执行出错: {error}\n请根据现有信息继续回答用户。",
            })
        else:
            await stream_callback({
                "type": "tool_result",
                "tool": tool_name,
                "result": result,
                "label": label,
            })
            full_messages.append({
                "role": "assistant",
                "content": f"正在使用 {tool_name} 工具{'重试' if tool_call_count > 1 else ''}…",
            })
            full_messages.append({
                "role": "user",
                "content": f"[工具结果] {tool_name} 返回:\n{result}\n\n请基于以上信息继续回答用户的问题。",
            })

    # 达到最大轮数，强制 AI 总结
    full_messages.append({
        "role": "system",
        "content": f"已达到最大工具调用次数 ({MAX_TOOL_CALLS} 次)。请基于现有信息给出最佳回答。"
    })

    try:
        final_text = await _call_ai_buffered(
            provider_config=dict(provider),
            model=model,
            messages=full_messages,
            abort_check=abort_check,
        )
        # 流式推送最终回复
        chunk_size = 10
        for i in range(0, len(final_text), chunk_size):
            chunk = final_text[i:i + chunk_size]
            await stream_callback({"type": "delta", "content": chunk})
    except Exception as e:
        final_text = f"错误：{str(e)}"

    await stream_callback({"type": "done"})
    return final_text
