// 대화 한 판의 상태 머신
// 상대 말함 → 3초 카운트(최대 재촉 2회) → 녹음 → 음성 인식 → 상대 응답 → … → 결말

import { api, sessionId } from "./api.js";
import { playUrl } from "./audio/mic.js";

class Stopped extends Error {}

export class Conversation {
  constructor(scenario, { mic, ui }) {
    this.s = scenario;
    this.mic = mic;
    this.ui = ui;
    this.history = [];
    this.stopped = false;
    this.lastResult = null;
  }

  stop() { this.stopped = true; }

  guard() { if (this.stopped) throw new Stopped(); }

  // 고정 대사(첫마디·재촉): 저장된 음성 재생, 실패하면 글자로
  async speakFixed(line) {
    const text = this.s.lines[line];
    let r = null;
    try {
      r = await api(`/api/tts/line/${this.s.id}/${line}`);
    } catch (e) {
      if (e.status === 401) throw e;
      this.ui.ttsFailed(e);
    }
    this.guard();
    this.history.push({ speaker: "npc", text });
    await this.deliver(text, r && r.url);
  }

  // 실시간 대사: 음성 생성, 실패하면 글자로
  async speakSay(text) {
    this.ui.status("npc-wait");
    let r = null;
    try {
      r = await api("/api/tts/say", { method: "POST", body: { scenario_id: this.s.id, text } });
    } catch (e) {
      if (e.status === 401) throw e;
      this.ui.ttsFailed(e);
    }
    this.guard();
    await this.deliver(text, r && r.url);
  }

  async deliver(text, url) {
    this.ui.status("npc");
    if (url) {
      this.ui.npcSays(text);
      try {
        await playUrl(url, { onTick: (t) => this.ui.npcTick(t) });
        this.ui.refreshUsage();
        this.guard();
        return;
      } catch (e) {
        this.ui.ttsFailed(e);
      }
    }
    // 음성 없이: 글자를 읽을 시간만큼 기다린 뒤 진행 (한국어 약 초당 9자)
    this.ui.status("npc-text");
    this.ui.npcSays(text, { muted: true });
    const ms = Math.min(7000, Math.max(1500, 400 + text.length * 110));
    await new Promise((res) => setTimeout(res, ms));
    this.ui.npcTick({ level: 0, ended: true });
    this.guard();
  }

  async run() {
    try {
      await this.speakFixed("opening");
      for (;;) {
        // 1) 3초 안에 대답 (재촉 최대 2회)
        let nag = 0;
        let rec;
        for (;;) {
          this.ui.status("listen");
          rec = await this.mic.listen({ onTick: (t) => this.ui.listenTick(t) });
          this.guard();
          if (rec.spoke) break;
          nag += 1;
          if (nag > 2) {
            const last = this.lastResult || {};
            return this.finish({ ...last, ending: "fail", reason: "끝까지 대답하지 않았습니다 (응답 회피).",
                                 goal_progress: last.goal_progress || 0, checklist_done: last.checklist_done || [],
                                 noResponse: true });
          }
          this.ui.nagged(nag);
          await this.speakFixed(`nag${nag}`);
        }

        // 2) 음성 인식
        this.ui.status("analyze");
        const fd = new FormData();
        fd.append("audio", rec.blob, "answer.webm");
        fd.append("seconds", String(rec.seconds || 0));
        const tr = await upload("/api/transcribe", fd);
        this.guard();
        const myText = tr.text || "";
        this.ui.meSays(myText || "(알아듣지 못함)", { nag, seconds: rec.seconds });
        this.ui.refreshUsage();

        // 3) 상대 응답 + 판정
        const prior = this.history.slice();
        this.history.push({ speaker: "me", text: myText });
        const r = await api("/api/turn", {
          method: "POST",
          body: { scenario_id: this.s.id, history: prior, user_text: myText, nag_count: nag },
        });
        this.guard();
        this.lastResult = r;
        this.ui.turnResult(r);
        this.history.push({ speaker: "npc", text: r.reply });
        await this.speakSay(r.reply);
        if (r.ending) return this.finish(r);
      }
    } catch (e) {
      if (e instanceof Stopped) return;
      this.ui.error(e);
    }
  }

  finish(r) {
    this.ui.end({ ...r, history: this.history });
  }
}

async function upload(path, formData) {
  const { keyStore } = await import("./api.js");
  const res = await fetch(path, {
    method: "POST",
    headers: { "X-OpenAI-Key": keyStore.get(), "X-Session-Id": sessionId },
    body: formData,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 무시 */ }
  if (!res.ok) {
    const err = new Error((data && data.detail && data.detail.message) || `요청 실패 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
