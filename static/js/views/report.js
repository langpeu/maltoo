// 교정 리포트 화면: 점수, 총평, 교정 카드, 모범 답변 듣기, 다시 말해보기 비교

import { api, keyStore } from "../api.js";
import { playUrl } from "../audio/mic.js";
import { analyzeFrame, ToneTracker } from "../audio/tone.js";
import { pushLevel } from "../ui/band.js";
import { $, esc, showError, toast } from "../util.js";

const END_LABEL = { falling_sharp: "끝 억양 뚝 ⤵", falling: "끝 억양 내림", flat: "끝 억양 평평", rising: "끝 억양 올림 ⤴" };

// main.js 가 넘겨주는 현재 상태 (현재 상대·난이도·세션·평소 목소리·마이크·대화 기록)
let ctx = {
  current: () => null, difficulty: () => "normal", session: () => null, baseline: () => null,
  lastHistory: () => [], mic: null, refreshUsage: () => {},
};
export function initReport(c) { ctx = { ...ctx, ...c }; }


export async function requestReport(r, game = null) {
  $("report-loading").hidden = false;
  $("report-body").hidden = true;
  showError($("report-error"), "");
  try {
    const rep = await api("/api/report", {
      method: "POST",
      body: {
        session_id: ctx.session() ? ctx.session().id : String(Date.now()),
        started_at: ctx.session() ? ctx.session().at : null,
        scenario_id: ctx.current().id,
        turns: (r.history || []).map((h) => ({ speaker: h.speaker, text: h.text, tone: h.tone || null,
                                               face: h.face || null, checkpoints: h.checkpoints || null })),
        ending: r.ending || null,
        goal_progress: r.goal_progress || 0,
        difficulty: r.difficulty || ctx.difficulty(),
        game,
      },
    });
    pastTurns = null;
    renderReport(rep);
  } catch (e) {
    showError($("report-error"), `리포트를 만들지 못했습니다: ${e.message}`);
  } finally {
    $("report-loading").hidden = true;
    ctx.refreshUsage();
  }
}

function scoreTile(label, v, sub, main = false) {
  return `<div class="score ${main ? "main" : ""}"><div class="s-label">${label}</div>
    <div class="s-val">${v == null ? "-" : v}<small>${v == null ? "" : "점"}</small></div><div class="s-sub">${sub}</div></div>`;
}

// 📈 내 기록에서 지난 리포트를 다시 볼 때 (다시 말해보기는 그때의 대화 기준)
let pastTurns = null;
export function renderPastReport(rep, turns) {
  pastTurns = turns || [];
  $("report-loading").hidden = true;
  showError($("report-error"), "");
  renderReport(rep);
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
    ctx.refreshUsage();
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
    await ctx.mic.open();
    if (!ctx.mic.calibrated) { box.textContent = "주변 소음 확인 중… 1초만 조용히"; await ctx.mic.calibrate(); }
    box.innerHTML = '<span class="verdict">🎙 지금 위의 초록 문장을 말해보세요</span> <span class="muted small">(8초 안에 시작, 멈추면 1.5초 뒤 종료)</span>';
    const tracker = new ToneTracker(ctx.baseline(), { threshold: ctx.mic.threshold });
    const rec = await ctx.mic.listen({
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
        headers: { "X-OpenAI-Key": keyStore.get(), "X-Session-Id": ctx.session() ? ctx.session().id : "" } });
      if (res.ok) said = (await res.json()).text || "";
    } catch { /* 글자 확인 없이 톤만 비교 */ }
    const meTurns = (pastTurns || ctx.lastHistory()).filter((h) => h.speaker === "me");
    const t1 = f.turn && meTurns[f.turn - 1] ? meTurns[f.turn - 1].tone : null;
    box.innerHTML = compareHtml(t1, t2, said, f.better);
  } catch (e) {
    box.textContent = `다시 말해보기를 하지 못했습니다: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🎙 한 번 더";
    ctx.refreshUsage();
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
