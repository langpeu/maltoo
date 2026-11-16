// 하단 실시간 분석 띠: 지금은 음량 파형만 (Phase 2에서 음높이·체크포인트 추가)

const MAX = 600;
let canvas, ctx, points = [], threshold = 0.02, raf;

export function initBand(el) {
  canvas = el;
  ctx = canvas.getContext("2d");
  const resize = () => {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
  };
  resize();
  addEventListener("resize", resize);
  const loop = () => { draw(); raf = requestAnimationFrame(loop); };
  loop();
}

// who: "me" | "npc" | "idle"
export function pushLevel(level, who = "me", th) {
  if (th) threshold = th;
  points.push({ level, who });
  if (points.length > MAX) points.shift();
}

export function clearBand() { points = []; }

function draw() {
  if (!ctx) return;
  const w = canvas.width, h = canvas.height, mid = h / 2;
  ctx.clearRect(0, 0, w, h);
  const n = Math.min(points.length, Math.floor(w / (3 * devicePixelRatio)));
  const bw = 3 * devicePixelRatio;
  const scale = (h / 2 - 4) / 0.25;
  for (let i = 0; i < n; i++) {
    const p = points[points.length - n + i];
    const x = w - (n - i) * bw;
    const amp = Math.max(1, Math.min(h / 2 - 2, p.level * scale));
    ctx.fillStyle = p.who === "npc" ? "#b5b5b5" : p.level > threshold ? "#000" : "#ffcd4a";
    ctx.fillRect(x, mid - amp, bw - devicePixelRatio, amp * 2);
  }
  // 기준선
  ctx.fillStyle = "rgba(0,0,0,.15)";
  ctx.fillRect(0, mid, w, devicePixelRatio);
}
