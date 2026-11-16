// 목소리 톤 분석 (브라우저에서만 계산, 녹음 원본은 서버로 보내지 않음 — 음성 인식용 업로드 제외)
//
// 프레임(약 30ms)마다: 음량(dB), 음높이(YIN), 영교차율(숨소리 판별)
// 실시간: 체크포인트(🔊 언성 상승, 📈 목소리 높아짐, ⏩ 말 빨라짐, ⤵ 끝 억양 뚝, 💥 강세, 😮‍💨 한숨) + 톤 미터
// 발화 종료 후: 평소 목소리(baseline) 대비 요약 수치

export const DEFAULT_BASELINE = {
  measured: false,
  db_med: -28,     // 말할 때 평균 음량 (dBFS)
  db_p90: -22,
  pitch_med: 0,    // 0 이면 발화 앞부분으로 추정
  range_st: 6,     // 음높이 변화 폭 (반음)
  rate: 5.5,       // 초당 음절(근사)
};

const st = (hz, ref) => 12 * Math.log2(hz / ref);
const median = (a) => quantile(a, 0.5);
function quantile(arr, q) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const i = (a.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

// ---------- 프레임 분석 ----------

export function detectPitch(buf, sampleRate) {
  // 16kHz 근처로 다운샘플 후 YIN (70~400Hz)
  const d = Math.max(1, Math.round(sampleRate / 16000));
  const fs = sampleRate / d;
  const n = Math.floor(buf.length / d);
  const x = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < d; k++) s += buf[i * d + k];
    x[i] = s / d;
    mean += x[i];
  }
  mean /= n;
  for (let i = 0; i < n; i++) x[i] -= mean;

  const tMin = Math.floor(fs / 400);
  const tMax = Math.min(Math.floor(fs / 70), Math.floor(n / 2));
  const W = n - tMax;
  if (W <= 0) return 0;
  const diff = new Float32Array(tMax + 1);
  for (let tau = 1; tau <= tMax; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) {
      const v = x[j] - x[j + tau];
      s += v * v;
    }
    diff[tau] = s;
  }
  // 누적 평균 정규화
  const cm = new Float32Array(tMax + 1);
  cm[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tMax; tau++) {
    run += diff[tau];
    cm[tau] = run ? (diff[tau] * tau) / run : 1;
  }
  let tau = -1;
  for (let t = tMin; t <= tMax; t++) {
    if (cm[t] < 0.15) {
      while (t + 1 <= tMax && cm[t + 1] < cm[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return 0;
  // 포물선 보간
  const a = cm[tau - 1] ?? cm[tau], b = cm[tau], c = cm[tau + 1] ?? cm[tau];
  const den = a + c - 2 * b;
  const shift = den ? (a - c) / (2 * den) : 0;
  return fs / (tau + shift);
}

export function analyzeFrame(buf, sampleRate) {
  let sum = 0, zc = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i] * buf[i];
    if (i && (buf[i] >= 0) !== (buf[i - 1] >= 0)) zc++;
  }
  const rms = Math.sqrt(sum / buf.length);
  const db = 20 * Math.log10(rms + 1e-9);
  const pitch = rms > 0.006 ? detectPitch(buf, sampleRate) : 0;
  return { rms, db, zcr: zc / buf.length, pitch };
}

// ---------- 음절(근사) 세기 ----------

function syllablePeaks(frames) {
  // 유성 구간 음량 봉우리 = 음절 핵 근사
  const peaks = [];
  for (let i = 2; i < frames.length - 2; i++) {
    const f = frames[i];
    if (!f.voiced) continue;
    const s = (k) => frames[k].db;
    const v = (s(i - 1) + s(i) + s(i + 1)) / 3;
    if (s(i) < s(i - 1) || s(i) < s(i + 1) || s(i) < s(i - 2) || s(i) < s(i + 2)) continue;
    let low = Infinity;
    for (let k = Math.max(0, i - 5); k <= Math.min(frames.length - 1, i + 5); k++) low = Math.min(low, frames[k].db);
    if (v - low < 3) continue;
    if (peaks.length && f.t - peaks[peaks.length - 1] < 110) continue;
    peaks.push(f.t);
  }
  return peaks;
}

function speakingSeconds(frames) {
  // 300ms 넘는 쉼은 빼고 말한 시간
  let ms = 0;
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].t - frames[i - 1].t;
    if (frames[i].loud || frames[i - 1].loud) ms += Math.min(dt, 300);
  }
  return ms / 1000;
}

function slopeStPerSec(pts) {
  // 최소제곱 기울기 (반음/초)
  if (pts.length < 4) return 0;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.t, 0) / n;
  const my = pts.reduce((s, p) => s + p.st, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.t - mx) * (p.st - my); den += (p.t - mx) ** 2; }
  return den ? (num / den) * 1000 : 0;
}

export function endCategory(slope) {
  if (slope < -10) return "falling_sharp";
  if (slope < -3) return "falling";
  if (slope > 4) return "rising";
  return "flat";
}

// ---------- 평소 목소리 ----------

export function computeBaseline(frames) {
  const V = frames.filter((f) => f.voiced);
  if (V.length < 60) return null; // 유성 2초 미만이면 측정 실패
  const hz = V.map((f) => f.pitch).filter((p) => p > 0);
  const pm = median(hz);
  const sts = hz.map((h) => st(h, pm)).filter((v) => Math.abs(v) <= 9); // 옥타브 오인식 제외
  const peaks = syllablePeaks(frames);
  const secs = speakingSeconds(frames);
  return {
    measured: true,
    db_med: +median(V.map((f) => f.db)).toFixed(1),
    db_p90: +quantile(V.map((f) => f.db), 0.9).toFixed(1),
    pitch_med: +pm.toFixed(1),
    range_st: +Math.max(2, quantile(sts, 0.9) - quantile(sts, 0.1)).toFixed(2),
    rate: +(secs ? Math.max(2.5, Math.min(9, peaks.length / secs)) : 5.5).toFixed(2),
    voiced_seconds: +(V.length * 0.03).toFixed(1),
  };
}

// ---------- 발화 추적 ----------

const CP = {
  loud: { icon: "🔊", label: "언성 상승" },
  high: { icon: "📈", label: "목소리 높아짐" },
  fast: { icon: "⏩", label: "말 빨라짐" },
  fall: { icon: "⤵", label: "끝 억양 뚝" },
  stress: { icon: "💥", label: "강하게 힘줌" },
  sigh: { icon: "😮‍💨", label: "한숨" },
};
export const CHECKPOINT_TYPES = CP;

export class ToneTracker {
  constructor(baseline, { threshold = 0.02, onCheckpoint } = {}) {
    this.b = { ...DEFAULT_BASELINE, ...(baseline || {}) };
    this.threshold = threshold;
    this.onCheckpoint = onCheckpoint;
    this.frames = [];
    this.checkpoints = [];
    this.lastCp = {};
    this.run = { unvoiced: 0, breath: 0, voicedRun: 0 };
    this.pitchRef = this.b.pitch_med || 0;
    this.speechStart = null;
    this.phrases = []; // 쉼마다 끝 억양 기울기
  }

  push(frame, t) {
    const loud = frame.rms > this.threshold;
    const voiced = loud && frame.pitch > 0;
    const f = { ...frame, t, loud, voiced, st: 0 };
    if (voiced && !this.pitchRef) {
      // 평소 목소리 미측정: 첫 1초 유성음으로 기준 추정
      const early = this.frames.filter((x) => x.voiced).map((x) => x.pitch);
      if (early.length >= 30) this.pitchRef = median(early);
    }
    if (voiced && this.pitchRef) {
      f.st = st(frame.pitch, this.pitchRef);
      const recent = this.frames.filter((x) => x.voiced).slice(-15).map((x) => x.st);
      if (recent.length >= 8 && Math.abs(f.st - median(recent)) > 9) { f.voiced = false; f.st = 0; } // 옥타브 오인식
    }
    if (loud && this.speechStart == null) this.speechStart = t;
    this.frames.push(f);
    if (this.speechStart != null) this.detect(f);
    return f;
  }

  cp(type, t, note) {
    const gap = { loud: 1200, high: 1500, fast: 3000, fall: 1200, stress: 900, sigh: 2000 }[type];
    if (this.lastCp[type] != null && t - this.lastCp[type] < gap) return;
    this.lastCp[type] = t;
    const c = { type, t, icon: CP[type].icon, label: CP[type].label, note };
    this.checkpoints.push(c);
    this.onCheckpoint && this.onCheckpoint(c);
  }

  detect(f) {
    const b = this.b, r = this.run;
    // 🔊 언성 상승: 최근 300ms 중 120ms 이상이 평소 상위 10% 음량보다 4dB 넘게 큼 (음절 사이 끊김에 강하게)
    const w300 = this.frames.filter((x) => x.t > f.t - 300);
    const loudN = w300.filter((x) => x.db > b.db_p90 + 4).length;
    if (loudN >= 4) this.cp("loud", f.t, `평소보다 약 ${Math.round(f.db - b.db_med)}dB 크게 말했습니다.`);

    // 📈 목소리 높아짐: 최근 400ms 유성음의 70% 이상이 평소보다 4.5반음 넘게 높음
    if (this.pitchRef) {
      const v400 = this.frames.filter((x) => x.voiced && x.t > f.t - 400);
      const hi = v400.filter((x) => x.st > 4.5).length;
      if (v400.length >= 6 && hi / v400.length >= 0.7) {
        const m = median(v400.map((x) => x.st));
        this.cp("high", f.t, `목소리가 평소보다 약 ${Math.round(m)}반음 높아졌습니다. 격앙된 것처럼 들릴 수 있습니다.`);
      }
    }

    // 💥 강세: 직전 1초 평균보다 음량 +6dB, 음높이 +3반음
    const recent = this.frames.filter((x) => x.voiced && x.t > f.t - 1000 && x.t < f.t);
    if (f.voiced && recent.length > 10) {
      const mdb = recent.reduce((s, x) => s + x.db, 0) / recent.length;
      const mst = median(recent.map((x) => x.st));
      if (f.db > mdb + 6 && f.st > mst + 3) this.cp("stress", f.t, "특정 단어에 힘을 세게 줬습니다. 따지거나 비꼬는 것처럼 들릴 수 있습니다.");
    }

    // ⏩ 말 빨라짐: 최근 2.5초 음절 속도가 평소의 1.35배 이상
    if (f.t - this.speechStart > 2500 && this.frames.length % 5 === 0) {
      const win = this.frames.filter((x) => x.t > f.t - 2500);
      const secs = speakingSeconds(win);
      if (secs > 1.2) {
        const rate = syllablePeaks(win).length / secs;
        if (rate > b.rate * 1.25) this.cp("fast", f.t, `말이 평소보다 약 ${(rate / b.rate).toFixed(1)}배 빨라졌습니다. 방어적·다급하게 들릴 수 있습니다.`);
      }
    }

    // 😮‍💨 한숨: 음높이 없는 숨소리(영교차율 높음)가 0.25~1초
    const breathy = f.loud && !f.voiced && f.zcr > 0.12;
    if (breathy) r.breath += 1;
    else {
      if (r.breath >= 8 && r.breath <= 34) this.cp("sigh", f.t, "한숨처럼 들리는 숨소리가 있었습니다. 짜증이나 무시로 받아들여질 수 있습니다.");
      r.breath = 0;
    }

    // ⤵ 끝 억양: 600ms 이상 말한 뒤 350ms 쉬면 마지막 350ms 음높이 기울기 확인
    if (f.voiced) { r.voicedRun += 1; r.unvoiced = 0; } else r.unvoiced += 1;
    if (r.unvoiced === 12 && r.voicedRun >= 20) {
      const tail = this.frames.filter((x) => x.voiced && x.t <= f.t).slice(-12);
      const slope = slopeStPerSec(tail);
      const cat = endCategory(slope);
      this.phrases.push({ t: tail.length ? tail[tail.length - 1].t : f.t, slope, cat });
      if (cat === "falling_sharp") this.cp("fall", tail.length ? tail[tail.length - 1].t : f.t,
        "문장 끝이 뚝 떨어졌습니다. 단정하거나 명령하는 말투로 들릴 수 있습니다.");
      r.voicedRun = 0;
    }
  }

  // 톤 미터용: 최근 2.5초
  live(nowT) {
    const win = this.frames.filter((x) => x.t > nowT - 2500);
    return scores(win, this.b, this.phrases.slice(-1)[0]?.cat, this.checkpoints.filter((c) => c.t > nowT - 4000));
  }

  summary({ latency_s = 0, nag = 0 } = {}) {
    const speech = this.frames.filter((x) => this.speechStart != null && x.t >= this.speechStart);
    const V = speech.filter((x) => x.voiced);
    const b = this.b;
    const secs = speakingSeconds(speech);
    const rate = secs ? syllablePeaks(speech).length / secs : 0;
    const sts = V.map((x) => x.st);
    const range = sts.length > 10 ? quantile(sts, 0.9) - quantile(sts, 0.1) : b.range_st;
    const last = this.phrases.slice(-1)[0];
    const count = (type) => this.checkpoints.filter((c) => c.type === type).length;
    const sc = scores(speech, b, last && last.cat, this.checkpoints);
    return {
      has_baseline: !!b.measured,
      speech_s: +secs.toFixed(1),
      latency_s: +latency_s.toFixed(1),
      nag,
      loud_db: V.length ? +(median(V.map((x) => x.db)) - b.db_med).toFixed(1) : 0,
      pitch_shift_st: V.length && b.measured && b.pitch_med ? +median(sts).toFixed(1) : 0,
      range_ratio: +(range / b.range_st).toFixed(2),
      rate_ratio: rate ? +(rate / b.rate).toFixed(2) : 1,
      end: last ? last.cat : "flat",
      end_slope: last ? +last.slope.toFixed(1) : 0,
      loud_n: count("loud"), high_n: count("high"), fast_n: count("fast"),
      fall_n: count("fall"), stress_n: count("stress"), sigh_n: count("sigh"),
      arousal: sc.arousal,
      warmth: sc.warmth,
      checkpoints: this.checkpoints.map(({ type, t, note }) => ({ type, t: +((t - this.speechStart) / 1000).toFixed(1), note })),
    };
  }
}

// 차분(0)↔격앙(100), 차가움(0)↔따뜻함(100)
function scores(frames, b, endCat, cps) {
  const V = frames.filter((x) => x.voiced);
  if (V.length < 5) return { arousal: 50, warmth: 50 };
  const loudDb = median(V.map((x) => x.db)) - b.db_med;
  const shift = median(V.map((x) => x.st));
  const sts = V.map((x) => x.st);
  const range = sts.length > 10 ? quantile(sts, 0.9) - quantile(sts, 0.1) : b.range_st;
  const secs = speakingSeconds(frames);
  const rateRatio = secs > 0.8 ? (syllablePeaks(frames).length / secs) / b.rate : 1;
  const n = (t) => cps.filter((c) => c.type === t).length;
  const arousal = 50 + 5 * loudDb + 4 * shift + 35 * (rateRatio - 1) + 6 * n("loud") + 5 * n("high");
  let warmth = 55 + 20 * (range / b.range_st - 1) - 6 * n("stress") - 10 * n("sigh") - 8 * n("fall");
  if (endCat === "rising") warmth += 10;
  if (endCat === "falling_sharp") warmth -= 12;
  if (loudDb > 4) warmth -= 8;
  return { arousal: Math.round(clamp(arousal)), warmth: Math.round(clamp(warmth)) };
}
