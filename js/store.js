// ============================================================
// 資料層：真正的資料在 Google 試算表（透過 api.js），
// 這裡負責「記憶體快取」「儲存延遲合併」「照片的本機快取」，
// 讓畫面不用每次都等網路。
// ============================================================
import * as api from './api.js';

const mem = { essays: new Map(), lists: {}, images: new Map() };
const inflight = new Map();

// ---------- 列表 ----------
export const cachedList = (subject) => mem.lists[subject] || null;
export async function listEssays(subject) {
  const list = await api.list(subject);
  mem.lists[subject] = list;
  return list;
}

// ---------- 單篇作文 ----------
export const peekEssay = (id) => mem.essays.get(id)?.essay || null;
export function markStale(id, maxAgeMs) {
  const c = mem.essays.get(id);
  if (c && Date.now() - c.at > maxAgeMs) mem.essays.delete(id);
}
export async function getEssay(id, { fresh = false } = {}) {
  if (!fresh) { const c = peekEssay(id); if (c) return c; }
  const essay = await api.get(id);
  essay.chat = essay.chat || [];
  mem.essays.set(id, { essay, at: Date.now() });
  return essay;
}
export async function createEssay(subject, title) {
  const essay = await api.create(subject, title);
  mem.essays.set(essay.id, { essay, at: Date.now() });
  mem.lists = {};
  return essay;
}
export async function deleteEssay(id) {
  await api.remove(id);
  mem.essays.delete(id);
  mem.lists = {};
}

// ---------- 欄位修改：先改本機，延遲 0.6 秒合併成一次送出 ----------
const pending = new Map();
export function patchEssay(id, fields) {
  const c = mem.essays.get(id);
  if (c) Object.assign(c.essay, fields);
  return new Promise((resolve, reject) => {
    let p = pending.get(id);
    if (!p) { p = { fields: {}, waiters: [], timer: null }; pending.set(id, p); }
    Object.assign(p.fields, fields);
    p.waiters.push({ resolve, reject });
    clearTimeout(p.timer);
    p.timer = setTimeout(() => flushOne(id), 600);
  });
}
export async function patchNow(id, fields) {
  const c = mem.essays.get(id);
  if (c) Object.assign(c.essay, fields);
  await api.patch(id, fields);
}
async function flushOne(id) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  try { await api.patch(id, p.fields); p.waiters.forEach((w) => w.resolve()); }
  catch (e) { p.waiters.forEach((w) => w.reject(e)); }
}
export const flushAll = () => Promise.all([...pending.keys()].map(flushOne));

// ---------- 照片：記憶體 ＋ IndexedDB 快取（伺服器才是正本） ----------
let dbp = null;
function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('essay-grader-cache', 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore('images', { keyPath: 'id' });
      s.createIndex('ts', 'ts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function idb(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('images', mode);
    const r = fn(t.objectStore('images'));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}
async function trimCache(max = 120, drop = 30) {
  const count = await idb('readonly', (s) => s.count());
  if (count <= max) return;
  const db = await openDB();
  await new Promise((resolve) => {
    const t = db.transaction('images', 'readwrite');
    let left = drop;
    t.objectStore('images').index('ts').openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (cur && left-- > 0) { cur.delete(); cur.continue(); }
    };
    t.oncomplete = t.onerror = t.onabort = () => resolve();
  });
}
async function cachePut(imageId, dataUrl) {
  await idb('readwrite', (s) => s.put({ id: imageId, data: dataUrl, ts: Date.now() }));
  trimCache().catch(() => {});
}

export function putImage(imageId, dataUrl) {
  mem.images.set(imageId, dataUrl);
  cachePut(imageId, dataUrl).catch(() => {});
}

export function imgSrc(essayId, imageId) {
  if (mem.images.has(imageId)) return Promise.resolve(mem.images.get(imageId));
  if (inflight.has(imageId)) return inflight.get(imageId);
  const p = (async () => {
    const hit = await idb('readonly', (s) => s.get(imageId)).catch(() => null);
    if (hit?.data) { mem.images.set(imageId, hit.data); return hit.data; }
    const { dataUrl } = await api.getImage(essayId, imageId);
    mem.images.set(imageId, dataUrl);
    cachePut(imageId, dataUrl).catch(() => {});
    return dataUrl;
  })().finally(() => inflight.delete(imageId));
  inflight.set(imageId, p);
  return p;
}

// 登出時清掉所有本機快取（共用電腦的隱私）
export async function clearAll() {
  mem.essays.clear(); mem.lists = {}; mem.images.clear();
  for (const t of pending.values()) clearTimeout(t.timer);
  pending.clear();
  await idb('readwrite', (s) => s.clear()).catch(() => {});
}
