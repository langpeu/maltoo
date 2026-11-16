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
    this.lastLandmarks = null; // 화면에 점을 찍기 위한 최근 랜드마크 (메모리에만)
    this.lastFrame = null;
    this.hist = [];            // 최근 2초 처리 기록 {t, face}
  }

  // UI 표시용 상태
  health() {
    if (!this.stream) return { state: "off", text: "📷 카메라 꺼짐" };
    if (this.status === "loading") return { state: "loading", text: "⏳ 표정 분석 준비 중…" };
    if (this.status === "error") return { state: "error", text: "❌ 표정 분석 모델을 불러오지 못함" };
    if (!this.running) return { state: "idle", text: "⏸ 표정 분석 대기" };
    const now = performance.now();
    const h = this.hist.filter((x) => x.t > now - 2000);
    if (h.length < 3) return { state: "loading", text: "⏳ 얼굴 찾는 중…" };
    const fps = Math.round(h.length / 2);
    const ratio = h.filter((x) => x.face).length / h.length;
    if (ratio >= 0.6) return { state: "ok", text: `✅ 얼굴 인식 중 · ${fps}fps`, fps, ratio };
    return { state: "warn", text: "⚠ 얼굴이 잘 안 보여요 — 화면 가운데, 밝은 곳으로", fps, ratio };
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
          this.lastLandmarks = L || null;
        } catch { /* 한 프레임 실패는 무시 */ }
        const f = this.tracker.push({ t: now - t0, phase: this.phase, bs, lm });
        this.lastFrame = f;
        this.hist.push({ t: now, face: !!bs });
        if (this.hist.length > 60) this.hist.shift();
        onFrame && onFrame(f);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    this.lastLandmarks = null;
    this.hist = [];
  }

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

// 눈·눈썹·코·입·얼굴 윤곽 랜드마크 번호 (점 표시용)
const OUTLINE = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
  148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const FEATURES = [33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380, 70, 63, 105, 66, 107, 336, 296, 334, 293, 300,
  1, 4, 5, 195, 61, 40, 37, 0, 267, 270, 291, 321, 314, 17, 84, 91, 13, 14, 468, 473];

// 거울 모드 비디오 위에 인식 점 그리기
export function drawLandmarks(canvas, landmarks, state) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * devicePixelRatio) { canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio; }
  const g = canvas.getContext("2d");
  g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!landmarks) return;
  // object-fit: cover 보정 (4:3 영상 기준)
  const vr = 4 / 3, cr = w / h;
  let sw = w, sh = h, ox = 0, oy = 0;
  if (cr > vr) { sh = w / vr; oy = (h - sh) / 2; } else { sw = h * vr; ox = (w - sw) / 2; }
  const pt = (i) => ({ x: w - (ox + landmarks[i].x * sw), y: oy + landmarks[i].y * sh });
  g.fillStyle = state === "ok" ? "rgba(255, 205, 74, .95)" : "rgba(224, 49, 49, .9)";
  for (const i of OUTLINE) { if (!landmarks[i]) continue; const p = pt(i); g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); }
  g.fillStyle = state === "ok" ? "rgba(80, 255, 140, .95)" : "rgba(224, 49, 49, .9)";
  for (const i of FEATURES) { if (!landmarks[i]) continue; const p = pt(i); g.beginPath(); g.arc(p.x, p.y, 2.4, 0, Math.PI * 2); g.fill(); }
}
