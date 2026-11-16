"""Phase 0 라우터: 공개 설정, 키 확인, 비용 집계, 한도 설정, 연결 테스트."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .. import usage
from ..config import get_config
from ..openai_client import SESSION_HEADER, Caller, get_caller

router = APIRouter(prefix="/api")


@router.get("/config")
def public_config():
    cfg = get_config()
    return {
        "company": cfg.get("company", {}),
        "models": cfg["models"],
        "krw_per_usd": cfg.get("krw_per_usd", 1400),
        "limits": usage.limits(),
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
