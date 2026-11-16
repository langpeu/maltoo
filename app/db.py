"""SQLite 저장소. data.db 는 개인 기록이므로 .gitignore 대상.

API 키 원문은 어떤 테이블에도 저장하지 않는다. key_id 는 키 끝 4자리.
"""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .config import ROOT

SCHEMA = """
CREATE TABLE IF NOT EXISTS usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL,           -- ISO 시각 (로컬)
    day         TEXT    NOT NULL,           -- YYYY-MM-DD (로컬)
    month       TEXT    NOT NULL,           -- YYYY-MM
    key_id      TEXT    NOT NULL,           -- API 키 끝 4자리
    session_id  TEXT,
    feature     TEXT    NOT NULL,           -- chat | transcribe | tts | image | verify
    model       TEXT,
    cost_usd    REAL    NOT NULL DEFAULT 0,
    saved_usd   REAL    NOT NULL DEFAULT 0, -- 캐시 재사용으로 아낀 금액
    cached      INTEGER NOT NULL DEFAULT 0,
    meta        TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_key_day   ON usage(key_id, day);
CREATE INDEX IF NOT EXISTS idx_usage_key_month ON usage(key_id, month);

CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);

-- 이후 단계에서 사용하는 테이블 (Phase 1~6)
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    key_id      TEXT,
    scenario_id TEXT,
    started_at  TEXT,
    ended_at    TEXT,
    ending      TEXT,
    summary     TEXT
);
CREATE TABLE IF NOT EXISTS turns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    speaker     TEXT NOT NULL,              -- me | npc
    text        TEXT,
    tone        TEXT,                       -- JSON
    face        TEXT,                       -- JSON
    analysis    TEXT,                       -- JSON
    created_at  TEXT
);
CREATE TABLE IF NOT EXISTS baseline (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT,
    tone        TEXT,
    face        TEXT
);
CREATE TABLE IF NOT EXISTS world_state (
    character_id TEXT PRIMARY KEY,
    affinity     REAL NOT NULL DEFAULT 50,
    trust        REAL NOT NULL DEFAULT 50,
    updated_at   TEXT
);
CREATE TABLE IF NOT EXISTS rumors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   TEXT,                       -- 소문을 들은 인물
    target_id   TEXT,                       -- 험담 대상
    content     TEXT,
    spread      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT
);
"""


def db_path() -> Path:
    return Path(os.environ.get("MALTOO_DB", ROOT / "data.db"))


def init_db() -> None:
    with connect() as con:
        con.executescript(SCHEMA)


@contextmanager
def connect():
    con = sqlite3.connect(db_path())
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    finally:
        con.close()


def get_setting(k: str, default=None):
    with connect() as con:
        row = con.execute("SELECT v FROM settings WHERE k = ?", (k,)).fetchone()
    return row["v"] if row else default


def set_setting(k: str, v) -> None:
    with connect() as con:
        con.execute(
            "INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            (k, str(v)),
        )
