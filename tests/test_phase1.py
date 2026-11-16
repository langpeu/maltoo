import json

import pytest

KEY = "sk-test-0000abcd"
H = {"X-OpenAI-Key": KEY, "X-Session-Id": "s1"}


def test_scenarios_list(client):
    r = client.get("/api/scenarios").json()
    assert len(r) == 7
    kinds = [s["kind"] for s in r]
    assert kinds.count("boss") == 4 and kinds.count("sub") == 3
    kim = next(s for s in r if s["id"] == "kim")
    assert {"opening", "nag1", "nag2", "end_success", "react_angry_0"} <= set(kim["lines"]) and kim["lines"]["nag1"] == "왜 말이 없어? 뭐 불만 있어?"
    genders = [s["character"]["gender"] for s in r]
    assert genders.count("여") == 3 and genders.count("남") == 4


def test_scenarios_have_valid_voices():
    from app import scenarios

    voices = {"alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar", "fable", "onyx", "nova"}
    for s in scenarios.all_scenarios():
        assert s["voice"]["voice"] in voices
        assert len(s["nags"]) == 2
        assert "과장" not in s["character"]["role"]  # 사용자만 과장


def test_cache_key_excludes_model():
    from app import cache

    a = cache.audio_key("안녕", "onyx", "톤")
    assert a == cache.audio_key(" 안녕 ", "onyx", "톤")
    assert a != cache.audio_key("안녕", "echo", "톤")


def test_fixed_line_generated_once_then_cached(client, fake_openai):
    r1 = client.get("/api/tts/line/choi/opening", headers=H).json()
    assert r1["cached"] is False and r1["url"].startswith("/assets/audio/")
    r2 = client.get("/api/tts/line/choi/opening", headers=H).json()
    assert r2["cached"] is True and r2["url"] == r1["url"]
    assert [c[0] for c in fake_openai].count("tts") == 1  # 두 번째는 OpenAI 호출 없음

    from app import cache
    m = json.loads(cache.MANIFEST.read_text(encoding="utf-8"))
    entry = next(iter(m.values()))
    assert entry["scenario"] == "choi" and entry["model"] == "gpt-4o-mini-tts"

    u = client.get("/api/usage", headers=H).json()
    assert u["saved_usd"] > 0  # 재사용으로 아낀 금액 기록


def test_cached_line_needs_no_key(client, fake_openai):
    client.get("/api/tts/line/kim/nag1", headers=H)
    r = client.get("/api/tts/line/kim/nag1")  # 키 없이
    assert r.status_code == 200 and r.json()["cached"] is True
    r = client.get("/api/tts/line/kim/nag2")  # 캐시 없음 + 키 없음
    assert r.status_code == 401


def test_bad_line(client, fake_openai):
    assert client.get("/api/tts/line/kim/hello", headers=H).status_code == 400
    assert client.get("/api/tts/line/nobody/opening", headers=H).status_code == 404


def test_say_runtime(client, fake_openai):
    r = client.post("/api/tts/say", json={"scenario_id": "kim", "text": "그래서?"}, headers=H).json()
    assert r["url"].startswith("/runtime/tts/")


def test_transcribe(client, fake_openai):
    files = {"audio": ("answer.webm", b"\x1aE\xdf\xa3fake", "audio/webm")}
    r = client.post("/api/transcribe", files=files, data={"seconds": "4.2"}, headers=H)
    assert r.status_code == 200
    assert "위험 보고" in r.json()["text"]
    stt = [c for c in fake_openai if c[0] == "stt"][0][1]
    assert stt["language"] == "ko"
    u = client.get("/api/usage", headers=H).json()
    assert u["by_feature_usd"]["transcribe"] == pytest.approx(4.2 / 60 * 0.003)


def test_turn(client, fake_openai):
    body = {
        "scenario_id": "choi",
        "history": [{"speaker": "npc", "text": "이게 지금 말이 돼? 일정이 이렇게 밀릴 때까지 대체 뭐 하고 있었어?"}],
        "user_text": "상무님, 2주 전에 보고드렸습니다.",
        "nag_count": 1,
    }
    r = client.post("/api/turn", json=body, headers=H)
    assert r.status_code == 200
    d = r.json()
    assert d["reply"] and d["emotion"]["anger"] == 70
    assert d["checklist_done"] == ["사실을 차분히 전달하기"]  # 없는 항목은 걸러냄
    assert d["turn_index"] == 1 and d["ending"] is None

    msgs = [c for c in fake_openai if c[0] == "chat"][0][1]["messages"]
    assert "랑프두잇" in msgs[0]["content"] and "과장" in msgs[0]["content"]
    assert sum(1 for m in msgs if m["role"] == "assistant") == 1  # 첫마디 중복 없음
    assert "재촉" in msgs[-1]["content"]


def test_turn_limit(client, fake_openai):
    hist = []
    for i in range(5):
        hist += [{"speaker": "npc", "text": "x"}, {"speaker": "me", "text": "y"}]
    r = client.post("/api/turn", json={"scenario_id": "kim", "history": hist, "user_text": "z"}, headers=H)
    assert r.status_code == 400


def test_last_turn_forces_ending():
    from app import scenarios
    from app.prompts import character

    s = scenarios.get("kim")
    d = character.parse('{"reply": "알았어", "ending": null}', s, 5)
    assert d["ending"] == "partial"
    d = character.parse("깨진 응답", s, 2)
    assert d["reply"] == "…" and d["ending"] is None


def test_limit_blocks_tts(client, fake_openai):
    from app import usage

    usage.record("abcd", "chat", "gpt-4o-mini", 0.50)
    r = client.post("/api/tts/say", json={"scenario_id": "kim", "text": "그래서?"}, headers=H)
    assert r.status_code == 402
    assert not [c for c in fake_openai if c[0] == "tts"]


def test_reactions_and_endings_lines():
    from app import scenarios

    for s in scenarios.all_scenarios():
        lines = scenarios.fixed_lines(s)
        for g in ("angry", "neutral", "soft"):
            assert sum(1 for k in lines if k.startswith(f"react_{g}_")) == 3, (s["id"], g)
        for e in ("success", "partial", "fail", "noresp"):
            assert f"end_{e}" in lines
        assert ("end_resign" in lines) == (s["kind"] == "sub")  # 퇴사 결말은 부하 직원만
        assert all(t.strip() and t.strip(".… ") for t in lines.values())  # 빈 문장 없음
    assert scenarios.get("choi")["reaction_start"] == "angry"


def test_reaction_cached_only(client, fake_openai):
    r = client.get("/api/tts/line/choi/react_angry_0?cached_only=true", headers=H)
    assert r.status_code == 404  # 추임새는 즉시 재생용이라 없으면 만들지 않음
    assert not [c for c in fake_openai if c[0] == "tts"]
    client.get("/api/tts/line/choi/react_angry_0", headers=H)  # 세팅처럼 생성
    r = client.get("/api/tts/line/choi/react_angry_0?cached_only=true", headers=H)
    assert r.status_code == 200 and r.json()["text"] == "뭐?!"


def test_voice_emotion(client, fake_openai):
    """목소리 지시문 = 인물 프로필 + 감정. 감정이 다르면 다른 음성(캐시 키)."""
    from app import scenarios
    s = scenarios.get("kim")
    assert scenarios.line_mood(s, "nag1") == "annoyed" and scenarios.line_mood(s, "nag2") == "angry"
    assert scenarios.line_mood(s, "react_soft_0") == "softened" and scenarios.line_mood(s, "end_fail") == "angry"
    assert scenarios.line_mood(scenarios.get("choi"), "opening") == "angry"
    assert scenarios.line_mood(scenarios.get("jung"), "end_resign") == "resigned"
    _, calm = scenarios.voice_for(s, "calm")
    _, angry = scenarios.voice_for(s, "angry")
    assert "department head" in calm and "clearly angry" in angry and calm != angry

    a = client.post("/api/tts/say", json={"scenario_id": "kim", "text": "그래서?", "mood": "calm"}, headers=H).json()
    b = client.post("/api/tts/say", json={"scenario_id": "kim", "text": "그래서?", "mood": "explosive"}, headers=H).json()
    assert a["url"] != b["url"]
    tts = [kw for k, kw in fake_openai if k == "tts"]
    assert "furious" in tts[-1]["instructions"]


def test_voice_playback_mood(client, fake_openai):
    """재생 감정 강조: 응답에 mood, 공개 설정에 감정별 음량·속도."""
    cfg = client.get("/api/config").json()["voice_playback"]
    assert cfg["moods"]["explosive"]["gain"] > cfg["moods"]["calm"]["gain"] > cfg["moods"]["resigned"]["gain"]
    assert client.get("/api/tts/line/kim/nag2", headers=H).json()["mood"] == "angry"
    r = client.post("/api/tts/say", json={"scenario_id": "kim", "text": "됐어.", "mood": "softened"}, headers=H).json()
    assert r["mood"] == "softened"


def test_custom_line_audio(client, fake_openai, tmp_path):
    """custom/<인물>/<대사>.mp3 가 있으면 생성 없이 그 파일을 쓴다."""
    from app import cache
    p = cache.custom_path("kim", "opening")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"ID3fake")
    r = client.get("/api/tts/line/kim/opening", headers=H).json()
    assert r["url"] == "/assets/audio/custom/kim/opening.mp3" and r["custom"] and r["mood"] == "calm"
    assert not [k for k, _ in fake_openai if k == "tts"]


def test_goal_checklist_matching_and_carry(client, fake_openai):
    """체크리스트: 번호·바꿔 쓴 문구도 인정하고, 이전 턴 달성 항목은 유지, 비율보다 낮게 표시하지 않음."""
    from app.prompts import character
    from app import scenarios
    s = scenarios.get("kim")
    cl = s["checklist"]
    assert character.match_checklist([1, "3"], cl) == [cl[0], cl[2]]
    assert character.match_checklist(["내 기여를 구체적으로 밝혔다"], cl) == [cl[0]]       # 바꿔 쓴 문구
    assert character.match_checklist(["관계 해치지 않는 제안"], cl) == [cl[1]]
    assert character.match_checklist(["없는 항목", 9, True], cl) == []
    p, done = character.goal_state(s, 5, [cl[1]], [cl[0]], None)       # 이전 달성 유지
    assert done == [cl[0], cl[1]] and p >= 66
    assert character.goal_state(s, 40, [], [], "success") == (100, cl)  # 성공이면 100

    from conftest import TURN_OVERRIDE
    TURN_OVERRIDE.update({"goal_progress": 0, "checklist_done": [2]})
    body = {"scenario_id": "kim", "history": [], "user_text": "제가 3주간 만든 보고서입니다.", "goal_done": [cl[0]]}
    d = client.post("/api/turn", json=body, headers=H).json()
    assert d["checklist_done"] == [cl[0], cl[1]] and d["goal_progress"] >= 66
    sys_prompt = [kw for k, kw in fake_openai if k == "chat"][-1]["messages"][0]["content"]
    assert "1) 내 기여를 구체적으로 밝히기" in sys_prompt and "[이미 달성한 체크리스트]" in sys_prompt
