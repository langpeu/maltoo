// 화면 공통 도우미 (여러 모듈에서 import)

export const $ = (id) => document.getElementById(id);
export const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let toastTimer;
export function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
export function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }
