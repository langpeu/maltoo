"""ElevenLabs 고정 대사 일괄 생성 API (설정 → 🎙 ElevenLabs 고정 대사)."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import cache, eleven, scenarios

router = APIRouter(prefix="/api/eleven")


def _key(request: Request) -> str:
    k = (request.headers.get(eleven.KEY_HEADER) or "").strip()
    if not k:
        raise HTTPException(401, {"code": "no_eleven_key", "message": "ElevenLabs API 키를 먼저 넣어 주세요."})
    return k


@router.get("/status")
def status():
    """인물별 고정 대사 목록과 ElevenLabs 음성 여부, 예상 글자 수."""
    m = eleven.manifest()
    out = []
    for s in scenarios.all_scenarios():
        lines = []
        for line, text in scenarios.fixed_lines(s).items():
            has = cache.custom_path(s["id"], line).exists()
            script = eleven.script_for(s, line)
            lines.append({"line": line, "text": text, "script": script, "chars": len(script), "custom": has,
                          "url": cache.custom_url(s["id"], line) if has else None,
                          "voice_name": (m.get(f"{s['id']}/{line}") or {}).get("voice_name", "")})
        out.append({"id": s["id"], "name": s["character"]["name"], "lines": lines,
                    "done": sum(1 for x in lines if x["custom"]), "total": len(lines),
                    "missing_chars": sum(x["chars"] for x in lines if not x["custom"])})
    return {"model": eleven.cfg()["model_id"], "characters": out}


@router.get("/voices")
def voices(request: Request):
    return {"voices": eleven.list_voices(_key(request))}


class LineIn(BaseModel):
    scenario_id: str
    line: str
    voice_id: str
    voice_name: str = ""
    force: bool = False


@router.post("/line")
def make_line(body: LineIn, request: Request):
    key = _key(request)
    s = scenarios.get(body.scenario_id)
    scenarios.fixed_line(s, body.line)  # 없는 대사면 400
    if cache.custom_path(s["id"], body.line).exists() and not body.force:
        return {"ok": True, "skipped": True, "url": cache.custom_url(s["id"], body.line)}
    text = eleven.script_for(s, body.line)
    data = eleven.synth(key, body.voice_id, text)
    eleven.save_line(s, body.line, data, {"voice_id": body.voice_id, "name": body.voice_name}, text)
    return {"ok": True, "url": cache.custom_url(s["id"], body.line), "chars": len(text)}
