import json

KEY = "sk-test-0000abcd"
H = {"X-OpenAI-Key": KEY, "X-Session-Id": "setup"}


def test_status_counts(client, fake_openai):
    st = client.get("/api/setup/status").json()
    assert st["audio"]["missing"] == 115  # 첫마디·재촉 21 + 추임새 63 + 결말 31
    assert st["portraits"]["missing"] == 70  # 7명 × 5표정 × 2(입 다묾/벌림)
    assert 0.5 < st["estimate_usd"] < 1.5
    first_kim = [j for j in st["jobs"] if j["kind"] == "portrait" and j["scenario_id"] == "kim"]
    assert (first_kim[0]["expr"], first_kim[0]["talk"]) == ("calm", False)  # 기본 사진이 먼저
    assert all(j["talk"] for j in first_kim[5:])  # 입 벌림은 표정 뒤


def test_portrait_chain_and_reuse(client, fake_openai):
    st = client.get("/api/setup/status").json()
    kim = [j for j in st["jobs"] if j["kind"] == "portrait" and j["scenario_id"] == "kim"]

    # 순서를 어기면 거절
    r = client.post("/api/setup/job", json=kim[1], headers=H)
    assert r.status_code == 409

    for j in kim:
        assert client.post("/api/setup/job", json=j, headers=H).status_code == 200

    gens = [c for c in fake_openai if c[0] == "img_gen"]
    edits = [c for c in fake_openai if c[0] == "img_edit"]
    assert len(gens) == 1 and len(edits) == 9
    gp = gens[0][1]["prompt"]
    assert "랑프두잇" in gp and "fictional" in gp
    assert "gold-tone rectangular metal-frame glasses" in gp and "mole on the left cheek" in gp  # 상세 외모
    assert "eyes at about 40% from the top" in gp  # 공통 촬영 조건
    assert any("glaring over the top of his glasses" in e[1]["prompt"] for e in edits)  # 인물별 표정 지시
    assert sum(1 for e in edits if "mask" in e[1]) == 5  # 입 벌림만 마스크
    assert all("input_fidelity" not in e[1] for e in edits)  # gpt-image-1-mini 는 high 미지원 → 생략
    assert all(e[1]["model"] == "gpt-image-1-mini" for e in edits)
    assert "mole on the left cheek" in [e for e in edits if "mask" not in e[1]][0][1]["prompt"]  # 편집에도 외모 재명시

    st2 = client.get("/api/setup/status").json()
    assert st2["portraits"]["missing"] == 60
    frames = st2["portraits_status"]["kim"]["frames"]
    assert frames["angry"]["closed"].endswith("/kim/angry.webp")
    assert frames["angry"]["talk"].endswith("/kim/angry_talk.webp")

    # 이미 있으면 다시 만들지 않음
    n = len(fake_openai)
    client.post("/api/setup/job", json=kim[0], headers=H)
    assert len(fake_openai) == n

    from app import portraits
    m = json.loads(portraits.MANIFEST.read_text(encoding="utf-8"))
    assert m["kim/calm.webp"]["model"] == "gpt-image-1-mini" and "prompt_hash" in m["kim/calm.webp"]


def test_setup_ignores_daily_limit_but_records_cost(client, fake_openai):
    from app import usage

    usage.record("abcd", "chat", "gpt-4o-mini", 0.50)  # 일일 한도 소진
    st = client.get("/api/setup/status").json()
    audio = [j for j in st["jobs"] if j["kind"] == "audio"][0]
    assert client.post("/api/setup/job", json=audio, headers=H).status_code == 200
    u = client.get("/api/usage", headers=H).json()
    assert u["by_feature_usd"]["tts"] > 0

    # 일반 대화 호출은 여전히 차단
    r = client.post("/api/tts/say", json={"scenario_id": "kim", "text": "그래서?"}, headers=H)
    assert r.status_code == 402


def test_setup_job_needs_key(client, fake_openai):
    st = client.get("/api/setup/status").json()
    assert client.post("/api/setup/job", json=st["jobs"][0]).status_code == 401


def test_setup_cost_not_counted_in_limit(client, fake_openai):
    st = client.get("/api/setup/status").json()
    kim = [j for j in st["jobs"] if j["kind"] == "portrait" and j["scenario_id"] == "kim"]
    for j in kim:
        client.post("/api/setup/job", json=j, headers=H)
    u = client.get("/api/usage", headers={**H, "X-Session-Id": "practice"}).json()
    assert u["setup_usd"] > 0.1 and u["today_usd"] > 0.1
    assert u["today_limited_usd"] == 0 and u["daily_status"] == "ok"
    assert u["session_usd"] == 0  # 연습 비용에 섞이지 않음
    r = client.post("/api/tts/say", json={"scenario_id": "kim", "text": "그래서?"}, headers=H)
    assert r.status_code == 200  # 세팅 후에도 연습 가능


def test_all_characters_have_detailed_appearance():
    from app import portraits, scenarios

    for s in scenarios.all_scenarios():
        c = s["character"]
        assert len(c["appearance_prompt"]) > 500
        for key in ("Build:", "Face:", "Eyes:", "Eyebrows:", "Nose:", "Mouth:", "Hair:", "Clothing:", "vibe"):
            assert key in c["appearance_prompt"], (s["id"], key)
        assert set(c["expression_notes"]) == {"annoyed", "angry", "explosive", "softened"}
        assert c["appearance_prompt"] in portraits.base_prompt(s)
