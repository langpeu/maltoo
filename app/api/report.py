"""Phase 6 라우터: 교정 리포트, 기록, 코치 음성(모범 답변)."""

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import cache, db, report, scenarios
from ..config import get_config
from ..openai_client import Caller, get_caller

router = APIRouter(prefix="/api")


class TurnRec(BaseModel):
    speaker: str
    text: str
    tone: dict | None = None
    face: dict | None = None
    checkpoints: list[dict] | None = None


class ReportIn(BaseModel):
    session_id: str
    scenario_id: str
    turns: list[TurnRec]
    ending: str | None = None
    goal_progress: int = 0
    started_at: str | None = None
    difficulty: str = "normal"


@router.post("/report")
def make_report(body: ReportIn, caller: Caller = Depends(get_caller)):
    s = scenarios.get(body.scenario_id)
    turns = [t.model_dump() for t in body.turns]
    measured = report.measured_scores(turns)

    coach = {"words_score": None, "summary": "", "strengths": [], "habits": [], "fixes": [], "next_practice": ""}
    if report.my_turns(turns):
        msgs = report.build_report_messages(s, turns, body.ending, body.goal_progress, body.difficulty)
        raw = caller.chat(msgs, max_tokens=1400, feature="chat", response_format={"type": "json_object"})
        coach = report.parse_report(raw, turns)

    scores = {
        "words": coach["words_score"],
        "tone": measured["tone"],
        "face": measured["face"],
        "goal": max(0, min(100, body.goal_progress)),
    }
    scores["overall"] = report.combine(scores["words"], scores["tone"], scores["face"], scores["goal"])
    result = {**coach, "scores": scores, "per_turn": measured["per_turn"], "ending": body.ending,
              "difficulty": body.difficulty}

    # 기록 저장 (개인 기록: data.db, GitHub 에 올라가지 않음)
    now = datetime.now().isoformat(timespec="seconds")
    with db.connect() as con:
        con.execute(
            "INSERT OR REPLACE INTO sessions(id, key_id, scenario_id, started_at, ended_at, ending, summary)"
            " VALUES(?,?,?,?,?,?,?)",
            (body.session_id, caller.key_id, s["id"], body.started_at or now, now, body.ending,
             json.dumps(result, ensure_ascii=False)),
        )
        con.execute("DELETE FROM turns WHERE session_id = ?", (body.session_id,))
        for i, t in enumerate(turns):
            con.execute(
                "INSERT INTO turns(session_id, idx, speaker, text, tone, face, analysis, created_at) VALUES(?,?,?,?,?,?,?,?)",
                (body.session_id, i, t["speaker"], t["text"], json.dumps(t.get("tone")), json.dumps(t.get("face")),
                 json.dumps(t.get("checkpoints"), ensure_ascii=False), now),
            )
    return result


@router.get("/history")
def history(limit: int = 50):
    with db.connect() as con:
        rows = con.execute(
            "SELECT id, scenario_id, ended_at, ending, summary FROM sessions WHERE summary IS NOT NULL"
            " ORDER BY ended_at DESC LIMIT ?", (max(1, min(200, limit)),)).fetchall()
    out = []
    for r in rows:
        try:
            summ = json.loads(r["summary"])
        except (TypeError, json.JSONDecodeError):
            continue
        try:
            s = scenarios.get(r["scenario_id"])
            name, title = s["character"]["name"], s["title"]
        except HTTPException:
            name, title = r["scenario_id"], ""
        out.append({"id": r["id"], "scenario_id": r["scenario_id"], "name": name, "title": title,
                    "ended_at": r["ended_at"], "ending": r["ending"], "scores": summ.get("scores", {}),
                    "difficulty": summ.get("difficulty", "normal"), "next_practice": summ.get("next_practice", "")})
    return out


@router.get("/history/{session_id}")
def history_one(session_id: str):
    with db.connect() as con:
        r = con.execute("SELECT scenario_id, summary FROM sessions WHERE id = ?", (session_id,)).fetchone()
        turns = con.execute("SELECT speaker, text FROM turns WHERE session_id = ? ORDER BY idx", (session_id,)).fetchall()
    if not r:
        raise HTTPException(404, {"code": "no_session", "message": "기록이 없습니다."})
    return {"scenario_id": r["scenario_id"], "report": json.loads(r["summary"]),
            "turns": [{"speaker": t["speaker"], "text": t["text"]} for t in turns]}


class CoachIn(BaseModel):
    text: str


@router.post("/tts/coach")
def coach_voice(body: CoachIn, caller: Caller = Depends(get_caller)):
    """모범 답변을 차분하고 좋은 억양의 코치 목소리로 (실시간 생성, .runtime 캐시)."""
    text = body.text.strip()[:400]
    if not text:
        raise HTTPException(400, {"code": "empty", "message": "읽을 문장이 없습니다."})
    v = get_config()["coach"]
    key = cache.audio_key(text, v["voice"], v["instructions"])
    if not cache.runtime_path(key).exists():
        cache.save_runtime(key, caller.tts(text, v["voice"], v["instructions"]))
    return {"url": cache.runtime_url(key)}
