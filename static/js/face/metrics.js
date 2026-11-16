// 표정 지표 계산 (순수 로직, MediaPipe 결과를 받아 처리 — 테스트 가능하도록 분리)
//
// 입력 프레임: { t(ms), phase, bs: {블렌드셰이프 이름: 0~1}, lm: {eyeL, eyeR, nose, chin} | null }
// phase: "listen"(상대가 말하는 중) | "silence"(3초 카운트) | "speak"(내가 말하는 중) | "idle"
// 영상은 어디에도 보내지 않는다. 수치 요약만 서버로 간다.

export const DEFAULT_FACE_BASELINE = {
  measured: false,
  brow: 0.12, frown: 0.06, press: 0.12, smile: 0.12, asym: 0.05, nose_ratio: 0, blink_per_min: 17,
};

export const PHASE_LABEL = { listen: "상대가 말하는 동안", silence: "대답을 기다리는 3초 동안", speak: "내가 말하는 동안", idle: "" };

const avg = (a, b) => (a + b) / 2;
const median = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function frameMetrics(bs, lm) {
  const g = (k) => bs[k] || 0;
  const m = {
    brow: avg(g("browDownLeft"), g("browDownRight")),
    frown: avg(g("mouthFrownLeft"), g("mouthFrownRight")),
    press: avg(g("mouthPressLeft"), g("mouthPressRight")),
    smileL: g("mouthSmileLeft"),
    smileR: g("mouthSmileRight"),
    blink: avg(g("eyeBlinkLeft"), g("eyeBlinkRight")),
    lookUp: avg(g("eyeLookUpLeft"), g("eyeLookUpRight")),
    lookDown: avg(g("eyeLookDownLeft"), g("eyeLookDownRight")),
    // 두 눈이 같은 방향을 볼 때만 (왼눈 바깥+오른눈 안쪽 = 한쪽, 반대 = 다른 쪽)
    lookSide: Math.max(avg(g("eyeLookOutLeft"), g("eyeLookInRight")), avg(g("eyeLookInLeft"), g("eyeLookOutRight"))),
    noseRatio: 0,
    yaw: 0,
  };
  m.smile = avg(m.smileL, m.smileR);
  m.asym = Math.abs(m.smileL - m.smileR);
  if (lm) {
    const eyeY = avg(lm.eyeL.y, lm.eyeR.y);
    const faceH = lm.chin.y - eyeY;
    if (faceH > 0) m.noseRatio = (lm.nose.y - eyeY) / faceH;  // 턱을 들면 작아짐
    const eyeW = lm.eyeR.x - lm.eyeL.x;
    if (eyeW) m.yaw = (lm.nose.x - lm.eyeL.x) / eyeW - 0.5;    // 고개를 돌리면 0에서 멀어짐
  }
  return m;
}

export const CP = {
  frown: { icon: "😠", label: "미간 찌푸림", note: "미간을 찌푸렸습니다. 불만이나 공격성으로 읽힐 수 있습니다." },
  roll: { icon: "🙄", label: "눈 굴림", note: "눈을 위로 굴렸습니다. 상대는 무시당했다고 느낍니다." },
  away: { icon: "👀", label: "시선 회피", note: "시선을 피했습니다. 회피하거나 자신 없어 보일 수 있습니다." },
  smirk: { icon: "😏", label: "비웃음", note: "한쪽 입꼬리만 올라갔습니다. 비웃는 것처럼 보일 수 있습니다." },
  press: { icon: "😤", label: "입술 꽉", note: "입술을 꽉 다물었습니다. 억누른 분노처럼 보입니다." },
  mouthdown: { icon: "😒", label: "입꼬리 내림", note: "입꼬리가 내려갔습니다. 불쾌한 기색으로 보입니다." },
  chinup: { icon: "⬆️", label: "턱 듦", note: "턱을 들었습니다. 거만하거나 내려다보는 것처럼 보일 수 있습니다." },
};
export const FACE_CHECKPOINTS = CP;

const SEVERITY_W = { roll: 1.0, smirk: 0.95, frown: 0.85, chinup: 0.8, press: 0.75, mouthdown: 0.7, away: 0.6 };

export class FaceTracker {
  constructor(baseline, { onCheckpoint, onWorse } = {}) {
    this.b = { ...DEFAULT_FACE_BASELINE, ...(baseline || {}) };
    this.onCheckpoint = onCheckpoint;
    this.onWorse = onWorse;      // 지금까지 중 가장 안 좋은 프레임이 갱신될 때 (사진 캡처용)
    this.worst = { score: -1, t: -1e9 };
    this.frames = [];     // 이번 턴 프레임
    this.all = [];        // 기준선 계산용(측정 화면)
    this.checkpoints = [];
    this.lastCp = {};
    this.run = {};
    this.roll = { upSince: null, armed: false };
    this.lastBlink = false;
    this.blinks = [];
  }

  beginTurn() {
    this.frames = [];
    this.checkpoints = [];
    this.blinks = [];
  }

  push({ t, phase = "idle", bs, lm }) {
    if (!bs) {
      const f = { t, phase, face: false };
      this.frames.push(f);
      return f;
    }
    const m = frameMetrics(bs, lm);
    if (!this.b.nose_ratio && m.noseRatio) {
      // 기준 미측정: 처음 1초로 추정
      const early = this.frames.filter((x) => x.face && x.m.noseRatio).map((x) => x.m.noseRatio);
      if (early.length >= 10) this.b.nose_ratio = median(early);
    }
    const f = { t, phase, face: true, m, flags: this.flags(m) };
    this.frames.push(f);
    this.all.push(f);
    if (phase !== "idle") {
      this.detect(f);
      const w = this.badness(f);
      // 첫 얼굴 프레임은 무조건 남기고(표정이 무난했던 대화도 내 사진이 있도록), 이후 더 나쁜 순간이 오면 교체
      const first = this.worst.score < 0;
      if (first || (w.type && w.score > this.worst.score + 2 && t - this.worst.t > 300)) {
        this.worst = { ...w, type: w.type || "neutral", score: Math.max(0, w.score), t, phase };
        this.onWorse && this.onWorse(this.worst);
      }
    }
    return f;
  }

  flags(m) {
    const b = this.b;
    const blinking = m.blink > 0.5;
    return {
      blinking,
      frown: m.brow > b.brow + 0.25,
      mouthdown: m.frown > b.frown + 0.25,
      press: m.press > b.press + 0.3,
      smirk: m.asym > Math.max(0.25, b.asym + 0.2) && Math.max(m.smileL, m.smileR) > 0.3,
      away: !blinking && (m.lookSide > 0.5 || m.lookDown > 0.55 || Math.abs(m.yaw) > 0.15),
      up: !blinking && m.lookUp > 0.5,
      chinup: !!(b.nose_ratio && m.noseRatio && m.noseRatio < b.nose_ratio * 0.82),
    };
  }

  // 체크포인트 심각도 0~100: 표정 종류의 무게(상대가 느끼는 불쾌감) × 그 순간 평소 대비 강도.
  // 결과 화면에서 '가장 안 좋았던 표정' 사진을 고를 때 쓴다.
  // 그 순간 표정 종류별 강도 0~1 (평소 대비)
  intensity(type, m) {
    const b = this.b;
    const over = (v, base, span) => Math.max(0, Math.min(1, ((v || 0) - (base || 0)) / span));
    return {
      frown: over(m.brow, b.brow, 0.6),
      mouthdown: over(m.frown, b.frown, 0.6),
      press: over(m.press, b.press, 0.6),
      smirk: Math.max(m.smileL || 0, m.smileR || 0) > 0.2 ? over(m.asym, b.asym, 0.5) : 0,
      away: Math.max(over(m.lookSide, 0.2, 0.8), over(m.lookDown, 0.25, 0.75), over(Math.abs(m.yaw || 0), 0.05, 0.35)),
      chinup: b.nose_ratio && m.noseRatio ? over(b.nose_ratio - m.noseRatio, 0, b.nose_ratio * 0.4) : 0,
      roll: 0.8,
    }[type] ?? 0;
  }

  severity(type, f) {
    const k = type === "roll" ? 0.8 : this.intensity(type, f.m || {});
    return Math.round((SEVERITY_W[type] || 0.5) * (60 + 40 * k));
  }

  // 체크포인트가 없어도 '가장 안 좋았던 순간'을 고르기 위한 프레임 점수 0~100 (체크포인트 점수보다 항상 낮게)
  badness(f) {
    let best = { type: null, score: 0 };
    for (const type of ["frown", "mouthdown", "press", "smirk", "away", "chinup"]) {
      const s = Math.round((SEVERITY_W[type] || 0.5) * 60 * this.intensity(type, f.m));
      if (s > best.score) best = { type, score: s };
    }
    return best;
  }

  cp(type, f) {
    const gap = { frown: 3000, roll: 1500, away: 4000, smirk: 3000, press: 3000, mouthdown: 3000, chinup: 4000 }[type];
    if (this.lastCp[type] != null && f.t - this.lastCp[type] < gap) return;
    this.lastCp[type] = f.t;
    const where = PHASE_LABEL[f.phase];
    const c = { type, t: f.t, phase: f.phase, icon: CP[type].icon, label: CP[type].label,
                severity: this.severity(type, f),
                note: (where ? `${where} ` : "") + CP[type].note };
    this.checkpoints.push(c);
    this.onCheckpoint && this.onCheckpoint(c);
  }

  // 최근 ms 동안 flag 비율
  ratio(flag, ms, now) {
    const w = this.frames.filter((x) => x.face && x.t > now - ms);
    if (w.length < 4) return 0;
    return w.filter((x) => x.flags[flag]).length / w.length;
  }

  detect(f) {
    const fl = f.flags;
    // 지속형: 최근 구간 대부분에서 나타나면
    if (fl.frown && this.ratio("frown", 1000, f.t) >= 0.8) this.cp("frown", f);
    if (fl.press && this.ratio("press", 1000, f.t) >= 0.8) this.cp("press", f);
    if (fl.mouthdown && this.ratio("mouthdown", 1000, f.t) >= 0.8) this.cp("mouthdown", f);
    if (fl.smirk && this.ratio("smirk", 400, f.t) >= 0.75) this.cp("smirk", f);
    if (fl.away && this.ratio("away", 2000, f.t) >= 0.7) this.cp("away", f);
    if (fl.chinup && this.ratio("chinup", 1000, f.t) >= 0.8) this.cp("chinup", f);

    // 눈 굴림: 위를 250ms 이상 보다가 2초 안에 돌아옴
    const r = this.roll;
    if (fl.up) {
      if (r.upSince == null) r.upSince = f.t;
      if (f.t - r.upSince >= 250) r.armed = true;
    } else if (f.face && f.m.lookUp < 0.3) {
      if (r.armed && f.t - r.upSince <= 2500) this.cp("roll", f);
      r.upSince = null;
      r.armed = false;
    }

    // 깜빡임
    if (fl.blinking && !this.lastBlink) this.blinks.push(f.t);
    this.lastBlink = fl.blinking;
  }

  phaseStats(phase) {
    const F = this.frames.filter((x) => x.phase === phase);
    const V = F.filter((x) => x.face);
    if (!F.length) return null;
    const pct = (flag) => (V.length ? Math.round((V.filter((x) => x.flags[flag]).length / V.length) * 100) : 0);
    const cps = this.checkpoints.filter((c) => c.phase === phase);
    const n = (type) => cps.filter((c) => c.type === type).length;
    return {
      seconds: +(((F[F.length - 1].t - F[0].t) || 0) / 1000).toFixed(1),
      face_pct: Math.round((V.length / F.length) * 100),
      frown_pct: pct("frown"),
      away_pct: pct("away"),
      press_pct: pct("press"),
      mouthdown_pct: pct("mouthdown"),
      chinup_pct: pct("chinup"),
      smile_delta: V.length ? +(median(V.map((x) => x.m.smile)) - this.b.smile).toFixed(2) : 0,
      rolls: n("roll"),
      smirks: n("smirk"),
    };
  }

  summary() {
    const V = this.frames.filter((x) => x.face);
    const span = this.frames.length ? (this.frames[this.frames.length - 1].t - this.frames[0].t) / 60000 : 0;
    const speak = this.frames.filter((x) => x.phase === "speak" && x.face);
    // 무표정: 말하는 동안 표정 변화가 거의 없고 웃음기 없음
    let flat = false;
    if (speak.length > 20) {
      const sd = (arr) => { const mu = arr.reduce((s, v) => s + v, 0) / arr.length; return Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length); };
      const move = sd(speak.map((x) => x.m.brow)) + sd(speak.map((x) => x.m.smile)) + sd(speak.map((x) => x.m.frown));
      flat = move < 0.06 && median(speak.map((x) => x.m.smile)) < this.b.smile + 0.05;
    }
    return {
      has_face: V.length > 0,
      has_baseline: !!this.b.measured,
      listen: this.phaseStats("listen"),
      silence: this.phaseStats("silence"),
      speak: this.phaseStats("speak"),
      blink_per_min: span > 0.05 ? Math.round(this.blinks.length / span) : null,
      blink_base: this.b.blink_per_min,
      expressionless: flat,
      checkpoints: this.checkpoints.map(({ type, t, phase, note }) => ({ type, phase, note, t: +(t / 1000).toFixed(1) })),
    };
  }
}

export function computeFaceBaseline(frames) {
  const V = frames.filter((x) => x.face);
  if (V.length < 30) return null; // 얼굴이 2~3초 이상 보여야 함
  const med = (k) => +median(V.map((x) => x.m[k])).toFixed(3);
  let blinks = 0, prev = false;
  for (const x of V) { const b = x.m.blink > 0.5; if (b && !prev) blinks++; prev = b; }
  const mins = (V[V.length - 1].t - V[0].t) / 60000;
  return {
    measured: true,
    brow: med("brow"), frown: med("frown"), press: med("press"), smile: med("smile"), asym: med("asym"),
    nose_ratio: med("noseRatio"),
    blink_per_min: mins > 0.1 ? Math.round(blinks / mins) : 17,
  };
}
