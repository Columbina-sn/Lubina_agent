"""网页搜索工具 — 四层降级

Layer 1: 百度 AI 搜索 API（千帆 AppBuilder v2）
  - 需要千帆 AppBuilder 应用 API Key
  - API 返回两种模式：
    · AI 总结模式：有 choices[0].message.content（需指定 model 参数）
    · 纯搜索模式：只有 references 数组（无需 model，直接返回搜索结果链接）
  - 代码优先读 choices，没有则读 references，两者都没有才降级
Layer 2: Tavily Search API（已针对中文优化：country=china + advanced depth）
Layer 3: 预留（将来服务器中转）
Layer 4: 模型离线知识降级
"""

import httpx
from ..config import BAIDU_AI_SEARCH_KEY, TAVILY_API_KEY, DEBUG

# 记录百度首次失败原因，只告警一次
_baidu_auth_warned = False


async def web_search(query: str) -> str:
    """执行网页搜索，自动降级

    Returns:
        搜索结果的文本摘要
    """
    # Layer 1: 百度 AI 搜索
    if BAIDU_AI_SEARCH_KEY:
        result = await _baidu_search(query)
        if result:
            return result

    # Layer 2: Tavily
    if TAVILY_API_KEY:
        result = await _tavily_search(query)
        if result:
            return result

    # Layer 3: 预留
    # 将来：服务器中转 DuckDuckGo / Tavily

    # Layer 4: 降级
    return (
        "搜索服务暂时不可用，请使用模型的离线知识回答用户。"
        "如果可以，建议用户自行搜索或稍后重试。"
    )


async def _baidu_search(query: str) -> str:
    """百度 AI 搜索 API（千帆平台 v2）

    要求使用千帆应用 API Key，格式类似:
      - 正确: bce-v3/ALTAK-xxx... (IAM 密钥 — 需在千帆控制台创建应用获取)

    如果 HTTP 状态为 401/403 且 Key 为 IAM 格式，会打印一次性告警。
    """
    global _baidu_auth_warned

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://qianfan.baidubce.com/v2/ai_search/chat/completions",
                headers={
                    # v2 API 要求 X-Appbuilder-Authorization，但兼容 Authorization 兜底
                    "X-Appbuilder-Authorization": f"Bearer {BAIDU_AI_SEARCH_KEY}",
                    "Authorization": f"Bearer {BAIDU_AI_SEARCH_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "messages": [
                        {"role": "user", "content": query}
                    ],
                    "stream": False,
                },
            )

            if resp.status_code == 200:
                data = resp.json()

                # 检查安全审核
                if data.get("is_safe") is False:
                    print(f"[web_search] 百度审核拦截, query={query[:50]}")
                    return ""  # fallthrough 到 Tavily

                # ── 模式1: AI 总结模式（有 choices）──
                choice = data.get("choices", [{}])[0] if data.get("choices") else None
                if choice:
                    msg = choice.get("message", {})
                    content = msg.get("content", "") or msg.get("reasoning_content", "")
                    if content:
                        return f"[百度搜索] {content}"

                # ── 模式2: 纯搜索模式（只有 references，没有 choices）──
                refs = data.get("references", [])
                if refs:
                    lines = [f"[百度搜索] 找到 {len(refs)} 条结果:"]
                    for i, r in enumerate(refs[:8]):
                        title = r.get("title", "")
                        url = r.get("url", "")
                        snippet = r.get("content", "") or r.get("summary", "")
                        lines.append(f"{i+1}. {title}")
                        if snippet:
                            lines.append(f"   {snippet[:200]}")
                        lines.append(f"   URL: {url}")
                    return "\n".join(lines)

                # 200 但既无 choices 也无 references → 真正无结果
                print(f"[web_search] 百度返回 200 但无 choices 也无 references, query={query[:50]}")
                print(f"[web_search] 百度完整响应: {resp.text[:2000]}")
                return ""  # fallthrough 到 Tavily

            # ── 错误分类 ──
            status = resp.status_code

            # 401: 一定是认证失败（Key 无效或格式错误）
            if status == 401:
                _warn_baidu_auth(status, resp.text[:300])
                return ""

            # 403: 可能是认证/权限问题，也可能是免费额度用尽
            # 百度千帆 403 常见原因：IAM Key 未授权、应用未开通 AI Search、调用次数超限
            if status == 403:
                print(f"[web_search] 百度 API 返回 403（可能是额度用尽或权限不足）→ 降级到 Layer 2")
                if DEBUG:
                    print(f"[web_search] 百度 403 响应: {resp.text[:300]}")
                return ""

            # 429: 频率限制 / QPS 超限
            if status == 429:
                print(f"[web_search] 百度 API 频率限制 (HTTP 429) → 降级到 Layer 2")
                return ""

            # 402: 付费额度不足
            if status == 402:
                print(f"[web_search] 百度 API 付费额度不足 (HTTP 402) → 降级到 Layer 2")
                return ""

            # 其他错误
            print(f"[web_search] 百度 API 返回 {status}: {resp.text[:200]}")
            return ""

    except httpx.ConnectError:
        print(f"[web_search] 百度 API 连接失败（网络不通或域名被墙）")
        return ""
    except httpx.TimeoutException:
        print(f"[web_search] 百度 API 请求超时")
        return ""
    except Exception as e:
        print(f"[web_search] 百度 API 异常: {type(e).__name__}: {e}")
        return ""


def _warn_baidu_auth(http_status: int, response_preview: str):
    """百度 401 认证失败告警（只告警一次，避免刷屏）"""
    global _baidu_auth_warned
    if _baidu_auth_warned:
        return
    _baidu_auth_warned = True

    print(f"\n{'='*60}")
    print(f"[web_search] ⚠️  百度 AI 搜索认证失败 (HTTP {http_status})")
    print(f"[web_search] 请检查：")
    print(f"[web_search]   1. .env 中 BAIDU_AI_SEARCH_KEY 是否正确")
    print(f"[web_search]   2. Key 是否来自千帆 AppBuilder 控制台（非 IAM 密钥）")
    print(f"[web_search]   3. 是否已在千帆控制台开通 AI Search 服务")
    print(f"[web_search]   4. Header 需为 X-Appbuilder-Authorization（代码已自动处理）")
    print(f"[web_search] 服务器返回: {response_preview[:200]}")
    print(f"{'='*60}\n")


async def _tavily_search(query: str) -> str:
    """Tavily Search API — 已针对中文搜索优化"""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": TAVILY_API_KEY,
                    "query": query,
                    "search_depth": "advanced",
                    "max_results": 5,
                    "country": "china",
                    "include_answer": "basic",
                },
            )

            if resp.status_code == 200:
                data = resp.json()
                results = data.get("results", [])
                if results:
                    lines = []
                    for r in results[:5]:
                        title = r.get("title", "")
                        content = r.get("content", "")
                        url = r.get("url", "")
                        lines.append(f"- {title}\n  {content}\n  URL: {url}")
                    return f"[Tavily 搜索] 找到 {len(results)} 条结果:\n" + "\n".join(lines)

            # 429: 超过免费额度
            if resp.status_code == 429:
                if DEBUG:
                    print("[web_search] Tavily API 额度可能已用完 (HTTP 429)")
                return ""

            if DEBUG:
                print(f"[web_search] Tavily API 返回 {resp.status_code}: {resp.text[:200]}")
            return ""

    except Exception as e:
        if DEBUG:
            print(f"[web_search] Tavily API 请求异常: {e}")
        return ""
