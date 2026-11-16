"""Phase 0 라우터: 공개 설정, 키 확인, 비용 집계, 한도 설정, 연결 테스트."""

import json
from datetime import datetime

import httpx

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .. import db, usage
from ..config import ROOT, get_config
from ..openai_client import SESSION_HEADER, Caller, get_caller

router = APIRouter(prefix="/api")


@router.get("/config")
def public_config():
    cfg = get_config()
    return {
        "company": cfg.get("company", {}),
        "models": cfg["models"],
        "krw_per_usd": cfg["krw_per_usd"],
        "limits": usage.limits(),
        "face": cfg.get("face", {}),
    }


@router.post("/key/verify")
def verify_key(caller: Caller = Depends(get_caller)):
    """models.list 는 과금되지 않는 요청이라 키 확인용으로 쓴다."""
    caller.verify()
    usage.record(caller.key_id, "verify", None, 0.0, caller.session_id)
    return {"ok": True, "key_hint": f"sk-...{caller.key_id}"}


@router.get("/usage")
def get_usage(request: Request, caller: Caller = Depends(get_caller)):
    return usage.summary(caller.key_id, request.headers.get(SESSION_HEADER))


class LimitsIn(BaseModel):
    daily: float
    monthly: float


@router.put("/settings/limits")
def put_limits(body: LimitsIn):
    try:
        usage.set_limits(body.daily, body.monthly)
    except ValueError as e:
        raise HTTPException(400, {"code": "bad_limits", "message": str(e)})
    return usage.limits()


@router.post("/test/chat")
def test_chat(caller: Caller = Depends(get_caller)):
    """비용 패널이 제대로 움직이는지 확인하는 아주 작은 호출 (1원 미만)."""
    company = get_config().get("company", {}).get("name", "회사")
    text = caller.chat(
        [
            {"role": "system", "content": f"너는 {company}의 사내 메신저 봇이다. 한 문장으로 짧게 답한다."},
            {"role": "user", "content": "출근 인사 한마디 해줘."},
        ],
        max_tokens=40,
        feature="chat",
    )
    return {"reply": text.strip(), "usage": usage.summary(caller.key_id, caller.session_id)}


# ---------- 평소 목소리(기준선) ----------

class BaselineIn(BaseModel):
    tone: dict | None = None
    face: dict | None = None


@router.get("/baseline")
def get_baseline():
    with db.connect() as con:
        row = con.execute("SELECT tone, face, created_at FROM baseline ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        return {"tone": None, "face": None}
    return {"tone": json.loads(row["tone"]) if row["tone"] else None,
            "face": json.loads(row["face"]) if row["face"] else None,
            "created_at": row["created_at"]}


FACE_KEYS = ("brow", "frown", "press", "smile", "asym", "nose_ratio", "blink_per_min")


def _clean_face(f: dict | None) -> dict | None:
    if not f:
        return None
    if not all(isinstance(f.get(k), (int, float)) for k in FACE_KEYS):
        raise HTTPException(400, {"code": "bad_face", "message": "표정 측정값이 올바르지 않습니다."})
    return {k: f[k] for k in FACE_KEYS} | {"measured": True}


@router.post("/baseline")
def save_baseline(body: BaselineIn):
    t = body.tone or {}
    need = ("db_med", "db_p90", "pitch_med", "range_st", "rate")
    if not all(isinstance(t.get(k), (int, float)) for k in need):
        raise HTTPException(400, {"code": "bad_baseline", "message": "측정값이 올바르지 않습니다. 다시 측정해 주세요."})
    if not (50 <= t["pitch_med"] <= 450):
        raise HTTPException(400, {"code": "bad_baseline", "message": "목소리 높이를 인식하지 못했습니다. 조용한 곳에서 다시 측정해 주세요."})
    tone = {k: t[k] for k in need} | {"measured": True}
    face = _clean_face(body.face)
    with db.connect() as con:
        con.execute("INSERT INTO baseline(created_at, tone, face) VALUES(?, ?, ?)",
                    (datetime.now().isoformat(timespec="seconds"), json.dumps(tone),
                     json.dumps(face) if face else None))
    return {"tone": tone, "face": face}


# ---------- 표정 분석 모델 ----------

@router.post("/face-model")
def ensure_face_model():
    """얼굴 인식 모델을 한 번만 받아 assets/models 에 저장 (GitHub 에 커밋해서 재사용). 키 불필요·무료."""
    cfg = get_config()["face"]
    path = ROOT / cfg["local_model"]
    if not path.exists():
        try:
            r = httpx.get(cfg["model_url"], timeout=60, follow_redirects=True)
            r.raise_for_status()
            if len(r.content) < 100_000:
                raise ValueError("파일이 너무 작습니다")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, {"code": "face_model", "message": f"표정 분석 모델을 받지 못했습니다: {type(e).__name__}"})
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(r.content)
        tmp.replace(path)
    return {"url": "/" + cfg["local_model"].replace("\\", "/"), "bytes": path.stat().st_size}
