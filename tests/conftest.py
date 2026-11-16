import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """임시 DB를 쓰는 테스트 클라이언트."""
    monkeypatch.setenv("MALTOO_DB", str(tmp_path / "test.db"))
    from fastapi.testclient import TestClient

    import main

    return TestClient(main.create_app())


class FakeUsage:
    prompt_tokens = 100
    completion_tokens = 20


class FakeResp:
    usage = FakeUsage()

    class _Choice:
        class message:
            content = "좋은 아침입니다, 과장님!"

    choices = [_Choice()]


class FakeOpenAI:
    """OpenAI 클라이언트 대역. 네트워크 호출 없음."""

    def __init__(self, api_key):
        self.api_key = api_key
        outer = self

        class _Models:
            def list(self_inner):
                if outer.api_key.endswith("BAD!"):
                    from openai import AuthenticationError
                    import httpx
                    req = httpx.Request("GET", "https://api.openai.com/v1/models")
                    raise AuthenticationError("bad key", response=httpx.Response(401, request=req), body=None)
                return []

        class _Completions:
            def create(self_inner, **kw):
                return FakeResp()

        class _Chat:
            completions = _Completions()

        self.models = _Models()
        self.chat = _Chat()


@pytest.fixture()
def fake_openai(monkeypatch):
    from app import openai_client

    monkeypatch.setattr(openai_client, "make_client", lambda key: FakeOpenAI(key))
