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

v2 改进：
- 循环不退出直到 AI 明确完成任务或达到上限
- 每次工具结果后强制 AI 评估是否还需要更多工具
- 工具调用过程中 AI 只需报告进度，不给出最终答案
"""

import json
import re
from datetime import datetime, timezone
from typing import Callable, Optional
from ..database import get_db
from ..tools.web_search import web_search
from ..tools.web_fetch import web_fetch
from ..tools.knowledge_grep import knowledge_grep
from .llm_caller import LLMCaller

DEFAULT_MAX_TOOL_CALLS = 8

# ── System Prompt ──

def _build_system_prompt() -> str:
    """构建系统提示词，包含当前北京时间"""
    from datetime import timedelta
    now = datetime.now(timezone.utc) + timedelta(hours=8)  # UTC+8 北京时间
    beijing_time = now.strftime("%Y 年 %m 月 %d 日（周%w）%H:%M")
    beijing_time = beijing_time.replace("周0", "周日").replace("周1", "周一").replace("周2", "周二").replace("周3", "周三").replace("周4", "周四").replace("周5", "周五").replace("周6", "周六")

    return f"""你是 Lubia，一款运行在用户个人电脑上的桌面 AI 助手。

当前时间：{beijing_time}（北京时间）

## 回复格式（二选一，不可混合）

A) 需要调用工具 → 只输出一行 JSON，后面不跟任何文字：
   {{"tool": "<工具名>", "parameters": {{...}}}}

B) 任务已全部完成 → 输出纯文本最终回答

绝对不能 JSON + 文字混合输出。

## 可用工具（每次调用一个）

	### 1. knowledge_grep — 搜索用户知识库
	参数: {{"query": "搜索词1 搜索词2 搜索词3"}}
	匹配词尽量简短（两个字最佳），用多个同义词/相关词（空格分隔）。
	如果一次查询无结果，换几个不同的词再试一次，不要重复使用相同的查询词。
	当搜索方向很多时（如"学习成绩+兴趣爱好+家庭住址"），必须拆分成多个方向，每个方向各写 4~5 个匹配词，分别调用一次 knowledge_grep。每个方向各四五个词完全可以。
### 2. web_search — 联网搜索
参数: {{"query": "搜索查询词"}}

### 3. web_fetch — 抓取网页内容
参数: {{"url": "https://..."}}
只抓取最相关的 1-2 个链接，不要逐个抓取所有搜索结果。

## 搜索策略

1. 个人信息 → 先 knowledge_grep
2. 实时信息 → web_search
3. 需要网页详情 → web_fetch（挑最相关的抓，不要全抓）

## 规则

- 不确定就查，不要编造信息
- 信息够了就停，不要过度搜索
- 同一工具连续 2 次无结果就该换方式或诚实说明；连续 3 次不同工具均无结果 → 系统会强制禁止继续调用，必须直接回答
- **查不到就直说查不到**：如果工具返回「未找到」，诚实告知用户，不要用训练数据里的旧知识编造
- 用中文回复，友好、详细
- 简单闲聊无需工具，直接答"""


# ── 工具调度 ──

# 工具元数据：唯一数据源，TOOL_LABELS 从此派生
# type: "read"（只读，前端合并气泡）| "write"（写入，前端独立气泡）
_TOOL_META = {
    "knowledge_grep": {"type": "read", "label": "知识库检索"},
    "web_search":     {"type": "read", "label": "联网搜索"},
    "web_fetch":      {"type": "read", "label": "网页抓取"},
}

TOOL_MAP = {
    "knowledge_grep": knowledge_grep,
    "web_search": web_search,
    "web_fetch": web_fetch,
}

TOOL_LABELS = {k: v["label"] for k, v in _TOOL_META.items()}

def _get_max_loop_rounds() -> int:
    """从 user_config 读取最大循环轮数，默认 8"""
    try:
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT value FROM user_config WHERE key = ?", ("max_loop_rounds",)
            ).fetchone()
            if row and row["value"]:
                val = int(row["value"])
                return max(5, min(20, val))
        finally:
            conn.close()
    except Exception:
        pass
    return DEFAULT_MAX_TOOL_CALLS


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
    """解析 JSON，复用 LLMCaller 成熟的多层修复逻辑"""
    obj = LLMCaller._parse_json(s)
    if isinstance(obj, dict):
        return obj
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
    """调用 AI → 返回完整响应文本（使用 LLMCaller 非流式，自带重试）"""
    caller = LLMCaller(provider_config, model)
    return await caller.call(messages, abort_check=abort_check)


async def _stream_text(text: str, stream_callback, chunk_size: int = 4):
    """将文本流式推送到前端（模拟真实的逐字输出）

    最终回复只有一次 AI 调用，拿到全文后手动分块。
    块大小为 4 字符 + 20ms 间隔，模拟人类阅读速度的流式体验。
    """
    import asyncio as _asyncio
    for i in range(0, len(text), chunk_size):
        chunk = text[i:i + chunk_size]
        await stream_callback({"type": "delta", "content": chunk})
        await _asyncio.sleep(0.02)  # 20ms 间隔，模拟自然流式


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
        full_messages.append({"role": "system", "content": _build_system_prompt()})
    full_messages.extend(messages)

    tool_call_count = 0
    consecutive_empty = 0  # 连续未产出有效结果的次数，达 3 次强制禁止重试
    max_tool_calls = _get_max_loop_rounds()
    _last_tool = ""  # 去重：上一个工具名

    while tool_call_count < max_tool_calls:
        # 检查中止
        if abort_check and abort_check():
            await stream_callback({"type": "done"})
            return "（已停止）"

        # 通知前端 AI 正在思考
        await stream_callback({"type": "thinking"})

        # ── 调用 AI（非流式：工具 JSON 短，非流式更快更可靠）──
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

        # 空响应保护
        if not tool_call and not response_text.strip():
            if tool_call_count == 0:
                await stream_callback({"type": "done"})
                return "（AI 返回了空内容，请重试）"
            full_messages.append({
                "role": "system",
                "content": "[系统通知] 你刚才的回复是空的。请基于已有的工具结果，给用户一个完整的最终回答。",
            })
            continue

        if not tool_call:
            # ✅ 最终回复 — 流式推送给前端
            await _stream_text(response_text, stream_callback)
            return response_text

        # ── 去重判断：同 read 工具连续调用 → 不计次、不弹泡 ──
        tool_name = tool_call.get("tool", "")
        params = tool_call.get("parameters", {})
        label = TOOL_LABELS.get(tool_name, tool_name)
        meta = _TOOL_META.get(tool_name, {})
        is_read = meta.get("type") == "read"

        is_dup = is_read and (tool_name == _last_tool)
        _last_tool = tool_name

        # ── 执行工具 ──
        if not is_dup:
            tool_call_count += 1
            await stream_callback({
                "type": "tool_start",
                "tool": tool_name,
                "args": params,
                "label": label,
            })

        result, error = await _execute_tool(tool_name, params)

        # 只存工具 JSON，保持上下文干净
        assistant_content = json.dumps(tool_call, ensure_ascii=False)
        full_messages.append({
            "role": "assistant",
            "content": assistant_content,
        })

        remaining = max_tool_calls - tool_call_count

        # ── 判断本次结果是否"空"（没产出有效信息）──
        is_empty = False
        if error:
            is_empty = True
        elif result:
            # 知识库/搜索/抓取返回了"没找到"类的结果 → 视为空
            empty_signals = [
                "没有找到相关信息", "未找到与", "没有找到与",
                "网页内容为空", "无法解析",
                "搜索服务暂时不可用",
            ]
            is_empty = any(sig in result for sig in empty_signals)

        if is_empty:
            consecutive_empty += 1
        else:
            consecutive_empty = 0

        if error:
            if not is_dup:
                await stream_callback({
                    "type": "tool_error",
                    "tool": tool_name,
                    "error": error,
                })
            stop_hint = ""
            if consecutive_empty >= 3:
                stop_hint = (
                    "\n[系统指令] 你已经连续 3 次尝试均未获得有效结果。"
                    "立即停止所有工具调用，用现有知识诚实回答用户。不得再发起任何工具请求。"
                )
            full_messages.append({
                "role": "system",
                "content": (
                    f"[工具结果] 工具 {tool_name} ({label}) 执行出错: {error}\n"
                    f"剩余机会: {remaining} 次。{stop_hint}"
                ),
            })
        else:
            if not is_dup:
                await stream_callback({
                    "type": "tool_result",
                    "tool": tool_name,
                    "args": params,
                    "result": result[:500],
                    "label": label,
                })
            else:
                # 重复调用：后台静默执行，通知 AI 这是重复操作
                pass

            # 截断防止上下文爆炸
            max_result_len = 2000
            if len(result) > max_result_len:
                result = result[:max_result_len] + f"\n…（截断，原 {len(result)} 字符）"

            dup_hint = "\n[系统提示] 重复调用同一工具，请换方式或基于现有信息回答。" if is_dup else ""
            stop_hint = ""
            if consecutive_empty >= 3:
                stop_hint = (
                    "\n[系统指令] 你已经连续 3 次尝试均未获得有效结果。"
                    "立即停止所有工具调用，用现有知识诚实回答用户。不得再发起任何工具请求。"
                )
            full_messages.append({
                "role": "system",
                "content": (
                    f"[工具结果] {tool_name} ({label}):\n{result}{dup_hint}\n"
                    f"剩余机会: {remaining} 次。信息够了就回答，不够可继续。{stop_hint}"
                ),
            })

    # ── 达到最大轮数，强制总结 ──
    await stream_callback({"type": "max_rounds", "max": max_tool_calls})

    full_messages.append({
        "role": "system",
        "content": (
            f"已达到最大工具调用次数 ({max_tool_calls} 次)。"
            f"你必须立即用自然语言给用户一个完整的回答。如果某些信息不全，诚实说明。"
        ),
    })

    final_text = ""
    try:
        final_text = await _call_ai_buffered(
            provider_config=dict(provider),
            model=model,
            messages=full_messages,
            abort_check=abort_check,
        )
    except Exception:
        final_text = ""

    if not final_text.strip():
        final_text = "抱歉，请重试。<small>（可在设置中调高最大循环轮数）</small>"

    # 流式推送最终回复
    await _stream_text(final_text, stream_callback)
    await stream_callback({"type": "done"})
    return final_text
