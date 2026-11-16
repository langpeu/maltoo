// 마이크·카메라 공용 객체 (평소 목소리 측정 화면과 대화 화면이 함께 씀)

import { Mic } from "./audio/mic.js";
import { FaceCam } from "./face/camera.js";

export const mic = new Mic();
export const faceCam = new FaceCam();
export const media = { faceCfg: null }; // 표정 분석 설정 (/api/config 의 face)

export async function openCamera(videoEl) {
  const ok = await faceCam.open();
  if (videoEl) faceCam.attach(videoEl);
  if (ok && media.faceCfg && faceCam.status !== "ready") faceCam.prepare(media.faceCfg); // 모델은 미리 받아둠
  return ok;
}
export function closeCamera() {
  faceCam.close();
  document.getElementById("bl-video").srcObject = null;
  document.getElementById("self-video").srcObject = null;
}
