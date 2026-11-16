import pytest

from conftest import TURN_OVERRIDE

KEY = "sk-test-0000abcd"
H = {"X-OpenAI-Key": KEY, "X-Session-Id": "s1"}


def turn(client, sid, **kw):
    body = {"scenario_id": sid, "history": [{"speaker": "npc", "text": "첫마디"}], "user_text": "테스트 발언입니다.",
            "session_id": kw.pop("session_id", "sess"), **kw}
    r = client.post("/api/turn", json=body, headers=H)
    assert r.status_code == 200, r.text
    return r.json()


def test_overview_defaults(client):
    w = client.get("/api/world").json()
    assert w["salary"] == 47_000_000 == w["base_salary"]
    assert w["characters"]["yoon"]["resign_risk"] == 35 and w["characters"]["yoon"]["team"] == 30
    assert w["characters"]["kim"]["kind"] == "boss" and not w["characters"]["kim"]["rumor_pending"]


def test_boss_salary_rules(client, fake_openai):
    # 분노 40→70(+30): -90만 / 신뢰 50→30(-20): -40만 / 공격 표현 1 + 언성 1 = 2회: -80만 / 재촉 1회: -50만
    TURN_OVERRIDE.update({"checkpoints": [{"type": "aggressive", "text_span": "", "note": ""}]})
    d = turn(client, "kim", prev_emotion={"anger": 40, "trust": 50}, nag_count=1, tone={"loud_n": 1})
    g = d["game"]
    assert g["salary_delta"] == -900_000 - 400_000 - 800_000 - 500_000
    assert g["salary"] == 47_000_000 + g["salary_delta"]
    assert len(g["reasons"]) == 4 and g["session"]["cut"] == 2_600_000

    # 잘한 대응: +20만, 이번 판 감액의 50%까지만 회복
    TURN_OVERRIDE.update({"emotion": {"anger": 40, "trust": 60, "defensiveness": 20},
                          "checkpoints": [{"type": "good", "text_span": "", "note": ""}]})
    d2 = turn(client, "kim", prev_emotion={"anger": 70, "trust": 30}, game_session={"cut": 100_000, "recovered": 40_000})
    assert d2["game"]["salary_delta"] == 10_000  # 회복 한도 5만 중 4만은 이미 회복
    assert client.get("/api/world").json()["salary"] == 47_000_000 - 2_600_000 + 10_000


def test_sub_resign_and_override(client, fake_openai):
    TURN_OVERRIDE.update({"emotion": {"anger": 95, "trust": 0, "defensiveness": 90},
                          "checkpoints": [{"type": "aggressive", "text_span": "", "note": ""},
                                          {"type": "sarcasm", "text_span": "", "note": ""}]})
    risks = []
    for i in range(6):
        d = turn(client, "jung", prev_emotion={"anger": 20, "trust": 60}, session_id=f"r{i}")
        risks.append(d["game"]["resign_risk"])
        if d["game"]["ending_override"]:
            break
    assert risks == sorted(risks) and risks[-1] == 100
    assert d["ending"] == "resign" and "1,500만" in d["game"]["loss_text"]
    assert d["game"]["stage"] == "책상 정리를 시작했습니다"
    assert client.get("/api/world").json()["characters"]["jung"]["resigned"] is True


def test_yoon_team_quit(client, fake_openai):
    TURN_OVERRIDE.update({"emotion": {"anger": 10, "trust": 80, "defensiveness": 10},
                          "team_issue_addressed": False, "ending": None, "checkpoints": []})
    turn(client, "yoon", prev_emotion={"anger": 10, "trust": 80})
    turn(client, "yoon", prev_emotion={"anger": 10, "trust": 80})
    TURN_OVERRIDE.update({"ending": "success"})
    d = turn(client, "yoon", prev_emotion={"anger": 10, "trust": 80})
    assert d["game"]["team"] >= 70 and d["ending"] == "team_quit"


def test_badmouth_bond_and_rumor_spread(client, fake_openai):
    # 이 사원에게 박 팀장 험담 → 이 사원은 박 팀장을 싫어함 → 호감 상승, 퇴사 위험 감소
    TURN_OVERRIDE.update({"emotion": {"anger": 30, "trust": 55, "defensiveness": 30}, "checkpoints": [],
                          "mentions": [{"character": "park", "sentiment": "negative", "quote": "박 팀장님 일정이 말이 안 되지"},
                                       {"character": "nobody", "sentiment": "negative", "quote": "x"},
                                       {"character": "lee", "sentiment": "negative", "quote": "자기 자신"}]})
    created = None
    for i in range(30):  # 재현 가능한 난수: 어떤 시드에서는 소문이 난다
        d = turn(client, "lee", prev_emotion={"anger": 30, "trust": 55}, session_id=f"b{i}")
        assert len(d["mentions"]) == 1 and d["game"]["mentions"][0]["name"] == "박 팀장"
        assert "호감이 올랐습니다" in d["game"]["mentions"][0]["effect"]
        if d["game"]["rumor_created"]:
            created = d
            break
    assert created, "30번 안에 소문이 한 번은 나야 함"
    # 같은 시드는 같은 결과 (결정적)
    from app import world
    assert world.pending_rumors("park")

    w = client.get("/api/world").json()
    assert w["characters"]["park"]["rumor_pending"] is True
    st = client.post("/api/world/start", json={"scenario_id": "park"}).json()
    assert st["rumor"]["line"].startswith("rumor_") and st["rumor"]["source"] == "이 사원"
    assert st["salary_delta"] == -500_000
    assert client.get("/api/world").json()["characters"]["park"]["rumor_pending"] is False
    # 두 번째 시작에는 소문 없음
    assert client.post("/api/world/start", json={"scenario_id": "park"}).json()["rumor"] is None
    # 이후 박 팀장 프롬프트에 소문 기억이 들어감
    turn(client, "park")
    sys = [c for c in fake_openai if c[0] == "chat"][-1][1]["messages"][0]["content"]
    assert "험담했다는 소문을 이 사원에게서 들었다" in sys and "[너의 인간관계" in sys


def test_badmouth_favorite_costs_salary(client, fake_openai):
    # 최 상무 앞에서 김 부장 험담 → 최 상무는 김 부장을 편애 → 신뢰 하락 + 연봉 -30만
    TURN_OVERRIDE.update({"emotion": {"anger": 65, "trust": 50, "defensiveness": 50}, "checkpoints": [],
                          "mentions": [{"character": "kim", "sentiment": "negative", "quote": "김 부장님이 문제죠"}]})
    d = turn(client, "choi", prev_emotion={"anger": 65, "trust": 50})
    assert d["game"]["salary_delta"] == -300_000
    assert "불쾌" in d["game"]["mentions"][0]["effect"]


def test_rumor_lines_are_fixed_audio():
    from app import scenarios

    for s in scenarios.all_scenarios():
        lines = scenarios.fixed_lines(s)
        assert "rumor_0" in lines and "rumor_1" in lines


@pytest.mark.parametrize("ending,cut,grade,meeting", [
    ("success", 300_000, "A", False), ("success", 1_000_000, "C", False), ("partial", 1_600_000, "D", False),
    ("fail", 3_500_000, "D", True), ("fail", 100_000, "D", False),
])
def test_review_grade(client, ending, cut, grade, meeting):
    r = client.post("/api/world/finish", json={"scenario_id": "kim", "ending": ending,
                                               "session": {"cut": cut, "recovered": 0}}).json()
    assert r["grade"] == grade and r["meeting"] is meeting
    assert r["salary_after"] - r["salary_before"] == {"A": 1_410_000, "C": 0, "D": -2_350_000}[grade]


def test_reset(client, fake_openai):
    turn(client, "kim", prev_emotion={"anger": 0, "trust": 100})
    assert client.get("/api/world").json()["salary"] != 47_000_000
    w = client.post("/api/world/reset").json()
    assert w["salary"] == 47_000_000 and w["characters"]["kim"]["trust"] == 45


def test_ending_images_in_setup(client, fake_openai):
    st = client.get("/api/setup/status").json()
    ends = [j for j in st["jobs"] if j["kind"] == "ending"]
    assert {j["ending_id"] for j in ends} == {"review", "resign_lee", "resign_jung", "resign_yoon"}
    review = next(j for j in ends if j["ending_id"] == "review")
    assert client.post("/api/setup/job", json=review, headers=H).status_code == 200
    lee = next(j for j in ends if j["ending_id"] == "resign_lee")
    assert client.post("/api/setup/job", json=lee, headers=H).status_code == 409  # 이 사원 기본 사진 없음
