"""인물 연기 + 턴 판정 프롬프트 (Phase 1).

gpt-4o-mini 는 상대 인물을 연기하고 감정·목표 진행을 판단만 한다.
금액·퇴사 위험도 같은 게임 수치는 여기서 정하지 않는다 (CLAUDE.md 규칙).
"""

import json

from ..config import get_config

MAX_TURNS = 5

OUTPUT_SPEC = """반드시 아래 JSON 객체 하나만 출력한다. 다른 텍스트 금지.
{
  "reply": "상대 인물의 다음 대사 (한국어, 1~3문장, 실제 말하듯이)",
  "emotion": {"anger": 0-100, "trust": 0-100, "defensiveness": 0-100},
  "reason": "이번 과장 발언이 상대 감정에 준 영향 한 줄 (한국어)",
  "goal_progress": 0-100,
  "checklist_done": ["달성된 체크리스트 항목 문구를 그대로"],
  "ending": null | "success" | "partial" | "fail"
}"""


def system_prompt(s: dict, turn_index: int) -> str:
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
[체크리스트] {', '.join(s['checklist'])}
[실패 조건] {', '.join(s['fail_conditions'])}

연기 규칙:
- 캐릭터를 끝까지 유지한다. 쉽게 설득되지 않는다. 사용자가 차분하고 구체적으로 대응할 때만 조금씩 누그러진다.
- 사용자가 공격적·비꼬는·명령조로 말하면 성격대로 더 거칠어진다. 지나치게 굽히기만 하면 더 밀어붙인다.
- 목표가 자연스럽게 달성되면 그 사실을 대사로 인정하고 ending 을 "success" 로 한다.
- 실패 조건에 해당하면 ending 을 "fail" 로 한다.
- 욕설, 인신공격, 차별 발언은 하지 않는다. 현실적인 직장 갈등 수준을 지킨다.
- 사용자 발언이 비어 있거나 알아듣기 어려우면 그 점을 성격대로 지적한다.
- 이번은 사용자의 {turn_index}번째 답변이다 (최대 {MAX_TURNS}번).{' 이번이 마지막이므로 반드시 ending 을 success/partial/fail 중 하나로 정하고 대화를 마무리하는 대사를 한다.' if last else ''}

{OUTPUT_SPEC}"""


def build_messages(s: dict, history: list[dict], user_text: str, turn_index: int) -> list[dict]:
    msgs = [{"role": "system", "content": system_prompt(s, turn_index)}]
    if not history or history[0].get("text") != s["opening"]:
        msgs.append({"role": "assistant", "content": json.dumps({"reply": s["opening"]}, ensure_ascii=False)})
    for h in history:
        if h.get("speaker") == "me":
            msgs.append({"role": "user", "content": h.get("text", "")})
        else:
            msgs.append({"role": "assistant", "content": json.dumps({"reply": h.get("text", "")}, ensure_ascii=False)})
    msgs.append({"role": "user", "content": user_text or "(말이 없음)"})
    return msgs


def _clamp(v, lo=0, hi=100, default=50):
    try:
        return max(lo, min(hi, int(round(float(v)))))
    except (TypeError, ValueError):
        return default


def parse(raw: str, s: dict, turn_index: int) -> dict:
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
    done = [x for x in (data.get("checklist_done") or []) if x in s["checklist"]]
    return {
        "reply": (data.get("reply") or "…").strip(),
        "emotion": {
            "anger": _clamp(emo.get("anger")),
            "trust": _clamp(emo.get("trust")),
            "defensiveness": _clamp(emo.get("defensiveness")),
        },
        "reason": (data.get("reason") or "").strip(),
        "goal_progress": _clamp(data.get("goal_progress"), default=0),
        "checklist_done": done,
        "ending": ending,
        "turn_index": turn_index,
        "max_turns": MAX_TURNS,
    }
