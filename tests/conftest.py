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
                outer.calls.append(("chat", kw))
                if kw.get("response_format"):
                    import json

                    class R(FakeResp):
                        class _C:
                            class message:
                                content = json.dumps({
                                    "reply": "그래서 결론이 뭔데?",
                                    "emotion": {"anger": 70, "trust": 30, "defensiveness": 55},
                                    "reason": "변명처럼 들려서 분노가 올랐다",
                                    "goal_progress": 20,
                                    "checklist_done": ["사실을 차분히 전달하기", "없는 항목"],
                                    "checkpoints": [
                                        {"type": "good", "text_span": "2주 전에", "note": "사실을 구체적으로 짚었다"},
                                        {"type": "aggressive", "text_span": "원문에 없는 말", "note": "x"},
                                        {"type": "weird", "text_span": "보고", "note": "x"},
                                    ],
                                    "tone_feedback": "말은 차분했지만 끝 억양이 뚝 떨어져 단정적으로 들렸다",
                                    "ending": None,
                                }, ensure_ascii=False)
                        choices = [_C()]
                    return R()
                return FakeResp()

        class _Chat:
            completions = _Completions()

        class _Bin:
            def read(self_inner):
                return b"ID3fake-mp3"

        class _Speech:
            def create(self_inner, **kw):
                outer.calls.append(("tts", kw))
                return _Bin()

        class _Tr:
            text = "상무님, 2주 전에 위험 보고를 드렸습니다."
            usage = None

        class _Transcriptions:
            def create(self_inner, **kw):
                outer.calls.append(("stt", kw))
                return _Tr()

        class _Audio:
            speech = _Speech()
            transcriptions = _Transcriptions()

        class _ImgResp:
            class _D:
                import base64 as _b
                b64_json = _b.b64encode(b"RIFFfake-webp").decode()
            data = [_D()]

        class _Images:
            def generate(self_inner, **kw):
                outer.calls.append(("img_gen", kw))
                return _ImgResp()

            def edit(self_inner, **kw):
                outer.calls.append(("img_edit", kw))
                return _ImgResp()

        self.calls = FAKE_CALLS
        self.models = _Models()
        self.chat = _Chat()
        self.audio = _Audio()
        self.images = _Images()


FAKE_CALLS: list = []


@pytest.fixture()
def fake_openai(monkeypatch, tmp_path):
    from app import cache, openai_client, portraits

    FAKE_CALLS.clear()
    monkeypatch.setattr(openai_client, "make_client", lambda key: FakeOpenAI(key))
    # 테스트가 실제 assets/audio 를 건드리지 않도록 캐시 경로를 임시 폴더로
    monkeypatch.setattr(cache, "AUDIO_DIR", tmp_path / "audio")
    monkeypatch.setattr(cache, "MANIFEST", tmp_path / "audio" / "manifest.json")
    monkeypatch.setattr(cache, "RUNTIME_DIR", tmp_path / "runtime")
    monkeypatch.setattr(portraits, "DIR", tmp_path / "characters")
    monkeypatch.setattr(portraits, "MANIFEST", tmp_path / "characters" / "manifest.json")
    return FAKE_CALLS
