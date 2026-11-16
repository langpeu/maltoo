// 🗣 대화 화면: 상대 사진·말풍선, 내 얼굴·표정, 톤 미터, 대화 기록, 턴 표시, 결과 화면으로 넘기기

import { api, keyStore } from "../api.js";
import { Conversation } from "../session.js";
import { addPin, clearBand, pushLevel } from "../ui/band.js";
import { drawLandmarks } from "../face/camera.js";
import { CP, FaceTracker, PHASE_LABEL } from "../face/metrics.js";
import { $, esc, toast } from "../util.js";
import { requestReport } from "./report.js";
import { closeCamera, faceCam, media, mic, openCamera } from "../media.js";
import { blState, openBaseline } from "./baseline.js";
import { finishWorld, setupGamePanel, updateGamePanel } from "./game.js";
import { exprFromEmotion, setBreathing, setExpression, setMouth, setSpeaking, showCharacter } from "../ui/portrait.js";

// main.js 가 넘겨주는 상태·화면 이동
let ctx = {
  current: () => null, difficulty: () => "normal", answerSeconds: () => 3,
  refreshUsage: () => {}, go: () => {}, openBrief: () => {}, openKeyModal: () => {},
};
export function initTalk(c) { ctx = { ...ctx, ...c }; }
// 다른 화면이 읽는 대화 상태
export const talkState = {
  get captures() { return captures; }, get worstFrame() { return worstFrame; },
  get session() { return sessionStart; }, get history() { return lastHistory; },
};

// ---------- 대화 ----------
let convo = null;

export function stopConversation() {
  if (convo) { convo.stop(); convo = null; }
  faceCam.stop();
}

// ---------- 표정 ----------
let captures = [];
let worstFrame = null; // 체크포인트가 없을 때 쓰는 '가장 안 좋았던 순간' 사진
let selfHidden = false;

function setupFace() {
  $("selfview").hidden = true;
  $("btn-self-show").hidden = true;
  $("face-base").textContent = blState.face ? "평소 표정 기준" : "기준 미측정";
  if (!faceCam.on) {
    $("face-note").textContent = "카메라가 꺼져 있어 표정은 분석하지 않습니다.";
    return null;
  }
  faceCam.attach($("self-video"));
  $("selfview").hidden = selfHidden;
  $("btn-self-show").hidden = !selfHidden;
  $("face-note").textContent = "표정 분석을 준비하는 중…";
  const tracker = new FaceTracker(blState.face, {
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
    onWorse: (w) => {
      const img = faceCam.capture(480);
      const info = CP[w.type] || { icon: "🙂", label: "대화 중 내 표정" };
      if (img) worstFrame = { ...w, severity: w.score, icon: info.icon, label: info.label, img };
    },
  });
  faceCam.prepare(media.faceCfg).then((ok) => {
    if (!ok) { $("face-note").textContent = "표정 분석 모델을 불러오지 못했습니다. (인터넷 연결 확인) 목소리만 분석합니다."; return; }
    $("face-note").textContent = "표정을 보고 있습니다. 평소처럼 대화하세요.";
    faceCam.start(tracker, { fps: media.faceCfg.fps });
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
  if (!keyStore.get()) return ctx.openKeyModal();
  const btn = $("btn-start");
  btn.disabled = true;
  try {
    $("brief-hint").textContent = "마이크 권한을 허용해 주세요…";
    await mic.open();
    $("brief-hint").textContent = "카메라를 켜는 중…";
    await openCamera(null);
    $("brief-hint").textContent = "주변 소음을 확인하는 중입니다. 1초만 조용히 해주세요…";
    await mic.calibrate();
    if (!blState.baseline && !blState.skipped) openBaseline("before-talk");
    else startTalk();
  } catch (e) {
    $("brief-hint").textContent = e.name === "NotAllowedError"
      ? "마이크 권한이 거부되었습니다. 주소창 왼쪽 자물쇠 아이콘에서 허용해 주세요."
      : `마이크를 열 수 없습니다: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-retry").addEventListener("click", () => ctx.current() && ctx.openBrief(ctx.current()));
$("btn-stop").addEventListener("click", () => { stopConversation(); closeCamera(); ctx.go("brief"); });

let myTurns = 0;

export async function startTalk() {
  const s = ctx.current();
  myTurns = 0;
  showCharacter(s);
  setBreathing(true);
  $("talk-goal").textContent = `🎯 ${s.goal}`;
  renderTurn(1);
  $("npc-bubble").textContent = "…";
  $("talk-log").innerHTML = "";
  $("state-title").textContent = `${s.character.name}의 감정`;
  setGauges({ anger: null, trust: null, defensiveness: null }, "첫 대답을 기다리는 중", 0, []);
  clearBand();
  $("band-empty").hidden = true;
  ctx.go("talk");

  talkUI._ttsWarned = false;
  $("tone-base").textContent = blState.baseline ? "평소 목소리 기준" : "기준 미측정";
  captures = [];
  worstFrame = null;
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
  convo = new Conversation(s, { mic, ui: talkUI, baseline: blState.baseline, face, difficulty: ctx.difficulty(),
                                answerMs: ctx.answerSeconds() * 1000, sessionId: sessionStart.id,
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

function setStatus(kind, text) {
  const st = $("talk-status");
  st.className = `status ${kind}`;
  $("status-text").textContent = text;
  $("countdown").hidden = kind !== "listen";
  setSpeaking(kind === "npc");
}

// 몇 번째 턴인지: "턴 2 / 5 ●●○○○ · 5턴 안에 목표 달성", 마지막 턴은 강조
const MAX_TURNS = 5;
function renderTurn(n) {
  const el = $("turn-count");
  const dots = Array.from({ length: MAX_TURNS }, (_, i) => `<i class="${i < n - 1 ? "done" : i === n - 1 ? "now" : ""}"></i>`).join("");
  const last = n >= MAX_TURNS;
  el.className = `turn-count ${last ? "last" : ""}`;
  el.innerHTML = `<b>턴 ${Math.min(n, MAX_TURNS)} / ${MAX_TURNS}</b><span class="turn-dots">${dots}</span>` +
    `<small>${last ? "⚠️ 마지막 턴! 지금 목표를 받아내세요" : `${MAX_TURNS}턴 안에 목표 달성 · ${MAX_TURNS - n + 1}번 남음`}</small>`;
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
  $("g-checklist").innerHTML = ctx.current().checklist
    .map((x) => `<li class="${done.includes(x) ? "done" : ""}">${esc(x)}</li>`).join("");
}

const talkUI = {
  status(kind) {
    const name = ctx.current().character.name;
    if (kind === "npc") setStatus("npc", `🔊 ${name}이(가) 말하는 중`);
    if (kind === "listen") setStatus("listen", "🎙 지금 대답하세요!");
    if (kind === "analyze") setStatus("analyze", "⏳ 듣고 판단하는 중…");
    if (kind === "npc-text") setStatus("npc", `💬 ${name}의 말을 읽어보세요`);
    if (kind === "npc-wait") setStatus("analyze", `💬 ${name}이(가) 대답하려는 중…`);
  },
  npcSays(text, { muted = false } = {}) {
    $("npc-bubble").innerHTML = esc(text) + (muted ? ' <span class="muted-badge">🔇 음성 없이 글자로</span>' : "");
    addLog("npc", `<small>${esc(ctx.current().character.name)}${muted ? " · 🔇" : ""}</small>${esc(text)}`);
  },
  npcReact(text) {
    $("npc-bubble").textContent = text;
    setSpeaking(true);
    addLog("npc react", `<small>${esc(ctx.current().character.name)} · 반응</small>${esc(text)}`);
  },
  ttsFailed(e) {
    if (!this._ttsWarned) toast(`음성을 만들지 못해 글자로 보여줍니다. (${e.message})`, 4500);
    this._ttsWarned = true;
    ctx.refreshUsage();
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
  turnStart(n) { renderTurn(n); },
  nagged(n) {
    addLog("nag", `<small>⏰ 3초 안에 대답하지 않음 (재촉 ${n}/2)</small>`);
  },
  meSays(text, { nag, seconds, tone, face }) {
    myTurns += 1;
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
  refreshUsage: () => ctx.refreshUsage(),
  error(e) {
    toast(e.message || "오류가 발생했습니다.", 6000);
    if (e.status === 401) ctx.openKeyModal();
    ctx.refreshUsage();
    ctx.go("brief");
  },
  end(r) { showResult(r); },
};

export function showResult(r) {
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
  $("result-checklist").innerHTML = ctx.current().checklist
    .map((x) => `<li class="${(r.checklist_done || []).includes(x) ? "done" : ""}">${esc(x)}</li>`).join("");
  $("result-log").innerHTML = (r.history || []).map((h) =>
    `<li class="${h.speaker}"><small>${h.speaker === "me" ? "나" : esc(ctx.current().character.name)}</small>${esc(h.text)}</li>`).join("");
  ctx.refreshUsage();
  ctx.go("result");
  lastHistory = r.history || [];
  finishWorld(r).then((game) => requestReport(r, game));
}

let sessionStart = null;
let lastHistory = [];
