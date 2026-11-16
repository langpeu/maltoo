import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="node 없음")
def test_tone_algorithm_js():
    root = Path(__file__).resolve().parent.parent
    r = subprocess.run(["node", "tests/js/tone.test.mjs"], cwd=root, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr + r.stdout
