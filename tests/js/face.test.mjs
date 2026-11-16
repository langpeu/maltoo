// 표정 지표 회귀 테스트 (합성 블렌드셰이프). 실행: node tests/js/face.test.mjs
import assert from "node:assert/strict";
import { computeFaceBaseline, FaceTracker } from "../../static/js/face/metrics.js";

const LM = (noseY = 0.55, noseX = 0.5) => ({ eyeL: { x: 0.4, y: 0.4 }, eyeR: { x: 0.6, y: 0.4 }, nose: { x: noseX, y: noseY }, chin: { x: 0.5, y: 0.75 } });
const neutral = { browDownLeft: 0.1, browDownRight: 0.1, mouthSmileLeft: 0.1, mouthSmileRight: 0.1, mouthFrownLeft: 0.05, mouthFrownRight: 0.05, mouthPressLeft: 0.1, mouthPressRight: 0.1 };

function feed(tr, { from, ms, phase, bs = {}, lm = LM(), step = 80 }) {
  for (let t = from; t < from + ms; t += step) tr.push({ t, phase, bs: { ...neutral, ...bs }, lm });
  return from + ms;
}

// 1) 기준선
const base = new FaceTracker(null);
let t = feed(base, { from: 0, ms: 6000, phase: "idle" });
base.push({ t, phase: "idle", bs: { ...neutral, eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }, lm: LM() });
const B = computeFaceBaseline(base.all);
assert.ok(B && B.measured);
assert.ok(Math.abs(B.brow - 0.1) < 0.01 && Math.abs(B.nose_ratio - 0.4286) < 0.01, JSON.stringify(B));
assert.equal(computeFaceBaseline(base.all.slice(0, 10)), null); // 얼굴이 너무 짧으면 실패

// 2) 대화 한 턴: 듣는 중 눈 굴림 + 찌푸림, 기다리는 중 시선 회피, 말하는 중 비웃음 + 턱 듦
const cps = [];
const tr = new FaceTracker(B, { onCheckpoint: (c) => cps.push(`${c.type}@${c.phase}`) });
tr.beginTurn();
t = feed(tr, { from: 0, ms: 1000, phase: "listen" });
t = feed(tr, { from: t, ms: 500, phase: "listen", bs: { eyeLookUpLeft: 0.8, eyeLookUpRight: 0.8 } }); // 위로
t = feed(tr, { from: t, ms: 300, phase: "listen" });                                                    // 돌아옴
t = feed(tr, { from: t, ms: 1500, phase: "listen", bs: { browDownLeft: 0.6, browDownRight: 0.6 } });   // 찌푸림
t = feed(tr, { from: t, ms: 2600, phase: "silence", bs: { eyeLookOutLeft: 0.8, eyeLookInRight: 0.8 } });
t = feed(tr, { from: t, ms: 800, phase: "speak", bs: { mouthSmileLeft: 0.6, mouthSmileRight: 0.1 } });
t = feed(tr, { from: t, ms: 1500, phase: "speak", lm: LM(0.48) });                                    // 턱 듦
for (const want of ["roll@listen", "frown@listen", "away@silence", "smirk@speak", "chinup@speak"]) {
  assert.ok(cps.includes(want), `missing ${want}: ${cps}`);
}
const S = tr.summary();
assert.ok(S.has_face && S.has_baseline);
assert.equal(S.listen.rolls, 1);
assert.ok(S.listen.frown_pct >= 40, JSON.stringify(S.listen));
assert.ok(S.silence.away_pct >= 90, JSON.stringify(S.silence));
assert.equal(S.speak.smirks, 1);
assert.ok(S.speak.chinup_pct >= 50, JSON.stringify(S.speak));

// 3) 차분한 턴: 체크포인트 없음, 얼굴 없는 프레임 처리
const calm = [];
const tr2 = new FaceTracker(B, { onCheckpoint: (c) => calm.push(c.type) });
t = feed(tr2, { from: 0, ms: 3000, phase: "listen" });
t = feed(tr2, { from: t, ms: 3000, phase: "speak", bs: { mouthSmileLeft: 0.3, mouthSmileRight: 0.3 } });
tr2.push({ t, phase: "speak", bs: null, lm: null });
assert.deepEqual(calm, []);
const S2 = tr2.summary();
assert.ok(S2.speak.face_pct < 100 && S2.speak.smile_delta > 0.1);
assert.equal(S2.expressionless, false);

// 4) 무표정
const tr3 = new FaceTracker(B);
feed(tr3, { from: 0, ms: 4000, phase: "speak" });
assert.equal(tr3.summary().expressionless, true);

console.log("face tests ok");
