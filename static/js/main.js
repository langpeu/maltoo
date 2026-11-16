import { api, keyStore } from "./api.js";
import { Mic, playUrl } from "./audio/mic.js";
import { Conversation } from "./session.js";
import { addPin, clearBand, initBand, pushLevel } from "./ui/band.js";
import { analyzeFrame, computeBaseline, ToneTracker } from "./audio/tone.js";
import { drawLandmarks, FaceCam } from "./face/camera.js";
import { computeFaceBaseline, FaceTracker, PHASE_LABEL } from "./face/metrics.js";
import { renderCost, resetCost } from "./ui/cost-panel.js";
import { setVoiceFxConfig, setVoiceFxStrength, voiceFxStrength } from "./audio/voicefx.js";
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
  for (const v of ["select", "brief", "baseline", "talk", "result", "history"]) $(`view-${v}`).hidden = v !== view;
  if (view === "history") loadHistory();
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
  renderDifficulty();
  go("brief");
}

// ---------- 대화 ----------
const mic = new Mic();
let convo = null;

function stopConversation() {
  if (convo) { convo.stop(); convo = null; }
  faceCam.stop();
}

// ---------- 표정 ----------
let captures = [];
let selfHidden = false;

function setupFace() {
  $("selfview").hidden = true;
  $("btn-self-show").hidden = true;
  $("face-base").textContent = faceBaseline ? "평소 표정 기준" : "기준 미측정";
  if (!faceCam.on) {
    $("face-note").textContent = "카메라가 꺼져 있어 표정은 분석하지 않습니다.";
    return null;
  }
  faceCam.attach($("self-video"));
  $("selfview").hidden = selfHidden;
  $("btn-self-show").hidden = !selfHidden;
  $("face-note").textContent = "표정 분석을 준비하는 중…";
  const tracker = new FaceTracker(faceBaseline, {
    onCheckpoint: (c) => {
      addPin({ icon: c.icon, title: `${c.label}${PHASE_LABEL[c.phase] ? " · " + PHASE_LABEL[c.phase] : ""}`, note: c.note });
      $("face-note").textContent = `${c.icon} ${c.note}`;
      $("self-flag").textContent = c.icon;
      setTimeout(() => { if ($("self-flag").textContent === c.icon) $("self-flag").textContent = ""; }, 2500);
      const img = faceCam.capture(480);
      if (!img) return;
      if (captures.length < 12) captures.push({ ...c, img });
      else {
        // 12장이 차면 가장 덜 심각한 사진을 더 심각한 새 사진으로 바꾼다 (최악의 표정은 꼭 남김)
        const i = captures.reduce((mi, x, j) => (x.severity < captures[mi].severity ? j : mi), 0);
        if (c.severity > captures[i].severity) captures[i] = { ...c, img };
      }
    },
  });
  faceCam.prepare(faceCfg).then((ok) => {
    if (!ok) { $("face-note").textContent = "표정 분석 모델을 불러오지 못했습니다. (인터넷 연결 확인) 목소리만 분석합니다."; return; }
    $("face-note").textContent = "표정을 보고 있습니다. 평소처럼 대화하세요.";
    faceCam.start(tracker, { fps: faceCfg.fps });
  });
  return { cam: faceCam, tracker };
}

// ---------- 표정 인식 상태 표시 ----------
function faceMiniHtml(f) {
  if (!f || !f.face) return "";
  const b = faceCam.tracker ? faceCam.tracker.b : { brow: 0.12, smile: 0.12 };
  const frown = Math.max(0, Math.min(1, (f.m.brow - b.brow) / 0.4));
  const smile = Math.max(0, Math.min(1, f.m.smile));
  const front = f.flags.away ? 0.2 : 1 - Math.min(0.8, Math.abs(f.m.yaw) * 4);
  const row = (label, v, hot) => `<div class="fm-row"><span>${label}</span><div class="fm-bar"><i class="${hot ? "hot" : ""}" style="width:${Math.round(v * 100)}%"></i></div><b>${Math.round(v * 100)}</b></div>`;
  return row("찌푸림", frown, f.flags.frown) + row("미소", smile, false) + row("시선 정면", front, f.flags.away);
}

function updateFaceUI() {
  const h = faceCam.health();
  const views = [
    { chip: "bl-face-chip", mini: "bl-face-mini", overlay: "bl-overlay", visible: !$("view-baseline").hidden },
    { chip: "face-chip", mini: "face-mini", overlay: "self-overlay", visible: !$("view-talk").hidden },
  ];
  for (const v of views) {
    if (!v.visible) continue;
    $(v.chip).textContent = h.text;
    $(v.chip).className = `face-chip ${v.chip === "face-chip" ? "inline " : ""}${h.state}`;
    $(v.mini).innerHTML = h.state === "ok" || h.state === "warn" ? faceMiniHtml(faceCam.lastFrame) : "";
    drawLandmarks($(v.overlay), faceCam.running ? faceCam.lastLandmarks : null, h.state);
  }
  $("selfview").classList.remove("ok", "warn", "error");
  if (["ok", "warn", "error"].includes(h.state)) $("selfview").classList.add(h.state);
}
setInterval(updateFaceUI, 100);

$("btn-self-hide").addEventListener("click", () => { selfHidden = true; $("selfview").hidden = true; $("btn-self-show").hidden = false; });
$("btn-self-show").addEventListener("click", () => { selfHidden = false; $("selfview").hidden = false; $("btn-self-show").hidden = true; });

const FACE_ICON = { frown: "😠", roll: "🙄", away: "👀", smirk: "😏", press: "😤", mouthdown: "😒", chinup: "⬆️" };
function faceLine(f) {
  if (!f || !f.has_face) return "";
  const byPhase = {};
  for (const c of f.checkpoints || []) (byPhase[c.phase] ||= []).push(FACE_ICON[c.type]);
  const parts = Object.entries(byPhase).map(([p, icons]) => `${{ listen: "듣는 중", silence: "기다리는 중", speak: "말하는 중" }[p] || p} ${icons.join("")}`);
  if (f.expressionless) parts.push("무표정");
  return `🙂 표정: ${parts.length ? parts.join(" · ") : "평소와 비슷"}`;
}

$("btn-start").addEventListener("click", async () => {
  if (!keyStore.get()) return openKeyModal();
  const btn = $("btn-start");
  btn.disabled = true;
  try {
    $("brief-hint").textContent = "마이크 권한을 허용해 주세요…";
    await mic.open();
    $("brief-hint").textContent = "카메라를 켜는 중…";
    await openCamera(null);
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
$("btn-stop").addEventListener("click", () => { stopConversation(); closeCamera(); go("brief"); });

let myTurns = 0;

async function startTalk() {
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
  captures = [];
  const face = setupFace();
  setMeters({ arousal: 50, warmth: 50 });
  $("tone-note").textContent = "말하는 동안 실시간으로 움직입니다.";
  sessionStart = { id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()), at: new Date().toISOString() };

  // 회사 세계관: 누적 상태 + 소문이 퍼졌는지
  let ws = null;
  try { ws = await api("/api/world/start", { method: "POST", body: { scenario_id: s.id } }); } catch { /* 게임 장치 없이 진행 */ }
  setupGamePanel(s, ws);
  if (ws && ws.rumor) {
    toast(`🗣 소문이 퍼졌습니다! ${ws.rumor.source}이(가) 당신이 한 말을 ${s.character.name}에게 전했습니다.`, 7000);
  }
  convo = new Conversation(s, { mic, ui: talkUI, baseline, face, difficulty,
                                answerMs: answerSeconds() * 1000, sessionId: sessionStart.id,
                                openingLine: ws && ws.rumor ? ws.rumor.line : "opening",
                                startAnger: ws ? ws.start_anger : 40 });
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
  try {
    const r = await api("/api/baseline");
    baseline = r.tone;
    faceBaseline = r.face;
  } catch { baseline = null; }
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
    ? `측정됨 · 음높이 ${Math.round(baseline.pitch_med)}Hz · 속도 ${baseline.rate}음절/초 · 표정 ${faceBaseline ? "측정됨" : "없음"}` : "아직 측정하지 않았습니다.";
}

const faceCam = new FaceCam();
let faceCfg = null;
let faceBaseline = null;

async function openCamera(videoEl) {
  const ok = await faceCam.open();
  if (videoEl) faceCam.attach(videoEl);
  if (ok && faceCfg && faceCam.status !== "ready") faceCam.prepare(faceCfg); // 모델은 미리 받아둠
  return ok;
}
function closeCamera() {
  faceCam.close();
  $("bl-video").srcObject = null;
  $("self-video").srcObject = null;
}

function openBaseline(mode) {
  blMode = mode;
  document.querySelectorAll("#bl-lines li").forEach((li) => li.classList.remove("now", "done"));
  $("bl-cam-off").hidden = true;
  openCamera($("bl-video")).then(async (ok) => {
    if (!ok) { $("bl-cam-off").hidden = false; $("bl-cam-off").textContent = "📷 카메라를 쓸 수 없습니다 (목소리만 측정)"; return; }
    // 측정 전에도 얼굴 인식이 되는지 바로 보이도록 미리보기 분석 시작
    if (faceCfg && (await faceCam.prepare(faceCfg))) faceCam.start(new FaceTracker(null), { fps: faceCfg.fps });
  });
  $("bl-status").textContent = '준비되면 "측정 시작"을 누르세요';
  $("bl-sec").textContent = "0 / 5문장";
  $("bl-prompter").className = "prompter";
  $("pr-step").textContent = "준비";
  $("pr-text").textContent = '"측정 시작"을 누르면 여기에 읽을 문장이 나옵니다.';
  $("pr-cue").textContent = "";
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
  const tracker = new ToneTracker(null, { threshold: mic.threshold });
  const faceTr = new FaceTracker(null);
  if (faceCam.on) {
    faceCam.prepare(faceCfg).then((ok) => {
      if (!ok) return;
      faceCam.phase = "idle";
      faceCam.start(faceTr, { fps: faceCfg.fps });
    });
  }

  // 3, 2, 1 카운트다운
  const items = [...document.querySelectorAll("#bl-lines li")];
  const pr = $("bl-prompter");
  pr.classList.add("count");
  $("pr-step").textContent = "곧 시작합니다";
  $("pr-cue").textContent = "";
  $("bl-status").textContent = "첫 문장을 읽을 준비를 하세요";
  for (const n of [3, 2, 1]) { $("pr-text").textContent = n; await new Promise((r) => setTimeout(r, 800)); }
  pr.classList.remove("count");

  // 문장 하나씩: 1초 이상 말하고 0.7초 멈추면 다음 문장
  let idx = 0, voicedMs = 0, quietMs = 0;
  const showSentence = () => {
    items.forEach((li, i) => { li.classList.toggle("now", i === idx); li.classList.toggle("done", i < idx); });
    if (idx >= items.length) return;
    pr.classList.add("reading");
    $("pr-step").textContent = `${idx + 1} / ${items.length} · ${items[idx].dataset.k}`;
    $("pr-text").textContent = items[idx].textContent;
    $("pr-cue").textContent = "🎙 지금 이 문장을 읽어주세요";
    $("pr-cue").className = "pr-cue";
    $("bl-sec").textContent = `${idx} / ${items.length}문장`;
    $("bl-bar").style.width = `${(idx / items.length) * 100}%`;
    $("bl-status").textContent = "평소 말하듯 편안하게, 다 읽으면 잠깐 멈추세요";
    $("btn-bl-done").disabled = false;
    voicedMs = 0;
    quietMs = 0;
  };
  const next = () => {
    idx += 1;
    if (idx >= items.length) {
      items.forEach((li) => { li.classList.remove("now"); li.classList.add("done"); });
      $("bl-sec").textContent = `${items.length} / ${items.length}문장`;
      $("bl-bar").style.width = "100%";
      return blCapture.stop();
    }
    showSentence();
  };
  blNext = next;
  showSentence();
  blCapture = mic.capture({
    maxMs: 90000,
    onTick: (t) => {
      const f = tracker.push(analyzeFrame(t.buf, t.sampleRate), t.elapsed);
      $("bl-level").style.width = `${Math.min(100, t.level * 400)}%`;
      if (f.loud) {
        voicedMs += 30;
        quietMs = 0;
        if (voicedMs > 300) { $("pr-cue").textContent = "👂 잘 듣고 있어요…"; $("pr-cue").className = "pr-cue live"; }
      } else if (voicedMs > 0) {
        quietMs += 30;
      }
      if (voicedMs >= 1000 && quietMs >= 700) next();
    },
  });
  const cap = blCapture;
  await cap.done;
  faceCam.stop();
  if (cap.skipped) return;
  await finishBaseline(tracker, faceTr);
});

let blNext = null;
$("btn-bl-done").addEventListener("click", () => blNext && blNext());

async function finishBaseline(tracker, faceTr) {
  $("btn-bl-done").disabled = true;
  const b = computeBaseline(tracker.frames);
  if (!b) {
    $("btn-bl-start").disabled = false;
    $("bl-status").textContent = "다시 시도해 주세요";
    $("bl-prompter").className = "prompter";
    $("pr-text").textContent = "다시 한 번 해볼까요?";
    $("pr-cue").textContent = "";
    return showError($("bl-error"), "목소리가 충분히 들리지 않았습니다. 마이크 가까이에서 또박또박 읽어주세요.");
  }
  try {
    const fb = faceTr ? computeFaceBaseline(faceTr.all) : null;
    const saved = await api("/api/baseline", { method: "POST", body: { tone: b, face: fb } });
    baseline = saved.tone;
    faceBaseline = saved.face;
  } catch (e) {
    $("btn-bl-start").disabled = false;
    return showError($("bl-error"), e.message);
  }
  $("bl-status").textContent = "✅ 측정 완료";
  $("bl-prompter").className = "prompter";
  $("pr-step").textContent = "완료";
  $("pr-text").textContent = "수고하셨습니다! 평소의 나를 기억해 둘게요.";
  $("pr-cue").textContent = "";
  $("bl-result").innerHTML = `
    <li>평소 음높이<b>${Math.round(b.pitch_med)}Hz</b></li>
    <li>음높이 변화 폭<b>${b.range_st}반음</b></li>
    <li>말 속도<b>${b.rate}음절/초</b></li>
    <li>표정 기본값<b>${faceBaseline ? "측정됨" : "없음"}</b></li>
    <li>평소 미소<b>${faceBaseline ? Math.round(faceBaseline.smile * 100) + "%" : "-"}</b></li>
    <li>눈 깜빡임<b>${faceBaseline ? faceBaseline.blink_per_min + "회/분" : "-"}</b></li>`;
  $("bl-result").hidden = false;
  renderBaselineLine();
  setTimeout(afterBaseline, 1500);
}

function afterBaseline() {
  faceCam.stop();
  if (!(blMode === "before-talk" && current)) closeCamera();
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
  meSays(text, { nag, seconds, tone, face }) {
    myTurns += 1;
    $("turn-count").textContent = `답변 ${myTurns} / 5`;
    const meta = [`${(seconds || 0).toFixed(1)}초`];
    if (nag) meta.push(`재촉 ${nag}번 받음`);
    return addLog("me", `<small>나 · ${meta.join(" · ")}</small><span class="said">${esc(text)}</span>` +
      (tone ? `<span class="tone-line">${esc(toneLine(tone))}</span>` : "") +
      (face && face.has_face ? `<span class="face-line">${esc(faceLine(face))}</span>` : ""));
  },
  toneCheckpoint(c, audio) {
    addPin({ icon: c.icon, title: c.label, note: c.note, audio });
  },
  toneLive(sc) { setMeters(sc); },
  gameUpdate(g) { updateGamePanel(g); },
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
  faceCam.stop();
  closeCamera();
  $("result-captures-wrap").hidden = !captures.length;
  $("result-captures").innerHTML = captures.map((c, i) => `
    <div class="capture"><img src="${c.img}" alt="">
      <div>${c.icon} <b>${esc(c.label)}</b><br>${esc(PHASE_LABEL[c.phase] || "")}
      · <a href="${c.img}" download="maltoo-${i + 1}.jpg">저장</a></div></div>`).join("");
  const map = {
    success: ["🟢 성공", "목표를 이뤘습니다!"],
    partial: ["🟡 부분 성공", "절반의 성과입니다."],
    fail: ["🔴 실패", "목표를 이루지 못했습니다."],
    resign: ["🚪 퇴사", "상대가 회사를 떠났습니다."],
    team_quit: ["👥 팀원 이탈", "목표는 이뤘지만 팀이 흔들렸습니다."],
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
  lastHistory = r.history || [];
  finishWorld(r).then((game) => requestReport(r, game));
}

// ---------- 회사 세계관 (Phase 5) ----------
let worldState = null;
const won = (v) => `${Math.round(v / 10000).toLocaleString("ko-KR")}만`;

async function loadWorld() {
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

function setupGamePanel(s, ws) {
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

function updateGamePanel(g) {
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

async function finishWorld(r) {
  let fin = null;
  try {
    fin = await api("/api/world/finish", { method: "POST",
      body: { scenario_id: current.id, ending: r.worldEnding || r.ending, session: r.gameSession || null } });
  } catch { /* 게임 장치 없이 */ }
  renderGameResult(r, fin);
  loadWorld();
  const game = fin ? { ...fin, mentions: r.mentions || [], team_quit: r.ending === "team_quit" } : null;
  return game;
}

function worstCapture() {
  return captures.reduce((w, c) => (!w || (c.severity || 0) > (w.severity || 0) ? c : w), null);
}

function renderGameResult(r, fin) {
  const box = $("game-result");
  if (!fin) { box.hidden = true; return; }
  const name = current.character.name;
  let img = "", html = "";
  let caption = "";
  if (fin.kind === "boss") {
    // 인사고과 사진: 이번 대화에서 가장 안 좋았던 내 표정 (브라우저 메모리의 캡처, 서버 전송 없음)
    const worst = worstCapture();
    img = worst ? worst.img : "/assets/endings/review.webp";
    if (worst) caption = `<figcaption>${worst.icon} ${esc(worst.label)} · ${esc(PHASE_LABEL[worst.phase] || "")}<br><small>가장 안 좋았던 내 표정</small></figcaption>`;
    const diff = fin.salary_after - fin.salary_before;
    html = `<h2><span class="grade ${fin.grade}">${fin.grade}</span>인사고과 ${fin.grade}등급</h2>
      <p class="big">연봉 ${won(fin.salary_before)} → ${won(fin.salary_after)} 원
        <span class="salary-delta ${diff < 0 ? "minus" : diff > 0 ? "plus" : ""}">${diff ? (diff > 0 ? "+" : "−") + won(Math.abs(diff)) : "동결"}</span></p>
      <p>이번 대화에서 깎인 금액: <b>${won(fin.session_cut || 0)} 원</b></p>
      ${fin.meeting ? '<p class="error">💀 인사팀에서 면담을 요청했습니다.</p>' : ""}
      <p class="small muted">연봉은 게임용 가상 수치입니다.</p>`;
  } else if (fin.resigned && r.ending === "resign") {
    img = `/assets/endings/resign_${current.id}.webp`;
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

// ---------- 교정 리포트 ----------
let sessionStart = null;
let lastHistory = [];

async function requestReport(r, game = null) {
  $("report-loading").hidden = false;
  $("report-body").hidden = true;
  showError($("report-error"), "");
  try {
    const rep = await api("/api/report", {
      method: "POST",
      body: {
        session_id: sessionStart ? sessionStart.id : String(Date.now()),
        started_at: sessionStart ? sessionStart.at : null,
        scenario_id: current.id,
        turns: (r.history || []).map((h) => ({ speaker: h.speaker, text: h.text, tone: h.tone || null,
                                               face: h.face || null, checkpoints: h.checkpoints || null })),
        ending: r.ending || null,
        goal_progress: r.goal_progress || 0,
        difficulty: r.difficulty || difficulty,
        game,
      },
    });
    renderReport(rep);
  } catch (e) {
    showError($("report-error"), `리포트를 만들지 못했습니다: ${e.message}`);
  } finally {
    $("report-loading").hidden = true;
    refreshUsage();
  }
}

function scoreTile(label, v, sub, main = false) {
  return `<div class="score ${main ? "main" : ""}"><div class="s-label">${label}</div>
    <div class="s-val">${v == null ? "-" : v}<small>${v == null ? "" : "점"}</small></div><div class="s-sub">${sub}</div></div>`;
}

function renderReport(rep) {
  const sc = rep.scores || {};
  $("report-scores").innerHTML =
    scoreTile("종합", sc.overall, "말·톤·표정 + 목표", true) +
    scoreTile("💬 말", sc.words, "표현·내용") +
    scoreTile("🎙 톤", sc.tone, sc.tone == null ? "측정 없음" : "목소리") +
    scoreTile("🙂 표정", sc.face, sc.face == null ? "카메라 꺼짐" : "얼굴·시선");
  $("report-summary").textContent = rep.summary || "";
  $("report-strengths").innerHTML = (rep.strengths || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>-</li>";
  $("report-habits").innerHTML = (rep.habits || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>-</li>";
  $("report-fixes").innerHTML = (rep.fixes || []).map((f, i) => `
    <div class="fix" data-i="${i}">
      ${f.turn ? `<span class="fix-turn">답변 ${f.turn}</span>` : ""}
      ${f.original ? `<div class="fix-orig">“${esc(f.original)}”</div>` : ""}
      <div class="fix-problem">${esc(f.problem)}</div>
      <div class="fix-better">“${esc(f.better)}”</div>
      <div class="fix-tips">${f.tone_tip ? `🎙 ${esc(f.tone_tip)}<br>` : ""}${f.face_tip ? `🙂 ${esc(f.face_tip)}` : ""}</div>
      <div class="fix-actions">
        <button class="btn" type="button" data-act="listen">▶ 모범 답변 듣기</button>
        <button class="btn btn-primary" type="button" data-act="retry">🎙 다시 말해보기</button>
      </div>
      <div class="fix-compare" hidden></div>
    </div>`).join("") || '<p class="muted">교정할 답변이 없습니다.</p>';
  $("report-fixes").querySelectorAll(".fix").forEach((el) => {
    const f = rep.fixes[Number(el.dataset.i)];
    el.querySelector('[data-act="listen"]').onclick = (e) => playModel(f, e.currentTarget);
    el.querySelector('[data-act="retry"]').onclick = (e) => retryFix(f, el, e.currentTarget);
  });
  $("report-next").textContent = rep.next_practice ? `🎯 다음 연습 과제: ${rep.next_practice}` : "";
  $("report-next").hidden = !rep.next_practice;
  $("report-body").hidden = false;
}

async function playModel(f, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "⏳ 준비 중…";
  try {
    const r = await api("/api/tts/coach", { method: "POST", body: { text: f.better } });
    btn.textContent = "🔊 재생 중…";
    await playUrl(r.url);
  } catch (e) {
    toast(`모범 답변을 재생하지 못했습니다: ${e.message}`);
  } finally {
    btn.textContent = label;
    btn.disabled = false;
    refreshUsage();
  }
}

// 톤 점수 (서버 app/report.py tone_score 와 같은 공식)
function toneScore(t) {
  if (!t) return null;
  let s = 100 - 12 * (t.loud_n || 0) - 8 * (t.high_n || 0) - 6 * (t.fast_n || 0) - 10 * (t.fall_n || 0)
    - 6 * (t.stress_n || 0) - 10 * (t.sigh_n || 0) - Math.max(0, (t.arousal ?? 50) - 60) * 0.5
    - Math.max(0, 40 - (t.warmth ?? 50)) * 0.5 - 5 * (t.nag || 0);
  return Math.round(Math.max(0, Math.min(100, s)));
}

function similarity(a, b) {
  const grams = (x) => { const t = x.replace(/[\s.,!?…~"“”]/g, ""); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const g of A) if (B.has(g)) n++;
  return Math.round((n / Math.max(A.size, B.size)) * 100);
}

const END_RANK = { falling_sharp: 0, falling: 1, flat: 2, rising: 3 };
async function retryFix(f, el, btn) {
  const box = el.querySelector(".fix-compare");
  box.hidden = false;
  btn.disabled = true;
  try {
    await mic.open();
    if (!mic.calibrated) { box.textContent = "주변 소음 확인 중… 1초만 조용히"; await mic.calibrate(); }
    box.innerHTML = '<span class="verdict">🎙 지금 위의 초록 문장을 말해보세요</span> <span class="muted small">(8초 안에 시작, 멈추면 1.5초 뒤 종료)</span>';
    const tracker = new ToneTracker(baseline, { threshold: mic.threshold });
    const rec = await mic.listen({
      startTimeoutMs: 8000,
      onTick: (t) => { tracker.push(analyzeFrame(t.buf, t.sampleRate), t.elapsed); pushLevel(t.level, "me", t.threshold); },
    });
    if (!rec.spoke) { box.innerHTML = "말소리가 들리지 않았습니다. 다시 눌러서 말해보세요."; return; }
    box.innerHTML = "⏳ 분석 중…";
    const t2 = tracker.summary({ latency_s: (tracker.speechStart || 0) / 1000 });
    const fd = new FormData();
    fd.append("audio", rec.blob, "retry.webm");
    fd.append("seconds", String(rec.seconds || 0));
    let said = "";
    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: fd,
        headers: { "X-OpenAI-Key": keyStore.get(), "X-Session-Id": sessionStart ? sessionStart.id : "" } });
      if (res.ok) said = (await res.json()).text || "";
    } catch { /* 글자 확인 없이 톤만 비교 */ }
    const meTurns = lastHistory.filter((h) => h.speaker === "me");
    const t1 = f.turn && meTurns[f.turn - 1] ? meTurns[f.turn - 1].tone : null;
    box.innerHTML = compareHtml(t1, t2, said, f.better);
  } catch (e) {
    box.textContent = `다시 말해보기를 하지 못했습니다: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🎙 한 번 더";
    refreshUsage();
  }
}

function compareHtml(t1, t2, said, better) {
  const rows = [];
  let up = 0, down = 0;
  const row = (label, a, b, better2) => {
    // better2: b 가 a 보다 좋으면 1, 나쁘면 -1, 같으면 0
    if (better2 > 0) up++; else if (better2 < 0) down++;
    const mark = better2 > 0 ? '<span class="up">좋아짐 ▲</span>' : better2 < 0 ? '<span class="down">나빠짐 ▼</span>' : "그대로";
    rows.push(`<tr><td>${label}</td><td>${a ?? "-"}</td><td>${b ?? "-"}</td><td>${t1 ? mark : ""}</td></tr>`);
  };
  const cmp = (a, b, lowerIsBetter, eps = 3) => (a == null || b == null || Math.abs(a - b) < eps ? 0 : (b < a) === lowerIsBetter ? 1 : -1);
  const s1 = toneScore(t1), s2 = toneScore(t2);
  row("톤 점수", s1, s2, cmp(s1, s2, false));
  row("격앙도 (낮을수록 차분)", t1?.arousal, t2.arousal, cmp(t1?.arousal, t2.arousal, true));
  row("따뜻함", t1?.warmth, t2.warmth, cmp(t1?.warmth, t2.warmth, false));
  const e1 = t1 ? END_LABEL[t1.end] : null, e2 = END_LABEL[t2.end];
  row("끝 억양", e1, e2, t1 ? Math.sign((END_RANK[t2.end] ?? 2) - (END_RANK[t1.end] ?? 2)) : 0);
  const sp = (t) => (t ? Math.abs(t.rate_ratio - 1) : null);
  row("말 속도 (평소=1)", t1 ? `${t1.rate_ratio}배` : null, `${t2.rate_ratio}배`, cmp(sp(t1), sp(t2), true, 0.08));
  const nc = (t) => (t ? (t.checkpoints || []).length : null);
  row("감지된 문제 신호", nc(t1), nc(t2), cmp(nc(t1), nc(t2), true, 1));
  const sim = said ? similarity(said, better) : null;
  let verdict;
  if (!t1) verdict = `🎙 톤 점수 ${s2}점`;
  else if (up > down) verdict = `👏 처음보다 좋아졌어요! (${up}개 항목 개선)`;
  else if (down > up) verdict = "🤔 처음보다 거칠게 들려요. 속도를 늦추고 끝을 살짝 올려보세요.";
  else verdict = "비슷해요. 모범 답변을 한 번 더 듣고 따라 해보세요.";
  return `<div class="verdict">${verdict}</div>
    <table><tr><th>항목</th><th>처음</th><th>다시</th><th></th></tr>${rows.join("")}</table>
    ${said ? `<div class="small">들린 말: “${esc(said)}” · 모범 답변과 일치도 <b>${sim}%</b></div>` : ""}`;
}

// ---------- 기록 ----------
async function loadHistory() {
  let items = [];
  try { items = await api("/api/history"); } catch { /* 없음 */ }
  $("history-lead").textContent = items.length
    ? `지금까지 ${items.length}번 연습했습니다. 최근 점수: ${items[0].scores.overall ?? "-"}점`
    : "아직 기록이 없습니다. 상대를 골라 첫 연습을 해보세요.";
  const ENDING = { success: "🟢 성공", partial: "🟡 부분 성공", fail: "🔴 실패" };
  const DIFF = { mild: "🌱", normal: "🌶", spicy: "🔥" };
  $("history-list").innerHTML = items.map((h) => `
    <li><div><b>${esc(h.name)}</b> · ${esc(h.title)} ${DIFF[h.difficulty] || ""}<br>
      <small>${esc(h.ended_at.replace("T", " ").slice(0, 16))} · ${ENDING[h.ending] || "-"} · 말 ${h.scores.words ?? "-"} / 톤 ${h.scores.tone ?? "-"} / 표정 ${h.scores.face ?? "-"}</small>
      ${h.next_practice ? `<br><small>🎯 ${esc(h.next_practice)}</small>` : ""}</div>
      <div class="h-score">${h.scores.overall ?? "-"}</div></li>`).join("");
  drawHistoryChart([...items].reverse());
}

function drawHistoryChart(items) {
  const svg = $("history-chart");
  const W = svg.clientWidth || 600, H = 240, P = { l: 34, r: 12, t: 14, b: 26 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const series = [
    { key: "overall", label: "종합", color: "#000", width: 3.5 },
    { key: "words", label: "💬 말", color: "#1c7ed6", width: 2 },
    { key: "tone", label: "🎙 톤", color: "#e8590c", width: 2 },
    { key: "face", label: "🙂 표정", color: "#2b8a3e", width: 2 },
  ];
  const x = (i) => P.l + (items.length <= 1 ? (W - P.l - P.r) / 2 : (i / (items.length - 1)) * (W - P.l - P.r));
  const y = (v) => P.t + (1 - v / 100) * (H - P.t - P.b);
  let g = "";
  for (const v of [0, 50, 100]) g += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="#ddd"/><text x="${P.l - 6}" y="${y(v) + 4}" font-size="11" text-anchor="end" fill="#777">${v}</text>`;
  if (!items.length) g += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#777" font-size="14">연습하면 점수 추이가 여기에 그려집니다</text>`;
  for (const s of series) {
    const pts = items.map((h, i) => [x(i), h.scores[s.key]]).filter(([, v]) => v != null).map(([px, v]) => `${px},${y(v)}`);
    if (pts.length > 1) g += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linejoin="round" points="${pts.join(" ")}"/>`;
    for (const p of pts) { const [px, py] = p.split(","); g += `<circle cx="${px}" cy="${py}" r="${s.key === "overall" ? 4 : 3}" fill="${s.color}"/>`; }
  }
  items.forEach((h, i) => { if (items.length <= 12 || i % Math.ceil(items.length / 12) === 0) g += `<text x="${x(i)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#777">${i + 1}회</text>`; });
  svg.innerHTML = g;
  $("history-legend").innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("");
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
  const chainKey = (j) => j.kind === "audio" ? "audio"
    : j.kind === "ending" && j.ending_id === "review" ? "ending:review" : `portrait:${j.scenario_id}`; // 사직서 장면은 그 인물 사진 뒤에
  for (const j of st.jobs) (chains[chainKey(j)] ||= []).push(j);
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
          if (j.kind === "portrait" && j.expr === "calm" && !j.talk) { done += chain.length - chain.indexOf(j) - 1; break; } // 기본 사진 실패 시 이 인물은 중단
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
api("/api/config").then((c) => {
  krwRate = c.krw_per_usd;
  faceCfg = c.face;
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
function startApp() {
  if (!keyStore.get()) openKeyModal();
  else { refreshUsage(); checkSetup().catch(() => {}); }
}
if (!guideSeen()) $("guide-modal").showModal();
else startApp();
setInterval(refreshUsage, 30000);
