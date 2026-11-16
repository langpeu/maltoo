"""ElevenLabs 고정 대사 생성: 키 헤더 필수, 대본 생성, custom 폴더 저장, 다시 만들기."""

H = {"X-ElevenLabs-Key": "sk_test_eleven"}


def test_eleven_flow(client, fake_openai, monkeypatch):
    from app import cache, eleven, scenarios

    sent = []
    monkeypatch.setattr(eleven, "synth", lambda key, vid, text: sent.append((key, vid, text)) or b"ID3eleven")
    monkeypatch.setattr(eleven, "list_voices", lambda key: [{"voice_id": "v1", "name": "진짜김부장", "category": "generated"}])

    assert client.get("/api/eleven/voices").status_code == 401
    assert client.get("/api/eleven/voices", headers=H).json()["voices"][0]["voice_id"] == "v1"

    st = client.get("/api/eleven/status").json()
    park = next(c for c in st["characters"] if c["id"] == "park")
    assert park["done"] == 0 and park["missing_chars"] > 0
    # 직접 쓴 대본(김 부장)과 자동 대본(감정 태그)
    assert eleven.script_for(scenarios.get("kim"), "nag1").startswith("[snorts")
    assert eleven.script_for(scenarios.get("park"), "nag2").startswith("[angry] ")
    assert not eleven.script_for(scenarios.get("park"), "opening").startswith("[")  # 평온은 태그 없음

    body = {"scenario_id": "park", "line": "nag2", "voice_id": "v1", "voice_name": "박팀장"}
    r = client.post("/api/eleven/line", json=body, headers=H).json()
    assert r["url"] == "/assets/audio/custom/park/nag2.mp3" and sent[-1][0] == "sk_test_eleven"
    assert cache.custom_path("park", "nag2").read_bytes() == b"ID3eleven"
    assert eleven.manifest()["park/nag2"]["voice_name"] == "박팀장"
    # 이미 있으면 건너뛰고, force 면 다시 만든다
    assert client.post("/api/eleven/line", json=body, headers=H).json()["skipped"]
    n = len(sent)
    client.post("/api/eleven/line", json={**body, "force": True}, headers=H)
    assert len(sent) == n + 1
    # 대화에서는 이 파일을 쓰고, 초기 세팅은 건너뛴다
    assert client.get("/api/tts/line/park/nag2").json()["url"].endswith("/custom/park/nag2.mp3")
    # 키는 파일에 남지 않는다
    assert "sk_test_eleven" not in cache.custom_path("park", "nag2").parent.parent.joinpath("manifest.json").read_text()
