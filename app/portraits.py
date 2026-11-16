"""상대 인물 실사 사진 (표정 5단계 × 입 다묾/입 벌림).

생성 순서 (인물 한 명당 10장):
1. calm(평온) 기본 사진: images.generate
2. 나머지 표정 4장: 기본 사진을 기준으로 images.edit (input_fidelity=high) → 같은 얼굴 유지
3. 표정별 입 벌린 사진 5장: 해당 표정 사진 + 입 주변 마스크로 images.edit → 입만 바뀌어 정확히 겹침

파일: assets/characters/<id>/<expr>.webp, <expr>_talk.webp  (GitHub 에 커밋해서 재사용)
manifest: 파일별 프롬프트 해시·모델·생성일. 키에 모델 이름은 넣지 않는다.
"""

import hashlib
import json
import threading
from datetime import datetime
from pathlib import Path

from . import usage
from .config import ROOT, get_config, model

DIR = ROOT / "assets" / "characters"
MANIFEST = DIR / "manifest.json"
MASK = DIR / "_mouth_mask.png"
_lock = threading.Lock()

EXPRESSIONS = {
    "calm": ("평온", "neutral, composed, slight professional expression, mouth closed"),
    "annoyed": ("짜증", "visibly annoyed: slightly furrowed brows, tight lips, a little eye-roll feeling, mouth closed"),
    "angry": ("분노", "angry: strongly furrowed brows, glaring eyes, flared nostrils, jaw clenched, mouth closed"),
    "explosive": ("폭발", "furious and shouting-level rage: deeply furrowed brows, wide intense eyes, face flushed red, "
                          "veins slightly visible on temple, lips pressed hard, mouth closed"),
    "softened": ("누그러짐", "softened and accepting: relaxed brows, gentle eyes, faint small smile, mouth closed"),
}
ORDER = list(EXPRESSIONS)


def _fmt() -> dict:
    return get_config()["portraits"]


def ext() -> str:
    return _fmt()["format"]


def base_prompt(s: dict) -> str:
    c = s["character"]
    company = get_config()["company"]["name"]
    return (
        "Photorealistic head-and-shoulders portrait photograph of a fictional Korean office worker. "
        f"Appearance: {c['appearance']} "
        f"Works at '{company}', a robot manufacturing company; softly blurred modern office with robot arms in the background. "
        "Subject faces the camera directly, face centered horizontally, eyes at about 40% from the top of the frame, "
        "mouth at about 60% from the top, shoulders visible. Natural soft office lighting, 85mm lens, realistic skin texture. "
        "This is an invented person who must not resemble any real or famous individual. No text, no logos, no watermark."
    )


def expression_prompt(expr: str) -> str:
    return (
        "Keep exactly the same person, face shape, hairstyle, clothing, background, framing and lighting. "
        f"Change only the facial expression to: {EXPRESSIONS[expr][1]}. Photorealistic."
    )


TALK_PROMPT = (
    "Keep everything identical. Only change the mouth so the person is mid-speech, "
    "lips naturally parted with the mouth half open as if saying 'ah', teeth slightly visible. "
    "Keep the same facial expression and emotion. Photorealistic."
)


def path(cid: str, expr: str, talk: bool = False) -> Path:
    return DIR / cid / f"{expr}{'_talk' if talk else ''}.{ext()}"


def url(cid: str, expr: str, talk: bool = False) -> str:
    return f"/assets/characters/{cid}/{expr}{'_talk' if talk else ''}.{ext()}"


def jobs(s: dict) -> list[tuple[str, bool]]:
    """인물 한 명의 생성 작업 목록 (순서 중요)."""
    out = [("calm", False)]
    out += [(e, False) for e in ORDER if e != "calm"]
    out += [(e, True) for e in ORDER]
    return out


def job_cost(expr: str, talk: bool) -> float:
    m = model("image")
    q = _fmt()["quality"]
    one = usage.cost_image(m, q)
    if expr == "calm" and not talk:
        return one
    return one + get_config()["pricing_usd"].get(m, {}).get("edit_input_estimate", 0)


def status(scenarios: list[dict]) -> dict:
    chars, missing, est = {}, 0, 0.0
    for s in scenarios:
        cid = s["id"]
        frames = {}
        for e in ORDER:
            frames[e] = {
                "closed": url(cid, e) if path(cid, e).exists() else None,
                "talk": url(cid, e, True) if path(cid, e, True).exists() else None,
            }
        todo = [(e, t) for e, t in jobs(s) if not path(cid, e, t).exists()]
        missing += len(todo)
        est += sum(job_cost(e, t) for e, t in todo)
        chars[cid] = {"frames": frames, "missing": len(todo), "estimate_usd": sum(job_cost(e, t) for e, t in todo)}
    return {"characters": chars, "missing": missing, "estimate_usd": est,
            "labels": {k: v[0] for k, v in EXPRESSIONS.items()}}


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _save(cid: str, expr: str, talk: bool, data: bytes, prompt: str) -> None:
    p = path(cid, expr, talk)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    with _lock:
        m = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
        m[f"{cid}/{p.name}"] = {"character": cid, "expression": expr, "talk": talk, "prompt_hash": _hash(prompt),
                                "model": model("image"), "created_at": datetime.now().isoformat(timespec="seconds")}
        tmp = MANIFEST.with_suffix(".tmp")
        tmp.write_text(json.dumps(dict(sorted(m.items())), ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(MANIFEST)


def generate_one(caller, s: dict, expr: str, talk: bool) -> None:
    """사진 한 장 생성. calm → 나머지 표정 → 입 벌림 순서로 호출해야 한다 (jobs() 순서)."""
    cid = s["id"]
    cost = job_cost(expr, talk)
    if expr == "calm" and not talk:
        prompt = base_prompt(s)
        data = caller.image_generate(prompt, cost)
    elif not talk:
        prompt = expression_prompt(expr)
        data = caller.image_edit(path(cid, "calm").read_bytes(), prompt, cost)
    else:
        prompt = TALK_PROMPT
        data = caller.image_edit(path(cid, expr).read_bytes(), prompt, cost, mask=MASK.read_bytes())
    _save(cid, expr, talk, data, prompt)
