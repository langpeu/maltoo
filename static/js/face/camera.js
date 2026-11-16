// 카메라 + MediaPipe Face Landmarker 연결부
// 영상은 브라우저 안에서만 처리한다. 서버로 보내는 것은 metrics.js 의 수치 요약뿐이다.

import { FaceLandmarker, FilesetResolver } from "/static/vendor/mediapipe/vision_bundle.mjs";

let landmarkerP = null;

// 로컬 서버가 모델을 assets/models 에 받아두게 하고 그 파일을 쓴다 (실패하면 구글 주소 직접)
async function modelUrl(faceCfg) {
  try {
    const r = await fetch("/api/face-model", { method: "POST" });
    if (r.ok) return (await r.json()).url;
  } catch { /* 무시 */ }
  return faceCfg.model_url;
}

export function loadLandmarker(faceCfg) {
  if (landmarkerP) return landmarkerP;
  landmarkerP = (async () => {
    const fileset = await FilesetResolver.forVisionTasks("/static/vendor/mediapipe/wasm");
    const model = await modelUrl(faceCfg);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: model, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });
    try { return await FaceLandmarker.createFromOptions(fileset, opts("GPU")); }
    catch { return await FaceLandmarker.createFromOptions(fileset, opts("CPU")); }
  })();
  landmarkerP.catch(() => { landmarkerP = null; });
  return landmarkerP;
}

const P = (lm, i) => ({ x: lm[i].x, y: lm[i].y });

export class FaceCam {
  constructor() {
    this.stream = null;
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.phase = "idle";
    this.running = false;
    this.landmarker = null;
    this.status = "off"; // off | loading | ready | error
  }

  get on() { return !!this.stream; }

  async open() {
    if (this.stream) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
      this.video.srcObject = this.stream;
      await this.video.play();
      return true;
    } catch {
      this.stream = null;
      return false;
    }
  }

  attach(el) { if (el) el.srcObject = this.stream; }

  async prepare(faceCfg) {
    this.status = "loading";
    try {
      this.landmarker = await loadLandmarker(faceCfg);
      this.status = "ready";
    } catch (e) {
      this.status = "error";
      this.error = e;
    }
    return this.status === "ready";
  }

  start(tracker, { fps = 12, onFrame } = {}) {
    this.tracker = tracker;
    if (this.running || !this.landmarker || !this.stream) return;
    this.running = true;
    const minGap = 1000 / fps;
    let last = 0;
    const t0 = performance.now();
    const loop = () => {
      if (!this.running) return;
      const now = performance.now();
      if (now - last >= minGap && this.video.readyState >= 2) {
        last = now;
        let bs = null, lm = null;
        try {
          const res = this.landmarker.detectForVideo(this.video, now);
          if (res.faceBlendshapes && res.faceBlendshapes[0]) {
            bs = {};
            for (const c of res.faceBlendshapes[0].categories) bs[c.categoryName] = c.score;
          }
          const L = res.faceLandmarks && res.faceLandmarks[0];
          if (L) lm = { eyeL: P(L, 33), eyeR: P(L, 263), nose: P(L, 1), chin: P(L, 152) };
        } catch { /* 한 프레임 실패는 무시 */ }
        const f = this.tracker.push({ t: now - t0, phase: this.phase, bs, lm });
        onFrame && onFrame(f);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; }

  // 체크포인트 순간 캡처 (메모리에만 보관, 서버 전송 없음)
  capture(width = 240) {
    if (!this.stream || this.video.readyState < 2) return null;
    const h = Math.round((this.video.videoHeight / this.video.videoWidth) * width) || 180;
    const c = document.createElement("canvas");
    c.width = width;
    c.height = h;
    const g = c.getContext("2d");
    g.translate(width, 0);
    g.scale(-1, 1); // 거울 모드
    g.drawImage(this.video, 0, 0, width, h);
    return c.toDataURL("image/jpeg", 0.8);
  }

  close() {
    this.stop();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
