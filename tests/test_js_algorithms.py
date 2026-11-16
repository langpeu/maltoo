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


def test_all_js_modules_parse(tmp_path):
    """모든 브라우저 JS 모듈이 ES 모듈 문법으로 읽히는지 (node --check 를 .mjs 로)."""
    import shutil
    import subprocess
    from pathlib import Path
    if not shutil.which("node"):
        import pytest
        pytest.skip("node 없음")
    root = Path(__file__).resolve().parent.parent / "static" / "js"
    bad = []
    for f in root.rglob("*.js"):
        dst = tmp_path / (f.stem + ".mjs")
        dst.write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
        r = subprocess.run(["node", "--check", str(dst)], capture_output=True, text=True)
        if r.returncode:
            bad.append(f"{f.relative_to(root)}: {r.stderr.strip().splitlines()[0] if r.stderr else ''}")
    assert not bad, bad


def test_js_api_paths_exist():
    """브라우저 JS 가 부르는 /api 경로(따옴표 고정 문자열)가 실제 서버 라우트에 있는지."""
    import re
    from pathlib import Path

    from main import create_app
    routes = set(create_app().openapi()["paths"])  # 포함된 라우터까지 전부
    root = Path(__file__).resolve().parent.parent / "static" / "js"
    bad = []
    for f in root.rglob("*.js"):
        for m in re.finditer(r'(?:api|fetch)\(\s*"(/api/[^"?]+)', f.read_text(encoding="utf-8")):
            if m.group(1) not in routes:
                bad.append(f"{f.relative_to(root)}: {m.group(1)}")
    assert not bad, bad
