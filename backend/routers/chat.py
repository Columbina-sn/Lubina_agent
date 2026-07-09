"""聊天 API — 流式 SSE 代理

POST /api/chat/completions  — 接收前端请求，转发到供应商 API，流式返回
"""

import json
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from ..database import get_db
from ..schemas.chat import ChatRequest
from ..utils import fail

router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.post("/completions")
async def chat_completions(req: ChatRequest):
    """聊天接口 — 转发到指定供应商，流式返回 SSE

    对于 ask 模式：直接把用户消息转发给 AI，不添加额外提示词。
    plan/agent 模式暂时与 ask 相同（预留扩展）。
    """
    # 1. 从数据库获取供应商信息
    conn = get_db()
    try:
        provider = conn.execute(
            "SELECT * FROM providers WHERE id = ? AND is_enabled = 1",
            (req.provider_id,),
        ).fetchone()
    finally:
        conn.close()

    if not provider:
        return fail(message="供应商不存在或已停用", code=404)

    api_key = provider["api_key"] or ""
    if not api_key:
        return fail(message="请先在设置中填写 API Key", code=400)

    # 2. 拼接完整 URL（处理 base_url 和 api_path 之间的斜杠）
    base = provider["base_url"].rstrip("/")
    path = provider["api_path"] if provider["api_path"].startswith("/") else "/" + provider["api_path"]
    url = f"{base}{path}"

    # 3. 构建请求体
    body = {
        "model": req.model,
        "messages": [m.model_dump() for m in req.messages],
        "stream": True,
    }
    if req.max_tokens is not None:
        body["max_tokens"] = req.max_tokens
    if req.temperature is not None:
        body["temperature"] = req.temperature

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    # 4. 流式转发
    import httpx

    async def event_generator():
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
                async with client.stream("POST", url, headers=headers, json=body) as resp:
                    if resp.status_code >= 400:
                        # 读取错误详情
                        err_text = await resp.aread()
                        try:
                            err_json = json.loads(err_text)
                            err_msg = err_json.get("error", {}).get("message", "") or err_json.get("message", "") or resp.reason_phrase
                        except Exception:
                            err_msg = err_text.decode("utf-8", errors="replace")[:500]
                        err_data = json.dumps({"error": True, "message": err_msg})
                        yield f"data: {err_data}\n\n"
                        yield "data: [DONE]\n\n"
                        return

                    async for line in resp.aiter_lines():
                        if line.startswith("data:"):
                            yield f"{line}\n\n"
                        elif line.strip() == "":
                            pass  # 忽略空行（aiter_lines 已去掉换行符）

                    # 确保发送结束标记
                    yield "data: [DONE]\n\n"

        except httpx.ConnectError:
            err_data = json.dumps({"error": True, "message": f"无法连接到 {provider['name']} API"})
            yield f"data: {err_data}\n\n"
            yield "data: [DONE]\n\n"
        except httpx.TimeoutException:
            err_data = json.dumps({"error": True, "message": "请求超时，请重试"})
            yield f"data: {err_data}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:
            err_data = json.dumps({"error": True, "message": f"请求异常：{str(exc)}"})
            yield f"data: {err_data}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
