// 설정 → 🎙 ElevenLabs 고정 대사: 인물별 목소리를 고르고 고정 대사를 ElevenLabs 로 만든다.
// 키·인물별 목소리 선택은 이 브라우저(localStorage)에만 저장. 서버는 요청마다 헤더로 받은 키를 그 요청에만 쓴다.

import { api } from "../api.js";
import { playUrl } from "../audio/mic.js";

const $ = (id) => document.getElementById(id);
const LS_KEY = "maltoo.elevenKey";
const LS_VOICES = "maltoo.elevenVoices";
const ls = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let state = null;      // /api/eleven/status
let voices = [];       // 내 ElevenLabs 목소리 목록
let picks = {};        // 인물 id → voice_id
let stopFlag = false;
let running = false;
const openLines = new Set();

function key() { return $("eleven-key").value.trim(); }
const skipReact = () => $("eleven-skip-react").checked;
const isReact = (line) => line.startsWith("react_");
// 이번에 만들 대상 (추임새 건너뛰기 반영)
const targets = (c) => c.lines.filter((l) => !l.custom && !(skipReact() && isReact(l.line)));
const charsOf = (ls) => ls.reduce((a, l) => a + l.chars, 0);
function headers() { return { "X-ElevenLabs-Key": key() }; }
function err(msg) { $("eleven-error").textContent = msg || ""; $("eleven-error").hidden = !msg; }

async function load() {
  state = await api("/api/eleven/status");
  render();
}

function summary() {
  const all = state.characters;
  const done = all.reduce((a, c) => a + c.done, 0);
  const total = all.reduce((a, c) => a + c.total, 0);
  const chars = all.reduce((a, c) => a + charsOf(targets(c)), 0);
  $("eleven-summary").textContent = `모델 ${state.model} · ElevenLabs 음성 ${done}/${total}개 · 만들 대사 약 ${chars.toLocaleString()}자(≈ 크레딧)${skipReact() ? " · 추임새 제외" : ""}`;
}

function render() {
  summary();
  const opts = (sel) => `<option value="">${voices.length ? "목소리 선택" : "← 목소리 불러오기"}</option>` +
    voices.map((v) => `<option value="${esc(v.voice_id)}" ${v.voice_id === sel ? "selected" : ""}>${esc(v.name)}</option>`).join("");
  $("eleven-list").innerHTML = state.characters.map((c) => `
    <div class="ev-char" data-id="${c.id}">
      <div class="ev-head">
        <b>${esc(c.name)}</b>
        <select data-pick="${c.id}">${opts(picks[c.id])}</select>
        <span class="ev-count">${c.done}/${c.total}개 · 만들 ${targets(c).length}개 ${charsOf(targets(c))}자</span>
        <button type="button" class="btn" data-run="${c.id}">빠진 대사 만들기</button>
        <button type="button" class="btn btn-ghost" data-toggle="${c.id}">${openLines.has(c.id) ? "접기" : "대사 보기"}</button>
      </div>
      ${openLines.has(c.id) ? `<div class="ev-lines">${c.lines.map((l) => `
        <div class="ev-line ${l.custom ? "done" : ""}" data-line="${c.id}/${l.line}">
          <code>${esc(l.line)}</code>
          <div>${esc(l.text)}<div class="script">${esc(l.script)}</div></div>
          <div class="ev-btns">
            ${l.custom ? `<button type="button" data-play="${esc(l.url)}">▶</button>` : ""}
            <button type="button" data-one="${c.id}/${l.line}">${l.custom ? "↻ 다시" : "만들기"}</button>
          </div>
        </div>`).join("")}</div>` : ""}
    </div>`).join("");
}

async function makeLine(cid, line, force) {
  const voice_id = picks[cid];
  if (!voice_id) throw new Error(`${state.characters.find((c) => c.id === cid).name}의 목소리를 먼저 고르세요.`);
  const v = voices.find((x) => x.voice_id === voice_id) || {};
  const row = document.querySelector(`[data-line="${cid}/${line}"]`);
  row && row.classList.add("busy");
  try {
    return await api("/api/eleven/line", { method: "POST", headers: headers(),
      body: { scenario_id: cid, line, voice_id, voice_name: v.name || "", force } });
  } finally { row && row.classList.remove("busy"); }
}

async function runCharacter(cid) {
  if (running) return;
  if (!key()) { err("ElevenLabs API 키를 먼저 넣어 주세요."); return; }
  const c = state.characters.find((x) => x.id === cid);
  const todo = targets(c);
  if (!todo.length) { err(""); $("eleven-summary").textContent = `${c.name}: 모두 만들어져 있습니다.`; return; }
  running = true; stopFlag = false; err("");
  $("btn-eleven-stop").hidden = false;
  let n = 0;
  try {
    for (const l of todo) {
      if (stopFlag) break;
      $("eleven-summary").textContent = `${c.name} 만드는 중… ${n + 1}/${todo.length} · ${l.line} “${l.text}”`;
      await makeLine(cid, l.line, false);
      n++;
    }
  } catch (e) { err(e.message); }
  running = false;
  $("btn-eleven-stop").hidden = true;
  await load();
  if (!$("eleven-error").textContent) $("eleven-summary").textContent += ` · ${c.name} ${n}개 완료`;
}

export function initEleven() {
  $("eleven-key").value = ls.get(LS_KEY, "");
  try { picks = JSON.parse(ls.get(LS_VOICES, "{}")) || {}; } catch { picks = {}; }

  $("eleven-key").addEventListener("change", () => ls.set(LS_KEY, key()));
  $("eleven-skip-react").addEventListener("change", () => { if (state) render(); });
  $("btn-eleven-open").addEventListener("click", async () => {
    $("settings-modal").close();
    $("eleven-modal").showModal();
    err("");
    try { await load(); } catch (e) { err(e.message); }
    if (key() && !voices.length) $("btn-eleven-voices").click();
  });
  $("btn-eleven-close").addEventListener("click", () => { stopFlag = true; $("eleven-modal").close(); });
  $("btn-eleven-stop").addEventListener("click", () => { stopFlag = true; });
  $("btn-eleven-voices").addEventListener("click", async () => {
    if (!key()) { err("ElevenLabs API 키를 먼저 넣어 주세요."); return; }
    ls.set(LS_KEY, key());
    err("");
    try {
      voices = (await api("/api/eleven/voices", { headers: headers() })).voices;
      voices.sort((a, b) => (a.category === "premade") - (b.category === "premade") || a.name.localeCompare(b.name));
      render();
    } catch (e) { err(e.message); }
  });

  $("eleven-list").addEventListener("change", (e) => {
    const cid = e.target.dataset.pick;
    if (!cid) return;
    picks[cid] = e.target.value;
    ls.set(LS_VOICES, JSON.stringify(picks));
  });
  $("eleven-list").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.toggle) {
      openLines.has(b.dataset.toggle) ? openLines.delete(b.dataset.toggle) : openLines.add(b.dataset.toggle);
      render();
    } else if (b.dataset.run) {
      runCharacter(b.dataset.run);
    } else if (b.dataset.play) {
      playUrl(`${b.dataset.play}?t=${Date.now()}`).catch(() => {});
    } else if (b.dataset.one) {
      if (running) return;
      if (!key()) { err("ElevenLabs API 키를 먼저 넣어 주세요."); return; }
      const [cid, line] = b.dataset.one.split("/");
      running = true; err("");
      try {
        const r = await makeLine(cid, line, true);
        await load();
        playUrl(`${r.url}?t=${Date.now()}`).catch(() => {});
      } catch (er) { err(er.message); }
      running = false;
    }
  });
}
