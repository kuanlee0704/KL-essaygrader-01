// ============================================================
// 和後端（Google Apps Script 網頁應用程式）溝通
// ------------------------------------------------------------
// 重點：Apps Script 不支援 CORS 預檢（OPTIONS），所以一律用 POST、
// 而且「不要」設定 Content-Type（讓它維持預設的 text/plain），
// 瀏覽器就會當成「簡單請求」直接送出，不會被擋。
// ============================================================
import { CONFIG } from './config.js';

const K = { base: 'eg.apiBase', code: 'eg.code' };
const ls = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

export const getBase = () => (CONFIG.API_BASE || ls.get(K.base)).trim();
export const setBase = (u) => ls.set(K.base, String(u).trim());
export const baseLocked = () => !!CONFIG.API_BASE.trim();
export const looksLikeUrl = (u) => /^https:\/\/script\.google\.com\/.+\/exec\/?$/.test(String(u).trim());
export const isConfigured = () => looksLikeUrl(getBase());
export const getCode = () => ls.get(K.code);
export const setCode = (c) => ls.set(K.code, String(c).trim());
export const clearCode = () => ls.del(K.code);

function mkErr(message, code, status) {
  return Object.assign(new Error(message), { code: code || '', status: status || 0 });
}

async function call(action, params = {}, opts = {}) {
  const base = opts.base || getBase();
  if (!base) throw mkErr('尚未設定後端網址', 'NO_BASE');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60000);
  let text;
  try {
    const res = await fetch(base, {
      method: 'POST',
      body: JSON.stringify({ action, code: opts.code ?? getCode(), ...params }),
      signal: ctrl.signal,
      redirect: 'follow',
      keepalive: !!opts.keepalive,
    });
    text = await res.text();
  } catch (e) {
    throw mkErr(e.name === 'AbortError' ? '後端回應太久，請稍後再試' : '連不到後端，請檢查網路或後端網址', 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = JSON.parse(text); } catch {
    throw mkErr('後端回傳的內容無法讀取。請確認網址結尾是 /exec，而且部署時「存取權」選了「所有人」。', 'BAD_RESPONSE');
  }
  if (!data.ok) throw mkErr(data.error || '發生錯誤', data.code, data.status);
  return data.data;
}

// 登入驗證：用「還沒存起來」的網址與通行碼試打一次
export const verify = (base, code) => call('me', {}, { base, code });

export const me = () => call('me');
export const list = (subject) => call('list', { subject });
export const get = (id) => call('get', { id });
export const status = (id) => call('status', { id }, { timeoutMs: 20000 });
export const create = (subject, title) => call('create', { subject, title });
export const patch = (id, fields) => call('patch', { id, ...fields }, { keepalive: true });
export const remove = (id) => call('remove', { id });
export const uploadImage = (id, kind, dataUrl) => call('uploadImage', { id, kind, dataUrl }, { timeoutMs: 90000 });
export const getImage = (id, imageId) => call('getImage', { id, imageId }, { timeoutMs: 90000 });
export const removeImage = (id, kind, imageId) => call('removeImage', { id, kind, imageId });
export const grade = (id) => call('grade', { id });
export const transcribe = (id, overwrite = false) => call('transcribe', { id, overwrite: !!overwrite });
// 稿紙格線辨識：一次送一批欄位的長條圖；p = { images, cols, mask, rows, first }
export const ocrGrid = (id, p) => call('ocrGrid', { id, ...p }, { timeoutMs: 170000 });
export const rewrite = (id) => call('rewrite', { id });
export const run = (jobId) => call('run', { jobId }, { timeoutMs: 400000 });
export const chat = (id, message) => call('chat', { id, message }, { timeoutMs: 150000 });
