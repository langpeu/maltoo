// 오른쪽 비용 패널

const $ = (id) => document.getElementById(id);

function krw(usd, rate) {
  const v = usd * rate;
  if (v === 0) return "₩0";
  if (v < 10) return `₩${v.toFixed(1)}`;
  return `₩${Math.round(v).toLocaleString("ko-KR")}`;
}
const usdText = (v) => `$${v.toFixed(4)}`;

let last = null;

export function renderCost(u) {
  const rate = u.krw_per_usd;

  const cells = [
    ["cost-session", u.session_usd],
    ["cost-today", u.today_usd],
    ["cost-month", u.month_usd],
  ];
  for (const [id, v] of cells) {
    const el = $(id);
    const next = krw(v, rate);
    if (last && el.textContent !== next) {
      el.classList.add("bump");
      setTimeout(() => el.classList.remove("bump"), 220);
    }
    el.textContent = next;
    $(`${id}-usd`).textContent = usdText(v);
  }

  bar("limit-daily", u.today_usd, u.limits.daily, u.daily_status);
  bar("limit-monthly", u.month_usd, u.limits.monthly, u.monthly_status);

  for (const el of document.querySelectorAll("#by-feature [data-f]")) {
    el.textContent = usdText(u.by_feature_usd[el.dataset.f] || 0);
  }
  $("cost-saved").textContent = usdText(u.saved_usd);

  const note = $("cost-note");
  if (u.daily_status === "blocked" || u.monthly_status === "blocked") {
    note.textContent = "한도에 도달해서 OpenAI 호출이 차단되었습니다. 설정에서 한도를 조정할 수 있습니다.";
    note.classList.add("blocked");
  } else {
    note.textContent = "추정치입니다. 정확한 청구액은 OpenAI 대시보드에서 확인하세요.";
    note.classList.remove("blocked");
  }
  last = u;
}

function bar(prefix, spent, limit, status) {
  const pct = limit ? Math.min(100, (spent / limit) * 100) : 0;
  const fill = $(`${prefix}-bar`);
  fill.style.width = `${pct}%`;
  fill.className = `bar-fill ${status === "ok" ? "" : status}`;
  $(`${prefix}-text`).textContent = `$${spent.toFixed(4)} / $${limit.toFixed(2)}`;
}

export function resetCost() {
  last = null;
  for (const id of ["cost-session", "cost-today", "cost-month"]) {
    $(id).textContent = "₩0";
    $(`${id}-usd`).textContent = "$0.0000";
  }
}
