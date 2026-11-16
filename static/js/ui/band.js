// 하단 실시간 분석 띠: 음량 파형 + 음높이 선 + 감정 체크포인트 핀
// 회색 = 상대, 검정 = 나, 노랑 = 조용함, 빨강 = 평소보다 큰 소리 / 음높이 선 빨강 = 평소보다 높음

const MAX = 900;
const BAR = 3; // px (CSS)
let canvas, ctx, tip, total = 0;
let points = [];   // {idx, level, who, st, hot}
let pins = [];     // {idx, icon, title, note, audio:{url, t}}
let threshold = 0.02;

export function initBand(el, tipEl) {
  canvas = el;
  tip = tipEl;
  ctx = canvas.getContext("2d");
  const resize = () => {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
  };
  resize();
  addEventListener("resize", resize);
  canvas.addEventListener("click", onClick);
  const loop = () => { draw(); requestAnimationFrame(loop); };
  loop();
}

// who: "me" | "npc"; st: 평소 대비 반음 (null 이면 음높이 없음); hot: 평소보다 큰 소리
export function pushLevel(level, who = "me", th, { st = null, hot = false } = {}) {
  if (th) threshold = th;
  points.push({ idx: total++, level, who, st, hot });
  if (points.length > MAX) points.shift();
}

export function addPin({ icon, title, note, audio }) {
  pins.push({ idx: total - 1, icon, title, note, audio });
  if (pins.length > 80) pins.shift();
}

export function clearBand() {
  points = [];
  pins = [];
  if (tip) tip.hidden = true;
}

function xOf(idx, w, n) {
  const bw = BAR * devicePixelRatio;
  const first = total - n;
  return w - (n - (idx - first)) * bw;
}

function draw() {
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  const dpr = devicePixelRatio, bw = BAR * dpr;
  const top = 22 * dpr; // 핀 자리
  const mid = top + (h - top) / 2;
  const half = (h - top) / 2 - 2 * dpr;
  ctx.clearRect(0, 0, w, h);
  const n = Math.min(points.length, Math.floor(w / bw));
  const vis = points.slice(points.length - n);
  const scale = half / 0.25;

  // 파형
  for (const p of vis) {
    const x = xOf(p.idx, w, n);
    const amp = Math.max(dpr, Math.min(half, p.level * scale));
    ctx.fillStyle = p.who === "npc" ? "#b5b5b5" : p.hot ? "#e03131" : p.level > threshold ? "#000" : "#ffcd4a";
    ctx.fillRect(x, mid - amp, bw - dpr, amp * 2);
  }
  ctx.fillStyle = "rgba(0,0,0,.15)";
  ctx.fillRect(0, mid, w, dpr);

  // 음높이 선 (평소 대비 ±12반음 → 위아래)
  ctx.lineWidth = 2 * dpr;
  let prev = null;
  for (const p of vis) {
    if (p.who !== "me" || p.st == null) { prev = null; continue; }
    const x = xOf(p.idx, w, n) + bw / 2;
    const y = mid - Math.max(-12, Math.min(12, p.st)) / 12 * half;
    if (prev) {
      ctx.strokeStyle = p.st > 4 ? "#e03131" : "#1c7ed6";
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    prev = { x, y };
  }

  // 핀
  ctx.font = `${16 * dpr}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const pin of pins) {
    const x = xOf(pin.idx, w, n);
    if (x < 0) continue;
    ctx.fillStyle = "rgba(0,0,0,.25)";
    ctx.fillRect(x, top, dpr, h - top);
    ctx.fillText(pin.icon, x, 0);
  }
}

function onClick(e) {
  const r = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) * devicePixelRatio;
  const w = canvas.width;
  const n = Math.min(points.length, Math.floor(w / (BAR * devicePixelRatio)));
  let best = null, bestD = 16 * devicePixelRatio;
  for (const pin of pins) {
    const d = Math.abs(xOf(pin.idx, w, n) - cx);
    if (d < bestD) { best = pin; bestD = d; }
  }
  if (!best) { tip.hidden = true; return; }
  tip.innerHTML = `<b>${best.icon} ${best.title}</b>${best.note}` +
    (best.audio && best.audio.ref && best.audio.ref.blob ? '<br><button type="button" class="btn">▶ 이 구간 듣기</button>' : "");
  tip.style.left = `${Math.max(140, Math.min(r.width - 140, e.clientX - r.left))}px`;
  tip.hidden = false;
  const btn = tip.querySelector("button");
  if (btn) btn.onclick = (ev) => { ev.stopPropagation(); playClip(best.audio); };
}

// 녹음(webm)은 탐색이 불안정해서 디코딩 후 구간만 재생
let actx, current;
const decoded = new WeakMap();
async function playClip(audio) {
  const blob = audio.ref && audio.ref.blob;
  if (!blob) return;
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === "suspended") await actx.resume();
  let buf = decoded.get(blob);
  if (!buf) {
    buf = await actx.decodeAudioData(await blob.arrayBuffer());
    decoded.set(blob, buf);
  }
  if (current) try { current.stop(); } catch { /* 이미 끝남 */ }
  current = actx.createBufferSource();
  current.buffer = buf;
  current.connect(actx.destination);
  current.start(0, Math.max(0, audio.t - 1.2), 2.8);
}

document.addEventListener("click", (e) => {
  if (tip && !tip.hidden && !tip.contains(e.target) && e.target !== canvas) tip.hidden = true;
});
