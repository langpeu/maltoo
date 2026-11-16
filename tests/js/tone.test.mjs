// 톤 분석 알고리즘 회귀 테스트 (합성 음성). 실행: node tests/js/tone.test.mjs
import assert from "node:assert/strict";
import { analyzeFrame, computeBaseline, detectPitch, ToneTracker } from "../../static/js/audio/tone.js";

const sr = 48000, N = 2048, STEP = 30;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function synth(sec, f0fn, amp, syl) {
  const out = new Float32Array(Math.floor(sec * sr));
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * f0fn(t)) / sr;
    const env = syl ? Math.max(0, Math.sin(Math.PI * syl * t)) ** 0.7 : 1;
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(h * ph) / h;
    out[i] = 0.35 * amp * env * v + (rnd() - 0.5) * 0.002;
  }
  return out;
}
function withSilence(sig, sec = 0.6) {
  const out = new Float32Array(sig.length + Math.floor(sec * sr));
  out.set(sig);
  return out;
}
function run(sig, baseline) {
  const cps = [];
  const tr = new ToneTracker(baseline, { threshold: 0.02, onCheckpoint: (c) => cps.push(c.type) });
  for (let t = 0; (t / 1000) * sr + N < sig.length; t += STEP) {
    const s = Math.floor((t / 1000) * sr);
    tr.push(analyzeFrame(sig.subarray(s, s + N), sr), t);
  }
  return { tr, cps };
}

// 음높이 검출 (오차 1% 이내)
for (const hz of [90, 150, 220, 330]) {
  const p = detectPitch(synth(0.1, () => hz, 1, 0).subarray(0, N), sr);
  assert.ok(Math.abs(p - hz) / hz < 0.01, `pitch ${hz} → ${p}`);
}

// 평소 목소리
const base = run(synth(12, (t) => 150 * 2 ** (Math.sin(t * 1.3) / 12), 0.5, 5)).tr;
const B = computeBaseline(base.frames);
assert.ok(B && Math.abs(B.pitch_med - 150) < 6, `baseline pitch ${B && B.pitch_med}`);

// 격앙: 크고, 높고, 빠르고, 끝이 뚝 떨어짐
const angry = run(withSilence(synth(4, (t) => (t < 3.3 ? 205 : 205 * 2 ** (-(t - 3.3) * 14 / 12)), 1.0, 7.5)), B);
const a = angry.tr.summary();
for (const type of ["loud", "high", "fast", "fall"]) assert.ok(angry.cps.includes(type), `angry should include ${type}: ${angry.cps}`);
assert.equal(a.end, "falling_sharp");
assert.ok(a.arousal >= 80, `angry arousal ${a.arousal}`);
assert.ok(a.warmth <= 45, `angry warmth ${a.warmth}`);

// 차분: 평소와 같고 끝이 올라감 → 체크포인트 없음
const calm = run(withSilence(synth(4, (t) => (t < 3.5 ? 150 * 2 ** (Math.sin(t * 2) * 1.5 / 12) : 150 * 2 ** ((t - 3.5) * 10 / 12)), 0.5, 5)), B);
const c = calm.tr.summary();
assert.deepEqual(calm.cps, [], `calm should have no checkpoints: ${calm.cps}`);
assert.equal(c.end, "rising");
assert.ok(c.arousal <= 60 && c.warmth >= 60, `calm scores ${c.arousal}/${c.warmth}`);

console.log("tone tests ok");
