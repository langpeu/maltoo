KEY = "sk-test-0000abcd"
H = {"X-OpenAI-Key": KEY, "X-Session-Id": "s1"}

TONE = {
    "has_baseline": True, "speech_s": 3.1, "latency_s": 2.4, "nag": 0,
    "loud_db": 6.2, "pitch_shift_st": 4.8, "range_ratio": 0.6, "rate_ratio": 1.4,
    "end": "falling_sharp", "end_slope": -13, "arousal": 88, "warmth": 25,
    "checkpoints": [{"type": "loud", "t": 0.8, "note": "x"}, {"type": "fall", "t": 2.9, "note": "y"}],
}


def test_baseline_roundtrip(client):
    assert client.get("/api/baseline").json()["tone"] is None
    b = {"db_med": -27.5, "db_p90": -21.0, "pitch_med": 142.0, "range_st": 5.5, "rate": 5.2, "voiced_seconds": 10}
    r = client.post("/api/baseline", json={"tone": b})
    assert r.status_code == 200 and r.json()["tone"]["measured"] is True
    got = client.get("/api/baseline").json()["tone"]
    assert got["pitch_med"] == 142.0 and "voiced_seconds" not in got
    # 최신 측정이 우선
    client.post("/api/baseline", json={"tone": {**b, "pitch_med": 210.0}})
    assert client.get("/api/baseline").json()["tone"]["pitch_med"] == 210.0


def test_baseline_validation(client):
    assert client.post("/api/baseline", json={"tone": {"db_med": -20}}).status_code == 400
    bad = {"db_med": -27.5, "db_p90": -21.0, "pitch_med": 20.0, "range_st": 5.5, "rate": 5.2}
    assert client.post("/api/baseline", json={"tone": bad}).status_code == 400


def test_tone_description():
    from app.prompts.tone import describe

    d = describe(TONE)
    for word in ("+6dB", "5반음 높음", "단조로움", "1.4배", "뚝 떨어짐", "2.4초 머뭇거림", "언성이 높아진 순간 1회", "격앙도 88"):
        assert word in d, word
    assert "미측정" in describe({**TONE, "has_baseline": False})
    assert describe(None) == "(목소리 측정값 없음)"


def test_turn_includes_tone_and_returns_checkpoints(client, fake_openai):
    body = {
        "scenario_id": "choi",
        "history": [{"speaker": "npc", "text": "이게 지금 말이 돼? 일정이 이렇게 밀릴 때까지 대체 뭐 하고 있었어?"}],
        "user_text": "상무님, 2주 전에 보고드렸습니다.",
        "tone": TONE,
    }
    d = client.post("/api/turn", json=body, headers=H).json()
    msgs = [c for c in fake_openai if c[0] == "chat"][0][1]["messages"]
    assert "[목소리 톤 측정]" in msgs[-1]["content"] and "뚝 떨어짐" in msgs[-1]["content"]
    assert "목소리 톤" in msgs[0]["content"]  # 톤 판단 규칙이 시스템 프롬프트에 있음
    # 원문에 없는 구절은 하이라이트 제거, 모르는 유형은 버림
    assert d["checkpoints"][0] == {"type": "good", "text_span": "2주 전에", "note": "사실을 구체적으로 짚었다"}
    assert d["checkpoints"][1]["text_span"] == ""
    assert len(d["checkpoints"]) == 2
    assert "끝 억양" in d["tone_feedback"]


def test_turn_without_tone_still_works(client, fake_openai):
    body = {"scenario_id": "kim", "history": [], "user_text": "네, 알겠습니다."}
    assert client.post("/api/turn", json=body, headers=H).status_code == 200
