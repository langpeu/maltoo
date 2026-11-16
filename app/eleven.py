"""ElevenLabs 로 고정 대사 음성 만들기 (실시간 대사는 OpenAI).

- 키는 요청 헤더(X-ElevenLabs-Key)로만 받고 저장·로그하지 않는다.
- 결과는 assets/audio/custom/<인물>/<대사>.mp3 (생성 음성보다 우선 재생, 커밋해서 재사용).
- 대본(오디오 태그 포함)은 scenarios/elevenlabs.json. 화면에 보이는 글자는 원래 대사 그대로.
"""

import json
from datetime import datetime, timezone
from functools import lru_cache

import httpx
from fastapi import HTTPException

from . import cache, scenarios
from .config import ROOT, get_config

KEY_HEADER = "X-ElevenLabs-Key"


@lru_cache
def _scripts() -> dict:
    with open(ROOT / "scenarios" / "elevenlabs.json", encoding="utf-8") as f:
        return json.load(f)


def cfg() -> dict:
    return get_config()["elevenlabs"]


def script_for(s: dict, line: str) -> str:
    """ElevenLabs 에 보낼 대본: 직접 쓴 대본이 있으면 그대로, 없으면 [인물 말투, 감정] + 원래 대사."""
    d = _scripts()
    ch = d["characters"].get(s["id"], {})
    if line in ch.get("lines", {}):
        return ch["lines"][line]
    base = ch.get("base_tag", "") if d.get("use_base_tag") else ""
    tags = [t for t in (base, d["mood_tags"].get(scenarios.line_mood(s, line), "")) if t]
    text = scenarios.fixed_line(s, line)
    return f"[{', '.join(tags)}] {text}" if tags else text


def _err(r: httpx.Response) -> HTTPException:
    try:
        d = r.json().get("detail")
        msg = d.get("message") if isinstance(d, dict) else str(d)
    except Exception:
        msg = r.text[:200]
    status = {401: 401, 402: 402, 429: 429}.get(r.status_code, 502)
    if r.status_code == 401:
        msg = "ElevenLabs API 키가 올바르지 않습니다."
    return HTTPException(status, {"code": "elevenlabs", "message": f"ElevenLabs: {msg}"})


def list_voices(key: str) -> list[dict]:
    r = httpx.get(f"{cfg()['api_base']}/v1/voices", headers={"xi-api-key": key}, timeout=30)
    if r.status_code != 200:
        raise _err(r)
    return [{"voice_id": v["voice_id"], "name": v.get("name", ""), "category": v.get("category", "")}
            for v in r.json().get("voices", [])]


def synth(key: str, voice_id: str, text: str) -> bytes:
    c = cfg()
    body = {"text": text, "model_id": c["model_id"], "voice_settings": c.get("voice_settings", {})}
    if c.get("language_code"):
        body["language_code"] = c["language_code"]
    r = httpx.post(f"{c['api_base']}/v1/text-to-speech/{voice_id}",
                   params={"output_format": c.get("output_format", "mp3_44100_128")},
                   headers={"xi-api-key": key, "Content-Type": "application/json"}, json=body, timeout=120)
    if r.status_code != 200:
        raise _err(r)
    return r.content


MANIFEST_NAME = "manifest.json"


def _manifest_path():
    return cache.AUDIO_DIR / "custom" / MANIFEST_NAME


def manifest() -> dict:
    p = _manifest_path()
    if not p.exists():
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def save_line(s: dict, line: str, data: bytes, voice: dict, text: str) -> None:
    p = cache.custom_path(s["id"], line)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    m = manifest()
    c = cfg()
    m[f"{s['id']}/{line}"] = {"source": "elevenlabs", "model": c["model_id"], "voice_id": voice.get("voice_id"),
                             "voice_name": voice.get("name", ""), "script": text,
                             "voice_settings": c.get("voice_settings", {}),
                             "created": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    mp = _manifest_path()
    with open(mp, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(m.items())), f, ensure_ascii=False, indent=2)
