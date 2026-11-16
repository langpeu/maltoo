// 📈 내 기록 화면: 회차별 점수 목록 + 추이 그래프

import { api } from "../api.js";
import { $, esc } from "../util.js";

export async function loadHistory() {
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
