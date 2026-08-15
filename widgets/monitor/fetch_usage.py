# -*- coding: utf-8 -*-
"""读取 Hermes state.db 的 token 用量数据，输出 JSON（供小组件轮询）。
只读打开（mode=ro），绝不写入任何数据库。
数据库路径：优先读环境变量 HERMES_DB_PATHS（分号分隔，由主进程传入已检测到的路径）；
未提供时回退到本机默认安装位置。"""
import json
import os
import sqlite3
import sys
from datetime import datetime, date, timedelta


def _db_paths():
    env = os.environ.get("HERMES_DB_PATHS", "")
    if env:
        return [p.strip() for p in env.split(";") if p.strip()]
    return [
        r"C:\path\to\hermes\state.db",              # 主库（桌面版全部会话）
        r"C:\path\to\hermes\profiles\code\state.db",  # code profile（当前会话）
    ]


DBS = _db_paths()


def open_ro(path):
    try:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    except Exception:
        return None


def q(cur, sql, params=()):
    try:
        return cur.execute(sql, params).fetchall()
    except Exception:
        return []


def main():
    today = datetime.now().strftime("%Y-%m-%d")
    month_start = today[:8] + "01"
    week_ago = (datetime.now() - timedelta(days=6)).strftime("%Y-%m-%d 00:00:00")
    agg = {  # 跨库累计
        "totals": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
                   "reasoning": 0, "cost": 0.0, "calls": 0},
        "today": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
                  "reasoning": 0, "cost": 0.0, "calls": 0},
        "month": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
                  "reasoning": 0, "cost": 0.0, "calls": 0},
        "by_model": {},
        "top_sessions_today": {},
        "sessions_total": 0,
        "recent": None,       # {"title":..., "ts":..., "minutes_ago":...}
        "active_24h": [],     # [{"title":..., "ts":...}]
        "trend": [],          # 近7日 [{date:"MM-DD", billed, cost}]
    }

    for path in DBS:
        conn = open_ro(path)
        if conn is None:
            continue
        cur = conn.cursor()

        # 全量汇总
        for row in q(cur, """SELECT COALESCE(SUM(api_call_count),0),
                                    COALESCE(SUM(input_tokens),0),
                                    COALESCE(SUM(output_tokens),0),
                                    COALESCE(SUM(cache_read_tokens),0),
                                    COALESCE(SUM(cache_write_tokens),0),
                                    COALESCE(SUM(reasoning_tokens),0),
                                    COALESCE(SUM(estimated_cost_usd),0)
                             FROM session_model_usage"""):
            agg["totals"]["calls"] += row[0]
            agg["totals"]["input"] += row[1]
            agg["totals"]["output"] += row[2]
            agg["totals"]["cache_read"] += row[3]
            agg["totals"]["cache_write"] += row[4]
            agg["totals"]["reasoning"] += row[5]
            agg["totals"]["cost"] += row[6]

        # 区间汇总（今日 / 本月）
        for key, since in (("today", today + " 00:00:00"), ("month", month_start + " 00:00:00")):
            for row in q(cur, """SELECT COALESCE(SUM(api_call_count),0),
                                        COALESCE(SUM(input_tokens),0),
                                        COALESCE(SUM(output_tokens),0),
                                        COALESCE(SUM(cache_read_tokens),0),
                                        COALESCE(SUM(cache_write_tokens),0),
                                        COALESCE(SUM(reasoning_tokens),0),
                                        COALESCE(SUM(estimated_cost_usd),0)
                                 FROM session_model_usage
                                 WHERE datetime(last_seen,'unixepoch','localtime') >= ?""",
                         (since,)):
                agg[key]["calls"] += row[0]
                agg[key]["input"] += row[1]
                agg[key]["output"] += row[2]
                agg[key]["cache_read"] += row[3]
                agg[key]["cache_write"] += row[4]
                agg[key]["reasoning"] += row[5]
                agg[key]["cost"] += row[6]

        # 近 7 日逐日趋势
        for row in q(cur, """SELECT date(last_seen,'unixepoch','localtime') AS d,
                                    SUM(input_tokens + cache_read_tokens + output_tokens + reasoning_tokens),
                                    SUM(estimated_cost_usd)
                             FROM session_model_usage
                             WHERE datetime(last_seen,'unixepoch','localtime') >= ?
                             GROUP BY d""", (week_ago,)):
            agg["trend"].append({"date": row[0], "billed": row[1] or 0, "cost": row[2] or 0.0})

        # 按模型
        for row in q(cur, """SELECT model, COALESCE(SUM(api_call_count),0),
                                    COALESCE(SUM(input_tokens),0),
                                    COALESCE(SUM(output_tokens),0),
                                    COALESCE(SUM(cache_read_tokens),0),
                                    COALESCE(SUM(reasoning_tokens),0),
                                    COALESCE(SUM(estimated_cost_usd),0)
                             FROM session_model_usage GROUP BY model"""):
            m = agg["by_model"].setdefault(row[0], {"calls": 0, "input": 0, "output": 0,
                                                    "cache_read": 0, "reasoning": 0, "cost": 0.0})
            m["calls"] += row[1]
            m["input"] += row[2]
            m["output"] += row[3]
            m["cache_read"] += row[4]
            m["reasoning"] += row[5]
            m["cost"] += row[6]

        # 今日各会话排行（join sessions 拿标题）
        for row in q(cur, """SELECT COALESCE(s.title, s.display_name, u.session_id),
                                    SUM(u.input_tokens + u.output_tokens + u.reasoning_tokens),
                                    SUM(u.cache_read_tokens)
                             FROM session_model_usage u LEFT JOIN sessions s ON s.id = u.session_id
                             WHERE datetime(u.last_seen,'unixepoch','localtime') >= ?
                             GROUP BY u.session_id""",
                     (today + " 00:00:00",)):
            title, billed, cache = row[0], row[1], row[2]
            key = title[:18]
            e = agg["top_sessions_today"].setdefault(
                key, {"billed": 0, "cache": 0, "count": 0})
            e["billed"] += billed or 0
            e["cache"] += cache or 0
            e["count"] += 1

        # 会话总数
        agg["sessions_total"] += q(cur, "SELECT COUNT(*) FROM sessions")[0][0]

        # 最近活动（该库最近一次 usage）
        r = q(cur, """SELECT u.session_id, COALESCE(s.title, u.session_id),
                             MAX(u.last_seen)
                      FROM session_model_usage u LEFT JOIN sessions s ON s.id = u.session_id
                      GROUP BY u.session_id ORDER BY MAX(u.last_seen) DESC LIMIT 1""")
        for sid, title, ts in r:
            if agg["recent"] is None or ts > agg["recent"]["ts"]:
                agg["recent"] = {"title": title, "ts": ts}

        # 24h 内活跃会话
        for row in q(cur, """SELECT COALESCE(s.title, u.session_id), MAX(u.last_seen)
                             FROM session_model_usage u LEFT JOIN sessions s ON s.id = u.session_id
                             GROUP BY u.session_id
                             HAVING MAX(u.last_seen) >= strftime('%s','now','localtime') - 86400
                             ORDER BY 2 DESC LIMIT 5"""):
            agg["active_24h"].append({"title": row[0], "ts": row[1]})

        conn.close()

    # 今日排行排序、截 top5
    top = sorted(agg["top_sessions_today"].items(),
                 key=lambda kv: kv[1]["billed"], reverse=True)[:5]
    agg["top_sessions_today"] = [{"title": t, **v} for t, v in top]

    # 近7日补全缺失日期（含今日）
    day_map = {d["date"]: d for d in agg["trend"]}
    filled = []
    for i in range(6, -1, -1):
        d = (date.today() - timedelta(days=i)).isoformat()
        e = day_map.get(d, {"date": d, "billed": 0, "cost": 0.0})
        filled.append({"date": d[5:], "billed": e["billed"], "cost": e["cost"]})
    agg["trend"] = filled

    # 按模型算单价（$/1K billed tokens，含缓存读取），排序截 top5
    for m in agg["by_model"].values():
        billed = m["input"] + m["cache_read"] + m["output"] + m["reasoning"]
        m["rate"] = round(m["cost"] / billed * 1000, 4) if billed > 0 else 0.0
    model_list = sorted(agg["by_model"].items(),
                        key=lambda kv: kv[1]["input"] + kv[1]["cache_read"] + kv[1]["output"] + kv[1]["reasoning"],
                        reverse=True)[:5]
    agg["by_model"] = [{"model": k, **v} for k, v in model_list]

    if agg["recent"]:
        now = datetime.now().timestamp()
        agg["recent"]["minutes_ago"] = max(0, int((now - agg["recent"]["ts"]) / 60))

    out = {"ok": True, "fetched_at": datetime.now().strftime("%H:%M:%S"),
           **agg}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)
