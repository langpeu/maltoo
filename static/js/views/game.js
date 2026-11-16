// 회사 세계관 게임 장치: 연봉 칩·감액 패널(상사), 퇴사 위험·팀 불만(부하), 인사고과·사직서 결과 카드

import { api } from "../api.js";
import { PHASE_LABEL } from "../face/metrics.js";
import { $, esc, toast } from "../util.js";

// main.js 가 넘겨주는 현재 상태
let ctx = { current: () => null, captures: () => [], worstFrame: () => null };
export function initGame(c) { ctx = { ...ctx, ...c }; }

let worldState = null;
const won = (v) => `${Math.round(v / 10000).toLocaleString("ko-KR")}만`;

export async function loadWorld() {
  try { worldState = await api("/api/world"); } catch { return; }
  $("salary-chip").textContent = `💰 ${won(worldState.salary)}`;
  for (const el of document.querySelectorAll("[data-badges]")) {
    const st = worldState.characters[el.dataset.badges];
    if (!st) continue;
    const b = [];
    if (st.kind === "sub") {
      if (st.resigned) b.push('<span class="sc-badge bad">🚪 퇴사함</span>');
      else b.push(`<span class="sc-badge ${st.resign_risk >= 60 ? "bad" : st.resign_risk >= 30 ? "warn" : ""}">퇴사 위험 ${Math.round(st.resign_risk)}%</span>`);
    }
    b.push(`<span class="sc-badge ${st.trust < 35 ? "bad" : ""}">신뢰 ${Math.round(st.trust)}</span>`);
    if (st.rumor_pending) b.push('<span class="sc-badge rumor">🗣 무슨 말을 들은 것 같다</span>');
    el.innerHTML = b.join("");
    el.closest(".scenario").classList.toggle("resigned", !!st.resigned);
  }
}

export function setupGamePanel(s, ws) {
  const boss = s.kind === "boss";
  $("game-boss").hidden = !boss;
  $("game-sub").hidden = boss;
  $("boss-reasons").innerHTML = "";
  $("sub-reasons").innerHTML = "";
  $("salary-delta").textContent = "";
  if (!ws) return;
  if (boss) {
    $("salary-now").textContent = `${won(ws.salary)} 원`;
    if (ws.salary_delta) flashSalary(ws.salary_delta, ["🗣 소문 때문에 시작부터 감액"]);
  } else {
    setRisk(ws.state.resign_risk, "");
    $("team-box").hidden = s.id !== "yoon";
    if (s.id === "yoon") setTeam(ws.state.team);
    if (ws.rumor) addReason("sub-reasons", `🗣 소문 때문에 퇴사 위험 +15`);
  }
}

function addReason(id, text) {
  const li = document.createElement("li");
  li.textContent = text;
  $(id).prepend(li);
}

function flashSalary(delta, reasons) {
  const el = $("salary-now");
  el.classList.remove("hit", "gain");
  void el.offsetWidth;
  el.classList.add(delta < 0 ? "hit" : "gain");
  $("salary-delta").textContent = `${delta > 0 ? "+" : "−"}${won(Math.abs(delta))} 원`;
  $("salary-delta").className = `salary-delta ${delta < 0 ? "minus" : "plus"}`;
  for (const r of reasons) addReason("boss-reasons", r);
}

function setRisk(v, stage) {
  $("risk-v").textContent = `${Math.round(v)}%`;
  $("risk-bar").style.width = `${Math.min(100, v)}%`;
  $("risk-stage").textContent = stage ? `👀 ${stage}` : "";
}
function setTeam(v) {
  $("team-v").textContent = `${Math.round(v)}%`;
  $("team-bar").style.width = `${Math.min(100, v)}%`;
}

export function updateGamePanel(g) {
  if (g.kind === "boss") {
    $("salary-now").textContent = `${won(g.salary)} 원`;
    $("salary-chip").textContent = `💰 ${won(g.salary)}`;
    if (g.salary_delta) flashSalary(g.salary_delta, [`${g.salary_delta < 0 ? "📉" : "📈"} ${(g.reasons || []).join(" · ")}`]);
  } else {
    setRisk(g.resign_risk, g.stage);
    if (g.team != null) setTeam(g.team);
    if (g.risk_delta) addReason("sub-reasons", `${g.risk_delta > 0 ? "▲" : "▼"} 퇴사 위험 ${g.risk_delta > 0 ? "+" : ""}${g.risk_delta}`);
  }
  for (const m of g.mentions || []) {
    addReason(g.kind === "boss" ? "boss-reasons" : "sub-reasons", `💬 ${m.effect}`);
    toast(`💬 ${m.effect}`, 4000);
  }
  if (g.rumor_created) setTimeout(() => toast("🗣 방금 한 말이 누군가에게 전해질지도 모릅니다…", 4500), 1500);
}

export async function finishWorld(r) {
  let fin = null;
  try {
    fin = await api("/api/world/finish", { method: "POST",
      body: { scenario_id: ctx.current().id, ending: r.worldEnding || r.ending, session: r.gameSession || null,
              goal_progress: r.goal_progress || 0 } });
  } catch { /* 게임 장치 없이 */ }
  renderGameResult(r, fin);
  loadWorld();
  const game = fin ? { ...fin, mentions: r.mentions || [], team_quit: r.ending === "team_quit" } : null;
  return game;
}

function worstCapture() {
  const cp = ctx.captures().reduce((w, c) => (!w || (c.severity || 0) > (w.severity || 0) ? c : w), null);
  return cp || ctx.worstFrame();
}

function renderGameResult(r, fin) {
  const box = $("game-result");
  if (!fin) { box.hidden = true; return; }
  const name = ctx.current().character.name;
  let img = "", html = "";
  let caption = "";
  if (fin.kind === "boss") {
    // 인사고과 사진: 이번 대화에서 가장 안 좋았던 내 표정 (브라우저 메모리의 캡처, 서버 전송 없음)
    const worst = worstCapture();
    img = worst ? worst.img : "/assets/endings/review.webp";
    if (worst) caption = `<figcaption>${worst.icon} ${esc(worst.label)} · ${esc(PHASE_LABEL[worst.phase] || "")}<br><small>가장 안 좋았던 내 표정</small></figcaption>`;
    const diff = fin.salary_after - fin.salary_before;
    html = `<h2><span class="grade ${fin.grade}">${fin.grade}</span>인사고과 ${fin.grade}등급</h2>
      ${fin.reason ? `<p class="grade-reason">${esc(fin.reason)}</p>` : ""}
      <p class="big">연봉 ${won(fin.salary_before)} → ${won(fin.salary_after)} 원
        <span class="salary-delta ${diff < 0 ? "minus" : diff > 0 ? "plus" : ""}">${diff ? (diff > 0 ? "+" : "−") + won(Math.abs(diff)) : "동결"}</span></p>
      <p>이번 대화에서 깎인 금액: <b>${won(fin.session_cut || 0)} 원</b></p>
      ${fin.meeting ? '<p class="error">💀 인사팀에서 면담을 요청했습니다.</p>' : ""}
      <p class="small muted">연봉은 게임용 가상 수치입니다.</p>`;
  } else if (fin.resigned && r.ending === "resign") {
    img = `/assets/endings/resign_${ctx.current().id}.webp`;
    html = `<h2>🚪 ${esc(name)}이(가) 사직서를 냈습니다</h2>
      <p class="big">손실: ${esc(fin.loss_text)}</p>
      <p class="small muted">설정 → 새 회사 입사로 처음부터 다시 할 수 있습니다. 채용 비용은 가상 수치입니다.</p>`;
  } else if (r.ending === "team_quit") {
    html = `<h2>👥 다른 팀원이 이탈했습니다</h2>
      <p>${esc(name)}의 문제를 덮고 넘어가자, 팀원들의 불만이 쌓여 한 명이 팀을 떠났습니다.</p>
      <p class="small muted">공감도 중요하지만, 문제는 분명하게 짚어야 합니다.</p>`;
  } else {
    html = `<h2>🚪 ${esc(name)}의 퇴사 위험도 ${Math.round(fin.resign_risk)}%</h2>
      <p>${fin.resign_risk >= 60 ? "이직을 진지하게 고민하고 있습니다. 다음 대화가 중요합니다." : fin.resign_risk >= 30 ? "아직 버티고 있지만 마음이 떠나고 있습니다." : "팀에 남을 생각입니다."}</p>`;
  }
  box.className = `game-result ${img ? "" : "noimg"}`;
  const imgTag = img ? `<img src="${img}" alt="" onerror="this.remove(); this.parentNode && this.parentNode.classList.add('noimg')">` : "";
  box.innerHTML = (caption ? `<figure class="worst-face">${imgTag}${caption}</figure>` : imgTag) + `<div>${html}</div>`;
  box.hidden = false;
}

$("btn-world-reset").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = "정말 초기화할까요? 한 번 더 누르세요";
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = "새 회사 입사"; }, 4000);
    return;
  }
  delete btn.dataset.armed;
  btn.textContent = "새 회사 입사";
  await api("/api/world/reset", { method: "POST" });
  await loadWorld();
  $("settings-modal").close();
  toast("🏢 랑프두잇에 새로 입사했습니다. 연봉과 인간관계가 초기화되었습니다.", 5000);
});
