"""响应工具函数 — 供所有路由模块使用

提取到独立文件以避免循环导入。
"""

from fastapi.responses import JSONResponse


def ok(data=None, message="ok", status_code=200):
    """成功响应 — 返回 { code:200, message, data }"""
    return JSONResponse(
        content={"code": 200, "message": message, "data": data},
        status_code=status_code,
    )


def fail(message, code=400, status_code=None):
    """失败响应 — 返回 { code, message, data:null }"""
    return JSONResponse(
        content={"code": code, "message": message, "data": None},
        status_code=status_code or code,
    )
