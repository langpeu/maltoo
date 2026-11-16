"""API 요청 본문 모델 (FastAPI/Pydantic). 라우터는 여기서 가져다 쓴다.

키·영상·녹음 원본은 받지 않는다: 톤·표정은 브라우저가 계산한 수치 요약만 온다.
"""

from pydantic import BaseModel

# ---------- 설정·기준값 (core) ----------


class LimitsIn(BaseModel):
    daily: float
    monthly: float


class BaselineIn(BaseModel):
    tone: dict | None = None
    face: dict | None = None


# ---------- 대화·음성·세계관 (conversation) ----------


class SayIn(BaseModel):
    scenario_id: str
    text: str
    mood: str = "calm"  # calm | annoyed | angry | explosive | softened | resigned | hurt (상대의 현재 감정)


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
    prev_emotion: dict | None = None  # 직전 턴 상대 감정 (게임 수치 계산용)
    game_session: dict | None = None  # 이번 판 누적 감액 {cut, recovered}
    goal_done: list[str] = []  # 지금까지 달성한 체크리스트 항목 (유지용)
    goal_progress: int = 0  # 직전 턴 목표 달성도 (떨어지지 않게)


class WorldStartIn(BaseModel):
    scenario_id: str


class WorldFinishIn(BaseModel):
    scenario_id: str
    ending: str | None = None
    session: dict | None = None
    goal_progress: int = 0


# ---------- 초기 세팅 (setup) ----------


class JobIn(BaseModel):
    kind: str
    scenario_id: str
    line: str | None = None
    expr: str | None = None
    talk: bool = False
    ending_id: str | None = None


# ---------- 교정 리포트 (report) ----------


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
    game: dict | None = None  # 연봉·인사고과·퇴사·소문 요약 (Phase 5)


class CoachIn(BaseModel):
    text: str


# ---------- ElevenLabs 고정 대사 (eleven) ----------


class ElevenLineIn(BaseModel):
    scenario_id: str
    line: str
    voice_id: str
    voice_name: str = ""
    force: bool = False
