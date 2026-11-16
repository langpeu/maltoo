"""대화 한 판의 교정 리포트.

- 톤·표정 점수: 브라우저 측정값으로 결정적 계산 (같은 입력 → 같은 점수)
- 말 점수·총평·교정 문장: gpt-4o-mini
- 종합 = 말·톤·표정 가중 평균(측정 안 된 항목은 제외) × 0.85 + 목표 달성도 × 0.15
"""

import json

from .config import get_config
from .prompts.face import describe as describe_face
from .prompts.tone import describe as describe_tone

WEIGHTS = {"words": 0.4, "tone": 0.35, "face": 0.25}


def _clamp(v: float) -> int:
    return int(round(max(0, min(100, v))))


def _n(d: dict | None, k: str, default=0.0) -> float:
    try:
        return float((d or {}).get(k, default) or 0)
    except (TypeError, ValueError):
        return default


def tone_score(t: dict | None) -> int | None:
    if not t:
        return None
    s = 100.0
    s -= 12 * _n(t, "loud_n") + 8 * _n(t, "high_n") + 6 * _n(t, "fast_n")
    s -= 10 * _n(t, "fall_n") + 6 * _n(t, "stress_n") + 10 * _n(t, "sigh_n")
    s -= max(0, _n(t, "arousal", 50) - 60) * 0.5
    s -= max(0, 40 - _n(t, "warmth", 50)) * 0.5
    if _n(t, "nag"):
        s -= 5 * _n(t, "nag")
    return _clamp(s)


def face_score(f: dict | None) -> int | None:
    if not f or not f.get("has_face"):
        return None
    s = 100.0
    for phase in ("listen", "silence", "speak"):
        p = f.get(phase) or {}
        if not p:
            continue
        s -= 15 * _n(p, "rolls") + 10 * _n(p, "smirks")
        s -= 0.25 * _n(p, "frown_pct") + 0.2 * _n(p, "away_pct") + 0.2 * _n(p, "chinup_pct")
        s -= 0.1 * (_n(p, "press_pct") + _n(p, "mouthdown_pct"))
    if f.get("expressionless"):
        s -= 10
    return _clamp(s)


def _avg(vals: list[int | None]) -> int | None:
    v = [x for x in vals if x is not None]
    return _clamp(sum(v) / len(v)) if v else None


def combine(words: int | None, tone: int | None, face: int | None, goal: int) -> int:
    parts = {"words": words, "tone": tone, "face": face}
    have = {k: v for k, v in parts.items() if v is not None}
    if not have:
        return _clamp(goal)
    wsum = sum(WEIGHTS[k] for k in have)
    base = sum(WEIGHTS[k] * v for k, v in have.items()) / wsum
    return _clamp(base * 0.85 + goal * 0.15)


def my_turns(turns: list[dict]) -> list[dict]:
    return [t for t in turns if t.get("speaker") == "me"]


def measured_scores(turns: list[dict]) -> dict:
    me = my_turns(turns)
    return {
        "tone": _avg([tone_score(t.get("tone")) for t in me]),
        "face": _avg([face_score(t.get("face")) for t in me]),
        "per_turn": [{"turn": i + 1, "tone": tone_score(t.get("tone")), "face": face_score(t.get("face"))}
                     for i, t in enumerate(me)],
    }


# ---------- gpt-4o-mini 코칭 ----------

REPORT_SPEC = """반드시 아래 JSON 하나만 출력한다.
{
  "words_score": 0-100,
  "summary": "총평 2~3문장 (말·톤·표정을 함께, 따뜻하지만 솔직하게)",
  "strengths": ["잘한 점 (최대 3개, 구체적으로)"],
  "habits": ["반복해서 나타난 말투·톤·표정 습관 (최대 3개)"],
  "fixes": [
    {"turn": 과장 답변 번호(1부터),
     "original": "과장이 실제로 한 말(원문 그대로, 일부만 인용 가능)",
     "problem": "왜 문제인지 (말·톤·표정 근거)",
     "better": "같은 의도를 지키면서 이렇게 말하면 좋을 대안 문장 (실제로 말할 문장 그대로, 1~3문장)",
     "tone_tip": "억양 팁 — 측정값을 근거로 숫자 포함 (예: 속도를 평소 수준으로 20% 늦추고, 문장 끝을 내리꽂지 말고 살짝 올리기)",
     "face_tip": "표정·시선 팁 (표정 측정이 없으면 빈 문자열)"}
  ],
  "next_practice": "다음 연습 과제 한 줄"
}
fixes 는 가장 효과가 큰 순서로 최대 3개. better 는 상대 인물의 성격과 상황에 맞고, 과장의 목표를 이루는 데 도움이 되는 자연스러운 한국어 직장 말투로 쓴다.
과장이 다른 사람을 험담했다면 즉효는 있어도 위험이 큰 전략이라고 짚는다(칭찬하지 않는다). 소문이 퍼졌다면 그 결과도 알려준다.
연봉 감액·퇴사 같은 게임 결과가 있으면 총평에서 어떤 행동 때문이었는지 연결해서 설명한다."""


def game_line(game: dict | None) -> str:
    if not game:
        return ""
    parts = []
    if game.get("grade"):
        parts.append(f"인사고과 {game['grade']}" + (" (인사팀 면담 요청)" if game.get("meeting") else ""))
    if game.get("session_cut"):
        parts.append(f"이번 대화로 연봉 {int(game['session_cut']) // 10000}만 원 감액")
    if game.get("resign_risk") is not None and game.get("kind") == "sub":
        parts.append(f"상대 퇴사 위험도 {int(game['resign_risk'])}%" + (" — 결국 퇴사함" if game.get("resigned") else ""))
    for m in game.get("mentions") or []:
        parts.append(f"{m.get('name')} 언급({m.get('sentiment')}): {m.get('effect', '')}" + (" → 소문이 퍼짐" if m.get("rumor") else ""))
    if game.get("team_quit"):
        parts.append("문제를 덮고 넘어가서 다른 팀원이 이탈함")
    return "게임 결과: " + "; ".join(parts) if parts else ""


def build_report_messages(s: dict, turns: list[dict], ending: str | None, goal: int, difficulty: str,
                          game: dict | None = None) -> list[dict]:
    company = get_config()["company"]["name"]
    c = s["character"]
    lines = []
    k = 0
    for t in turns:
        if t.get("speaker") == "me":
            k += 1
            lines.append(f"[과장 답변 {k}] {t.get('text', '')}")
            if t.get("tone"):
                lines.append("  (목소리) " + describe_tone(t["tone"]).replace("\n", " / "))
            if t.get("face"):
                lines.append("  (표정) " + describe_face(t["face"]).replace("\n", " / "))
            cps = t.get("checkpoints") or []
            if cps:
                lines.append("  (대사 판정) " + "; ".join(f"{x.get('type')}: {x.get('text_span', '')} — {x.get('note', '')}" for x in cps))
        else:
            lines.append(f"[{c['name']}] {t.get('text', '')}")
    system = f"""너는 직장 커뮤니케이션 코치다. {company}(가상의 로봇 제조 회사) 과장이 갈등 대화를 연습한 기록을 보고 교정 리포트를 쓴다.
상대: {c['name']} ({c['role']}) — {c['personality']}
상황: {s['situation']}
과장의 목표: {s['goal']} (체크리스트: {', '.join(s['checklist'])})
결과: {ending or '미정'} / 목표 달성도 {goal}% / 난이도 {difficulty}
{game_line(game)}
말뿐 아니라 목소리 톤과 표정 측정값을 근거로 판단한다. 과장을 비난하지 말고, 바로 따라 할 수 있게 구체적으로 쓴다.

{REPORT_SPEC}"""
    return [{"role": "system", "content": system}, {"role": "user", "content": "\n".join(lines) or "(대화 없음)"}]


def parse_report(raw: str, turns: list[dict]) -> dict:
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        a, b = raw.find("{"), raw.rfind("}")
        try:
            d = json.loads(raw[a:b + 1]) if a >= 0 else {}
        except json.JSONDecodeError:
            d = {}
    n_me = len(my_turns(turns))
    fixes = []
    for f in (d.get("fixes") or [])[:3]:
        if not isinstance(f, dict) or not str(f.get("better") or "").strip():
            continue
        try:
            turn = int(f.get("turn") or 0)
        except (TypeError, ValueError):
            turn = 0
        fixes.append({
            "turn": turn if 1 <= turn <= n_me else None,
            "original": str(f.get("original") or "").strip(),
            "problem": str(f.get("problem") or "").strip(),
            "better": str(f.get("better") or "").strip()[:300],
            "tone_tip": str(f.get("tone_tip") or "").strip(),
            "face_tip": str(f.get("face_tip") or "").strip(),
        })
    try:
        words = _clamp(float(d.get("words_score")))
    except (TypeError, ValueError):
        words = None
    as_list = lambda v: [str(x).strip() for x in (v or []) if str(x).strip()][:3]  # noqa: E731
    return {
        "words_score": words,
        "summary": str(d.get("summary") or "").strip(),
        "strengths": as_list(d.get("strengths")),
        "habits": as_list(d.get("habits")),
        "fixes": fixes,
        "next_practice": str(d.get("next_practice") or "").strip(),
    }
