// 상대 인물 실사 사진: 표정 5단계 전환 + 음성 크기에 맞춘 입 움직임
// 입 다문 사진(p-closed) 위에 입 벌린 사진(p-talk)을 겹치고, 음량에 따라 투명도를 바꾼다.

const $ = (id) => document.getElementById(id);
const LABELS = { calm: "평온", annoyed: "짜증", angry: "분노", explosive: "폭발", softened: "누그러짐" };

let frames = {};       // { scenarioId: { expr: {closed, talk} } }
let currentId = null;
let currentExpr = "calm";
let mouth = 0;

export function setPortraitFrames(f) { frames = f || {}; }

export function framesOf(id) { return frames[id] && frames[id].frames; }

export function hasPhoto(id, expr = "calm") {
  const f = framesOf(id);
  return !!(f && f[expr] && f[expr].closed);
}

export function exprFromEmotion(e) {
  if (!e) return "calm";
  if (e.anger >= 80) return "explosive";
  if (e.anger >= 60) return "angry";
  if (e.anger >= 35 || e.defensiveness >= 70) return "annoyed";
  if (e.trust >= 60) return "softened";
  return "calm";
}

export function showCharacter(s) {
  currentId = s.id;
  $("p-fallback").textContent = s.character.emoji;
  $("talk-name").textContent = s.character.name;
  setExpression("calm", true);
}

export function setExpression(expr, immediate = false) {
  const f = framesOf(currentId) || {};
  // 해당 표정 사진이 없으면 가장 가까운 것으로
  const order = [expr, "angry", "annoyed", "calm"];
  const use = order.find((x) => f[x] && f[x].closed);
  $("p-expr").textContent = LABELS[expr] || "";
  currentExpr = expr;
  const closed = $("p-closed");
  const talk = $("p-talk");
  if (!use) {
    closed.removeAttribute("src");
    talk.removeAttribute("src");
    return;
  }
  const apply = () => {
    closed.src = f[use].closed;
    if (f[use].talk) talk.src = f[use].talk; else talk.removeAttribute("src");
  };
  if (immediate || !closed.getAttribute("src")) return apply();
  // 부드럽게 전환: 새 사진을 미리 받아두고 교체
  const pre = new Image();
  pre.onload = () => {
    $("portrait").classList.add("swap");
    setTimeout(() => { apply(); $("portrait").classList.remove("swap"); }, 160);
  };
  pre.src = f[use].closed;
  if (f[use].talk) new Image().src = f[use].talk;
}

// level: 0~1 근처의 음성 RMS
export function setMouth(level) {
  const target = Math.max(0, Math.min(1, (level - 0.015) * 9));
  // 열릴 때는 빠르게, 닫힐 때는 조금 천천히
  mouth += (target - mouth) * (target > mouth ? 0.7 : 0.35);
  $("p-talk").style.opacity = mouth.toFixed(3);
}

export function setSpeaking(on) {
  $("portrait").classList.toggle("speaking", on);
  if (!on) { mouth = 0; $("p-talk").style.opacity = "0"; }
}

export function setBreathing(on) { $("portrait").classList.toggle("breathing", on); }

export function currentExpression() { return currentExpr; }
