// IndexedDB 래퍼 — 모든 원고는 이 기기에 먼저 저장됩니다 (local-first)
const DB_NAME = 'jipilsil';
const DB_VER = 3; // 3: AI 작업(aiwork) 저장소 추가 — 기존 저장소·데이터는 그대로 (추가만)
let _db;

export function uid(p = '') {
  return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('works')) d.createObjectStore('works', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('episodes')) {
        const s = d.createObjectStore('episodes', { keyPath: 'id' });
        s.createIndex('workId', 'workId');
      }
      if (!d.objectStoreNames.contains('versions')) {
        const s = d.createObjectStore('versions', { keyPath: 'id' });
        s.createIndex('episodeId', 'episodeId');
      }
      if (!d.objectStoreNames.contains('memos')) {
        const s = d.createObjectStore('memos', { keyPath: 'id' });
        s.createIndex('episodeId', 'episodeId');
      }
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('bookmarks')) d.createObjectStore('bookmarks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('tombstones')) d.createObjectStore('tombstones', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('aiwork')) { const s = d.createObjectStore('aiwork', { keyPath: 'id' }); s.createIndex('kind', 'kind'); }
    };
    r.onsuccess = () => { _db = r.result; _db.onversionchange = () => { try { _db.close(); } catch (e) {} _db = null; }; res(_db); };
    r.onerror = () => rej(r.error);
  });
}

function tx(store, mode = 'readonly') {
  return openDB().then(d => d.transaction(store, mode).objectStore(store));
}
function wrap(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

export async function put(store, val, key) { const s = await tx(store, 'readwrite'); return wrap(key === undefined ? s.put(val) : s.put(val, key)); }
export async function get(store, key) { const s = await tx(store); return wrap(s.get(key)); }
export async function del(store, key) { const s = await tx(store, 'readwrite'); return wrap(s.delete(key)); }
export async function all(store) { const s = await tx(store); return wrap(s.getAll()); }
export async function byIndex(store, index, val) { const s = await tx(store); return wrap(s.index(index).getAll(val)); }

export const kv = {
  get: k => get('kv', k),
  set: (k, v) => put('kv', v, k),
};

// 저장 공간이 브라우저에 의해 지워지지 않도록 요청
export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {}
  return false;
}

// 한 트랜잭션 안에서 읽고-고치고-쓰기 (자동 저장과 동기화가 서로 덮어쓰지 않게)
// fn(cur) 이 undefined 를 돌려주면 쓰지 않음
export async function update(store, key, fn) {
  const d = await openDB();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite'); const s = t.objectStore(store);
    let out;
    const g = s.get(key);
    g.onsuccess = () => { out = fn(g.result); if (out !== undefined) s.put(out); };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}
