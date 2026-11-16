"""인물 연기 + 턴 판정 프롬프트 (Phase 1).

gpt-4o-mini 는 상대 인물을 연기하고 감정·목표 진행을 판단만 한다.
금액·퇴사 위험도 같은 게임 수치는 여기서 정하지 않는다 (CLAUDE.md 규칙).
"""

import json

from ..config import get_config
from .face import describe as describe_face
from .tone import describe as describe_tone

MAX_TURNS = 5

OUTPUT_SPEC = """반드시 아래 JSON 객체 하나만 출력한다. 다른 텍스트 금지.
{
  "reply": "상대 인물의 다음 대사 (한국어, 1~3문장, 실제 말하듯이)",
  "emotion": {"anger": 0-100, "trust": 0-100, "defensiveness": 0-100},
  "reason": "이번 과장 발언이 상대 감정에 준 영향 한 줄 (한국어)",
  "goal_progress": 0-100 (지금까지 대화 전체 기준 목표 달성도),
  "checklist_done": [지금까지 달성된 체크리스트 항목 번호, 예: 1, 3 — 일부라도 말했으면 넣는다],
  "checkpoints": [
    {"type": "aggressive" | "excuse" | "cold" | "sarcasm" | "good",
     "text_span": "과장 발언에서 그대로 복사한 짧은 구절",
     "note": "왜 그렇게 들리는지 + 어떻게 바꾸면 좋은지 한 줄 (한국어)"}
  ],
  "tone_feedback": "이번 발언의 목소리 톤과 표정이 상대에게 어떻게 보이고 들렸는지 한 줄 (한국어, 측정값 근거)",
  "mentions": [{"character": "언급된 다른 인물의 id", "sentiment": "negative" | "positive" | "neutral",
                "quote": "과장이 그 사람에 대해 한 말 (원문 일부)"}],
  "team_issue_addressed": true | false | null,
  "ending": null | "success" | "partial" | "fail"
}
goal_progress 와 checklist_done 은 서로 맞춘다: 달성도가 0보다 크면 그 근거가 된 항목 번호를 checklist_done 에 반드시 넣는다 (예: 3개 중 2개 달성이면 [1, 2], 약 60~70).
mentions 는 과장이 너 말고 다른 회사 인물을 언급했을 때만 넣는다 (없으면 빈 배열). 험담·비난·불평은 negative.
team_issue_addressed 는 윤 대리 시나리오에서만: 과장이 실수 문제와 팀원들의 불만을 분명히 짚었으면 true, 덮고 넘어갔으면 false. 다른 시나리오는 null.
checkpoints 는 0~3개. text_span 은 반드시 과장 발언 원문에 있는 그대로의 구절이어야 한다.
aggressive=공격적·명령조, excuse=변명조, cold=차갑고 무뚝뚝함, sarcasm=비꼼, good=잘한 표현."""


def difficulty_line(difficulty: str) -> str:
    d = get_config().get("difficulty", {})
    return (d.get(difficulty) or d.get("normal") or {}).get("prompt", "")


def system_prompt(s: dict, turn_index: int, difficulty: str = "normal", world_ctx: str = "") -> str:
    company = get_config()["company"]
    c = s["character"]
    relation = "상사" if s["kind"] == "boss" else "부하 직원"
    last = turn_index >= MAX_TURNS
    return f"""너는 롤플레이 연습 앱의 상대 역할이다. 사용자가 직장 갈등 대화를 연습한다.

[회사] {company['name']} — {company['description']}. 협동로봇, 감속기, 로봇 부품을 만든다.
[사용자] 이 회사의 과장. 너에게 사용자는 {'부하 직원' if s['kind'] == 'boss' else '상사'}다. 호칭은 상황에 맞게 '과장', '과장님', '자네' 등을 쓴다.
[너의 역할] {c['name']} ({c['age']}세, {c['gender']}, {c['role']}) — 사용자의 {relation}
- 성격: {c['personality']}
- 말투: {c['speech_style']}
[상황] {s['situation']}
[사용자의 목표] {s['goal']}
[체크리스트] {' / '.join(f"{i + 1}) {x}" for i, x in enumerate(s['checklist']))}
[실패 조건] {', '.join(s['fail_conditions'])}
[{difficulty_line(difficulty)}]
{world_ctx}

판단 규칙 (말 + 목소리 톤 + 표정):
- 과장의 대사 뒤에 [목소리 톤 측정]과 [표정 측정]이 붙어 있다. 같은 말이라도 톤이 공격적이면(언성 상승, 끝 억양 뚝, 빠름, 강세, 한숨) 상대는 기분 나쁘게 받아들인다.
- 표정도 너는 보고 있다. 네가 말하는 동안 과장이 눈을 굴리거나 찌푸리거나 비웃었다면 말보다 그게 더 기분 나쁘다. 시선 회피는 자신감 없음·회피로, 턱을 든 것은 거만함으로 받아들인다. 대사에서 직접 지적해도 된다 (예: "지금 눈 굴렸어?").
- 말은 공손해도 톤이 거칠면 감정(anger)을 올리고, 그 이유를 reason 에 톤까지 짚어서 쓴다.
- 반대로 차분하고 끝 억양이 부드러우면 신뢰(trust)를 올린다.
- 인물의 대사(reply)도 톤에 반응할 수 있다. 예: "지금 나한테 짜증 내는 거야?"

연기 규칙:
- 캐릭터를 끝까지 유지한다. 쉽게 설득되지 않는다. 사용자가 차분하고 구체적으로 대응할 때만 조금씩 누그러진다.
- 사용자가 공격적·비꼬는·명령조로 말하면 성격대로 더 거칠어진다. 지나치게 굽히기만 하면 더 밀어붙인다.
- 목표가 자연스럽게 달성되면 그 사실을 대사로 인정하고 ending 을 "success" 로 한다.
- 실패 조건에 해당하면 ending 을 "fail" 로 한다.
- 욕설, 인신공격, 차별 발언은 하지 않는다. 현실적인 직장 갈등 수준을 지킨다.
- 사용자 발언이 비어 있거나 알아듣기 어려우면 그 점을 성격대로 지적한다.
- 이번은 사용자의 {turn_index}번째 답변이다 (최대 {MAX_TURNS}번).{' 이번이 마지막이므로 반드시 ending 을 success/partial/fail 중 하나로 정하고 대화를 마무리하는 대사를 한다.' if last else ''}

{OUTPUT_SPEC}"""


def build_messages(s: dict, history: list[dict], user_text: str, turn_index: int,
                   tone: dict | None = None, face: dict | None = None, difficulty: str = "normal",
                   world_ctx: str = "") -> list[dict]:
    msgs = [{"role": "system", "content": system_prompt(s, turn_index, difficulty, world_ctx)}]
    # 이전 상대 대사는 JSON 이 아니라 평문으로 넣는다.
    # ({"reply": ...} 만 넣으면 모델이 그걸 따라 해서 emotion·goal_progress 를 빼먹고 reply 만 답한다 → 감정 50, 목표 0% 고정)
    if not history:  # 첫마디(소문 버전 포함)는 클라이언트 history 첫 줄로 온다
        msgs.append({"role": "assistant", "content": s["opening"]})
    for h in history:
        if h.get("speaker") == "me":
            msgs.append({"role": "user", "content": h.get("text", "")})
        else:
            msgs.append({"role": "assistant", "content": h.get("text", "")})
    content = user_text or "(말이 없음)"
    if tone:
        content += "\n\n[목소리 톤 측정]\n" + describe_tone(tone)
    if face:
        content += "\n\n[표정 측정 — 상대(너)가 보고 있는 과장의 얼굴]\n" + describe_face(face)
    content += ("\n\n[출력 형식] 위 과장의 말에 대해, 시스템에 적힌 JSON 형식 전체로만 답한다. "
                "reply 하나만 쓰지 말고 emotion, reason, goal_progress(지금까지 기준), checklist_done(번호), "
                "checkpoints, tone_feedback, mentions, team_issue_addressed, ending 을 모두 채운다.")
    msgs.append({"role": "user", "content": content})
    return msgs


def _clamp(v, lo=0, hi=100, default=50):
    if isinstance(v, str):  # "40%", "약 40" 같은 답도 숫자로
        import re
        m = re.search(r"-?\d+(?:\.\d+)?", v)
        v = m.group(0) if m else None
    try:
        return max(lo, min(hi, int(round(float(v)))))
    except (TypeError, ValueError):
        return default


CP_TYPES = ("aggressive", "excuse", "cold", "sarcasm", "good")


def _norm(x: str) -> str:
    return "".join(ch for ch in str(x) if ch.isalnum())


def match_checklist(raw, checklist: list[str]) -> list[str]:
    """gpt 가 준 체크리스트 달성 표시(번호·원문·바꿔 쓴 문구)를 실제 항목으로 맞춘다."""
    from difflib import SequenceMatcher
    raw = list(raw or [])
    # [true, false, true] 처럼 항목 순서대로 참/거짓으로 답한 경우
    if raw and all(isinstance(x, bool) for x in raw):
        return [c for c, ok in zip(checklist, raw) if ok]
    out = []
    for x in raw:
        if isinstance(x, dict):  # {"item": "...", "done": true} / {"index": 1}
            if x.get("done") is False or x.get("achieved") is False:
                continue
            x = x.get("index", x.get("id", x.get("item", x.get("text", x.get("name")))))
        hit = None
        if isinstance(x, bool):
            continue
        if isinstance(x, (int, float)) or (isinstance(x, str) and x.strip().isdigit()):
            i = int(x) - 1
            hit = checklist[i] if 0 <= i < len(checklist) else None
        elif isinstance(x, str) and x.strip():
            nx = _norm(x)
            for c in checklist:
                nc = _norm(c)
                if nx == nc or (nx and (nx in nc or nc in nx)) or SequenceMatcher(None, nx, nc).ratio() >= 0.6:
                    hit = c
                    break
        if hit and hit not in out:
            out.append(hit)
    return [c for c in checklist if c in out]  # 원래 순서


def goal_state(s: dict, gpt_progress: int, done: list[str], prev_done: list[str] | None, ending: str | None) -> tuple[int, list[str]]:
    """목표 달성도는 체크한 항목 수에 맞춘다 (체크 1개인데 60% 같은 어긋남 방지).

    - 이미 달성한 항목은 유지
    - % = 체크 비율 + 다음 항목에 대한 부분 점수(최대 반 칸). 예) 3개 중 1개 → 33~49%, 2개 → 67~83%, 3개 → 100%
    - 성공 결말이면 전부 체크, 100%
    """
    cl = s["checklist"]
    allp = [c for c in cl if c in set(done) | set(prev_done or [])]
    if ending == "success" or (cl and len(allp) == len(cl)):
        return 100, list(cl)
    if not cl:
        return min(max(gpt_progress, 0), 100), []
    step = 100 / len(cl)
    lo = round(step * len(allp))
    hi = round(step * len(allp) + step / 2)
    return max(lo, min(gpt_progress, hi)), allp


def parse(raw: str, s: dict, turn_index: int, user_text: str = "", valid_ids: set | None = None,
          prev_done: list[str] | None = None, prev_progress: int = 0) -> dict:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        try:
            data = json.loads(raw[start:end + 1]) if start >= 0 else {}
        except json.JSONDecodeError:
            data = {}
    emo = data.get("emotion") or {}
    ending = data.get("ending")
    if ending not in ("success", "partial", "fail"):
        ending = None
    if ending is None and turn_index >= MAX_TURNS:
        ending = "partial"
    # 다른 모양으로 답해도 받아준다: {"goal": {"progress", "checklist"}}
    goal = data.get("goal") if isinstance(data.get("goal"), dict) else {}
    raw_p = data.get("goal_progress", goal.get("progress"))
    raw_c = data.get("checklist_done", goal.get("checklist") or goal.get("checklist_done"))
    done = match_checklist(raw_c if isinstance(raw_c, list) else [raw_c] if raw_c else [], s["checklist"])
    progress, done = goal_state(s, max(_clamp(raw_p, default=0), _clamp(prev_progress, default=0)),
                                done, prev_done, ending)
    # 결말을 체크리스트와 맞춘다: 체크리스트를 다 채웠거나, 마지막 턴에 핵심(마지막) 항목 포함 한 개 빼고 다 채웠으면 성공
    cl = s["checklist"]
    if ending in (None, "partial") and cl:
        core_done = cl[-1] in done and len(done) >= len(cl) - 1
        if len(done) == len(cl) or (turn_index >= MAX_TURNS and core_done):
            ending = "success"
            progress, done = 100, list(cl)
    cps = []
    for c in (data.get("checkpoints") or [])[:3]:
        if not isinstance(c, dict) or c.get("type") not in CP_TYPES:
            continue
        span = str(c.get("text_span") or "").strip()
        if span and user_text and span not in user_text:
            span = ""  # 원문에 없는 구절은 하이라이트하지 않음
        cps.append({"type": c["type"], "text_span": span, "note": str(c.get("note") or "").strip()})
    return {
        "reply": (data.get("reply") or "…").strip(),
        "emotion": {
            "anger": _clamp(emo.get("anger")),
            "trust": _clamp(emo.get("trust")),
            "defensiveness": _clamp(emo.get("defensiveness")),
        },
        "reason": (data.get("reason") or "").strip(),
        "goal_progress": progress,
        "goal_debug": {"raw_progress": raw_p, "raw_checklist": raw_c},
        "checklist_done": done,
        "checkpoints": cps,
        "mentions": _mentions(data.get("mentions"), valid_ids or set(), s["id"]),
        "team_issue_addressed": data.get("team_issue_addressed") if isinstance(data.get("team_issue_addressed"), bool) else None,
        "tone_feedback": str(data.get("tone_feedback") or "").strip(),
        "ending": ending,
        "turn_index": turn_index,
        "max_turns": MAX_TURNS,
    }


def _mentions(raw, valid_ids: set, self_id: str) -> list[dict]:
    out = []
    for m in (raw or [])[:4]:
        if not isinstance(m, dict):
            continue
        cid = str(m.get("character") or "").strip()
        if cid not in valid_ids or cid == self_id:
            continue
        sent = m.get("sentiment") if m.get("sentiment") in ("negative", "positive", "neutral") else "neutral"
        out.append({"character": cid, "sentiment": sent, "quote": str(m.get("quote") or "").strip()[:120]})
    return out
