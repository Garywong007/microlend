const BASE = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/, '') + '/api';
let token = null;

export function setToken(t) {
  token = t;
  try {
    if (t) sessionStorage.setItem('ml_token', t);
    else sessionStorage.removeItem('ml_token');
  } catch {
    /* storage can be unavailable (private mode) - the session then lives in memory only */
  }
}

export function loadToken() {
  try {
    token = sessionStorage.getItem('ml_token');
  } catch {
    token = null;
  }
  return token;
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.details = body?.details;
  }
}

async function request(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: 'Cannot reach the MicroLend API. Is the backend running?' });
  }
  if (raw && res.ok) return res;
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  /** Downloads an authenticated file (CSV export). */
  async download(path, filename) {
    const res = await request(path, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};
