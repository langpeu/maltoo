import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(not shutil.which("node"), reason="node 없음")
@pytest.mark.parametrize("script", ["tests/js/tone.test.mjs", "tests/js/face.test.mjs"])
def test_js_algorithms(script):
    r = subprocess.run(["node", script], cwd=ROOT, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr + r.stdout
