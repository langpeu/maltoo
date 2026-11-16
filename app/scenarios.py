"""시나리오 정의 로더."""

import json
from functools import lru_cache

from fastapi import HTTPException

from .config import ROOT

FIXED_LINES = ("opening", "nag1", "nag2")


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


def fixed_line(s: dict, line: str) -> str:
    if line == "opening":
        return s["opening"]
    if line in ("nag1", "nag2"):
        return s["nags"][int(line[-1]) - 1]
    raise HTTPException(400, {"code": "bad_line", "message": "고정 대사는 opening, nag1, nag2 중 하나입니다."})
