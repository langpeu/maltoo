// 초기 세팅: 고정 음성·인물 사진이 있는지 확인하고, 없으면 한 장씩 생성 (생성물은 assets/ 에 저장 → 커밋해서 재사용)

import { api } from "../api.js";
import { setPortraitFrames } from "../ui/portrait.js";
import { $, showError, toast } from "../util.js";

let setupRunning = false;

const fmtUsd = (v) => `$${v.toFixed(2)}`;
const fmtKrw = (v, rate) => `₩${Math.round(v * rate).toLocaleString("ko-KR")}`;
let krwRate = 1335;
let deps = { loadScenarios: async () => {}, refreshUsage: () => {} };

export function setKrwRate(v) { if (v) krwRate = v; }
export function initSetup(d) { deps = { ...deps, ...d }; }

export async function refreshSetupInfo() {
  try {
    const st = await api("/api/setup/status");
    $("setup-info").textContent = st.missing
      ? `음성 ${st.audio.missing}개, 사진 ${st.portraits.missing}장이 아직 없습니다. 예상 ${fmtUsd(st.estimate_usd)} (${fmtKrw(st.estimate_usd, krwRate)}).`
      : "음성과 인물 사진이 모두 준비되어 있습니다. assets/ 폴더를 GitHub에 커밋해 두면 다른 PC에서도 재사용합니다.";
    return st;
  } catch { $("setup-info").textContent = "확인하지 못했습니다."; return null; }
}

export async function checkSetup({ force = false } = {}) {
  if (setupRunning) { $("setup-modal").showModal(); return; }
  const st = await api("/api/setup/status");
  setPortraitFrames(st.portraits_status);
  if (!st.missing && !force) return;
  $("setup-audio").textContent = `${st.audio.missing}개 · ${fmtUsd(st.audio.estimate_usd)}`;
  $("setup-photo").textContent = `${st.portraits.missing}장 · ${fmtUsd(st.portraits.estimate_usd)}`;
  $("setup-cost").textContent = `${fmtUsd(st.estimate_usd)} (${fmtKrw(st.estimate_usd, krwRate)})`;
  $("setup-progress").hidden = true;
  showError($("setup-error"), "");
  $("btn-setup-run").disabled = false;
  $("btn-setup-run").textContent = st.missing ? "지금 만들기" : "모두 준비됨 · 닫기";
  $("btn-setup-run").dataset.mode = st.missing ? "run" : "close";
  $("setup-modal").showModal();
}

function setupLog(text, fail = false) {
  const li = document.createElement("li");
  li.textContent = text;
  if (fail) li.className = "fail";
  $("setup-log").prepend(li);
}

async function runSetup() {
  if (setupRunning) return;
  setupRunning = true;
  $("btn-setup-run").disabled = true;
  $("btn-setup-later").textContent = "닫기 (계속 진행)";
  $("setup-progress").hidden = false;
  $("setup-log").innerHTML = "";
  const st = await api("/api/setup/status");
  const total = st.jobs.length;
  let done = 0;
  const failed = [];
  const tick = (label) => {
    $("setup-bar").style.width = `${(done / total) * 100}%`;
    $("setup-count").textContent = `${done} / ${total}`;
    if (label) $("setup-now").textContent = label;
  };
  tick("시작합니다…");

  // 인물별로 묶어서 순서 유지(기본 사진 → 표정 → 입 벌림), 3명씩 동시에 진행
  const chains = {};
  const chainKey = (j) => j.kind === "audio" ? "audio"
    : j.kind === "ending" && j.ending_id === "review" ? "ending:review" : `portrait:${j.scenario_id}`; // 사직서 장면은 그 인물 사진 뒤에
  for (const j of st.jobs) (chains[chainKey(j)] ||= []).push(j);
  const queue = Object.values(chains);
  const worker = async () => {
    while (queue.length) {
      const chain = queue.shift();
      for (const j of chain) {
        try {
          tick(`만드는 중: ${j.label}`);
          await api("/api/setup/job", { method: "POST", body: j });
          done += 1;
          setupLog(`✓ ${j.label}`);
        } catch (e) {
          done += 1;
          failed.push(j);
          setupLog(`✗ ${j.label} — ${e.message}`, true);
          if (j.kind === "portrait" && j.expr === "calm" && !j.talk) { done += chain.length - chain.indexOf(j) - 1; break; } // 기본 사진 실패 시 이 인물은 중단
        } finally { tick(); }
      }
      deps.refreshUsage();
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  setupRunning = false;
  $("btn-setup-later").textContent = "닫기";
  tick(failed.length ? `완료 (실패 ${failed.length}건 — 다시 누르면 빠진 것만 이어서 만듭니다)` : "완료!");
  $("btn-setup-run").disabled = false;
  $("btn-setup-run").textContent = failed.length ? "빠진 것 다시 만들기" : "모두 준비됨 · 닫기";
  $("btn-setup-run").dataset.mode = failed.length ? "run" : "close";
  await deps.loadScenarios();
  deps.refreshUsage();
  if (!failed.length) toast("준비 완료! assets/ 폴더를 GitHub에 커밋하면 다음부터는 재사용합니다.", 7000);
}

$("btn-setup-run").addEventListener("click", () => {
  if ($("btn-setup-run").dataset.mode === "close") $("setup-modal").close();
  else runSetup();
});
$("btn-setup-later").addEventListener("click", () => $("setup-modal").close());
$("btn-setup-open").addEventListener("click", () => { $("settings-modal").close(); checkSetup({ force: true }); });
