"""config.json 로더. 모델 이름·가격·한도는 코드에 하드코딩하지 않고 여기서 읽는다."""

import json
import os
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@lru_cache(maxsize=1)
def get_config() -> dict:
    path = Path(os.environ.get("MALTOO_CONFIG", ROOT / "config.json"))
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def model(role: str) -> str:
    return get_config()["models"][role]


def pricing(model_name: str) -> dict:
    return get_config()["pricing_usd"].get(model_name, {})
