"""초기 세팅: 필요한 고정 음성·인물 사진이 있는지 확인하고, 없으면 한 장씩 생성.

생성된 assets/ 를 GitHub 에 커밋하면 이후에는 확인만 하고 재사용한다.
세팅 작업은 사용자가 예상 비용을 확인하고 시작하므로 일/월 한도 검사에서 제외한다 (비용은 기록).
"""

from fastapi import APIRouter, Depends, HTTPException

from .. import cache, portraits, scenarios, usage
from ..config import model
from ..openai_client import Caller, get_caller
from ..schemas import JobIn

router = APIRouter(prefix="/api/setup")


def _audio_jobs():
    for s in scenarios.all_scenarios():
        for line, text in scenarios.fixed_lines(s).items():
            if cache.custom_path(s["id"], line).exists():
                continue  # 직접 넣은 음성이 있으면 만들지 않음
            voice, instr = scenarios.voice_for(s, scenarios.line_mood(s, line))
            key = cache.audio_key(text, voice, instr)
            if not cache.fixed_path(key).exists():
                yield {"kind": "audio", "scenario_id": s["id"], "line": line,
                       "label": f"{s['character']['name']} 음성 · {_line_label(line)} “{text}”",
                       "cost": usage.cost_tts(model("tts"), text)}


def _line_label(line: str) -> str:
    if line == "opening":
        return "첫마디"
    if line.startswith("nag"):
        return f"재촉 {line[-1]}"
    if line.startswith("react_"):
        return "추임새"
    return {"end_success": "결말·성공", "end_partial": "결말·부분 성공", "end_fail": "결말·실패",
            "end_noresp": "결말·응답 회피", "end_resign": "결말·퇴사"}.get(line, line)


def _portrait_jobs():
    for s in scenarios.all_scenarios():
        for expr, talk in portraits.jobs(s):
            if not portraits.path(s["id"], expr, talk).exists():
                label = portraits.EXPRESSIONS[expr][0] + (" · 입 벌림" if talk else "")
                yield {"kind": "portrait", "scenario_id": s["id"], "expr": expr, "talk": talk,
                       "label": f"{s['character']['name']} 사진 · {label}",
                       "cost": portraits.job_cost(expr, talk)}


def _ending_jobs():
    for eid in portraits.ending_ids(scenarios.all_scenarios()):
        if not portraits.ending_path(eid).exists():
            label = "인사고과 통보 장면" if eid == "review" else f"{scenarios.get(eid.removeprefix('resign_'))['character']['name']} 사직서 장면"
            yield {"kind": "ending", "scenario_id": eid.removeprefix("resign_") if eid != "review" else "kim",
                   "ending_id": eid, "label": f"엔딩 · {label}", "cost": portraits.ending_cost(eid)}


@router.get("/status")
def status():
    audio = list(_audio_jobs())
    photos = list(_portrait_jobs()) + list(_ending_jobs())  # 엔딩은 인물 기본 사진 뒤에
    return {
        "audio": {"missing": len(audio), "estimate_usd": sum(j["cost"] for j in audio)},
        "portraits": {"missing": len(photos), "estimate_usd": sum(j["cost"] for j in photos)},
        "missing": len(audio) + len(photos),
        "estimate_usd": sum(j["cost"] for j in audio + photos),
        "jobs": audio + photos,  # 순서 중요: 인물별 기본 사진 → 표정 → 입 벌림
        "portraits_status": portraits.status(scenarios.all_scenarios())["characters"],
    }


@router.post("/job")
def run_job(job: JobIn, caller: Caller = Depends(get_caller)):
    caller.skip_limits = True
    caller.session_id = "setup"  # '이번 연습' 비용에 섞이지 않게
    s = scenarios.get(job.scenario_id)

    if job.kind == "audio":
        text = scenarios.fixed_line(s, job.line or "")
        mood = scenarios.line_mood(s, job.line or "")
        voice, instr = scenarios.voice_for(s, mood)
        key = cache.audio_key(text, voice, instr)
        if not cache.fixed_path(key).exists():
            data = caller.tts(text, voice, instr)
            cache.save_fixed(key, data, {"scenario": s["id"], "line": job.line, "text": text, "voice": voice,
                                         "mood": mood, "instructions": instr, "model": model("tts")})
        return {"ok": True, "url": cache.fixed_url(key)}

    if job.kind == "portrait":
        if job.expr not in portraits.EXPRESSIONS:
            raise HTTPException(400, {"code": "bad_expr", "message": "없는 표정입니다."})
        if portraits.path(s["id"], job.expr, job.talk).exists():
            return {"ok": True, "url": portraits.url(s["id"], job.expr, job.talk)}
        need_base = job.expr != "calm" or job.talk
        base = portraits.path(s["id"], "calm" if not job.talk else job.expr)
        if need_base and not base.exists():
            raise HTTPException(409, {"code": "need_base", "message": "기준 사진이 아직 없습니다. 순서대로 생성하세요."})
        portraits.generate_one(caller, s, job.expr, job.talk)
        return {"ok": True, "url": portraits.url(s["id"], job.expr, job.talk)}

    if job.kind == "ending":
        ids = portraits.ending_ids(scenarios.all_scenarios())
        if job.ending_id not in ids:
            raise HTTPException(400, {"code": "bad_ending", "message": "없는 엔딩 장면입니다."})
        if not portraits.ending_path(job.ending_id).exists():
            try:
                portraits.generate_ending(caller, job.ending_id, {x["id"]: x for x in scenarios.all_scenarios()})
            except FileNotFoundError:
                raise HTTPException(409, {"code": "need_base", "message": "인물 기본 사진을 먼저 만들어야 합니다."})
        return {"ok": True, "url": portraits.ending_url(job.ending_id)}

    raise HTTPException(400, {"code": "bad_kind", "message": "알 수 없는 작업입니다."})
