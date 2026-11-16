"""음성 캐시.

- 고정 대사(첫마디·재촉): assets/audio/<key>.mp3 + manifest.json → GitHub 에 커밋해서 재사용
- 실시간 대사: .runtime/tts/<key>.mp3 → 커밋하지 않음
- 캐시 키 = hash(대사 + voice + instructions). 모델 이름은 넣지 않는다 (모델 교체 시에도 재사용).
"""

import hashlib
import json
import threading
from datetime import datetime
from pathlib import Path

from .config import ROOT

AUDIO_DIR = ROOT / "assets" / "audio"
RUNTIME_DIR = ROOT / ".runtime" / "tts"
MANIFEST = AUDIO_DIR / "manifest.json"
_lock = threading.Lock()


def audio_key(text: str, voice: str, instructions: str) -> str:
    raw = "␟".join([text.strip(), voice, instructions.strip()])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def fixed_path(key: str) -> Path:
    return AUDIO_DIR / f"{key}.mp3"


def fixed_url(key: str) -> str:
    return f"/assets/audio/{key}.mp3"


def runtime_path(key: str) -> Path:
    return RUNTIME_DIR / f"{key}.mp3"


def runtime_url(key: str) -> str:
    return f"/runtime/tts/{key}.mp3"


def read_manifest() -> dict:
    if not MANIFEST.exists():
        return {}
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)


def save_fixed(key: str, data: bytes, meta: dict) -> None:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    fixed_path(key).write_bytes(data)
    with _lock:
        m = read_manifest()
        m[key] = {**meta, "created_at": datetime.now().isoformat(timespec="seconds")}
        tmp = MANIFEST.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(dict(sorted(m.items())), f, ensure_ascii=False, indent=2)
        tmp.replace(MANIFEST)


def save_runtime(key: str, data: bytes) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    runtime_path(key).write_bytes(data)
