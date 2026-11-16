import pytest

KEY = "sk-test-0000abcd"
H = {"X-OpenAI-Key": KEY, "X-Session-Id": "s1"}


def test_cost_formulas():
    from app import usage

    # gpt-4o-mini: 입력 $0.15/1M, 출력 $0.60/1M
    assert usage.cost_chat("gpt-4o-mini", 1_000_000, 0) == pytest.approx(0.15)
    assert usage.cost_chat("gpt-4o-mini", 0, 1_000_000) == pytest.approx(0.60)
    # 음성 인식: 분당 $0.003
    assert usage.cost_transcribe("gpt-4o-mini-transcribe", seconds=60) == pytest.approx(0.003)
    # 이미지: 중 품질 $0.034
    assert usage.cost_image("gpt-image-1.5", "medium", 2) == pytest.approx(0.068)
    # 모르는 모델은 0 (예외 없음)
    assert usage.cost_chat("unknown", 1000, 1000) == 0


def test_key_id_is_last4_only():
    from app import usage

    assert usage.key_id_of("sk-abcdefgh1234") == "1234"


def test_no_key_returns_401(client):
    r = client.get("/api/usage")
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "no_key"


def test_verify_ok_and_bad(client, fake_openai):
    r = client.post("/api/key/verify", headers=H)
    assert r.status_code == 200
    assert r.json()["key_hint"] == "sk-...abcd"

    r = client.post("/api/key/verify", headers={"X-OpenAI-Key": "sk-xxxxBAD!"})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "invalid_key"


def test_chat_records_cost(client, fake_openai):
    r = client.post("/api/test/chat", headers=H)
    assert r.status_code == 200
    u = r.json()["usage"]
    expected = (100 * 0.15 + 20 * 0.60) / 1_000_000
    assert u["session_usd"] == pytest.approx(expected)
    assert u["today_usd"] == pytest.approx(expected)
    assert u["by_feature_usd"]["chat"] == pytest.approx(expected)
    assert u["calls"] == 1


def test_limit_blocks_call(client, fake_openai):
    from app import usage

    usage.record("abcd", "chat", "gpt-4o-mini", 0.50, "s0")  # 일일 한도($0.50) 소진
    r = client.post("/api/test/chat", headers=H)
    assert r.status_code == 402
    d = r.json()["detail"]
    assert d["code"] == "limit_exceeded" and d["scope"] == "daily"

    s = client.get("/api/usage", headers=H).json()
    assert s["daily_status"] == "blocked"


def test_limits_are_per_key(client, fake_openai):
    from app import usage

    usage.record("zzzz", "chat", "gpt-4o-mini", 0.50)  # 다른 키
    assert client.post("/api/test/chat", headers=H).status_code == 200


def test_set_limits_validation(client):
    assert client.put("/api/settings/limits", json={"daily": 1, "monthly": 10}).status_code == 200
    assert client.get("/api/config").json()["limits"]["daily"] == 1
    r = client.put("/api/settings/limits", json={"daily": 10, "monthly": 1})
    assert r.status_code == 400


def test_api_key_never_stored(client, fake_openai, tmp_path):
    client.post("/api/key/verify", headers=H)
    client.post("/api/test/chat", headers=H)
    raw = (tmp_path / "test.db").read_bytes()
    assert KEY.encode() not in raw


def test_index_and_logo_served(client):
    assert "랑프두잇" in client.get("/").text
    assert client.get("/assets/brand/logo.jpg").status_code == 200


def test_legacy_db_moves_to_data_dir(tmp_path, monkeypatch):
    """루트 data.db 가 있으면 처음 실행 때 data/maltoo.db 로 옮겨지고 내용이 유지된다."""
    import sqlite3

    from app import db
    monkeypatch.delenv("MALTOO_DB", raising=False)
    monkeypatch.setattr(db, "LEGACY_DB", tmp_path / "data.db")
    monkeypatch.setattr(db, "DATA_DIR", tmp_path / "data")
    con = sqlite3.connect(tmp_path / "data.db")
    con.execute("CREATE TABLE marker (v TEXT)")
    con.execute("INSERT INTO marker VALUES ('kept')")
    con.commit()
    con.close()
    db.init_db()
    assert not (tmp_path / "data.db").exists() and (tmp_path / "data" / "maltoo.db").exists()
    con = sqlite3.connect(tmp_path / "data" / "maltoo.db")
    assert con.execute("SELECT v FROM marker").fetchone()[0] == "kept"
    con.close()
