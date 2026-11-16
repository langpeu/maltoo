import pytest

KEY = "sk-test-0000abcd"
H = {"X-OpenAI-Key": KEY, "X-Session-Id": "s1"}

TONE_BAD = {"loud_n": 1, "high_n": 1, "fast_n": 0, "fall_n": 1, "stress_n": 0, "sigh_n": 0,
            "arousal": 80, "warmth": 30, "nag": 1, "has_baseline": True, "end": "falling_sharp"}
TONE_GOOD = {"loud_n": 0, "high_n": 0, "fast_n": 0, "fall_n": 0, "stress_n": 0, "sigh_n": 0,
             "arousal": 50, "warmth": 65, "nag": 0}
FACE = {"has_face": True, "expressionless": False,
        "listen": {"rolls": 1, "smirks": 0, "frown_pct": 40, "away_pct": 0, "chinup_pct": 0, "press_pct": 0, "mouthdown_pct": 0},
        "speak": {"rolls": 0, "smirks": 0, "frown_pct": 0, "away_pct": 20, "chinup_pct": 0, "press_pct": 0, "mouthdown_pct": 0}}


def test_scores_deterministic():
    from app import report

    bad, good = report.tone_score(TONE_BAD), report.tone_score(TONE_GOOD)
    assert good == 100 and bad < 60 and bad == report.tone_score(dict(TONE_BAD))
    assert report.tone_score(None) is None
    f = report.face_score(FACE)
    assert f == 100 - 15 - 10 - 4  # 눈 굴림 1, 찌푸림 40%, 시선 회피 20%
    assert report.face_score({"has_face": False}) is None
    # 없는 항목은 빼고 가중 평균
    assert report.combine(80, None, None, 50) == round(80 * 0.85 + 50 * 0.15)
    assert report.combine(None, None, None, 40) == 40
    assert report.combine(100, 100, 100, 100) == 100


def _turns():
    return [
        {"speaker": "npc", "text": "이게 지금 말이 돼?"},
        {"speaker": "me", "text": "상무님, 2주 전에 보고드렸습니다.", "tone": TONE_BAD, "face": FACE,
         "checkpoints": [{"type": "excuse", "text_span": "보고드렸습니다", "note": "변명조"}]},
        {"speaker": "npc", "text": "그래서 결론이 뭔데?"},
        {"speaker": "me", "text": "대책을 정리해서 오후까지 드리겠습니다.", "tone": TONE_GOOD},
    ]


def test_report_and_history(client, fake_openai):
    body = {"session_id": "sess-1", "scenario_id": "choi", "turns": _turns(), "ending": "partial",
            "goal_progress": 60, "difficulty": "spicy"}
    r = client.post("/api/report", json=body, headers=H)
    assert r.status_code == 200
    d = r.json()
    sc = d["scores"]
    assert sc["words"] == 72 and sc["goal"] == 60
    assert sc["tone"] == round((d["per_turn"][0]["tone"] + 100) / 2)
    assert sc["face"] == 71 and 0 < sc["overall"] <= 100
    # 범위 밖 턴은 None, 대안 없는 교정은 버림
    assert len(d["fixes"]) == 2 and d["fixes"][1]["turn"] is None
    assert d["habits"][0] == "문장 끝을 뚝 떨어뜨림"

    # 코치 프롬프트에 톤·표정 근거가 들어감
    msgs = [c for c in fake_openai if c[0] == "chat"][-1][1]["messages"]
    user = msgs[1]["content"]
    assert "(목소리)" in user and "(표정)" in user and "(대사 판정) excuse" in user
    assert "spicy" in msgs[0]["content"]

    h = client.get("/api/history").json()
    assert len(h) == 1 and h[0]["id"] == "sess-1" and h[0]["name"] == "최 상무"
    assert h[0]["scores"]["overall"] == sc["overall"] and h[0]["difficulty"] == "spicy"
    one = client.get("/api/history/sess-1").json()
    assert len(one["turns"]) == 4 and one["report"]["summary"]

    # 같은 세션 다시 저장 → 덮어쓰기
    client.post("/api/report", json=body, headers=H)
    assert len(client.get("/api/history").json()) == 1


def test_report_no_answers_skips_gpt(client, fake_openai):
    body = {"session_id": "s2", "scenario_id": "kim", "turns": [{"speaker": "npc", "text": "x"}],
            "ending": "fail", "goal_progress": 0}
    d = client.post("/api/report", json=body, headers=H).json()
    assert d["scores"]["overall"] == 0 and d["fixes"] == []
    assert not [c for c in fake_openai if c[0] == "chat"]


def test_coach_voice(client, fake_openai):
    r = client.post("/api/tts/coach", json={"text": "대책부터 말씀드려도 될까요?"}, headers=H)
    assert r.status_code == 200 and r.json()["url"].startswith("/runtime/tts/")
    tts = [c for c in fake_openai if c[0] == "tts"][0][1]
    assert tts["voice"] == "marin" and "부드럽게" in tts["instructions"]


@pytest.mark.parametrize("level,word", [("mild", "순한 맛"), ("spicy", "매운 맛"), ("normal", "보통")])
def test_difficulty_in_prompt(client, fake_openai, level, word):
    body = {"scenario_id": "kim", "history": [], "user_text": "네.", "difficulty": level}
    client.post("/api/turn", json=body, headers=H)
    sys = [c for c in fake_openai if c[0] == "chat"][-1][1]["messages"][0]["content"]
    assert word in sys
