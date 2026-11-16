"""브라우저가 측정한 목소리 톤 수치 → gpt-4o-mini 에 넘길 한국어 설명.

gpt-4o-mini 는 소리를 직접 듣지 못하므로, 평소 목소리 대비 수치를 문장으로 풀어서 전달한다.
"""

END_TEXT = {
    "falling_sharp": "문장 끝이 뚝 떨어짐(단정·명령조로 들림)",
    "falling": "문장 끝이 내려감",
    "flat": "문장 끝이 평평함",
    "rising": "문장 끝이 살짝 올라감(부드럽게 들림)",
}
CP_TEXT = {
    "loud": "언성이 높아진 순간", "high": "목소리가 격앙되게 높아진 순간", "fast": "말이 빨라진 순간",
    "fall": "끝 억양이 뚝 떨어진 순간", "stress": "단어에 세게 힘준 순간", "sigh": "한숨 소리",
}


def _num(t: dict, k: str, default=0.0) -> float:
    try:
        return float(t.get(k, default))
    except (TypeError, ValueError):
        return default


def describe(tone: dict | None) -> str:
    if not tone:
        return "(목소리 측정값 없음)"
    lines = []
    base = "평소 목소리 대비" if tone.get("has_baseline") else "평소 목소리 미측정, 일반 기준 대비"
    lines.append(f"- 기준: {base}")
    ld = _num(tone, "loud_db")
    if abs(ld) >= 2:
        lines.append(f"- 음량: {'+' if ld > 0 else ''}{ld:.0f}dB ({'크게' if ld > 0 else '작게'} 말함)")
    else:
        lines.append("- 음량: 평소와 비슷")
    ps = _num(tone, "pitch_shift_st")
    if abs(ps) >= 1.5:
        lines.append(f"- 음높이: 평소보다 {abs(ps):.0f}반음 {'높음' if ps > 0 else '낮음'}")
    rr = _num(tone, "range_ratio", 1)
    if rr < 0.7:
        lines.append("- 억양 변화: 단조로움(무뚝뚝·차갑게 들릴 수 있음)")
    elif rr > 1.5:
        lines.append("- 억양 변화: 기복이 큼")
    rate = _num(tone, "rate_ratio", 1)
    if abs(rate - 1) >= 0.15:
        lines.append(f"- 말 속도: 평소의 {rate:.1f}배 ({'빠름' if rate > 1 else '느림'})")
    lines.append(f"- 끝 억양: {END_TEXT.get(tone.get('end'), '알 수 없음')}")
    lat = _num(tone, "latency_s")
    if lat >= 2:
        lines.append(f"- 대답 시작까지 {lat:.1f}초 머뭇거림")
    cps = tone.get("checkpoints") or []
    if cps:
        kinds = {}
        for c in cps:
            kinds[c.get("type")] = kinds.get(c.get("type"), 0) + 1
        lines.append("- 감지: " + ", ".join(f"{CP_TEXT.get(k, k)} {n}회" for k, n in kinds.items()))
    lines.append(f"- 종합 인상: 격앙도 {int(_num(tone, 'arousal', 50))}/100, 따뜻함 {int(_num(tone, 'warmth', 50))}/100")
    return "\n".join(lines)
