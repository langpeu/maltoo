"""Phase 1 라우터: 시나리오, 음성 합성(캐시), 음성 인식, 대화 턴."""

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .. import cache, scenarios, usage, world
from ..config import model
from ..openai_client import Caller, get_caller, get_optional_caller
from ..prompts import character

router = APIRouter(prefix="/api")

MAX_AUDIO_BYTES = 10 * 1024 * 1024


# ---------- 시나리오 ----------

@router.get("/scenarios")
def list_scenarios():
    out = []
    for s in scenarios.all_scenarios():
        d = {k: s[k] for k in ("id", "kind", "title", "character", "situation", "goal", "checklist", "fail_conditions")}
        d["lines"] = scenarios.fixed_lines(s)  # 음성 실패 시 글자로 · 추임새/결말 선택용
        d["reaction_start"] = s.get("reaction_start", "neutral")
        out.append(d)
    return out


# ---------- 음성 합성 ----------

@router.get("/tts/line/{scenario_id}/{line}")
def tts_line(scenario_id: str, line: str, cached_only: bool = False,
             caller: Caller | None = Depends(get_optional_caller)):
    """고정 대사: 캐시가 있으면 비용 0, 없으면 생성해서 assets/audio 에 저장(커밋 대상)."""
    s = scenarios.get(scenario_id)
    text = scenarios.fixed_line(s, line)
    mood = scenarios.line_mood(s, line)
    voice, instr = scenarios.voice_for(s, mood)
    key = cache.audio_key(text, voice, instr)
    if cache.fixed_path(key).exists():
        if caller:
            usage.record(caller.key_id, "tts", model("tts"), 0.0, caller.session_id, cached=True,
                         saved_usd=usage.cost_tts(model("tts"), text), meta={"key": key})
        return {"url": cache.fixed_url(key), "text": text, "cached": True}
    if cached_only:
        raise HTTPException(404, {"code": "not_cached", "message": "아직 만들어 두지 않은 음성입니다."})
    if caller is None:
        raise HTTPException(401, {"code": "no_key", "message": "OpenAI API 키가 없습니다. 키를 먼저 입력하세요."})
    data = caller.tts(text, voice, instr)
    cache.save_fixed(key, data, {"scenario": s["id"], "line": line, "text": text, "voice": voice, "mood": mood,
                                 "instructions": instr, "model": model("tts")})
    return {"url": cache.fixed_url(key), "text": text, "cached": False}


class SayIn(BaseModel):
    scenario_id: str
    text: str
    mood: str = "calm"  # calm | annoyed | angry | explosive | softened | resigned | hurt (상대의 현재 감정)


@router.post("/tts/say")
def tts_say(body: SayIn, caller: Caller = Depends(get_caller)):
    """실시간 대사: .runtime/tts 에 저장 (커밋하지 않음)."""
    s = scenarios.get(body.scenario_id)
    text = body.text.strip()[:500]
    if not text:
        raise HTTPException(400, {"code": "empty", "message": "읽을 문장이 없습니다."})
    voice, instr = scenarios.voice_for(s, body.mood)
    key = cache.audio_key(text, voice, instr)
    if not cache.runtime_path(key).exists():
        cache.save_runtime(key, caller.tts(text, voice, instr))
    return {"url": cache.runtime_url(key), "text": text}


# ---------- 음성 인식 ----------

@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), seconds: float = Form(0.0),
                     caller: Caller = Depends(get_caller)):
    data = await audio.read()
    if not data:
        raise HTTPException(400, {"code": "empty_audio", "message": "녹음된 소리가 없습니다."})
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, {"code": "too_long", "message": "녹음이 너무 깁니다."})
    text = caller.transcribe(data, audio.filename or "answer.webm", seconds)
    return {"text": text}


# ---------- 대화 턴 ----------

class Utter(BaseModel):
    speaker: str  # me | npc
    text: str


class TurnIn(BaseModel):
    scenario_id: str
    history: list[Utter] = []
    user_text: str
    nag_count: int = 0
    tone: dict | None = None  # 브라우저가 측정한 목소리 톤 요약 (녹음 원본 아님)
    face: dict | None = None  # 브라우저가 측정한 표정 요약 (영상 아님)
    difficulty: str = "normal"  # mild | normal | spicy
    session_id: str = ""
    prev_emotion: dict | None = None   # 직전 턴 상대 감정 (게임 수치 계산용)
    game_session: dict | None = None   # 이번 판 누적 감액 {cut, recovered}


@router.post("/turn")
def turn(body: TurnIn, caller: Caller = Depends(get_caller)):
    s = scenarios.get(body.scenario_id)
    turn_index = sum(1 for h in body.history if h.speaker == "me") + 1
    if turn_index > character.MAX_TURNS:
        raise HTTPException(400, {"code": "turn_over", "message": "대화가 이미 끝났습니다."})
    user_text = body.user_text.strip()
    if body.nag_count:
        user_text = f"{user_text}\n(참고: 과장은 {body.nag_count}번 재촉을 받은 뒤에야 대답했다)"
    msgs = character.build_messages(s, [h.model_dump() for h in body.history], user_text, turn_index, body.tone, body.face,
                                     body.difficulty, world.prompt_context(s))
    raw = caller.chat(msgs, max_tokens=700, feature="chat", response_format={"type": "json_object"})
    parsed = character.parse(raw, s, turn_index, body.user_text.strip(), set(world.names()))
    game = world.apply_turn(s, parsed, body.prev_emotion, body.tone, body.nag_count, body.game_session,
                            seed=f"{body.session_id}:{turn_index}")
    if game.get("ending_override"):
        parsed["ending"] = game["ending_override"]
    parsed["game"] = game
    return parsed


# ---------- 회사 세계관 ----------

@router.get("/world")
def world_overview():
    return world.overview()


class WorldStartIn(BaseModel):
    scenario_id: str


@router.post("/world/start")
def world_start(body: WorldStartIn):
    return world.start(scenarios.get(body.scenario_id))


class WorldFinishIn(BaseModel):
    scenario_id: str
    ending: str | None = None
    session: dict | None = None


@router.post("/world/finish")
def world_finish(body: WorldFinishIn):
    return world.finish(scenarios.get(body.scenario_id), body.ending, body.session)


@router.post("/world/reset")
def world_reset():
    return world.reset()
