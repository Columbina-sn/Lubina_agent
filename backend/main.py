"""Lubina 后端入口

启动方式（从项目根目录）:
    uvicorn backend.main:app --reload --port 19800

全局异常处理 + 统一响应格式 + 健康检查端点。
业务路由：providers / chat / config / vendors
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
import uvicorn

from .config import HOST, PORT, DEBUG
from .schemas.response import ApiResponse
from .database import init_db
from .routers import providers, chat, config_router, vendors
from .utils import ok, fail

# ═══════════════════════════════════════════
# App 初始化
# ═══════════════════════════════════════════


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时初始化数据库，关闭时清理资源"""
    init_db()
    yield


app = FastAPI(
    title="Lubina Backend",
    version="0.2.0",
    description="Lubina 桌面 AI 助手后端服务 —— 运行在 127.0.0.1，不对外暴露",
    lifespan=lifespan,
)

# CORS：允许前端跨域访问
# 开发时 Vite dev server 在 localhost:1420
# Tauri 生产环境 WebView 使用 tauri://localhost
# 桌面应用只监听 127.0.0.1，allow_origins=["*"] 是安全的
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ═══════════════════════════════════════════
# 响应工具函数
# ═══════════════════════════════════════════

def ok(data=None, message="ok", status_code=200):
    """成功响应 — 返回 { code:0, message, data }"""
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


# ═══════════════════════════════════════════
# 全局异常处理
# ═══════════════════════════════════════════

@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """HTTP 层面异常（404 Not Found 等）→ 包装成统一响应格式"""
    return fail(message=exc.detail, code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """请求参数校验失败（Pydantic 验证不通过）→ 友好中文提示"""
    errors = exc.errors()
    if errors:
        first = errors[0]
        # 提取字段名和错误信息，拼成人类可读的提示
        field = first.get("loc", ["unknown"])[-1]
        msg = first.get("msg", "参数校验失败")
        message = f"请求参数错误：{field} —— {msg}"
    else:
        message = "请求参数校验失败"
    return fail(message=message, code=422)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """兜底：未预期的内部错误 → 打印完整 traceback，返回 500"""
    import traceback
    traceback.print_exc()
    # DEBUG 模式下返回具体错误信息，方便调试
    detail = str(exc) if DEBUG else "服务器内部错误，请查看后端日志"
    return fail(message=f"服务器内部错误：{detail}", code=500)


# ═══════════════════════════════════════════
# 注册业务路由
# ═══════════════════════════════════════════

app.include_router(providers.router)
app.include_router(chat.router)
app.include_router(config_router.router)
app.include_router(vendors.router)

# ═══════════════════════════════════════════
# 路由
# ═══════════════════════════════════════════

@app.get("/health")
async def health():
    """健康检查 —— Tauri 用此接口判断后端是否就绪"""
    return ok(data={
        "status": "ok",
        "version": "0.1.0",
    })


# ═══════════════════════════════════════════
# 启动入口
# ═══════════════════════════════════════════

if __name__ == "__main__":
    # 直接从 backend/ 目录运行：python main.py
    # 此时相对导入会失败，需要切换到绝对导入
    uvicorn.run(
        "backend.main:app",
        host=HOST,
        port=PORT,
        reload=DEBUG,
        log_level="info",
    )
