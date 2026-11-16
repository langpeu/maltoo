// 서버 API 호출. API 키는 localStorage 에만 저장하고, 요청 헤더로만 전달한다.

const KEY_STORAGE = "maltoo.openaiKey";

export const sessionId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());

export const keyStore = {
  get() {
    try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
  },
  set(key) {
    try { localStorage.setItem(KEY_STORAGE, key); } catch { /* 저장 불가 환경 */ }
  },
  clear() {
    try { localStorage.removeItem(KEY_STORAGE); } catch { /* 무시 */ }
  },
  hint(key = this.get()) {
    return key ? `sk-...${key.slice(-4)}` : "키 없음";
  },
};

export class ApiError extends Error {
  constructor(status, detail) {
    super((detail && detail.message) || `요청 실패 (${status})`);
    this.status = status;
    this.code = detail && detail.code;
  }
}

export async function api(path, { method = "GET", body, key, headers: extra } = {}) {
  const headers = { "X-Session-Id": sessionId, ...(extra || {}) };
  const k = key ?? keyStore.get();
  if (k) headers["X-OpenAI-Key"] = k;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) throw new ApiError(res.status, data && data.detail);
  return data;
}
