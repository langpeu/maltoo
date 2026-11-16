"""사용량 → 비용 계산, 기록, 한도 검사.

모든 OpenAI 호출은 이 모듈의 check_limit() 를 먼저 거치고, 끝나면 record() 로 기록한다.
금액은 config.json 가격표로 계산한 추정치다.
"""

import json
from datetime import datetime

from . import db
from .config import get_config, pricing


class LimitExceeded(Exception):
    def __init__(self, scope: str, spent: float, limit: float, estimate: float):
        self.scope = scope  # "daily" | "monthly"
        self.spent = spent
        self.limit = limit
        self.estimate = estimate
        label = "오늘" if scope == "daily" else "이번 달"
        super().__init__(
            f"{label} 비용 한도(${limit:.2f})에 도달해서 OpenAI 호출을 막았습니다. "
            f"지금까지 ${spent:.4f} 사용, 이번 요청 예상 ${estimate:.4f}. "
            "설정에서 한도를 올리거나 내일(다음 달) 다시 시도하세요."
        )


def key_id_of(api_key: str) -> str:
    """키 원문 대신 끝 4자리만 식별자로 사용한다."""
    return api_key[-4:] if api_key and len(api_key) >= 4 else "????"


# ---------- 비용 계산 ----------

def cost_chat(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    p = pricing(model)
    return (prompt_tokens * p.get("input_per_1m", 0) + completion_tokens * p.get("output_per_1m", 0)) / 1_000_000


def cost_transcribe(model: str, seconds: float = 0.0, input_tokens: int = 0, output_tokens: int = 0) -> float:
    """토큰 사용량이 응답에 있으면 토큰 기준, 없으면 음성 길이(분) 기준."""
    p = pricing(model)
    if input_tokens or output_tokens:
        return (input_tokens * p.get("input_per_1m", 0) + output_tokens * p.get("output_per_1m", 0)) / 1_000_000
    return seconds / 60.0 * p.get("per_minute", 0)


def estimate_tts_seconds(text: str) -> float:
    """한국어 낭독 속도 약 초당 6글자로 음성 길이를 근사."""
    return max(1.0, len(text.strip()) / 6.0)


def cost_tts(model: str, text: str) -> float:
    """TTS 응답에는 사용량이 없어서 음성 길이 추정치 × 분당 가격으로 계산."""
    p = pricing(model)
    return estimate_tts_seconds(text) / 60.0 * p.get("per_minute_estimate", 0)


def cost_image(model: str, quality: str = "medium", count: int = 1) -> float:
    return pricing(model).get("per_image", {}).get(quality, 0) * count


# ---------- 한도 ----------

def limits() -> dict:
    cfg = get_config()["limits_usd"]
    return {
        "daily": float(db.get_setting("limit_daily", cfg["daily"])),
        "monthly": float(db.get_setting("limit_monthly", cfg["monthly"])),
        "warn_ratio": float(cfg.get("warn_ratio", 0.8)),
    }


def set_limits(daily: float, monthly: float) -> None:
    if daily <= 0 or monthly <= 0:
        raise ValueError("한도는 0보다 커야 합니다.")
    if daily > monthly:
        raise ValueError("일일 한도가 월 한도보다 클 수 없습니다.")
    db.set_setting("limit_daily", daily)
    db.set_setting("limit_monthly", monthly)


def _now():
    return datetime.now()


def _sum(con, key_id: str, column: str, value: str) -> float:
    row = con.execute(
        f"SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE key_id = ? AND {column} = ?",
        (key_id, value),
    ).fetchone()
    return float(row["s"])


def check_limit(key_id: str, estimate: float) -> None:
    """호출 전 사전 검사: (지금까지 사용액 + 이번 예상액) 이 한도를 넘으면 차단."""
    now = _now()
    lim = limits()
    with db.connect() as con:
        day_spent = _sum(con, key_id, "day", now.strftime("%Y-%m-%d"))
        month_spent = _sum(con, key_id, "month", now.strftime("%Y-%m"))
    if day_spent + estimate > lim["daily"]:
        raise LimitExceeded("daily", day_spent, lim["daily"], estimate)
    if month_spent + estimate > lim["monthly"]:
        raise LimitExceeded("monthly", month_spent, lim["monthly"], estimate)


# ---------- 기록 · 집계 ----------

def record(key_id: str, feature: str, model: str | None, cost_usd: float,
           session_id: str | None = None, cached: bool = False, saved_usd: float = 0.0,
           meta: dict | None = None) -> None:
    now = _now()
    with db.connect() as con:
        con.execute(
            "INSERT INTO usage(ts, day, month, key_id, session_id, feature, model, cost_usd, saved_usd, cached, meta)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                now.isoformat(timespec="seconds"), now.strftime("%Y-%m-%d"), now.strftime("%Y-%m"),
                key_id, session_id, feature, model, round(cost_usd, 8), round(saved_usd, 8),
                1 if cached else 0, json.dumps(meta or {}, ensure_ascii=False),
            ),
        )


def summary(key_id: str, session_id: str | None = None) -> dict:
    now = _now()
    day, month = now.strftime("%Y-%m-%d"), now.strftime("%Y-%m")
    with db.connect() as con:
        today = _sum(con, key_id, "day", day)
        this_month = _sum(con, key_id, "month", month)
        session = 0.0
        if session_id:
            session = float(con.execute(
                "SELECT COALESCE(SUM(cost_usd),0) s FROM usage WHERE key_id=? AND session_id=?",
                (key_id, session_id)).fetchone()["s"])
        by_feature = {
            r["feature"]: float(r["s"])
            for r in con.execute(
                "SELECT feature, SUM(cost_usd) s FROM usage WHERE key_id=? AND month=? GROUP BY feature",
                (key_id, month))
        }
        saved = float(con.execute(
            "SELECT COALESCE(SUM(saved_usd),0) s FROM usage WHERE key_id=? AND month=?",
            (key_id, month)).fetchone()["s"])
        calls = int(con.execute(
            "SELECT COUNT(*) c FROM usage WHERE key_id=? AND month=? AND cached=0 AND feature!='verify'",
            (key_id, month)).fetchone()["c"])

    lim = limits()
    krw = float(get_config()["krw_per_usd"])

    def status(spent, limit):
        r = spent / limit if limit else 0
        return "blocked" if r >= 1 else "warn" if r >= lim["warn_ratio"] else "ok"

    return {
        "key_id": key_id,
        "krw_per_usd": krw,
        "session_usd": session,
        "today_usd": today,
        "month_usd": this_month,
        "by_feature_usd": by_feature,
        "saved_usd": saved,
        "calls": calls,
        "limits": lim,
        "daily_status": status(today, lim["daily"]),
        "monthly_status": status(this_month, lim["monthly"]),
    }
