import { api, keyStore } from "./api.js";
import { initBand } from "./ui/band.js";
import { renderCost, resetCost } from "./ui/cost-panel.js";
import { setVoiceFxConfig, setVoiceFxStrength, voiceFxStrength } from "./audio/voicefx.js";
import { initEleven } from "./ui/eleven.js";
import { $, esc, showError, toast } from "./util.js";
import { loadHistory } from "./views/history.js";
import { checkSetup, initSetup, refreshSetupInfo, setKrwRate } from "./views/setup.js";
import { initReport } from "./views/report.js";
import { closeCamera, media, mic } from "./media.js";
import { blState, initBaseline, loadBaseline, openBaseline, renderBaselineLine } from "./views/baseline.js";
import { initGame, loadWorld } from "./views/game.js";
import { framesOf, hasPhoto, setPortraitFrames } from "./ui/portrait.js";
import { initTalk, startTalk, stopConversation, talkState } from "./views/talk.js";

// ---------- 공통 ----------
function updateKeyHints() {
  $("key-hint").textContent = keyStore.hint();
  $("settings-key-hint").textContent = keyStore.hint();
}
function go(view) {
  for (const v of ["select", "brief", "baseline", "talk", "result", "history"]) $(`view-${v}`).hidden = v !== view;
  if (view === "history") loadHistory();
  $("state-panel").hidden = !(view === "talk" || view === "result");
  scrollTo({ top: 0, behavior: "smooth" });
}
// 왼쪽 위 로고·말투 → 처음 화면(상대 고르기). 대화 중이면 한 번 묻는다.
function goHome() {
  if (!$("view-talk").hidden && !confirm("대화를 그만두고 처음 화면으로 갈까요?")) return;
  stopConversation();
  closeCamera();
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  go("select");
}
$("brand-home").addEventListener("click", goHome);
$("brand-home").addEventListener("keydown", (e) => { if (e.key === "Enter") goHome(); });
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-go]");
  if (t) { stopConversation(); go(t.dataset.go); }
});

// ---------- 비용 ----------
async function refreshUsage() {
  if (!keyStore.get()) return;
  try { renderCost(await api("/api/usage")); }
  catch (e) { if (e.status === 401) openKeyModal(); }
}

// ---------- 시나리오 선택 ----------
let scenarios = [];
let current = null;

async function loadScenarios() {
  scenarios = await api("/api/scenarios");
  setTimeout(loadWorld, 0);
  try { setPortraitFrames((await api("/api/setup/status")).portraits_status); } catch { /* 사진 없음 */ }
  for (const kind of ["boss", "sub"]) {
    $(`grid-${kind}`).innerHTML = scenarios.filter((s) => s.kind === kind).map((s) => `
      <button class="scenario" type="button" data-id="${s.id}">
        <div class="sc-top">
          ${hasPhoto(s.id) ? `<img class="sc-photo" src="${framesOf(s.id).calm.closed}" alt="">` : `<div class="sc-emoji">${s.character.emoji}</div>`}
          <div><div class="sc-name">${esc(s.character.name)}</div>
          <div class="sc-role">${s.character.age}세 · ${s.character.gender} · ${esc(s.character.role)}</div></div>
        </div>
        <div class="sc-title">${esc(s.title)}</div>
        <div class="sc-goal">🎯 ${esc(s.goal)}</div>
        <div class="sc-badges" data-badges="${s.id}"></div>
      </button>`).join("");
  }
}
document.addEventListener("click", (e) => {
  const card = e.target.closest(".scenario");
  if (!card) return;
  const s = scenarios.find((x) => x.id === card.dataset.id);
  if (!blState.baseline && !blState.skipped) {
    current = s;
    openBaseline("before-brief");
  } else openBrief(s);
});

function openBrief(s) {
  current = s;
  const c = s.character;
  $("brief-avatar").innerHTML = hasPhoto(s.id)
    ? `<img class="sc-photo" style="width:100%;height:100%" src="${framesOf(s.id).calm.closed}" alt="">` : c.emoji;
  $("brief-kind").textContent = s.kind === "boss" ? "상사" : "부하 직원";
  $("brief-name").textContent = `${c.name} — ${s.title}`;
  $("brief-meta").textContent = `${c.age}세 · ${c.gender} · ${c.role}`;
  $("brief-personality").textContent = c.personality;
  $("brief-situation").textContent = s.situation;
  $("brief-goal").textContent = s.goal;
  $("brief-checklist").innerHTML = s.checklist.map((x) => `<li>${esc(x)}</li>`).join("");
  $("brief-fail").textContent = `실패 조건: ${s.fail_conditions.join(" / ")}`;
  $("brief-hint").textContent = "";
  renderBaselineLine();
  renderDifficulty();
  go("brief");
}

// ---------- 난이도 ----------
let difficulty = (() => { try { return localStorage.getItem("maltoo.difficulty") || "normal"; } catch { return "normal"; } })();
let difficultyCfg = { mild: { answer_seconds: 5 }, normal: { answer_seconds: 3 }, spicy: { answer_seconds: 3 } };
const answerSeconds = () => (difficultyCfg[difficulty] || difficultyCfg.normal).answer_seconds;
function renderDifficulty() {
  document.querySelectorAll("#difficulty button").forEach((b) => b.classList.toggle("on", b.dataset.d === difficulty));
  $("brief-sec").textContent = answerSeconds();
}
document.querySelectorAll("#difficulty button").forEach((b) => b.addEventListener("click", () => {
  difficulty = b.dataset.d;
  try { localStorage.setItem("maltoo.difficulty", difficulty); } catch { /* 무시 */ }
  renderDifficulty();
}));

// ---------- 첫 방문 안내 ----------
function guideSeen() { try { return localStorage.getItem("maltoo.guideSeen") === "1"; } catch { return true; } }
$("btn-guide").addEventListener("click", () => $("guide-modal").showModal());
$("btn-guide-ok").addEventListener("click", () => {
  try { localStorage.setItem("maltoo.guideSeen", "1"); } catch { /* 무시 */ }
  const first = !$("btn-guide-ok").dataset.done;
  $("btn-guide-ok").dataset.done = "1";
  $("guide-modal").close();
  if (first) startApp();
});

// ---------- 키 입력 ----------
function openKeyModal() {
  const m = $("key-modal");
  showError($("key-error"), "");
  $("key-input").value = "";
  if (!m.open) m.showModal();
  $("key-input").focus();
}
$("key-modal").addEventListener("cancel", (e) => { if (!keyStore.get()) e.preventDefault(); });
$("key-toggle").addEventListener("click", () => {
  const input = $("key-input");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("key-toggle").textContent = show ? "숨기기" : "보기";
});
$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("key-input").value.trim();
  if (!key.startsWith("sk-")) return showError($("key-error"), "OpenAI API 키는 sk- 로 시작합니다.");
  const btn = $("key-submit");
  btn.disabled = true;
  btn.textContent = "확인 중…";
  try {
    await api("/api/key/verify", { method: "POST", key });
    keyStore.set(key);
    $("key-modal").close();
    updateKeyHints();
    resetCost();
    await refreshUsage();
    toast("키를 확인했습니다. 이 브라우저에만 저장됩니다.");
    checkSetup().catch(() => {});
  } catch (err) {
    showError($("key-error"), err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "확인하고 시작";
  }
});

// ---------- 설정 ----------
$("btn-settings").addEventListener("click", async () => {
  showError($("settings-error"), "");
  try {
    const cfg = await api("/api/config");
    $("limit-daily").value = cfg.limits.daily;
    $("limit-monthly").value = cfg.limits.monthly;
  } catch { /* 무시 */ }
  updateKeyHints();
  refreshSetupInfo();
  $("settings-modal").showModal();
});
$("btn-settings-close").addEventListener("click", () => $("settings-modal").close());
$("btn-bl-remeasure").addEventListener("click", async () => {
  $("settings-modal").close();
  stopConversation();
  try { await mic.open(); await mic.calibrate(); } catch (e) { return toast(`마이크를 열 수 없습니다: ${e.message}`); }
  openBaseline("settings");
});
$("btn-limits-save").addEventListener("click", async () => {
  try {
    await api("/api/settings/limits", {
      method: "PUT",
      body: { daily: Number($("limit-daily").value), monthly: Number($("limit-monthly").value) },
    });
    $("settings-modal").close();
    await refreshUsage();
    toast("비용 한도를 저장했습니다.");
  } catch (err) { showError($("settings-error"), err.message); }
});
$("btn-key-change").addEventListener("click", () => { $("settings-modal").close(); openKeyModal(); });
$("btn-key-delete").addEventListener("click", () => {
  keyStore.clear();
  updateKeyHints();
  resetCost();
  $("settings-modal").close();
  openKeyModal();
  toast("이 브라우저에서 키를 삭제했습니다.");
});
$("btn-test-chat").addEventListener("click", async () => {
  const btn = $("btn-test-chat");
  const out = $("test-reply");
  btn.disabled = true;
  try {
    const r = await api("/api/test/chat", { method: "POST" });
    out.textContent = `🤖 사내 메신저: ${r.reply}`;
    out.hidden = false;
    renderCost(r.usage);
  } catch (err) {
    showError($("settings-error"), err.message);
  } finally { btn.disabled = false; }
});

// ---------- 시작 ----------
initSetup({ loadScenarios, refreshUsage });
initTalk({
  current: () => current, difficulty: () => difficulty, answerSeconds,
  refreshUsage, go, openBrief, openKeyModal,
});
initBaseline({ current: () => current, startTalk, openBrief, go });
initGame({ current: () => current, captures: () => talkState.captures, worstFrame: () => talkState.worstFrame });
initReport({
  current: () => current, difficulty: () => difficulty, session: () => talkState.session, baseline: () => blState.baseline,
  lastHistory: () => talkState.history, mic, refreshUsage,
});
initBand($("band-canvas"), $("band-tip"));
loadBaseline();
updateKeyHints();
loadScenarios().catch(() => toast("시나리오를 불러오지 못했습니다."));
api("/api/config").then((c) => {
  setKrwRate(c.krw_per_usd);
  media.faceCfg = c.face;
  if (c.difficulty) difficultyCfg = c.difficulty;
  if (c.voice_playback) setVoiceFxConfig(c.voice_playback);
}).catch(() => {});

// 상대 목소리 감정 강조 세기
function renderVoiceFx() {
  document.querySelectorAll("#voicefx-pick button").forEach((b) => b.classList.toggle("on", b.dataset.fx === voiceFxStrength()));
}
document.querySelectorAll("#voicefx-pick button").forEach((b) => b.addEventListener("click", () => {
  setVoiceFxStrength(b.dataset.fx);
  renderVoiceFx();
}));
renderVoiceFx();
initEleven();
function startApp() {
  if (!keyStore.get()) openKeyModal();
  else { refreshUsage(); checkSetup().catch(() => {}); }
}
if (!guideSeen()) $("guide-modal").showModal();
else startApp();
setInterval(refreshUsage, 30000);
