// 🎙 내 캐릭터 확인: 평소 목소리·표정 기준값 측정 (5문장 읽기, 카메라 미리보기)

import { api } from "../api.js";
import { analyzeFrame, computeBaseline, ToneTracker } from "../audio/tone.js";
import { computeFaceBaseline, FaceTracker } from "../face/metrics.js";
import { closeCamera, faceCam, media, mic, openCamera } from "../media.js";
import { $, showError, toast } from "../util.js";

// 측정 결과 (main.js 의 대화 화면도 읽음)
export const blState = { baseline: null, face: null, skipped: false };

// main.js 가 넘겨주는 화면 이동
let ctx = { current: () => null, startTalk: () => {}, openBrief: () => {}, go: () => {} };
export function initBaseline(c) { ctx = { ...ctx, ...c }; }

let blMode = "before-talk";
let blCapture = null;

export async function loadBaseline() {
  try {
    const r = await api("/api/blState.baseline");
    blState.baseline = r.tone;
    blState.face = r.face;
  } catch { blState.baseline = null; }
  renderBaselineLine();
}

export function renderBaselineLine() {
  const t = blState.baseline
    ? `🎙 평소 목소리: 측정됨 (음높이 약 ${Math.round(blState.baseline.pitch_med)}Hz) · <a id="link-bl">다시 측정</a>`
    : `🎙 평소 목소리: 아직 측정 안 함 — 시작하면 30초 측정부터 합니다.`;
  $("brief-baseline").innerHTML = t;
  const a = $("link-bl");
  if (a) a.onclick = async () => {
    try { await mic.open(); await mic.calibrate(); openBaseline("before-talk"); }
    catch (e) { $("brief-hint").textContent = `마이크를 열 수 없습니다: ${e.message}`; }
  };
  $("settings-baseline").textContent = blState.baseline
    ? `측정됨 · 음높이 ${Math.round(blState.baseline.pitch_med)}Hz · 속도 ${blState.baseline.rate}음절/초 · 표정 ${blState.face ? "측정됨" : "없음"}` : "아직 측정하지 않았습니다.";
}

export function openBaseline(mode) {
  blMode = mode;
  document.querySelectorAll("#bl-lines li").forEach((li) => li.classList.remove("now", "done"));
  $("bl-cam-off").hidden = true;
  openCamera($("bl-video")).then(async (ok) => {
    if (!ok) { $("bl-cam-off").hidden = false; $("bl-cam-off").textContent = "📷 카메라를 쓸 수 없습니다 (목소리만 측정)"; return; }
    // 측정 전에도 얼굴 인식이 되는지 바로 보이도록 미리보기 분석 시작
    if (media.faceCfg && (await faceCam.prepare(media.faceCfg))) faceCam.start(new FaceTracker(null), { fps: media.faceCfg.fps });
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
  ctx.go("baseline");
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
    faceCam.prepare(media.faceCfg).then((ok) => {
      if (!ok) return;
      faceCam.phase = "idle";
      faceCam.start(faceTr, { fps: media.faceCfg.fps });
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
    const saved = await api("/api/blState.baseline", { method: "POST", body: { tone: b, face: fb } });
    blState.baseline = saved.tone;
    blState.face = saved.face;
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
    <li>표정 기본값<b>${blState.face ? "측정됨" : "없음"}</b></li>
    <li>평소 미소<b>${blState.face ? Math.round(blState.face.smile * 100) + "%" : "-"}</b></li>
    <li>눈 깜빡임<b>${blState.face ? blState.face.blink_per_min + "회/분" : "-"}</b></li>`;
  $("bl-result").hidden = false;
  renderBaselineLine();
  setTimeout(afterBaseline, 1500);
}

function afterBaseline() {
  faceCam.stop();
  if (!(blMode === "before-talk" && ctx.current())) closeCamera();
  if (blMode === "before-talk" && ctx.current()) ctx.startTalk();
  else if (blMode === "before-brief" && ctx.current()) {
    toast(blState.baseline ? "내 기본값을 저장했습니다." : "일반 기본값으로 분석합니다. 설정에서 언제든 측정할 수 있습니다.", 4000);
    ctx.openBrief(ctx.current());
  } else ctx.go("select");
}


$("btn-bl-skip").addEventListener("click", () => {
  if (blCapture) { blCapture.skipped = true; blCapture.stop(); }
  blState.skipped = true;
  afterBaseline();
});
