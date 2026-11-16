"""시나리오 정의 로더."""

import json
from functools import lru_cache

from fastapi import HTTPException

from .config import ROOT

REACTION_GROUPS = ("angry", "neutral", "soft")


@lru_cache(maxsize=1)
def _load() -> dict[str, dict]:
    with open(ROOT / "scenarios" / "scenarios.json", encoding="utf-8") as f:
        data = json.load(f)
    return {s["id"]: s for s in data["scenarios"]}


def all_scenarios() -> list[dict]:
    return list(_load().values())


def get(scenario_id: str) -> dict:
    s = _load().get(scenario_id)
    if not s:
        raise HTTPException(404, {"code": "no_scenario", "message": "없는 시나리오입니다."})
    return s


def fixed_lines(s: dict) -> dict[str, str]:
    """미리 만들어 두는 고정 대사 전체 (id → 문장).

    - opening, nag1, nag2           : 첫마디·재촉
    - react_<그룹>_<n>              : 추임새 (내 말이 끝나자마자 바로 재생)
    - end_<결말>                    : 결말 대사 (success/partial/fail/noresp, 부하 직원은 resign)
    - rumor_<n>                     : 소문이 퍼진 뒤의 첫마디
    """
    out = {"opening": s["opening"], "nag1": s["nags"][0], "nag2": s["nags"][1]}
    for g in REACTION_GROUPS:
        for n, text in enumerate(s.get("reactions", {}).get(g, [])):
            out[f"react_{g}_{n}"] = text
    for k, text in s.get("endings", {}).items():
        out[f"end_{k}"] = text
    for n, text in enumerate(s.get("rumor_openings", [])):
        out[f"rumor_{n}"] = text
    return out


def fixed_line(s: dict, line: str) -> str:
    lines = fixed_lines(s)
    if line not in lines:
        raise HTTPException(400, {"code": "bad_line", "message": f"없는 고정 대사입니다: {line}"})
    return lines[line]


# ---------- 목소리 (인물 프로필 + 감정) ----------

_START_MOOD = {"angry": "angry", "neutral": "calm", "soft": "calm"}
_REACT_MOOD = {"angry": "angry", "neutral": "calm", "soft": "softened"}
_END_MOOD = {"success": "softened", "partial": "calm", "fail": "angry", "noresp": "angry", "resign": "resigned"}


def line_mood(s: dict, line: str) -> str:
    """고정 대사마다 어떤 감정으로 읽을지."""
    if line == "opening":
        return _START_MOOD.get(s.get("reaction_start", "neutral"), "calm")
    if line == "nag1":
        return "annoyed"
    if line == "nag2":
        return "angry"
    if line.startswith("rumor_"):
        return "annoyed"
    if line.startswith("react_"):
        return _REACT_MOOD.get(line.split("_")[1], "calm")
    if line.startswith("end_"):
        return _END_MOOD.get(line[4:], "calm")
    return "calm"


def voice_for(s: dict, mood: str = "calm") -> tuple[str, str]:
    """(TTS 목소리, 지시문). 지시문 = 인물 프로필 + 현재 감정 + 공통 연기 지시 (config.json)."""
    from .config import get_config
    cfg = get_config()
    moods = cfg.get("voice_moods", {})
    v = s["voice"]
    parts = [v.get("profile") or v.get("instructions", ""), moods.get(mood) or moods.get("calm", ""),
             cfg.get("voice_style_suffix", "")]
    return v["voice"], "\n".join(p for p in parts if p).strip()
