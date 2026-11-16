// 마이크: 녹음 + 말소리 감지(VAD)
// - listen(): 3초 안에 말을 시작하지 않으면 {spoke:false}
// - 말을 시작하면 1.5초 무음이 이어질 때 녹음 종료 → {spoke:true, blob, seconds}
// - 상대 음성이 재생되는 동안에는 listen 을 호출하지 않는다 (에코 방지)

export class Mic {
  constructor() {
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.buf = null;
    this.threshold = 0.02;
  }

  async open() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
  }

  level() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    return Math.sqrt(sum / this.buf.length);
  }

  // 주변 소음 측정 → 말소리 기준값 설정
  async calibrate(ms = 900) {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const samples = [];
    const end = performance.now() + ms;
    while (performance.now() < end) {
      samples.push(this.level());
      await sleep(30);
    }
    samples.sort((a, b) => a - b);
    const noise = samples[Math.floor(samples.length * 0.8)] || 0.005;
    this.threshold = Math.min(0.08, Math.max(0.015, noise * 3.5));
    this.calibrated = true;
    return { noise, threshold: this.threshold };
  }

  listen({ startTimeoutMs = 3000, endSilenceMs = 1500, maxMs = 30000, onTick } = {}) {
    return new Promise((resolve) => {
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

      const t0 = performance.now();
      let voicedMs = 0;
      let spoke = false;
      let lastVoice = 0;
      let done = false;

      const finish = (result) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        rec.onstop = () => {
          if (!result.spoke) return resolve(result);
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          resolve({ ...result, blob });
        };
        rec.stop();
      };

      const step = 30;
      const timer = setInterval(() => {
        const now = performance.now();
        const elapsed = now - t0;
        const lv = this.level();
        const loud = lv > this.threshold;

        if (loud) {
          voicedMs += step;
          lastVoice = now;
          if (!spoke && voicedMs >= 120) spoke = true;
        } else if (!spoke) {
          voicedMs = Math.max(0, voicedMs - step);
        }

        const remain = spoke ? null : Math.max(0, startTimeoutMs - elapsed);
        onTick && onTick({ level: lv, threshold: this.threshold, spoke, remain, elapsed,
                           buf: this.buf, sampleRate: this.ctx.sampleRate });

        if (!spoke && elapsed >= startTimeoutMs) return finish({ spoke: false });
        if (spoke && now - lastVoice >= endSilenceMs) return finish({ spoke: true, seconds: elapsed / 1000 });
        if (elapsed >= maxMs) return finish({ spoke, seconds: elapsed / 1000 });
      }, step);

      rec.start(250);
    });
  }

  // 평소 목소리 측정용: 정해진 시간(또는 stop() 호출 전)까지 프레임 전달
  capture({ maxMs = 30000, onTick } = {}) {
    let stop;
    const done = new Promise((resolve) => {
      const t0 = performance.now();
      const timer = setInterval(() => {
        const elapsed = performance.now() - t0;
        const lv = this.level();
        onTick && onTick({ level: lv, threshold: this.threshold, elapsed, buf: this.buf, sampleRate: this.ctx.sampleRate });
        if (elapsed >= maxMs) finish();
      }, 30);
      const finish = () => { clearInterval(timer); resolve(); };
      stop = finish;
    });
    return { done, stop: () => stop() };
  }

  close() {
    this.stream && this.stream.getTracks().forEach((t) => t.stop());
    this.ctx && this.ctx.close();
    this.stream = this.ctx = this.analyser = null;
  }
}

// 상대 음성 재생 + 실제 음량 측정 (입 모양·파형용)
let playCtx = null;

export function playUrl(url, { onTick } = {}) {
  return new Promise((resolve, reject) => {
    const a = new Audio();
    a.src = url;
    let analyser = null;
    let buf = null;
    try {
      playCtx = playCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (playCtx.state === "suspended") playCtx.resume();
      const src = playCtx.createMediaElementSource(a);
      analyser = playCtx.createAnalyser();
      analyser.fftSize = 1024;
      buf = new Float32Array(analyser.fftSize);
      src.connect(analyser);
      analyser.connect(playCtx.destination);
    } catch { analyser = null; }

    const level = () => {
      if (!analyser) return a.paused ? 0 : 0.05 + Math.random() * 0.1;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return Math.sqrt(sum / buf.length);
    };
    const timer = setInterval(() => onTick && onTick({ level: level() }), 33);
    const done = (fn) => (arg) => { clearInterval(timer); onTick && onTick({ level: 0, ended: true }); fn(arg); };
    a.onended = done(resolve);
    a.onerror = done(() => reject(new Error("음성을 재생하지 못했습니다.")));
    a.play().catch(done(reject));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
