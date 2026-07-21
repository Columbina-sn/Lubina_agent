"""网页抓取工具 — 获取 URL 内容并提取正文

供 Re-Act 循环中的 WebFetchTool 使用。
"""

import re
import httpx
from html.parser import HTMLParser


class _TextExtractor(HTMLParser):
    """简易 HTML → 纯文本提取器"""

    def __init__(self):
        super().__init__()
        self.text = []
        self.skip_tags = {"script", "style", "noscript", "iframe", "svg", "head"}
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag.lower() in self.skip_tags:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag.lower() in self.skip_tags and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth > 0:
            return
        stripped = data.strip()
        if stripped:
            self.text.append(stripped)


async def web_fetch(url: str) -> str:
    """获取 URL 并提取可读文本

    Args:
        url: 目标网址

    Returns:
        提取后的文本（截断到 4000 字符）
    """
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                },
            )

            if resp.status_code >= 400:
                return f"无法访问该网址（HTTP {resp.status_code}）"

            html = resp.text

            # 简易 HTML → 文本提取
            extractor = _TextExtractor()
            try:
                extractor.feed(html)
            except Exception:
                pass

            text = "\n".join(extractor.text)

            # 压缩多余空行
            text = re.sub(r"\n{3,}", "\n\n", text)

            # 截断
            if len(text) > 4000:
                text = text[:4000] + "\n\n…（内容过长，已截断）"

            if not text.strip():
                return "网页内容为空或无法解析。"

            return f"[网页内容: {url}]\n{text}"

    except httpx.ConnectError:
        return f"无法连接到 {url}"
    except httpx.TimeoutException:
        return f"访问 {url} 超时"
    except Exception as e:
        return f"抓取网页时出错: {str(e)}"
