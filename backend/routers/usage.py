"""用量统计 API

GET /api/usage/stats?period=7d|30d|this_week|this_month
返回按天聚合的 Token 用量数据，供前端图表渲染。
"""

from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Query
from ..database import get_db

router = APIRouter(prefix="/api/usage", tags=["usage"])


def _beijing_now():
    return datetime.now(timezone.utc) + timedelta(hours=8)


def _parse_period(period: str):
    """解析时间段 → (start_date, end_date) 北京时间"""
    now = _beijing_now()
    today = now.date()

    if period == "7d":
        return today - timedelta(days=6), today
    elif period == "30d":
        return today - timedelta(days=29), today
    elif period == "210d":
        return today - timedelta(days=209), today
    elif period == "385d":
        return today - timedelta(days=384), today
    elif period == "this_week":
        weekday = today.weekday()  # 0=周一
        start = today - timedelta(days=weekday)
        return start, today
    elif period == "this_month":
        start = today.replace(day=1)
        return start, today
    else:
        # 默认 7 天
        return today - timedelta(days=6), today


@router.get("/stats")
async def get_usage_stats(period: str = Query("7d", description="时间段: 7d, 30d, this_week, this_month")):
    """获取用量统计数据"""
    start_date, end_date = _parse_period(period)

    conn = get_db()
    try:
        # 按天聚合查询
        rows = conn.execute(
            """SELECT date(created_at) as day,
                      COUNT(*) as calls,
                      SUM(est_input_tokens) as est_input,
                      SUM(est_output_tokens) as est_output,
                      SUM(actual_input_tokens) as actual_input,
                      SUM(actual_output_tokens) as actual_output
               FROM usage_logs
               WHERE date(created_at) >= ? AND date(created_at) <= ?
               GROUP BY date(created_at)
               ORDER BY day""",
            (start_date.isoformat(), end_date.isoformat()),
        ).fetchall()

        # 汇总
        total = conn.execute(
            """SELECT COUNT(*) as calls,
                      COALESCE(SUM(est_input_tokens), 0) as est_input,
                      COALESCE(SUM(est_output_tokens), 0) as est_output,
                      COALESCE(SUM(actual_input_tokens), 0) as actual_input,
                      COALESCE(SUM(actual_output_tokens), 0) as actual_output
               FROM usage_logs
               WHERE date(created_at) >= ? AND date(created_at) <= ?""",
            (start_date.isoformat(), end_date.isoformat()),
        ).fetchone()
    finally:
        conn.close()

    # 构建每日数据（含无数据的日期补零）
    daily_map = {}
    for row in rows:
        daily_map[row["day"]] = {
            "date": row["day"],
            "calls": row["calls"],
            "input_tokens": row["actual_input"] or row["est_input"] or 0,
            "output_tokens": row["actual_output"] or row["est_output"] or 0,
        }

    # 补全日期范围内所有天
    daily = []
    cursor = start_date
    while cursor <= end_date:
        ds = cursor.isoformat()
        daily.append(daily_map.get(ds, {
            "date": ds,
            "calls": 0,
            "input_tokens": 0,
            "output_tokens": 0,
        }))
        cursor += timedelta(days=1)

    # 用 actual 优先，无则用 estimate
    total_tokens = (total["actual_input"] or total["est_input"] or 0) + (total["actual_output"] or total["est_output"] or 0)
    total_calls = total["calls"] or 0

    # ── 今日统计 ──
    today_str = end_date.isoformat()
    today_data = daily_map.get(today_str, {
        "date": today_str,
        "calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
    })

    return {
        "code": 200,
        "message": "ok",
        "data": {
            "daily": daily,
            "total": {
                "calls": total_calls,
                "tokens": total_tokens,
                "input_tokens": total["actual_input"] or total["est_input"] or 0,
                "output_tokens": total["actual_output"] or total["est_output"] or 0,
            },
            "today": {
                "calls": today_data["calls"],
                "tokens": today_data["input_tokens"] + today_data["output_tokens"],
                "input_tokens": today_data["input_tokens"],
                "output_tokens": today_data["output_tokens"],
            },
            "period": period,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
        },
    }
