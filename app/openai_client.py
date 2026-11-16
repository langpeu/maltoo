"""OpenAI 호출 래퍼.

- API 키는 요청 헤더(X-OpenAI-Key)로만 받고, 해당 요청에만 사용한다. 저장·로그 금지.
- 모든 유료 호출은 usage.check_limit() → 호출 → usage.record() 순서를 지킨다.
"""

import base64

from fastapi import HTTPException, Request
from openai import (
    APIConnectionError,
    AuthenticationError,
    BadRequestError,
    OpenAI,
    PermissionDeniedError,
    RateLimitError,
)

from . import usage
from .config import get_config, model

KEY_HEADER = "X-OpenAI-Key"
SESSION_HEADER = "X-Session-Id"


class Caller:
    """요청 하나에 대한 OpenAI 호출 컨텍스트."""

    def __init__(self, api_key: str, session_id: str | None, skip_limits: bool = False):
        self._api_key = api_key
        self.skip_limits = skip_limits  # 초기 세팅 스크립트: 사용자가 예상 비용을 확인했으므로 한도 검사 생략
        self.key_id = usage.key_id_of(api_key)
        self.session_id = session_id

    @property
    def client(self) -> OpenAI:
        return make_client(self._api_key)

    # ---- 무료: 키 확인 ----
    def verify(self) -> None:
        with translate_errors():
            self.client.models.list()

    # ---- 유료: 채팅 ----
    def chat(self, messages: list[dict], max_tokens: int = 300, feature: str = "chat",
             response_format: dict | None = None) -> str:
        m = model("chat")
        prompt_chars = sum(len(str(x.get("content", ""))) for x in messages)
        # 사전 예상: 한국어 약 1글자 ≈ 1토큰으로 넉넉하게 잡음
        estimate = usage.cost_chat(m, prompt_chars + 50, max_tokens)
        self._check(estimate)

        kwargs = {"model": m, "messages": messages, "max_completion_tokens": max_tokens}
        if response_format:
            kwargs["response_format"] = response_format
        with translate_errors():
            resp = self.client.chat.completions.create(**kwargs)

        u = resp.usage
        cost = usage.cost_chat(m, u.prompt_tokens, u.completion_tokens)
        usage.record(self.key_id, feature, m, cost, self.session_id,
                     meta={"prompt_tokens": u.prompt_tokens, "completion_tokens": u.completion_tokens},
                     exempt=self.skip_limits)
        return resp.choices[0].message.content or ""

    # ---- 유료: 음성 합성 ----
    def tts(self, text: str, voice: str, instructions: str) -> bytes:
        m = model("tts")
        cost = usage.cost_tts(m, text)
        self._check(cost)
        with translate_errors():
            resp = self.client.audio.speech.create(
                model=m, voice=voice, input=text, instructions=instructions, response_format="mp3")
        data = resp.read() if hasattr(resp, "read") else resp.content
        usage.record(self.key_id, "tts", m, cost, self.session_id, meta={"chars": len(text)}, exempt=self.skip_limits)
        return data

    # ---- 유료: 음성 인식 ----
    def transcribe(self, audio: bytes, filename: str, seconds: float) -> str:
        m = model("transcribe")
        self._check(usage.cost_transcribe(m, seconds=max(seconds, 1.0)))
        with translate_errors():
            resp = self.client.audio.transcriptions.create(
                model=m, file=(filename, audio), language="ko")
        text = resp if isinstance(resp, str) else getattr(resp, "text", "")
        u = getattr(resp, "usage", None)
        in_tok = getattr(u, "input_tokens", 0) or 0
        out_tok = getattr(u, "output_tokens", 0) or 0
        cost = usage.cost_transcribe(m, seconds=seconds, input_tokens=in_tok, output_tokens=out_tok)
        usage.record(self.key_id, "transcribe", m, cost, self.session_id,
                     meta={"seconds": round(seconds, 1), "input_tokens": in_tok, "output_tokens": out_tok},
                     exempt=self.skip_limits)
        return (text or "").strip()

    # ---- 유료: 이미지 (초기 세팅 스크립트에서만 사용) ----
    def image_generate(self, prompt: str, cost: float) -> bytes:
        m = model("image")
        f = get_config()["portraits"]
        self._check(cost)
        with translate_errors():
            resp = self.client.images.generate(model=m, prompt=prompt, size=f["size"], quality=f["quality"],
                                               output_format=f["format"], output_compression=f["compression"], n=1)
        usage.record(self.key_id, "image", m, cost, self.session_id, meta={"op": "generate"}, exempt=self.skip_limits)
        return base64.b64decode(resp.data[0].b64_json)

    def image_edit(self, image: bytes, prompt: str, cost: float, mask: bytes | None = None) -> bytes:
        m = model("image")
        f = get_config()["portraits"]
        self._check(cost)
        kwargs = dict(model=m, image=("base.webp", image, "image/webp"), prompt=prompt, size=f["size"],
                      quality=f["quality"], output_format=f["format"], output_compression=f["compression"], n=1)
        if f.get("input_fidelity"):
            kwargs["input_fidelity"] = f["input_fidelity"]
        if mask is not None:
            kwargs["mask"] = ("mask.png", mask, "image/png")
        with translate_errors():
            resp = self.client.images.edit(**kwargs)
        usage.record(self.key_id, "image", m, cost, self.session_id, meta={"op": "edit"}, exempt=self.skip_limits)
        return base64.b64decode(resp.data[0].b64_json)

    def _check(self, estimate: float) -> None:
        if self.skip_limits:
            return
        try:
            usage.check_limit(self.key_id, estimate)
        except usage.LimitExceeded as e:
            raise HTTPException(status_code=402, detail={"code": "limit_exceeded", "scope": e.scope,
                                                         "message": str(e)})


def make_client(api_key: str) -> OpenAI:
    """테스트에서 교체(monkeypatch)할 수 있도록 분리."""
    return OpenAI(api_key=api_key, timeout=30, max_retries=1)


def get_optional_caller(request: Request) -> Caller | None:
    """캐시 재생처럼 키가 없어도 되는 요청용."""
    key = (request.headers.get(KEY_HEADER) or "").strip()
    return Caller(key, request.headers.get(SESSION_HEADER)) if key else None


def get_caller(request: Request) -> Caller:
    key = (request.headers.get(KEY_HEADER) or "").strip()
    if not key:
        raise HTTPException(status_code=401, detail={"code": "no_key",
                                                     "message": "OpenAI API 키가 없습니다. 키를 먼저 입력하세요."})
    return Caller(key, request.headers.get(SESSION_HEADER))


class translate_errors:
    """OpenAI 예외를 사용자용 한국어 메시지의 HTTP 오류로 바꾼다. 키 원문은 절대 포함하지 않는다."""

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc is None or isinstance(exc, HTTPException):
            return False
        if isinstance(exc, AuthenticationError):
            raise HTTPException(401, {"code": "invalid_key", "message": "API 키가 올바르지 않습니다. 다시 확인해 주세요."})
        if isinstance(exc, PermissionDeniedError):
            raise HTTPException(403, {"code": "forbidden",
                                      "message": "이 키로는 해당 모델을 쓸 권한이 없습니다. (조직 인증 필요 여부를 확인하세요)"})
        if isinstance(exc, RateLimitError):
            body = getattr(exc, "body", None) or {}
            code = body.get("code") if isinstance(body, dict) else None
            if code == "insufficient_quota":
                raise HTTPException(402, {"code": "insufficient_quota",
                                          "message": "OpenAI 계정의 크레딧이 부족합니다. 결제 설정을 확인하세요."})
            raise HTTPException(429, {"code": "rate_limited", "message": "요청이 너무 많습니다. 잠시 후 다시 시도하세요."})
        if isinstance(exc, BadRequestError):
            body = getattr(exc, "body", None) or {}
            msg = body.get("message") if isinstance(body, dict) else None
            raise HTTPException(400, {"code": "bad_request",
                                      "message": f"OpenAI가 요청을 거절했습니다: {msg or '잘못된 요청'}"})
        if isinstance(exc, APIConnectionError):
            raise HTTPException(503, {"code": "connection", "message": "OpenAI 서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요."})
        raise HTTPException(502, {"code": "openai_error", "message": f"OpenAI 오류: {type(exc).__name__}"})
