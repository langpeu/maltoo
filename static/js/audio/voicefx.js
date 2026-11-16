// 상대 음성 감정 강조: 재생할 때 감정별로 음량·속도를 조절한다 (비용 없음, 음성 재생성 불필요).
// 수치는 config.json voice_playback, 세기는 설정(localStorage maltoo.voiceFx).

let cfg = { moods: {}, strengths: { off: 0, low: 0.5, normal: 1, strong: 1.5 } };
let strength = (() => { try { return localStorage.getItem("maltoo.voiceFx") || "normal"; } catch { return "normal"; } })();

export function setVoiceFxConfig(c) { if (c && c.moods) cfg = { ...cfg, ...c }; }
export function voiceFxStrength() { return strength; }
export function setVoiceFxStrength(s) {
  strength = s;
  try { localStorage.setItem("maltoo.voiceFx", s); } catch { /* 무시 */ }
}

// 감정 → { gain, rate }. 세기 k: 음량은 배수의 k제곱(데시벨 비례), 속도는 차이에 k를 곱한다.
export function fxFor(mood) {
  const m = cfg.moods[mood] || cfg.moods.calm || { gain: 1, rate: 1 };
  const k = cfg.strengths[strength] ?? 1;
  return { gain: Math.pow(m.gain, k), rate: 1 + (m.rate - 1) * k };
}
