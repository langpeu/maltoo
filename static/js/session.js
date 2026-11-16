// 대화 한 판의 상태 머신
// 상대 말함 → 3초 카운트(최대 재촉 2회) → 녹음 → 음성 인식 → 상대 응답 → … → 결말

import { api, sessionId } from "./api.js";
import { playUrl } from "./audio/mic.js";
import { analyzeFrame, ToneTracker } from "./audio/tone.js";
import { exprFromEmotion } from "./ui/portrait.js";
import { fxFor } from "./audio/voicefx.js";

const ENDING_MOOD = { success: "softened", partial: "calm", fail: "angry", noresp: "angry", resign: "resigned", resigned: "resigned" };

class Stopped extends Error {}

export class Conversation {
  constructor(scenario, { mic, ui, baseline = null, face = null, difficulty = "normal", answerMs = 3000,
                          sessionId = "", openingLine = "opening", startAnger = 40 }) {
    this.s = scenario;
    this.face = face; // { cam, tracker } | null
    this.difficulty = difficulty;
    this.answerMs = answerMs;
    this.startedAt = new Date().toISOString();
    this.sessionId = sessionId;
    this.openingLine = openingLine;               // 소문이 퍼졌으면 rumor_<n>
    this.prevEmotion = { anger: startAnger, trust: 50 };
    this.gameSession = { cut: 0, recovered: 0 };   // 이번 판 연봉 감액·회복 누적
    this.mentions = [];
    this.baseline = baseline;
    this.mic = mic;
    this.ui = ui;
    this.history = [];
    this.stopped = false;
    this.lastResult = null;
    this.mood = scenario.reaction_start || "neutral";  // 추임새 그룹: angry | neutral | soft
    this.lastReaction = null;
  }

  // 감정 수치 → 추임새 그룹
  static moodOf(e) {
    if (!e) return "neutral";
    if (e.anger >= 55 || e.defensiveness >= 70) return "angry";
    if (e.trust >= 60 && e.anger < 40) return "soft";
    return "neutral";
  }

  // 추임새: 내 말이 끝나자마자 바로 재생 (저장된 음성이 있을 때만, 실패해도 무시)
  async react() {
    const ids = Object.keys(this.s.lines).filter((k) => k.startsWith(`react_${this.mood}_`) && k !== this.lastReaction);
    if (!ids.length) return;
    const id = ids[Math.floor(Math.random() * ids.length)];
    this.lastReaction = id;
    try {
      const r = await api(`/api/tts/line/${this.s.id}/${id}?cached_only=true`);
      if (this.stopped) return;
      this.phase("listen");
      this.ui.npcReact(r.text);
      await playUrl(r.url, { onTick: (t) => this.ui.npcTick(t), fx: fxFor(r.mood) });
    } catch { /* 추임새는 없어도 진행 */ }
  }

  // 결말 대사 (없으면 GPT가 만든 대사를 실시간 음성으로)
  async speakEnding(kind, fallbackText) {
    const line = `end_${kind}`;
    if (this.s.lines[line]) return this.speakFixed(line);
    if (fallbackText) {
      this.history.push({ speaker: "npc", text: fallbackText });
      return this.speakSay(fallbackText, ENDING_MOOD[kind] || "calm");
    }
  }

  stop() { this.stopped = true; }

  phase(p) { if (this.face) this.face.cam.phase = p; }

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
    await this.deliver(text, r && r.url, r && r.mood);
  }

  // 실시간 대사: 음성 생성, 실패하면 글자로
  // mood: 상대의 현재 감정 → 목소리에 실림 (기본: 마지막 턴 감정으로 계산한 표정과 같은 단계)
  async speakSay(text, mood) {
    this.ui.status("npc-wait");
    mood = mood || exprFromEmotion(this.lastEmotion);
    let r = null;
    try {
      r = await api("/api/tts/say", { method: "POST", body: { scenario_id: this.s.id, text, mood } });
    } catch (e) {
      if (e.status === 401) throw e;
      this.ui.ttsFailed(e);
    }
    this.guard();
    await this.deliver(text, r && r.url, r ? r.mood : mood);
  }

  async deliver(text, url, mood) {
    this.phase("listen");
    this.ui.status("npc");
    if (url) {
      this.ui.npcSays(text);
      try {
        await playUrl(url, { onTick: (t) => this.ui.npcTick(t), fx: fxFor(mood) });
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
      if (this.face) this.face.tracker.beginTurn();
      await this.speakFixed(this.openingLine);
      for (;;) {
        // 1) 3초 안에 대답 (재촉 최대 2회)
        let nag = 0;
        let rec, tracker;
        const turnAudio = { blob: null }; // 체크포인트 핀에서 "이 구간 듣기"용
        for (;;) {
          this.ui.status("listen");
          this.phase("silence");
          tracker = new ToneTracker(this.baseline, {
            threshold: this.mic.threshold,
            onCheckpoint: (c) => this.ui.toneCheckpoint(c, { ref: turnAudio, t: c.t / 1000 }),
          });
          let lastLive = 0;
          rec = await this.mic.listen({
            startTimeoutMs: this.answerMs,
            onTick: (t) => {
              if (t.spoke) this.phase("speak");
              const f = tracker.push(analyzeFrame(t.buf, t.sampleRate), t.elapsed);
              this.ui.listenTick({ ...t, st: f.voiced && tracker.pitchRef ? f.st : null,
                                   hot: f.db > tracker.b.db_p90 + 4 });
              if (t.spoke && t.elapsed - lastLive > 150) {
                lastLive = t.elapsed;
                this.ui.toneLive(tracker.live(t.elapsed));
              }
            },
          });
          this.guard();
          if (rec.spoke) break;
          nag += 1;
          if (nag > 2) {
            const last = this.lastResult || {};
            await this.speakEnding("noresp");
            this.noResponse = true;
            return this.finish({ ...last, ending: "fail", reason: "끝까지 대답하지 않았습니다 (응답 회피).",
                                 goal_progress: last.goal_progress || 0, checklist_done: last.checklist_done || [],
                                 noResponse: true });
          }
          this.ui.nagged(nag);
          await this.speakFixed(`nag${nag}`);
        }

        // 2) 음성 인식 (동시에 상대 추임새를 바로 재생해서 공백을 없앰)
        this.phase("idle");
        const face = this.face ? this.face.tracker.summary() : null;
        if (this.face) this.face.tracker.beginTurn();
        this.ui.status("analyze");
        const reacting = this.react();
        const fd = new FormData();
        fd.append("audio", rec.blob, "answer.webm");
        fd.append("seconds", String(rec.seconds || 0));
        const tr = await upload("/api/transcribe", fd);
        this.guard();
        const myText = tr.text || "";
        turnAudio.blob = rec.blob;
        const tone = tracker.summary({ latency_s: (tracker.speechStart || 0) / 1000, nag });
        this.ui.toneLive({ arousal: tone.arousal, warmth: tone.warmth });
        const myLog = this.ui.meSays(myText || "(알아듣지 못함)", { nag, seconds: rec.seconds, tone, face });
        this.ui.refreshUsage();

        // 3) 상대 응답 + 판정
        const prior = this.history.map(({ speaker, text }) => ({ speaker, text }));
        const meEntry = { speaker: "me", text: myText, tone, face };
        this.history.push(meEntry);
        const r = await api("/api/turn", {
          method: "POST",
          body: { scenario_id: this.s.id, history: prior, user_text: myText, nag_count: nag, tone, face,
                  difficulty: this.difficulty, session_id: this.sessionId,
                  goal_done: (this.lastResult && this.lastResult.checklist_done) || [],
                  goal_progress: (this.lastResult && this.lastResult.goal_progress) || 0,
                  prev_emotion: this.prevEmotion, game_session: this.gameSession },
        });
        this.guard();
        await reacting;
        this.guard();
        this.lastResult = r;
        console.info("[목표]", r.goal_progress, r.checklist_done, r.goal_debug);
        meEntry.checkpoints = r.checkpoints || [];
        this.prevEmotion = { anger: r.emotion.anger, trust: r.emotion.trust };
        this.lastEmotion = r.emotion;
        if (r.game) {
          this.gameSession = r.game.session || this.gameSession;
          this.mentions.push(...(r.game.mentions || []));
          this.ui.gameUpdate(r.game);
        }
        this.mood = Conversation.moodOf(r.emotion);
        this.ui.turnResult(r, myLog);
        if (r.ending) {
          await this.speakEnding(r.ending === "team_quit" ? "partial" : r.ending, r.reply);
          return this.finish(r);
        }
        this.history.push({ speaker: "npc", text: r.reply });
        await this.speakSay(r.reply);
      }
    } catch (e) {
      if (e instanceof Stopped) return;
      this.ui.error(e);
    }
  }

  finish(r) {
    this.ui.end({ ...r, history: this.history, startedAt: this.startedAt, difficulty: this.difficulty,
                  gameSession: this.gameSession, mentions: this.mentions,
                  worldEnding: this.noResponse ? "noresp" : r.ending });
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
