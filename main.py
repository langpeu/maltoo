"""말투(maltoo) 서버 진입점.

실행: python main.py  →  http://127.0.0.1:8000
"""

import threading
import webbrowser

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import db
from app.api import conversation, core, report, setup
from app.config import ROOT, get_config


def create_app() -> FastAPI:
    db.init_db()
    app = FastAPI(title="말투 (maltoo)", docs_url="/api/docs")
    app.include_router(core.router)
    app.include_router(conversation.router)
    app.include_router(setup.router)
    app.include_router(report.router)
    app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
    app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")
    (ROOT / ".runtime").mkdir(exist_ok=True)
    app.mount("/runtime", StaticFiles(directory=ROOT / ".runtime"), name="runtime")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(ROOT / "static" / "index.html")

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    srv = get_config()["server"]
    url = f"http://{srv['host']}:{srv['port']}"
    print(f"\n  말투 서버 시작: {url}\n  종료하려면 Ctrl+C\n")
    if srv.get("open_browser"):
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=srv["host"], port=srv["port"], log_level="warning")
