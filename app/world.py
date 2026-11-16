"""회사 세계관 · 게임 수치 (결정적 규칙).

- 상사 시나리오: 연봉 변동, 인사고과
- 부하 시나리오: 퇴사 위험도, 퇴사 엔딩 / 윤 대리: 팀 불만
- 인물 언급(험담·칭찬) → 관계 반응, 소문 전파 → 다음 시나리오 첫마디·시작 페널티
- 누적 기억: world_state(인물별 호감·신뢰·퇴사 위험·팀 불만), settings(연봉), rumors

gpt-4o-mini 는 감정·언급만 판단하고, 금액·확률은 모두 여기서 config.json 규칙으로 계산한다.
"""

import json
import random
from datetime import datetime
from functools import lru_cache

from . import db, scenarios
from .config import ROOT, get_config

ANGRY_TYPES = ("aggressive", "sarcasm")


@lru_cache(maxsize=1)
def world() -> dict:
    with open(ROOT / "scenarios" / "world.json", encoding="utf-8") as f:
        return json.load(f)


def game_cfg() -> dict:
    return get_config()["game"]


def names() -> dict[str, str]:
    return {s["id"]: s["character"]["name"] for s in scenarios.all_scenarios()}


def attitude(frm: str, to: str) -> int:
    for r in world()["relations"]:
        if r["from"] == frm and r["to"] == to:
            return r["attitude"]
    return 0


def relations_of(cid: str) -> list[dict]:
    return [r for r in world()["relations"] if r["from"] == cid]


def _round10k(v: float) -> int:
    return int(round(v / 10000.0)) * 10000


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ---------- 누적 상태 ----------

def base_salary() -> int:
    return int(game_cfg()["base_salary_krw"])


def salary() -> int:
    return int(float(db.get_setting("salary_krw", base_salary())))


def set_salary(v: int) -> None:
    db.set_setting("salary_krw", int(v))


def state(cid: str) -> dict:
    start = world()["start"].get(cid, {})
    with db.connect() as con:
        r = con.execute("SELECT * FROM world_state WHERE character_id = ?", (cid,)).fetchone()
    if not r:
        return {"affinity": start.get("affinity", 50), "trust": start.get("trust", 50),
                "resign_risk": start.get("resign_risk", 0), "team": start.get("team", 0), "resigned": False}
    return {"affinity": r["affinity"], "trust": r["trust"], "resign_risk": r["resign_risk"],
            "team": r["team"], "resigned": bool(r["resigned"])}


def save_state(cid: str, st: dict) -> None:
    clamp = lambda v: max(0.0, min(100.0, float(v)))  # noqa: E731
    with db.connect() as con:
        con.execute(
            "INSERT INTO world_state(character_id, affinity, trust, resign_risk, team, resigned, updated_at)"
            " VALUES(?,?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET affinity=excluded.affinity,"
            " trust=excluded.trust, resign_risk=excluded.resign_risk, team=excluded.team,"
            " resigned=excluded.resigned, updated_at=excluded.updated_at",
            (cid, clamp(st["affinity"]), clamp(st["trust"]), clamp(st["resign_risk"]), clamp(st["team"]),
             1 if st.get("resigned") else 0, _now()))


def pending_rumors(target: str) -> list[dict]:
    with db.connect() as con:
        rows = con.execute("SELECT * FROM rumors WHERE target_id = ? AND spread = 0 ORDER BY id", (target,)).fetchall()
    return [dict(r) for r in rows]


def heard_rumors(target: str) -> list[dict]:
    with db.connect() as con:
        rows = con.execute("SELECT * FROM rumors WHERE target_id = ? AND spread = 1 ORDER BY id DESC LIMIT 3",
                           (target,)).fetchall()
    return [dict(r) for r in rows]


def overview() -> dict:
    chars = {}
    for s in scenarios.all_scenarios():
        st = state(s["id"])
        chars[s["id"]] = {**st, "kind": s["kind"], "rumor_pending": bool(pending_rumors(s["id"]))}
    return {"salary": salary(), "base_salary": base_salary(), "characters": chars}


def reset() -> dict:
    """새 회사 입사: 연봉·관계·소문 초기화 (연습 기록·비용 기록은 유지)."""
    with db.connect() as con:
        con.execute("DELETE FROM world_state")
        con.execute("DELETE FROM rumors")
        con.execute("DELETE FROM settings WHERE k = 'salary_krw'")
    return overview()


# ---------- 시나리오 시작 ----------

def start(s: dict) -> dict:
    """소문이 퍼져 있으면 첫마디를 소문 버전으로 바꾸고 시작 페널티."""
    cid = s["id"]
    rules = game_cfg()
    st = state(cid)
    out = {"rumor": None, "salary": salary(), "salary_delta": 0, "state": st, "kind": s["kind"],
           "start_anger": rules["start_anger"].get(s.get("reaction_start", "neutral"), 40)}
    pend = pending_rumors(cid)
    if pend and s.get("rumor_openings"):
        r = pend[0]
        idx = r["id"] % len(s["rumor_openings"])
        src = names().get(r["source_id"], r["source_id"])
        out["rumor"] = {"line": f"rumor_{idx}", "text": s["rumor_openings"][idx], "source": src,
                        "content": r["content"]}
        if s["kind"] == "boss":
            d = rules["salary_rules_krw"]["rumor_start"]
            set_salary(salary() + d)
            out["salary"], out["salary_delta"] = salary(), d
        else:
            st["resign_risk"] += rules["resign"]["rumor_start"]
        st["trust"] -= 10
        save_state(cid, st)
        with db.connect() as con:
            con.execute("UPDATE rumors SET spread = 1 WHERE target_id = ? AND spread = 0", (cid,))
        out["state"] = st
    return out


# ---------- 프롬프트용 세계 맥락 ----------

def prompt_context(s: dict) -> str:
    cid = s["id"]
    nm = names()
    st = state(cid)
    lines = ["[너의 인간관계 — 과장이 이 사람들을 언급하면 이 감정대로 반응한다]"]
    for r in relations_of(cid):
        feel = "좋아한다" if r["attitude"] >= 30 else "싫어한다" if r["attitude"] <= -30 else "그저 그렇다"
        lines.append(f"- {nm.get(r['to'], r['to'])}: {feel} ({r['note']})")
    lines.append(f"[과장에 대한 너의 누적 기억] 호감 {int(st['affinity'])}/100, 신뢰 {int(st['trust'])}/100"
                 + (" — 지난 대화들 때문에 이미 감정이 안 좋다." if st["trust"] < 35 else ""))
    for r in heard_rumors(cid):
        lines.append(f"- 과장이 너를 험담했다는 소문을 {nm.get(r['source_id'], r['source_id'])}에게서 들었다: \"{r['content']}\"")
    others = ", ".join(f"{k}={v}" for k, v in nm.items() if k != cid)
    lines.append(f"[인물 id] {others}")
    return "\n".join(lines)


# ---------- 턴 처리 ----------

def apply_turn(s: dict, parsed: dict, prev: dict | None, tone: dict | None, nag: int,
               sess: dict | None, seed: str) -> dict:
    """한 턴의 결과로 연봉/퇴사 위험/관계/소문을 계산·저장하고 화면용 요약을 돌려준다."""
    rules = game_cfg()
    sr = rules["salary_rules_krw"]
    cid = s["id"]
    nm = names()
    st = state(cid)
    sess = {"cut": 0, "recovered": 0, **(sess or {})}
    emo = parsed["emotion"]
    prev = prev or {"anger": rules["start_anger"].get(s.get("reaction_start", "neutral"), 40), "trust": 50}
    d_anger = emo["anger"] - prev.get("anger", 40)
    d_trust = emo["trust"] - prev.get("trust", 50)
    cps = parsed.get("checkpoints") or []
    n_aggr = sum(1 for c in cps if c["type"] in ANGRY_TYPES)
    if tone and (tone.get("loud_n") or 0) > 0:
        n_aggr += 1
    n_aggr = min(n_aggr, sr["max_aggressive_per_turn"])
    good = any(c["type"] == "good" for c in cps) or d_trust >= 10
    reasons: list[str] = []
    out = {"kind": s["kind"], "reasons": reasons, "mentions": [], "rumor_created": None, "ending_override": None}

    # 인물 언급 → 관계 반응 + 소문
    mc = rules["mention"]
    for m in parsed.get("mentions") or []:
        target = m["character"]
        if target == cid or target not in nm:
            continue
        att = attitude(cid, target)
        eff = {"character": target, "name": nm[target], "sentiment": m["sentiment"], "effect": ""}
        if m["sentiment"] == "negative":
            if att < 0:
                st["affinity"] += mc["bond_affinity"]
                eff["effect"] = f"{nm[cid]}도 {nm[target]}을(를) 싫어해서 호감이 올랐습니다 (+{mc['bond_affinity']})"
                if s["kind"] == "sub":
                    st["resign_risk"] += rules["resign"]["bond"]
            elif att >= 30:
                st["trust"] += mc["offend_trust"]
                eff["effect"] = f"{nm[cid]}은(는) {nm[target]}을(를) 아껴서 불쾌해합니다 (신뢰 {mc['offend_trust']})"
                if s["kind"] == "boss":
                    out.setdefault("_extra_salary", 0)
                    out["_extra_salary"] += sr["badmouth_favorite"]
            else:
                eff["effect"] = f"{nm[cid]}은(는) 별 반응이 없습니다"
            # 소문 판정 (재현 가능한 난수)
            rc = rules["rumor"]
            p = rc["base"] + (rc["listener_likes_target"] if att >= 0 else 0) + (rc["listener_dislikes_target"] if att <= -40 else 0)
            p = max(rc["min"], min(rc["max"], p))
            roll = random.Random(f"{seed}:{target}").random()
            eff["rumor_chance"] = round(p, 2)
            if roll < p:
                content = (m.get("quote") or f"{nm[target]} 험담")[:120]
                with db.connect() as con:
                    con.execute("INSERT INTO rumors(source_id, target_id, content, spread, created_at) VALUES(?,?,?,0,?)",
                                (cid, target, content, _now()))
                out["rumor_created"] = {"target": target, "name": nm[target]}
                eff["rumor"] = True
        elif m["sentiment"] == "positive":
            if att <= -30:
                st["affinity"] += mc["praise_disliked_affinity"]
                eff["effect"] = f"{nm[cid]}은(는) {nm[target]} 칭찬이 달갑지 않습니다"
            elif att >= 30:
                st["trust"] += mc["praise_liked_trust"]
                eff["effect"] = f"{nm[cid]}이(가) {nm[target]} 칭찬에 흐뭇해합니다"
        out["mentions"].append(eff)

    # 누적 기억: 감정 변화 반영
    st["trust"] += d_trust * 0.3
    st["affinity"] += (-d_anger * 0.2) + (5 if good else 0)

    if s["kind"] == "boss":
        delta = out.pop("_extra_salary", 0)
        if out["mentions"] and delta:
            reasons.append(f"아끼는 사람 험담 {delta // 10000:+,}만")
        if d_anger > 0:
            v = _round10k(sr["anger_per_10"] * d_anger / 10)
            delta += v
            reasons.append(f"분노 +{d_anger} → {v // 10000:,}만")
        if d_trust < 0:
            v = _round10k(sr["trust_drop_per_10"] * (-d_trust) / 10)
            delta += v
            reasons.append(f"신뢰 {d_trust} → {v // 10000:,}만")
        if n_aggr:
            v = sr["aggressive_expression"] * n_aggr
            delta += v
            reasons.append(f"공격적 표현·언성 {n_aggr}회 → {v // 10000:,}만")
        if nag:
            v = sr["no_response"] * nag
            delta += v
            reasons.append(f"응답 회피 {nag}회 → {v // 10000:,}만")
        cut_now = -min(0, delta)
        sess["cut"] += cut_now
        if good:
            room = max(0, int(sess["cut"] * sr["max_recovery_ratio"]) - sess["recovered"])
            v = min(sr["good_response"], room)
            if v > 0:
                delta += v
                sess["recovered"] += v
                reasons.append(f"잘한 대응 → +{v // 10000:,}만")
        set_salary(salary() + delta)
        out.update({"salary": salary(), "salary_delta": delta})
    else:
        rr = rules["resign"]
        d = rr["anger_k"] * max(0, d_anger) + rr["trust_drop_k"] * max(0, -d_trust) - rr["trust_up_k"] * max(0, d_trust)
        d += rr["aggressive"] * n_aggr + rr["nag"] * nag + (rr["good"] if good else 0)
        before = st["resign_risk"]
        st["resign_risk"] = max(0.0, min(100.0, st["resign_risk"] + d))
        out["risk_delta"] = round(st["resign_risk"] - before, 1)
        out["resign_risk"] = round(st["resign_risk"], 1)
        stage = ""
        for th, msg in rr["stages"]:
            if st["resign_risk"] >= th:
                stage = msg
        out["stage"] = stage
        if st["resign_risk"] >= 100:
            st["resigned"] = True
            out["ending_override"] = "resign"
            out["loss_text"] = rr["loss_text"]
        if cid == "yoon":
            tc = rules["team"]
            addressed = parsed.get("team_issue_addressed")
            if addressed is not None:
                st["team"] += tc["addressed"] if addressed else tc["not_addressed"]
            out["team"] = round(max(0, min(100, st["team"])), 1)
            if out["team"] >= tc["quit_at"] and parsed.get("ending") in ("success", "partial") and not out["ending_override"]:
                out["ending_override"] = "team_quit"

    save_state(cid, st)
    out["state"] = state(cid)
    out["session"] = sess
    return out


# ---------- 시나리오 종료 ----------

def finish(s: dict, ending: str | None, sess: dict | None) -> dict:
    rules = game_cfg()
    sess = {"cut": 0, "recovered": 0, **(sess or {})}
    if s["kind"] != "boss":
        st = state(s["id"])
        return {"kind": "sub", "resign_risk": st["resign_risk"], "resigned": st["resigned"],
                "loss_text": rules["resign"]["loss_text"] if st["resigned"] else ""}
    rv = rules["review"]
    net_cut = sess["cut"] - sess["recovered"]
    if ending == "success" and net_cut <= rv["A_max_cut"]:
        grade = "A"
    elif ending in ("success", "partial") and net_cut <= rv["C_max_cut"]:
        grade = "C"
    else:
        grade = "D"
    meeting = ending in ("fail", "noresp") and net_cut >= rv["meeting_min_cut"]
    before = salary()
    change = _round10k(base_salary() * rules["review_grades"][grade])
    set_salary(before + change)
    return {"kind": "boss", "grade": grade, "meeting": meeting, "salary_before": before,
            "salary_after": salary(), "grade_change": change, "session_cut": net_cut}
