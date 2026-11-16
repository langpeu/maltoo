KEY = "sk-test-0000abcd"
H = {"X-OpenAI-Key": KEY, "X-Session-Id": "s1"}

TONE_B = {"db_med": -27.5, "db_p90": -21.0, "pitch_med": 142.0, "range_st": 5.5, "rate": 5.2}
FACE_B = {"brow": 0.1, "frown": 0.05, "press": 0.1, "smile": 0.12, "asym": 0.03, "nose_ratio": 0.43, "blink_per_min": 15}
FACE = {
    "has_face": True, "has_baseline": True, "expressionless": False, "blink_per_min": 40, "blink_base": 15,
    "listen": {"seconds": 3.2, "face_pct": 100, "frown_pct": 60, "away_pct": 0, "press_pct": 0,
               "mouthdown_pct": 0, "chinup_pct": 0, "smile_delta": 0, "rolls": 1, "smirks": 0},
    "silence": {"seconds": 2.0, "face_pct": 100, "frown_pct": 0, "away_pct": 85, "press_pct": 0,
                "mouthdown_pct": 0, "chinup_pct": 0, "smile_delta": 0, "rolls": 0, "smirks": 0},
    "speak": {"seconds": 4.0, "face_pct": 100, "frown_pct": 0, "away_pct": 0, "press_pct": 0,
              "mouthdown_pct": 0, "chinup_pct": 40, "smile_delta": 0, "rolls": 0, "smirks": 1},
    "checkpoints": [{"type": "roll", "phase": "listen", "note": "x", "t": 1.2}],
}


def test_baseline_with_face(client):
    r = client.post("/api/baseline", json={"tone": TONE_B, "face": {**FACE_B, "extra": 1}})
    assert r.status_code == 200 and r.json()["face"]["measured"] is True
    got = client.get("/api/baseline").json()
    assert got["face"]["nose_ratio"] == 0.43 and "extra" not in got["face"]
    # 카메라 없이 측정해도 저장됨
    client.post("/api/baseline", json={"tone": TONE_B})
    assert client.get("/api/baseline").json()["face"] is None
    assert client.post("/api/baseline", json={"tone": TONE_B, "face": {"brow": 1}}).status_code == 400


def test_face_description():
    from app.prompts.face import describe

    d = describe(FACE)
    for w in ("상대가 말하는 동안: 미간 찌푸림 60%", "눈 굴림 1회", "대답을 기다리는 3초 동안: 시선 회피 85%",
              "말하는 동안: 턱 듦 40%", "비웃는 듯한 입꼬리 1회", "깜빡임 분당 40회"):
        assert w in d, w
    assert "얼굴 인식 안 됨" in describe({"has_face": False})
    assert "무표정" in describe({**FACE, "expressionless": True})


def test_turn_sends_face(client, fake_openai):
    body = {"scenario_id": "kim", "history": [], "user_text": "부장님, 그 보고서는 제가 만들었습니다.", "face": FACE}
    assert client.post("/api/turn", json=body, headers=H).status_code == 200
    msgs = [c for c in fake_openai if c[0] == "chat"][0][1]["messages"]
    assert "[표정 측정" in msgs[-1]["content"] and "눈 굴림" in msgs[-1]["content"]
    assert "눈을 굴리거나" in msgs[0]["content"]


def test_face_model_download_once(client, monkeypatch, tmp_path):
    import json as _j

    from app import config
    from app.api import core

    cfg = _j.loads(_j.dumps(config.get_config()))
    cfg["face"]["local_model"] = str(tmp_path / "m" / "face.task")
    monkeypatch.setattr(core, "get_config", lambda: cfg)
    calls = []

    class R:
        content = b"x" * 200_000

        def raise_for_status(self):
            pass

    monkeypatch.setattr(core.httpx, "get", lambda url, **kw: calls.append(url) or R())
    assert client.post("/api/face-model").status_code == 200
    assert client.post("/api/face-model").status_code == 200
    assert len(calls) == 1  # 두 번째는 저장된 파일 사용

    monkeypatch.setattr(core.httpx, "get", lambda url, **kw: (_ for _ in ()).throw(OSError("blocked")))
    cfg["face"]["local_model"] = str(tmp_path / "m2" / "face.task")
    r = client.post("/api/face-model")
    assert r.status_code == 502 and "모델" in r.json()["detail"]["message"]
