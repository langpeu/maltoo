import { api, keyStore } from "./api.js";
import { Mic } from "./audio/mic.js";
import { Conversation } from "./session.js";
import { addPin, clearBand, initBand, pushLevel } from "./ui/band.js";
import { analyzeFrame, computeBaseline, ToneTracker } from "./audio/tone.js";
import { renderCost, resetCost } from "./ui/cost-panel.js";
import {
  exprFromEmotion, framesOf, hasPhoto, setBreathing, setExpression, setMouth, setPortraitFrames, setSpeaking, showCharacter,
} from "./ui/portrait.js";

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- 공통 ----------
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }
function updateKeyHints() {
  $("key-hint").textContent = keyStore.hint();
  $("settings-key-hint").textContent = keyStore.hint();
}
function go(view) {
  for (const v of ["select", "brief", "baseline", "talk", "result"]) $(`view-${v}`).hidden = v !== view;
  $("state-panel").hidden = !(view === "talk" || view === "result");
  scrollTo({ top: 0, behavior: "smooth" });
}
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
      </button>`).join("");
  }
}
document.addEventListener("click", (e) => {
  const card = e.target.closest(".scenario");
  if (!card) return;
  const s = scenarios.find((x) => x.id === card.dataset.id);
  if (!baseline && !baselineSkipped) {
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
  go("brief");
}

// ---------- 대화 ----------
const mic = new Mic();
let convo = null;

function stopConversation() {
  if (convo) { convo.stop(); convo = null; }
}

$("btn-start").addEventListener("click", async () => {
  if (!keyStore.get()) return openKeyModal();
  const btn = $("btn-start");
  btn.disabled = true;
  try {
    $("brief-hint").textContent = "마이크 권한을 허용해 주세요…";
    await mic.open();
    $("brief-hint").textContent = "주변 소음을 확인하는 중입니다. 1초만 조용히 해주세요…";
    await mic.calibrate();
    if (!baseline && !baselineSkipped) openBaseline("before-talk");
    else startTalk();
  } catch (e) {
    $("brief-hint").textContent = e.name === "NotAllowedError"
      ? "마이크 권한이 거부되었습니다. 주소창 왼쪽 자물쇠 아이콘에서 허용해 주세요."
      : `마이크를 열 수 없습니다: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-retry").addEventListener("click", () => current && openBrief(current));
$("btn-stop").addEventListener("click", () => { stopConversation(); go("brief"); });

let myTurns = 0;

function startTalk() {
  const s = current;
  myTurns = 0;
  showCharacter(s);
  setBreathing(true);
  $("talk-goal").textContent = `🎯 ${s.goal}`;
  $("turn-count").textContent = "답변 0 / 5";
  $("npc-bubble").textContent = "…";
  $("talk-log").innerHTML = "";
  $("state-title").textContent = `${s.character.name}의 감정`;
  setGauges({ anger: null, trust: null, defensiveness: null }, "첫 대답을 기다리는 중", 0, []);
  clearBand();
  $("band-empty").hidden = true;
  go("talk");

  talkUI._ttsWarned = false;
  $("tone-base").textContent = baseline ? "평소 목소리 기준" : "기준 미측정";
  setMeters({ arousal: 50, warmth: 50 });
  $("tone-note").textContent = "말하는 동안 실시간으로 움직입니다.";
  convo = new Conversation(s, { mic, ui: talkUI, baseline });
  convo.run();
}

function addLog(cls, html) {
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = html;
  $("talk-log").appendChild(li);
  li.scrollIntoView({ block: "nearest" });
  return li;
}

// ---------- 톤 표시 ----------
function setMeters({ arousal, warmth }) {
  $("m-arousal").style.left = `${arousal}%`;
  $("m-warmth").style.left = `${warmth}%`;
  if (arousal >= 70) $("tone-note").textContent = "목소리가 격앙되게 들립니다. 한 박자 늦추고 낮춰 보세요.";
  else if (warmth <= 30) $("tone-note").textContent = "차갑게 들립니다. 문장 끝을 살짝 올려 보세요.";
}

const END_LABEL = { falling_sharp: "끝 억양 뚝 ⤵", falling: "끝 억양 내림", flat: "끝 억양 평평", rising: "끝 억양 올림 ⤴" };
function toneLine(t) {
  const parts = [];
  if (t.has_baseline) {
    if (Math.abs(t.loud_db) >= 2) parts.push(`음량 ${t.loud_db > 0 ? "+" : ""}${t.loud_db}dB`);
    if (Math.abs(t.pitch_shift_st) >= 1.5) parts.push(`음높이 ${t.pitch_shift_st > 0 ? "+" : ""}${t.pitch_shift_st}반음`);
  }
  if (Math.abs(t.rate_ratio - 1) >= 0.15) parts.push(`속도 ${t.rate_ratio}배`);
  parts.push(END_LABEL[t.end] || "");
  const icons = (t.checkpoints || []).map((c) => ({ loud: "🔊", high: "📈", fast: "⏩", fall: "⤵", stress: "💥", sigh: "😮‍💨" }[c.type])).join("");
  return `🎙 ${parts.filter(Boolean).join(" · ")}${icons ? " · " + icons : ""}`;
}

const TEXT_CP = { aggressive: "💢 공격적", excuse: "🛡 변명조", cold: "🧊 차가움", sarcasm: "😏 비꼼", good: "✅ 좋은 표현" };
function markTextCheckpoints(li, cps) {
  const said = li.querySelector(".said");
  if (!said || !cps.length) return;
  let html = esc(said.textContent);
  for (const c of cps) {
    const span = esc(c.text_span || "");
    if (span && html.includes(span)) html = html.replace(span, `<mark class="hl ${c.type}" title="${esc(c.note || "")}">${span}</mark>`);
  }
  said.innerHTML = html;
  const ul = document.createElement("ul");
  ul.className = "text-cps";
  ul.innerHTML = cps.map((c) => `<li>${TEXT_CP[c.type] || c.type} — ${esc(c.note || "")}</li>`).join("");
  li.appendChild(ul);
}

// ---------- 평소 목소리 ----------
let baseline = null;
let baselineSkipped = false;
let blMode = "before-talk";
let blCapture = null;

async function loadBaseline() {
  try { baseline = (await api("/api/baseline")).tone; } catch { baseline = null; }
  renderBaselineLine();
}

function renderBaselineLine() {
  const t = baseline
    ? `🎙 평소 목소리: 측정됨 (음높이 약 ${Math.round(baseline.pitch_med)}Hz) · <a id="link-bl">다시 측정</a>`
    : `🎙 평소 목소리: 아직 측정 안 함 — 시작하면 30초 측정부터 합니다.`;
  $("brief-baseline").innerHTML = t;
  const a = $("link-bl");
  if (a) a.onclick = async () => {
    try { await mic.open(); await mic.calibrate(); openBaseline("before-talk"); }
    catch (e) { $("brief-hint").textContent = `마이크를 열 수 없습니다: ${e.message}`; }
  };
  $("settings-baseline").textContent = baseline
    ? `측정됨 · 음높이 ${Math.round(baseline.pitch_med)}Hz · 속도 ${baseline.rate}음절/초` : "아직 측정하지 않았습니다.";
}

let camStream = null;
async function openCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
    $("bl-video").srcObject = camStream;
    $("bl-cam-off").hidden = true;
  } catch {
    $("bl-cam-off").hidden = false;
    $("bl-cam-off").textContent = "📷 카메라를 쓸 수 없습니다 (목소리만 측정)";
  }
}
function closeCamera() {
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  $("bl-video").srcObject = null;
}
function highlightLine(progress) {
  const items = [...document.querySelectorAll("#bl-lines li")];
  const k = Math.min(items.length - 1, Math.floor(progress * items.length));
  items.forEach((li, i) => { li.classList.toggle("now", i === k); li.classList.toggle("done", i < k); });
}

function openBaseline(mode) {
  blMode = mode;
  highlightLine(0);
  document.querySelectorAll("#bl-lines li").forEach((li) => li.classList.remove("now", "done"));
  openCamera();
  $("bl-status").textContent = '준비되면 "측정 시작"을 누르세요';
  $("bl-sec").textContent = "0 / 10초";
  $("bl-bar").style.width = "0%";
  $("bl-result").hidden = true;
  showError($("bl-error"), "");
  $("btn-bl-start").disabled = false;
  $("btn-bl-done").disabled = true;
  go("baseline");
}

$("btn-bl-start").addEventListener("click", async () => {
  showError($("bl-error"), "");
  $("btn-bl-start").disabled = true;
  try {
    await mic.open();
    if (!mic.calibrated) {
      $("bl-status").textContent = "주변 소음을 확인하는 중입니다. 1초만 조용히 해주세요…";
      await mic.calibrate();
    }
  } catch (e) {
    $("btn-bl-start").disabled = false;
    return showError($("bl-error"), `마이크를 열 수 없습니다: ${e.message}`);
  }
  $("bl-status").textContent = "🎙 듣고 있습니다. 편안하게 읽어주세요…";
  const tracker = new ToneTracker(null, { threshold: mic.threshold });
  const TARGET = 10; // 유성음 10초 모이면 자동 완료
  blCapture = mic.capture({
    maxMs: 30000,
    onTick: (t) => {
      const f = tracker.push(analyzeFrame(t.buf, t.sampleRate), t.elapsed);
      const voiced = tracker.frames.filter((x) => x.voiced).length * 0.03;
      $("bl-sec").textContent = `${voiced.toFixed(1)} / ${TARGET}초`;
      $("bl-bar").style.width = `${Math.min(100, (voiced / TARGET) * 100)}%`;
      $("bl-level").style.width = `${Math.min(100, t.level * 400)}%`;
      $("btn-bl-done").disabled = voiced < 6;
      highlightLine(Math.min(0.99, voiced / TARGET));
      if (voiced >= TARGET) blCapture.stop();
      void f;
    },
  });
  const cap = blCapture;
  await cap.done;
  if (cap.skipped) return;
  await finishBaseline(tracker);
});

$("btn-bl-done").addEventListener("click", () => blCapture && blCapture.stop());

async function finishBaseline(tracker) {
  $("btn-bl-done").disabled = true;
  const b = computeBaseline(tracker.frames);
  if (!b) {
    $("btn-bl-start").disabled = false;
    $("bl-status").textContent = "다시 시도해 주세요";
    return showError($("bl-error"), "목소리가 충분히 들리지 않았습니다. 마이크 가까이에서 조금 더 길게 읽어주세요.");
  }
  try {
    baseline = (await api("/api/baseline", { method: "POST", body: { tone: b } })).tone;
  } catch (e) {
    $("btn-bl-start").disabled = false;
    return showError($("bl-error"), e.message);
  }
  $("bl-status").textContent = "✅ 측정 완료";
  $("bl-result").innerHTML = `
    <li>평소 음높이<b>${Math.round(b.pitch_med)}Hz</b></li>
    <li>음높이 변화 폭<b>${b.range_st}반음</b></li>
    <li>말 속도<b>${b.rate}음절/초</b></li>`;
  $("bl-result").hidden = false;
  renderBaselineLine();
  setTimeout(afterBaseline, 1500);
}

function afterBaseline() {
  closeCamera();
  if (blMode === "before-talk" && current) startTalk();
  else if (blMode === "before-brief" && current) {
    toast(baseline ? "내 기본값을 저장했습니다." : "일반 기본값으로 분석합니다. 설정에서 언제든 측정할 수 있습니다.", 4000);
    openBrief(current);
  } else go("select");
}


$("btn-bl-skip").addEventListener("click", () => {
  if (blCapture) { blCapture.skipped = true; blCapture.stop(); }
  baselineSkipped = true;
  afterBaseline();
});

function setStatus(kind, text) {
  const st = $("talk-status");
  st.className = `status ${kind}`;
  $("status-text").textContent = text;
  $("countdown").hidden = kind !== "listen";
  setSpeaking(kind === "npc");
}

function setGauges(emo, reason, progress, done) {
  for (const [k, id] of [["anger", "g-anger"], ["trust", "g-trust"], ["defensiveness", "g-def"]]) {
    const v = emo[k];
    $(id).style.width = v == null ? "0%" : `${v}%`;
    $(`${id}-v`).textContent = v == null ? "-" : v;
  }
  $("g-reason").textContent = reason || "";
  $("g-goal").style.width = `${progress}%`;
  $("g-goal-v").textContent = `${progress}%`;
  $("g-checklist").innerHTML = current.checklist
    .map((x) => `<li class="${done.includes(x) ? "done" : ""}">${esc(x)}</li>`).join("");
}

const talkUI = {
  status(kind) {
    const name = current.character.name;
    if (kind === "npc") setStatus("npc", `🔊 ${name}이(가) 말하는 중`);
    if (kind === "listen") setStatus("listen", "🎙 지금 대답하세요!");
    if (kind === "analyze") setStatus("analyze", "⏳ 듣고 판단하는 중…");
    if (kind === "npc-text") setStatus("npc", `💬 ${name}의 말을 읽어보세요`);
    if (kind === "npc-wait") setStatus("analyze", `💬 ${name}이(가) 대답하려는 중…`);
  },
  npcSays(text, { muted = false } = {}) {
    $("npc-bubble").innerHTML = esc(text) + (muted ? ' <span class="muted-badge">🔇 음성 없이 글자로</span>' : "");
    addLog("npc", `<small>${esc(current.character.name)}${muted ? " · 🔇" : ""}</small>${esc(text)}`);
  },
  npcReact(text) {
    $("npc-bubble").textContent = text;
    setSpeaking(true);
    addLog("npc react", `<small>${esc(current.character.name)} · 반응</small>${esc(text)}`);
  },
  ttsFailed(e) {
    if (!this._ttsWarned) toast(`음성을 만들지 못해 글자로 보여줍니다. (${e.message})`, 4500);
    this._ttsWarned = true;
    refreshUsage();
  },
  npcTick({ level, ended }) {
    if (ended) return setSpeaking(false);
    pushLevel(level, "npc");
    setMouth(level);
  },
  listenTick({ level, threshold, spoke, remain, st, hot }) {
    pushLevel(level, "me", threshold, { st, hot });
    if (spoke) {
      $("countdown").hidden = true;
      $("status-text").textContent = "🎙 듣고 있습니다… (멈추면 1.5초 뒤 종료)";
      $("talk-status").classList.remove("urgent");
    } else if (remain != null) {
      const sec = Math.ceil(remain / 1000);
      $("countdown").textContent = sec;
      $("talk-status").classList.toggle("urgent", sec <= 1);
    }
  },
  nagged(n) {
    addLog("nag", `<small>⏰ 3초 안에 대답하지 않음 (재촉 ${n}/2)</small>`);
  },
  meSays(text, { nag, seconds, tone }) {
    myTurns += 1;
    $("turn-count").textContent = `답변 ${myTurns} / 5`;
    const meta = [`${(seconds || 0).toFixed(1)}초`];
    if (nag) meta.push(`재촉 ${nag}번 받음`);
    return addLog("me", `<small>나 · ${meta.join(" · ")}</small><span class="said">${esc(text)}</span>` +
      (tone ? `<span class="tone-line">${esc(toneLine(tone))}</span>` : ""));
  },
  toneCheckpoint(c, audio) {
    addPin({ icon: c.icon, title: c.label, note: c.note, audio });
  },
  toneLive(sc) { setMeters(sc); },
  turnResult(r, li) {
    if (li) markTextCheckpoints(li, r.checkpoints || []);
    if (r.tone_feedback) $("tone-note").textContent = r.tone_feedback;
    setGauges(r.emotion, r.reason, r.goal_progress, r.checklist_done);
    setExpression(exprFromEmotion(r.emotion));
  },
  refreshUsage,
  error(e) {
    toast(e.message || "오류가 발생했습니다.", 6000);
    if (e.status === 401) openKeyModal();
    refreshUsage();
    go("brief");
  },
  end(r) { showResult(r); },
};

function showResult(r) {
  convo = null;
  setSpeaking(false);
  const map = {
    success: ["🟢 성공", "목표를 이뤘습니다!"],
    partial: ["🟡 부분 성공", "절반의 성과입니다."],
    fail: ["🔴 실패", "목표를 이루지 못했습니다."],
  };
  const [badge, title] = map[r.ending] || map.partial;
  $("result-badge").textContent = badge;
  $("result-badge").className = `result-badge ${r.ending}`;
  $("result-title").textContent = title;
  $("result-reason").textContent = r.reason || "";
  const p = r.goal_progress || 0;
  $("result-progress").style.width = `${p}%`;
  $("result-progress-text").textContent = `${p}%`;
  $("result-checklist").innerHTML = current.checklist
    .map((x) => `<li class="${(r.checklist_done || []).includes(x) ? "done" : ""}">${esc(x)}</li>`).join("");
  $("result-log").innerHTML = (r.history || []).map((h) =>
    `<li class="${h.speaker}"><small>${h.speaker === "me" ? "나" : esc(current.character.name)}</small>${esc(h.text)}</li>`).join("");
  refreshUsage();
  go("result");
}

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

// ---------- 초기 세팅: 음성·인물 사진 ----------
let setupRunning = false;

const fmtUsd = (v) => `$${v.toFixed(2)}`;
const fmtKrw = (v, rate) => `₩${Math.round(v * rate).toLocaleString("ko-KR")}`;
let krwRate = 1335;

async function refreshSetupInfo() {
  try {
    const st = await api("/api/setup/status");
    $("setup-info").textContent = st.missing
      ? `음성 ${st.audio.missing}개, 사진 ${st.portraits.missing}장이 아직 없습니다. 예상 ${fmtUsd(st.estimate_usd)} (${fmtKrw(st.estimate_usd, krwRate)}).`
      : "음성과 인물 사진이 모두 준비되어 있습니다. assets/ 폴더를 GitHub에 커밋해 두면 다른 PC에서도 재사용합니다.";
    return st;
  } catch { $("setup-info").textContent = "확인하지 못했습니다."; return null; }
}

async function checkSetup({ force = false } = {}) {
  if (setupRunning) { $("setup-modal").showModal(); return; }
  const st = await api("/api/setup/status");
  setPortraitFrames(st.portraits_status);
  if (!st.missing && !force) return;
  $("setup-audio").textContent = `${st.audio.missing}개 · ${fmtUsd(st.audio.estimate_usd)}`;
  $("setup-photo").textContent = `${st.portraits.missing}장 · ${fmtUsd(st.portraits.estimate_usd)}`;
  $("setup-cost").textContent = `${fmtUsd(st.estimate_usd)} (${fmtKrw(st.estimate_usd, krwRate)})`;
  $("setup-progress").hidden = true;
  showError($("setup-error"), "");
  $("btn-setup-run").disabled = false;
  $("btn-setup-run").textContent = st.missing ? "지금 만들기" : "모두 준비됨 · 닫기";
  $("btn-setup-run").dataset.mode = st.missing ? "run" : "close";
  $("setup-modal").showModal();
}

function setupLog(text, fail = false) {
  const li = document.createElement("li");
  li.textContent = text;
  if (fail) li.className = "fail";
  $("setup-log").prepend(li);
}

async function runSetup() {
  if (setupRunning) return;
  setupRunning = true;
  $("btn-setup-run").disabled = true;
  $("btn-setup-later").textContent = "닫기 (계속 진행)";
  $("setup-progress").hidden = false;
  $("setup-log").innerHTML = "";
  const st = await api("/api/setup/status");
  const total = st.jobs.length;
  let done = 0;
  const failed = [];
  const tick = (label) => {
    $("setup-bar").style.width = `${(done / total) * 100}%`;
    $("setup-count").textContent = `${done} / ${total}`;
    if (label) $("setup-now").textContent = label;
  };
  tick("시작합니다…");

  // 인물별로 묶어서 순서 유지(기본 사진 → 표정 → 입 벌림), 3명씩 동시에 진행
  const chains = {};
  for (const j of st.jobs) (chains[`${j.kind}:${j.kind === "audio" ? "all" : j.scenario_id}`] ||= []).push(j);
  const queue = Object.values(chains);
  const worker = async () => {
    while (queue.length) {
      const chain = queue.shift();
      for (const j of chain) {
        try {
          tick(`만드는 중: ${j.label}`);
          await api("/api/setup/job", { method: "POST", body: j });
          done += 1;
          setupLog(`✓ ${j.label}`);
        } catch (e) {
          done += 1;
          failed.push(j);
          setupLog(`✗ ${j.label} — ${e.message}`, true);
          if (j.kind === "portrait") { done += chain.length - chain.indexOf(j) - 1; break; } // 기준 사진 실패 시 이 인물은 중단
        } finally { tick(); }
      }
      refreshUsage();
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  setupRunning = false;
  $("btn-setup-later").textContent = "닫기";
  tick(failed.length ? `완료 (실패 ${failed.length}건 — 다시 누르면 빠진 것만 이어서 만듭니다)` : "완료!");
  $("btn-setup-run").disabled = false;
  $("btn-setup-run").textContent = failed.length ? "빠진 것 다시 만들기" : "모두 준비됨 · 닫기";
  $("btn-setup-run").dataset.mode = failed.length ? "run" : "close";
  await loadScenarios();
  refreshUsage();
  if (!failed.length) toast("준비 완료! assets/ 폴더를 GitHub에 커밋하면 다음부터는 재사용합니다.", 7000);
}

$("btn-setup-run").addEventListener("click", () => {
  if ($("btn-setup-run").dataset.mode === "close") $("setup-modal").close();
  else runSetup();
});
$("btn-setup-later").addEventListener("click", () => $("setup-modal").close());
$("btn-setup-open").addEventListener("click", () => { $("settings-modal").close(); checkSetup({ force: true }); });

// ---------- 시작 ----------
initBand($("band-canvas"), $("band-tip"));
loadBaseline();
updateKeyHints();
loadScenarios().catch(() => toast("시나리오를 불러오지 못했습니다."));
api("/api/config").then((c) => { krwRate = c.krw_per_usd; }).catch(() => {});
if (!keyStore.get()) openKeyModal();
else { refreshUsage(); checkSetup().catch(() => {}); }
setInterval(refreshUsage, 30000);
