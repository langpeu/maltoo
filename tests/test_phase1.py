import json

import pytest

KEY = "sk-test-0000abcd"
H = {"X-OpenAI-Key": KEY, "X-Session-Id": "s1"}


def test_scenarios_list(client):
    r = client.get("/api/scenarios").json()
    assert len(r) == 7
    kinds = [s["kind"] for s in r]
    assert kinds.count("boss") == 4 and kinds.count("sub") == 3
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


def test_pregenerate(client, fake_openai):
    est = client.get("/api/tts/pregenerate").json()
    assert est["total"] == 21 and est["missing"] == 21 and est["estimate_usd"] > 0
    r = client.post("/api/tts/pregenerate", headers=H).json()
    assert r["made"] == 21 and r["missing"] == 0


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
