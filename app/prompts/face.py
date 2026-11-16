"""브라우저가 측정한 표정 수치 → gpt-4o-mini 에 넘길 한국어 설명. (영상은 받지 않는다)"""

PHASE = {"listen": "상대가 말하는 동안", "silence": "대답을 기다리는 3초 동안", "speak": "말하는 동안"}
CP = {"frown": "미간 찌푸림", "roll": "눈 굴림", "away": "시선 회피", "smirk": "한쪽 입꼬리(비웃음)",
      "press": "입술 꽉 다묾", "mouthdown": "입꼬리 내림", "chinup": "턱 듦"}


def _phase_line(name: str, s: dict | None) -> str | None:
    if not s or not s.get("seconds"):
        return None
    if s.get("face_pct", 0) < 30:
        return f"- {PHASE[name]}: 얼굴이 거의 화면에 없음"
    parts = []
    for key, label in (("frown_pct", "미간 찌푸림"), ("away_pct", "시선 회피"), ("press_pct", "입술 꽉"),
                       ("mouthdown_pct", "입꼬리 내림"), ("chinup_pct", "턱 듦")):
        v = s.get(key, 0)
        if v >= 20:
            parts.append(f"{label} {v}%")
    if s.get("rolls"):
        parts.append(f"눈 굴림 {s['rolls']}회")
    if s.get("smirks"):
        parts.append(f"비웃는 듯한 입꼬리 {s['smirks']}회")
    sd = s.get("smile_delta", 0)
    if sd >= 0.15:
        parts.append("평소보다 미소")
    return f"- {PHASE[name]}: " + (", ".join(parts) if parts else "평소와 비슷한 표정")


def describe(face: dict | None) -> str:
    if not face or not face.get("has_face"):
        return "(카메라 꺼짐 또는 얼굴 인식 안 됨)"
    lines = ["- 기준: " + ("평소 표정 대비" if face.get("has_baseline") else "평소 표정 미측정, 일반 기준 대비")]
    for name in ("listen", "silence", "speak"):
        line = _phase_line(name, face.get(name))
        if line:
            lines.append(line)
    if face.get("expressionless"):
        lines.append("- 말하는 동안 표정 변화가 거의 없음(무표정, 차갑거나 무관심해 보일 수 있음)")
    bpm, base = face.get("blink_per_min"), face.get("blink_base") or 17
    if bpm and bpm > base * 1.8:
        lines.append(f"- 눈 깜빡임 분당 {bpm}회(평소 {base}회) — 긴장·당황")
    return "\n".join(lines)
