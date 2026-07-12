"""网页搜索工具 — 四层降级

Layer 1: 百度 AI 搜索 API（千帆平台）
Layer 2: Tavily Search API
Layer 3: 预留（将来服务器中转）
Layer 4: 模型离线知识降级
"""

import httpx
from ..config import BAIDU_AI_SEARCH_KEY, TAVILY_API_KEY, DEBUG


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
    """百度 AI 搜索 API（千帆平台 v2）"""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://qianfan.baidubce.com/v2/ai_search/chat/completions",
                headers={
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
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                if content:
                    return f"[百度搜索] {content}"

            # 429/403: 额度耗尽
            if resp.status_code in (429, 403, 402):
                if DEBUG:
                    print(f"[web_search] 百度 API 额度可能已用完 (HTTP {resp.status_code})")
                return ""

            if DEBUG:
                print(f"[web_search] 百度 API 返回 {resp.status_code}: {resp.text[:200]}")
            return ""

    except Exception as e:
        if DEBUG:
            print(f"[web_search] 百度 API 请求异常: {e}")
        return ""


async def _tavily_search(query: str) -> str:
    """Tavily Search API"""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": TAVILY_API_KEY,
                    "query": query,
                    "search_depth": "basic",
                    "max_results": 5,
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
