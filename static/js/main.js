import { api, keyStore } from "./api.js";
import { renderCost, resetCost } from "./ui/cost-panel.js";

const $ = (id) => document.getElementById(id);

// ---------- 공통 ----------
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = !msg;
}

function updateKeyHints() {
  $("key-hint").textContent = keyStore.hint();
  $("settings-key-hint").textContent = keyStore.hint();
}

// ---------- 비용 ----------
export async function refreshUsage() {
  if (!keyStore.get()) return;
  try {
    renderCost(await api("/api/usage"));
  } catch (e) {
    if (e.status === 401) openKeyModal();
  }
}

// ---------- 키 입력 ----------
function openKeyModal() {
  const m = $("key-modal");
  showError($("key-error"), "");
  $("key-input").value = "";
  if (!m.open) m.showModal();
  $("key-input").focus();
}

$("key-modal").addEventListener("cancel", (e) => {
  // 키가 없으면 닫을 수 없음
  if (!keyStore.get()) e.preventDefault();
});

$("key-toggle").addEventListener("click", () => {
  const input = $("key-input");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("key-toggle").textContent = show ? "숨기기" : "보기";
});

$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("key-input").value.trim();
  if (!key.startsWith("sk-")) {
    showError($("key-error"), "OpenAI API 키는 sk- 로 시작합니다.");
    return;
  }
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
  $("settings-modal").showModal();
});

$("btn-settings-close").addEventListener("click", () => $("settings-modal").close());

$("btn-limits-save").addEventListener("click", async () => {
  try {
    await api("/api/settings/limits", {
      method: "PUT",
      body: { daily: Number($("limit-daily").value), monthly: Number($("limit-monthly").value) },
    });
    $("settings-modal").close();
    await refreshUsage();
    toast("비용 한도를 저장했습니다.");
  } catch (err) {
    showError($("settings-error"), err.message);
  }
});

$("btn-key-change").addEventListener("click", () => {
  $("settings-modal").close();
  openKeyModal();
});

$("btn-key-delete").addEventListener("click", () => {
  keyStore.clear();
  updateKeyHints();
  resetCost();
  $("settings-modal").close();
  openKeyModal();
  toast("이 브라우저에서 키를 삭제했습니다.");
});

// ---------- 비용 표시 테스트 ----------
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
    toast(err.message, 5000);
    if (err.status === 401) openKeyModal();
    await refreshUsage();
  } finally {
    btn.disabled = false;
  }
});

// ---------- 시작 ----------
updateKeyHints();
if (!keyStore.get()) {
  openKeyModal();
} else {
  refreshUsage();
}
setInterval(refreshUsage, 30000);
