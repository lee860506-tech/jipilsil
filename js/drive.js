// 구글 드라이브 동기화 — Google Identity Services 토큰 + Drive API v3 (권한: drive.file 만)
// 원칙: 기기 저장이 먼저, 드라이브는 그다음. 덮어쓰기 전에는 항상 수정 기록을 남기고,
// 양쪽이 모두 바뀌었으면 절대 몰래 덮어쓰지 않고 사용자에게 고르게 합니다.
import * as db from './db.js';
import { normalizeText, canon, pad2, hashText, looseKey, learnNl, unNl } from './util.js';
import { listRows, castRows, toCSV } from './tables.js';
import { mergeNotes, contentOf, contentKey } from './notes.js';
import { uid } from './db.js';
import { aiContentOf, aiContentKey } from './aiwork.js';

const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const GDOC = 'application/vnd.google-apps.document';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
const cfg = () => window.YW_CONFIG || {};

export class NeedAuth extends Error {}

let token = null;          // {access_token, exp}
let tokenClient = null;
let gisLoading = null;
let busy = null;
const hooks = { onChange: () => {}, onConflict: () => {}, onStatus: () => {}, snapshot: async () => {} };
export function setHooks(h) { Object.assign(hooks, h); }

export async function getClientId() {
  return (await db.kv.get('clientId')) || cfg().DEFAULT_CLIENT_ID || '';
}
export async function init() {
  token = (await db.kv.get('driveToken')) || null;
}
export const hasValidToken = () => !!(token && token.exp > Date.now() + 60_000);
export const tokenLeft = () => token ? token.exp - Date.now() : 0;
export const isLinkedSync = () => !!linkedCache;
export async function wasConnected() { return !!(await db.kv.get('driveLinked')); }

let linkedCache = null;
export function gisReady() { return !!window.google?.accounts?.oauth2; }
export function loadGIS() {
  if (gisReady()) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    const to = setTimeout(() => { gisLoading = null; rej(new Error('구글 로그인 스크립트가 늦어요. 인터넷 연결을 확인하고 다시 눌러 주세요.')); }, 15000);
    s.onload = () => { clearTimeout(to); res(); };
    s.onerror = () => { clearTimeout(to); gisLoading = null; s.remove(); rej(new Error('구글 로그인 스크립트를 불러오지 못했어요. 인터넷 연결(또는 광고 차단 확장)을 확인해 주세요.')); };
    document.head.appendChild(s);
  });
  return gisLoading;
}
/** 미리 준비: 설정 화면을 열 때·앱 시작 때 호출해 두면 클릭 즉시 로그인 창이 열려요. */
export async function prepare() { linkedCache = await wasConnected(); try { await loadGIS(); } catch (e) {} return gisReady(); }

/**
 * 반드시 클릭 핸들러 안에서 await 없이 바로 호출 (팝업 차단 방지).
 * clientId 는 호출하는 쪽에서 동기로 넘겨요. 결과는 Promise.
 */
export function connectNow(clientId, { silent = false } = {}) {
  if (!clientId) return Promise.reject(new Error('OAuth 클라이언트 ID가 비어 있어요. 설정에 붙여 넣어 주세요.'));
  if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) return Promise.reject(new Error('클라이언트 ID 모양이 아니에요. 「숫자-영문.apps.googleusercontent.com」 전체를 붙여 넣어 주세요.'));
  if (!gisReady()) return Promise.reject(Object.assign(new Error('구글 로그인 준비 중이에요. 잠시 후 한 번 더 눌러 주세요.'), { notReady: true }));
  return new Promise((res, rej) => {
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: cfg().SCOPE || 'https://www.googleapis.com/auth/drive.file',
      callback: async r => {
        if (r.error === 'access_denied') return rej(new Error('구글이 접근을 막았어요 (access_denied). 구글 콘솔 → 대상 → 테스트 사용자에 내 Gmail을 추가해 주세요. 권한 화면에서 「취소」를 눌렀다면 다시 눌러 「계속」을 선택해 주세요.'));
        if (r.error) return rej(new Error('구글 연결 실패: ' + (r.error_description || r.error)));
        if (window.google.accounts.oauth2.hasGrantedAllScopes && !window.google.accounts.oauth2.hasGrantedAllScopes(r, cfg().SCOPE)) {
          return rej(new Error('드라이브 권한에 체크해 주셔야 저장할 수 있어요.'));
        }
        token = { access_token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        await db.kv.set('driveToken', token); await db.kv.set('driveLinked', true); linkedCache = true;
        res(token);
      },
      error_callback: e => {
        const t = e?.type;
        rej(new Error(t === 'popup_failed_to_open' ? '로그인 창이 차단됐어요. 주소창 오른쪽의 팝업 차단 아이콘에서 「항상 허용」 후 다시 눌러 주세요.'
          : t === 'popup_closed' ? '로그인 창이 닫혔어요. 창에 「403 access_denied · 앱이 테스트 중」이 보였다면 구글 콘솔 → 대상 → 테스트 사용자에 내 Gmail을 추가해 주세요. 「401 invalid_client / deleted_client」였다면 클라이언트 ID를 다시 확인해 주세요.'
          : '구글 로그인 창을 열 수 없어요' + (t ? ` (${t})` : '') + '.'));
      },
    });
    tokenClient = tc;
    tc.requestAccessToken({ prompt: silent || linkedCache ? '' : 'consent' });
  });
}
// 예전 방식 호환 (자동 재연결 등, 사용자 동작 밖에서 쓰지 않음)
export async function connect(opts = {}) {
  const clientId = await getClientId(); await prepare();
  return connectNow(clientId, opts);
}
export async function disconnect() {
  try { if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token.access_token, () => {}); } catch (e) {}
  token = null;
  await db.kv.set('driveToken', null); await db.kv.set('driveLinked', false); await db.kv.set('driveRootId', null); linkedCache = false;
}

async function api(url, opt = {}) {
  if (!hasValidToken()) throw new NeedAuth('드라이브 다시 연결 필요');
  const r = await fetch(url, { ...opt, headers: { Authorization: 'Bearer ' + token.access_token, ...(opt.headers || {}) } });
  if (r.status === 401) { token = null; await db.kv.set('driveToken', null); throw new NeedAuth('드라이브 로그인이 만료됐어요'); }
  if (!r.ok) { const t = await r.text().catch(() => ''); const e = new Error(`드라이브 오류 ${r.status}`); e.status = r.status; e.body = t; throw e; }
  return r;
}
const j = r => r.json();

function multipart(meta, body, mime) {
  const b = 'yw' + Math.random().toString(36).slice(2);
  const blob = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`,
    body, `\r\n--${b}--`]);
  return { blob, type: `multipart/related; boundary=${b}` };
}
async function listAll(q) {
  let out = [], pageToken = '';
  do {
    const u = new URL(API + '/files');
    u.searchParams.set('q', q); u.searchParams.set('pageSize', '1000'); u.searchParams.set('spaces', 'drive');
    u.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,modifiedTime,appProperties,parents,description,trashed)');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const d = await api(u).then(j); out = out.concat(d.files || []); pageToken = d.nextPageToken;
  } while (pageToken);
  return out;
}
const prop = (k, v) => `appProperties has { key='${k}' and value='${v}' }`;

async function createFolder(name, parent, appProperties) {
  return api(API + '/files?fields=id,modifiedTime', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: parent ? [parent] : undefined, appProperties }) }).then(j);
}
async function ensureRoot() {
  let id = await db.kv.get('driveRootId');
  if (id) {
    try { const f = await api(`${API}/files/${id}?fields=id,trashed`).then(j); if (!f.trashed) return id; } catch (e) { if (e instanceof NeedAuth) throw e; }
  }
  const found = await listAll(`${prop('ywKind', 'root')} and trashed=false`);
  id = found[0]?.id || (await createFolder(cfg().DRIVE_ROOT_NAME || '집필실', null, { ywKind: 'root' })).id;
  await db.kv.set('driveRootId', id);
  return id;
}

export function episodeLabel(ep, idx) { return ep.label?.trim() || `${pad2(idx + 1)}화`; }
export function driveName(ep, idx) { return (episodeLabel(ep, idx) + (ep.title ? ' ' + ep.title : '')).slice(0, 120); }
const epMeta = (ep, idx, extra = {}) => JSON.stringify({ v: 1, title: ep.title || '', label: ep.label || '', order: ep.order ?? idx, status: ep.status || 'draft', oneLine: ep.oneLine || '', memo: (ep.memo || '').slice(0, 20000), ...extra });
// 구글 문서 내보내기 → 원고: 줄바꿈 규칙 되돌리고, 문서가 붙인 끝 줄바꿈은 뗌
const fromDoc = (E, nl) => unNl(E, nl).replace(/\n+$/, '');
const exKeyOf = E => hashText(canon(E));
const workMeta = w => JSON.stringify({ v: 1, order: w.order ?? 0, cast: (w.cast || []).slice(0, 300) }).slice(0, 25000);
function parseMeta(d) { try { return JSON.parse(d || '{}'); } catch (e) { return {}; } }

async function exportText(fileId) {
  const r = await api(`${API}/files/${fileId}/export?mimeType=text/plain`);
  return normalizeText(await r.text());
}

async function workEpisodesSorted(workId) {
  return (await db.byIndex('episodes', 'workId', workId)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
}

// ---------- 동기화 본체 ----------
export function sync(reason = '') {
  if (busy) { busy.again = true; return busy.p; }
  const st = { again: false };
  st.p = (async () => {
    try { do { st.again = false; await syncOnce(reason); } while (st.again); }
    finally { busy = null; }
  })();
  busy = st;
  return st.p;
}

async function syncOnce() {
  if (!navigator.onLine) { hooks.onStatus('offline'); return { offline: true }; }
  if (!hasValidToken()) { hooks.onStatus('needauth'); throw new NeedAuth(); }
  hooks.onStatus('syncing');
  const rootId = await ensureRoot();
  const tombs = await db.all('tombstones');
  const tombIds = new Set(tombs.map(t => t.id));

  // 1) 원격 목록
  const [rWorks, rEps, rMemoFolders] = await Promise.all([
    listAll(`${prop('ywKind', 'work')} and trashed=false`),
    listAll(`${prop('ywKind', 'episode')} and trashed=false`),
    listAll(`${prop('ywKind', 'memofolder')} and trashed=false`),
  ]);

  // 2) 작품 폴더 연결 / 새 기기에서 가져오기
  const works = new Map((await db.all('works')).map(w => [w.id, w]));
  for (const f of rWorks) {
    const wid = f.appProperties?.ywWorkId; if (!wid || tombIds.has(wid)) continue;
    let w = works.get(wid);
    if (!w) {
      const m = parseMeta(f.description);
      w = { id: wid, title: f.name, order: m.order ?? works.size, cast: m.cast || [], createdAt: Date.now(), updatedAt: Date.now(), driveFolderId: f.id, dirty: false, folderMtime: f.modifiedTime };
      await db.put('works', w); works.set(wid, w); hooks.onChange({ work: wid });
    } else {
      const m = parseMeta(f.description);
      let changed = false;
      await db.update('works', wid, c => {
        if (!c) return undefined;
        c.driveFolderId = f.id;
        if (!c.dirty && c.folderMtime !== f.modifiedTime) { // 다른 기기에서 바뀐 이름·인물표 받기
          if (f.name && f.name !== c.title) { c.title = f.name; changed = true; }
          if (m.cast && JSON.stringify(m.cast) !== JSON.stringify(c.cast || [])) { c.cast = m.cast; changed = true; }
          c.folderMtime = f.modifiedTime;
        }
        return c;
      });
      Object.assign(w, await db.get('works', wid));
      if (changed) hooks.onChange({ work: wid });
    }
  }
  for (const f of rMemoFolders) { const w = works.get(f.appProperties?.ywWorkId); if (w && w.memoFolderId !== f.id) { w.memoFolderId = f.id; await db.update('works', w.id, c => c && (c.memoFolderId = f.id, c)); } }

  // 3) 회차 내려받기 / 충돌 감지
  const remoteIds = new Set();
  for (const f of rEps) {
    const eid = f.appProperties?.ywEpId; if (!eid) continue;
    remoteIds.add(f.id);
    if (tombIds.has(eid)) continue;
    let ep = await db.get('episodes', eid);
    const m = parseMeta(f.description);
    if (!ep) {
      const wid = f.appProperties?.ywWorkId;
      if (!works.has(wid)) continue; // 작품 폴더가 없으면 건너뜀
      const E = await exportText(f.id); const text = fromDoc(E, m.nl);
      ep = { id: eid, workId: wid, order: m.order ?? 0, title: m.title || '', label: m.label || '', memo: m.memo || '', status: m.status || 'draft', oneLine: m.oneLine || '', text,
        createdAt: Date.now(), updatedAt: Date.now(), rev: 0, dirty: false, drive: { fileId: f.id, modifiedTime: f.modifiedTime, exKey: await exKeyOf(E), nl: m.nl || null } };
      await db.put('episodes', ep); hooks.onChange({ episode: eid, work: wid, created: true });
      continue;
    }
    if (ep.conflict) {
      // 예전에 잘못 잡힌 충돌(줄바꿈·공백만 다름)은 조용히 정리: 기기 글 유지, 두 버전은 수정 기록에 그대로
      if (looseKey(ep.conflict.remoteText) === looseKey(ep.text)) {
        await db.update('episodes', ep.id, cur => { if (!cur) return undefined; delete cur.conflict; cur.dirty = true; return cur; });
        hooks.onChange({ episode: ep.id, work: ep.workId, conflictCleared: true });
      }
      continue; // 진짜 충돌은 사용자 선택 대기 중
    }
    const known = ep.drive?.modifiedTime;
    if (ep.drive?.fileId === f.id && known === f.modifiedTime) continue; // 원격 변화 없음
    const E = await exportText(f.id); const exKey = await exKeyOf(E);
    const nl = ep.drive?.nl || m.nl || null;
    const applyMeta = cur => { const t0 = JSON.stringify([cur.title, cur.label, cur.memo, cur.order, cur.status, cur.oneLine]);
      cur.title = m.title ?? cur.title; cur.label = m.label ?? cur.label; cur.memo = m.memo ?? cur.memo; if (m.order != null) cur.order = m.order; cur.status = m.status ?? cur.status; cur.oneLine = m.oneLine ?? cur.oneLine;
      return t0 !== JSON.stringify([cur.title, cur.label, cur.memo, cur.order, cur.status, cur.oneLine]); };
    const setDrive = cur => { cur.drive = { ...(cur.drive || {}), fileId: f.id, modifiedTime: f.modifiedTime, exKey, nl }; cur.remoteMissing = false; };
    if (ep.drive?.exKey && exKey === ep.drive.exKey) {
      // 내가 올린 그대로 (구글 문서 변환·저장 시각만 바뀜) → 원격 변경 아님
      let mc = false;
      await db.update('episodes', ep.id, cur => { if (!cur) return undefined; setDrive(cur); if (!cur.dirty) mc = applyMeta(cur); return cur; });
      if (mc) hooks.onChange({ episode: ep.id, work: ep.workId, pulled: true, textChanged: false });
      continue;
    }
    const remoteText = fromDoc(E, nl);
    if (looseKey(remoteText) === looseKey(ep.text)) {
      // 줄바꿈·공백만 다름(구글 문서 왕복 흔적) → 같은 원고. 기기 글을 그대로 두고 조용히 넘어감
      let metaOnly = false;
      await db.update('episodes', ep.id, cur => { if (!cur) return undefined; setDrive(cur);
        if (!cur.dirty) metaOnly = applyMeta(cur);
        return cur; });
      if (metaOnly) hooks.onChange({ episode: ep.id, work: ep.workId, pulled: true, textChanged: false });
      continue;
    }
    if (!ep.dirty) {
      // 기기에서는 안 바뀌고 드라이브만 바뀜 → 덮기 전에 기록 남기고 반영
      const changed = canon(remoteText) !== canon(ep.text);
      if (changed) await hooks.snapshot(ep, 'before-pull', '드라이브 내용 받기 전');
      let raced = false;
      await db.update('episodes', ep.id, cur => {
        if (!cur || cur.rev !== ep.rev || cur.dirty) { raced = true; return undefined; } // 그사이 기기에서 수정됨 → 다음 회차에 다시 판단
        if (changed) { cur.text = remoteText; cur.rev = (cur.rev || 0) + 1; }
        cur.title = m.title ?? cur.title; cur.label = m.label ?? cur.label; cur.memo = m.memo ?? cur.memo; if (m.order != null) cur.order = m.order;
        cur.status = m.status ?? cur.status; cur.oneLine = m.oneLine ?? cur.oneLine;
        setDrive(cur); cur.dirty = false;
        return cur;
      });
      if (raced) { if (busy) busy.again = true; continue; }
      hooks.onChange({ episode: ep.id, work: ep.workId, pulled: true, textChanged: changed, prevText: ep.text });
    } else if (canon(remoteText) === canon(ep.text)) {
      await db.update('episodes', ep.id, cur => cur && (setDrive(cur), cur)); // 내용 같음 → 메타만 올리면 됨
    } else {
      // 양쪽 모두 바뀜 → 둘 다 보관하고 선택을 기다림
      await hooks.snapshot(ep, 'conflict-local', '충돌: 이 기기 버전');
      await hooks.snapshot({ ...ep, text: remoteText }, 'conflict-remote', '충돌: 드라이브 버전');
      const conflict = { remoteText, remoteModifiedTime: f.modifiedTime, fileId: f.id, exKey, nl, at: Date.now() };
      const saved = await db.update('episodes', ep.id, cur => cur && (cur.conflict = conflict, cur));
      hooks.onConflict(saved || ep);
    }
  }

  // 4) 드라이브에서 사라진 회차: 기기 원고는 그대로 두고 표시만
  for (const ep of await db.all('episodes')) {
    if (ep.drive?.fileId && !remoteIds.has(ep.drive.fileId) && !ep.remoteMissing) {
      await db.update('episodes', ep.id, cur => cur && (cur.remoteMissing = true, cur)); hooks.onChange({ episode: ep.id, work: ep.workId });
    }
  }

  // 5) 삭제 대기열 → 드라이브 휴지통으로 (복구 가능)
  for (const t of tombs) {
    if (t.fileId) {
      try { await api(`${API}/files/${t.fileId}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); }
      catch (e) { if (e instanceof NeedAuth) throw e; if (e.status !== 404) continue; }
    }
    await db.del('tombstones', t.id);
  }

  // 6) 작품 폴더 만들기/이름 바꾸기
  for (const w of works.values()) {
    if (tombIds.has(w.id)) continue;
    if (!w.driveFolderId) {
      const title = w.title, meta = workMeta(w);
      const f = await api(API + '/files?fields=id,modifiedTime', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: title, mimeType: FOLDER, parents: [rootId], description: meta, appProperties: { ywKind: 'work', ywWorkId: w.id } }) }).then(j);
      w.driveFolderId = f.id;
      await db.update('works', w.id, c => c && (c.driveFolderId = f.id, c.folderMtime = f.modifiedTime, c.title === title && workMeta(c) === meta && (c.dirty = false), c));
    } else if (w.dirty) {
      const title = w.title, meta = workMeta(w);
      const r = await api(`${API}/files/${w.driveFolderId}?fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: title, description: meta }) }).then(j);
      await db.update('works', w.id, c => c && (c.folderMtime = r.modifiedTime, c.title === title && workMeta(c) === meta && (c.dirty = false), c));
    }
  }

  // 7) 바뀐 회차 올리기 (구글 문서로 저장 → ChatGPT 등에서도 읽고 고칠 수 있음)
  for (const w of works.values()) {
    const eps = await workEpisodesSorted(w.id);
    for (let i = 0; i < eps.length; i++) {
      const ep = eps[i];
      if (!ep.dirty || ep.conflict || ep.remoteMissing) continue;
      const rev = ep.rev;
      const meta = { name: driveName(ep, i), description: epMeta(ep, i), appProperties: { ywKind: 'episode', ywEpId: ep.id, ywWorkId: w.id } };
      let res;
      if (!ep.drive?.fileId) {
        const mp = multipart({ ...meta, mimeType: GDOC, parents: [w.driveFolderId] }, ep.text || '', 'text/plain; charset=UTF-8');
        res = await api(`${UP}/files?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.blob }).then(j);
      } else {
        const mp = multipart(meta, ep.text || '', 'text/plain; charset=UTF-8');
        res = await api(`${UP}/files/${ep.drive.fileId}?uploadType=multipart&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': mp.type }, body: mp.blob }).then(j);
      }
      // 올린 직후 구글 문서가 어떻게 내보내는지 확인 → 줄바꿈 규칙과 「내가 올린 모양」을 기억 (다른 기기도 설명에서 읽음)
      let exKey = null, nl = ep.drive?.nl || null;
      try {
        const E0 = await exportText(res.id); exKey = await exKeyOf(E0); nl = learnNl(ep.text || '', E0) || nl;
        const r2 = await api(`${API}/files/${res.id}?fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: epMeta(ep, i, { ex: exKey, nl }) }) }).then(j);
        res.modifiedTime = r2.modifiedTime || res.modifiedTime;
      } catch (e) { if (e instanceof NeedAuth) throw e; }
      const cur = await db.update('episodes', ep.id, c => {
        if (!c) return undefined;
        c.drive = { fileId: res.id, modifiedTime: res.modifiedTime, syncedAt: Date.now(), exKey, nl };
        if (c.rev === rev && (c.title || '') === (ep.title || '') && (c.memo || '') === (ep.memo || '') && (c.label || '') === (ep.label || '') && c.order === ep.order) c.dirty = false;
        return c;
      });
      if (cur) hooks.onChange({ episode: cur.id, work: w.id, pushed: true });
    }
  }

  // 8) 음성 메모 올리기 → <작품>/음성메모/
  for (const mm of await db.all('memos')) {
    if (mm.driveFileId) continue;
    const w = works.get(mm.workId); if (!w?.driveFolderId) continue;
    if (!w.memoFolderId) { const fid = (await createFolder('음성메모', w.driveFolderId, { ywKind: 'memofolder', ywWorkId: w.id })).id; w.memoFolderId = fid; await db.update('works', w.id, c => c && (c.memoFolderId = fid, c)); }
    const mp = multipart({ name: mm.name, parents: [w.memoFolderId], appProperties: { ywKind: 'memo', ywMemoId: mm.id, ywEpId: mm.episodeId } }, mm.blob, mm.mime || 'audio/webm');
    const res = await api(`${UP}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.blob }).then(j);
    await db.update('memos', mm.id, c => c && (c.driveFileId = res.id, c)); hooks.onChange({ memo: mm.id });
  }

  // 9) 아이디어 사진 → <작품>/아이디어 사진/ 또는 공통/아이디어 사진/
  const photos = await db.all('photos');
  if (photos.some(ph => !ph.driveFileId || ph.metaDirty)) {
    const pfolders = await listAll(`${prop('ywKind', 'photofolder')} and trashed=false`);
    const pf = new Map(pfolders.map(f => [f.appProperties?.ywWorkId, f.id]));
    const folderFor = async wid => {
      const key = wid && works.get(wid)?.driveFolderId ? wid : 'common';
      if (pf.has(key)) return pf.get(key);
      let parent;
      if (key === 'common') {
        parent = (await listAll(`${prop('ywKind', 'common')} and trashed=false`))[0]?.id || (await createFolder('공통', rootId, { ywKind: 'common' })).id;
      } else parent = works.get(key).driveFolderId;
      const id = (await createFolder('아이디어 사진', parent, { ywKind: 'photofolder', ywWorkId: key })).id; pf.set(key, id); return id;
    };
    for (const ph of photos) {
      const meta = { name: ph.name, description: [ph.caption, (ph.tags || []).map(t => '#' + t).join(' ')].filter(Boolean).join('\n') };
      if (!ph.driveFileId) {
        const mp = multipart({ ...meta, parents: [await folderFor(ph.workId)], appProperties: { ywKind: 'photo', ywPhotoId: ph.id, ywWorkId: ph.workId || 'common', ywEpId: ph.episodeId || '' } }, ph.blob, ph.mime || 'image/jpeg');
        const res = await api(`${UP}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.blob }).then(j);
        const sent = JSON.stringify(meta);
        await db.update('photos', ph.id, c => c && (c.driveFileId = res.id, c.driveWork = ph.workId || 'common', JSON.stringify({ name: c.name, description: meta.description }) === sent && (c.metaDirty = false), c));
      } else if (ph.metaDirty) {
        const body = { ...meta };
        const target = ph.workId || 'common';
        let q = '';
        if (ph.driveWork && ph.driveWork !== target) { q = `&addParents=${await folderFor(ph.workId)}&removeParents=${pf.get(ph.driveWork) || ''}`; }
        await api(`${API}/files/${ph.driveFileId}?fields=id${q}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        await db.update('photos', ph.id, c => c && (c.metaDirty = false, c.driveWork = target, c));
      }
      hooks.onChange({ photo: ph.id });
    }
  }

  // 10) 회차 목록표 · 인물·설정표 → 작품 폴더의 구글 시트 (앱 → 드라이브 한 방향)
  let remoteSheets = null;
  for (const w0 of works.values()) {
    const w = await db.get('works', w0.id); if (!w?.driveFolderId) continue;
    const eps = await workEpisodesSorted(w.id);
    for (const [kind, name, rows] of [['list', '회차 목록표', listRows(eps)], ['cast', '인물·설정표', castRows(w)]]) {
      const csv = '\uFEFF' + toCSV(rows); const h = await hashText(csv);
      const sh = w.sheets?.[kind];
      if (sh?.hash === h) continue;
      let id = sh?.id;
      if (!id) { // 다른 기기에서 이미 만든 시트가 있으면 그걸 이어 씀
        if (!remoteSheets) remoteSheets = await listAll(`${prop('ywKind', 'sheet')} and trashed=false`);
        id = remoteSheets.find(f => f.appProperties?.ywWorkId === w.id && f.appProperties?.ywSheet === kind)?.id;
      }
      if (id) {
        try { const mp = multipart({ name }, csv, 'text/csv; charset=UTF-8'); await api(`${UP}/files/${id}?uploadType=multipart&fields=id`, { method: 'PATCH', headers: { 'Content-Type': mp.type }, body: mp.blob }); }
        catch (e) { if (e instanceof NeedAuth) throw e; if (e.status === 404) id = null; else throw e; }
      }
      if (!id) {
        const mp = multipart({ name, mimeType: GSHEET, parents: [w.driveFolderId], appProperties: { ywKind: 'sheet', ywWorkId: w.id, ywSheet: kind } }, csv, 'text/csv; charset=UTF-8');
        id = (await api(`${UP}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.blob }).then(j)).id;
      }
      await db.update('works', w.id, c => c && ((c.sheets = c.sheets || {})[kind] = { id, hash: h }, c));
    }
  }


  // 11) 설계 노트 → 집필실 폴더의 「설계 노트.json」 하나 (노트 단위 양방향 병합, 양쪽 수정은 사본으로 둘 다 보관)
  await syncNotes(rootId);
  // 12) AI 작업(가져온 자료·비교 기록·작법 교재) → 「AI 작업.json」 (따로 · 같은 방식으로 병합). 문제가 생겨도 다른 동기화는 멈추지 않음
  try { await syncAI(rootId); await db.kv.set('aiSyncErr', null); }
  catch (e) { if (e instanceof NeedAuth) throw e; console.warn('AI 작업 동기화', e); await db.kv.set('aiSyncErr', String(e?.message || e)); }

  await db.kv.set('lastSync', Date.now());
  hooks.onStatus('synced');
  return { ok: true };
}

// 충돌 해결: 'local' = 이 기기 버전으로 드라이브 덮기, 'remote' = 드라이브 버전 사용, 'both' = 사본 회차 만들기
export async function resolveConflict(epId, choice, makeCopy) {
  const ep = await db.get('episodes', epId); if (!ep?.conflict) return ep;
  const c = ep.conflict;
  if (choice === 'remote') {
    await hooks.snapshot(ep, 'before-pull', '드라이브 버전 선택 전');
    ep.text = c.remoteText; ep.dirty = false; ep.rev = (ep.rev || 0) + 1;
  } else if (choice === 'local') {
    ep.dirty = true;
  } else if (choice === 'both') {
    await makeCopy(ep, c.remoteText); // 드라이브 버전을 새 회차로 보관
    ep.dirty = true;                   // 이 회차는 기기 버전 유지
  }
  ep.drive = { ...(ep.drive || {}), fileId: c.fileId, modifiedTime: c.remoteModifiedTime, exKey: c.exKey || ep.drive?.exKey, nl: c.nl || ep.drive?.nl };
  delete ep.conflict;
  await db.put('episodes', ep);
  return ep;
}

// ---------- 설계 노트 (+ 기기끼리 맞출 설정) ----------
const SET_KEYS = ['penName', 'goal', 'theme', 'font', 'lineH', 'fontSize', 'letterSp', 'focusMin', 'breakMin', 'snapMin', 'tidy'];
const pickSet = o => Object.fromEntries(SET_KEYS.filter(k => k in o).map(k => [k, o[k]]));
async function syncNotes(rootId) {
  const st = (await db.kv.get('notesSync')) || {};
  const localDel = (await db.kv.get('noteDel')) || {};
  let local = await db.all('notes');
  let fileId = st.fileId, ver = null;
  if (fileId) {
    try { const f = await api(`${API}/files/${fileId}?fields=id,version,trashed`).then(j); if (f.trashed) fileId = null; else ver = f.version; }
    catch (e) { if (e instanceof NeedAuth) throw e; if (e.status === 404) fileId = null; else throw e; }
  }
  if (!fileId) {
    const found = await listAll(`${prop('ywKind', 'notes')} and trashed=false`);
    if (found[0]) { fileId = found[0].id; const f = await api(`${API}/files/${fileId}?fields=id,version`).then(j); ver = f.version; }
  }
  const lset = await db.kv.get('settings') || {}; const lsetAt = (await db.kv.get('settingsAt')) || 0;
  if (!fileId && !local.length && !Object.keys(localDel).length && !lsetAt) return;
  let remote = { notes: [], deleted: {} };
  const known = fileId && st.fileId === fileId && st.version === ver; // 마지막으로 내가 올린(받은) 그대로면 받지 않음
  if (fileId && !known) {
    try { remote = JSON.parse(await api(`${API}/files/${fileId}?alt=media`).then(r => r.text())); } catch (e) { if (e instanceof NeedAuth) throw e; if (!(e instanceof SyntaxError)) throw e; }
    remote.notes = remote.notes || []; remote.deleted = remote.deleted || {};
  }
  let m;
  if (known) {
    const changed = local.some(n => n.dirty || !n.base) || Object.keys(localDel).some(id => !(st.deleted || {})[id]);
    m = { put: [], del: [], deleted: { ...(st.deleted || {}), ...localDel }, copies: 0, changed };
  } else m = mergeNotes(local, localDel, remote, () => uid('n'));
  for (const n of m.put) await db.update('notes', n.id, c => (c && c.dirty && c.updatedAt !== (local.find(x => x.id === n.id)?.updatedAt)) ? undefined : n); // 받는 사이 고친 건 건드리지 않음
  for (const id of m.del) await db.del('notes', id);
  if (m.put.length || m.del.length) hooks.onChange({ notes: true, copies: m.copies });
  // 설정(필명·하루 목표·테마 등): 나중에 바꾼 쪽이 이김
  let setAt = st.settingsAt || 0;
  if (!known && remote.settings?.at > lsetAt) { const merged = { ...lset }; for (const k of SET_KEYS) if (k in remote.settings.data) merged[k] = remote.settings.data[k]; await db.kv.set('settings', merged); await db.kv.set('settingsAt', remote.settings.at); setAt = remote.settings.at; hooks.onChange({ settings: true }); }
  else if (!known && remote.settings?.at) setAt = Math.max(setAt, remote.settings.at);
  const curSetAt = (await db.kv.get('settingsAt')) || 0;
  if (curSetAt > setAt) m.changed = true;
  if (!m.changed && fileId) { await db.kv.set('notesSync', { fileId, version: ver, deleted: m.deleted, settingsAt: setAt }); await clearDel(localDel); return; }
  local = await db.all('notes');
  const sent = new Map(local.map(n => [n.id, n.updatedAt]));
  const body = JSON.stringify({ v: 1, app: 'jipilsil', savedAt: new Date().toISOString(), notes: local.map(contentOfId), deleted: m.deleted, settings: curSetAt ? { at: curSetAt, data: pickSet(await db.kv.get('settings') || {}) } : (remote.settings || undefined) }, null, 1);
  // 올리기 직전 다시 확인: 그 사이 다른 기기가 올렸으면 다음 동기화에서 다시 합침
  if (fileId) { const f = await api(`${API}/files/${fileId}?fields=version`).then(j); if (f.version !== ver) { await db.kv.set('notesSync', { ...st, fileId, version: null }); return; } }
  let res;
  if (fileId) { const mp = multipart({ name: '설계 노트.json' }, body, 'application/json'); res = await api(`${UP}/files/${fileId}?uploadType=multipart&fields=id,version`, { method: 'PATCH', headers: { 'Content-Type': mp.type }, body: mp.blob }).then(j); }
  else { const mp = multipart({ name: '설계 노트.json', mimeType: 'application/json', parents: [rootId], appProperties: { ywKind: 'notes' }, description: '집필실 설계 노트(소스·아이디어·시퀀스) 백업 · 앱에서 고쳐 주세요' }, body, 'application/json'); res = await api(`${UP}/files?uploadType=multipart&fields=id,version`, { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.blob }).then(j); }
  if (!res.version) { try { res.version = (await api(`${API}/files/${res.id}?fields=version`).then(j)).version; } catch (e) { if (e instanceof NeedAuth) throw e; } }
  for (const n of local) await db.update('notes', n.id, c => c && c.updatedAt === sent.get(n.id) ? (c.dirty = false, c.base = contentKey(c), c) : undefined);
  await db.kv.set('notesSync', { fileId: res.id, version: res.version, deleted: m.deleted, settingsAt: Math.max(curSetAt, setAt) });
  await clearDel(localDel);
  hooks.onChange({ notes: true });
}
async function clearDel(done) { const cur = (await db.kv.get('noteDel')) || {}; for (const id of Object.keys(done)) delete cur[id]; await db.kv.set('noteDel', cur); }
const contentOfId = n => ({ id: n.id, ...contentOf(n), ...(n.conflictOf ? { conflictOf: n.conflictOf } : {}) });

// ---------- AI 작업 (설계 노트와 같은 방식: 기록 단위 병합, 양쪽 수정은 사본으로 둘 다 보관) ----------
const aiOfId = r => ({ id: r.id, ...aiContentOf(r), ...(r.conflictOf ? { conflictOf: r.conflictOf } : {}) });
async function syncAI(rootId) {
  const st = (await db.kv.get('aiSync')) || {};
  const localDel = (await db.kv.get('aiDel')) || {};
  let local = await db.all('aiwork');
  let fileId = st.fileId, ver = null;
  if (fileId) {
    try { const f = await api(`${API}/files/${fileId}?fields=id,version,trashed`).then(j); if (f.trashed) fileId = null; else ver = f.version; }
    catch (e) { if (e instanceof NeedAuth) throw e; if (e.status === 404) fileId = null; else throw e; }
  }
  if (!fileId) {
    const found = await listAll(`${prop('ywKind', 'aiwork')} and trashed=false`);
    if (found[0]) { fileId = found[0].id; const f = await api(`${API}/files/${fileId}?fields=id,version`).then(j); ver = f.version; }
  }
  if (!fileId && !local.length && !Object.keys(localDel).length) return;
  let remote = { items: [], deleted: {} };
  const known = fileId && st.fileId === fileId && st.version === ver;
  if (fileId && !known) {
    try { remote = JSON.parse(await api(`${API}/files/${fileId}?alt=media`).then(r => r.text())); } catch (e) { if (e instanceof NeedAuth) throw e; if (!(e instanceof SyntaxError)) throw e; }
    remote.items = remote.items || []; remote.deleted = remote.deleted || {};
  }
  let m;
  if (known) m = { put: [], del: [], deleted: { ...(st.deleted || {}), ...localDel }, copies: 0, changed: local.some(n => n.dirty || !n.base) || Object.keys(localDel).some(id => !(st.deleted || {})[id]) };
  else m = mergeNotes(local, localDel, remote, () => uid('a'), { contentOf: aiContentOf, contentKey: aiContentKey, items: 'items' });
  for (const n of m.put) await db.update('aiwork', n.id, c => (c && c.dirty && c.updatedAt !== (local.find(x => x.id === n.id)?.updatedAt)) ? undefined : n);
  for (const id of m.del) await db.del('aiwork', id);
  if (m.put.length || m.del.length) hooks.onChange({ ai: true, aiCopies: m.copies });
  const clr = async done => { const cur = (await db.kv.get('aiDel')) || {}; for (const id of Object.keys(done)) delete cur[id]; await db.kv.set('aiDel', cur); };
  if (!m.changed && fileId) { await db.kv.set('aiSync', { fileId, version: ver, deleted: m.deleted }); await clr(localDel); return; }
  local = await db.all('aiwork');
  const sent = new Map(local.map(n => [n.id, n.updatedAt]));
  const body = JSON.stringify({ v: 1, app: 'jipilsil', kind: 'aiwork', savedAt: new Date().toISOString(), items: local.map(aiOfId), deleted: m.deleted });
  if (fileId) { const f = await api(`${API}/files/${fileId}?fields=version`).then(j); if (f.version !== ver) { await db.kv.set('aiSync', { ...st, fileId, version: null }); return; } }
  let res;
  if (fileId) { const mp = multipart({ name: 'AI 작업.json' }, body, 'application/json'); res = await api(`${UP}/files/${fileId}?uploadType=multipart&fields=id,version`, { method: 'PATCH', headers: { 'Content-Type': mp.type }, body: mp.blob }).then(j); }
  else { const mp = multipart({ name: 'AI 작업.json', mimeType: 'application/json', parents: [rootId], appProperties: { ywKind: 'aiwork' }, description: '집필실 AI 작업(가져온 자료·비교·작법 교재) 백업 · 앱에서 고쳐 주세요' }, body, 'application/json'); res = await api(`${UP}/files?uploadType=multipart&fields=id,version`, { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.blob }).then(j); }
  if (!res.version) { try { res.version = (await api(`${API}/files/${res.id}?fields=version`).then(j)).version; } catch (e) { if (e instanceof NeedAuth) throw e; } }
  for (const n of local) await db.update('aiwork', n.id, c => c && c.updatedAt === sent.get(n.id) ? (c.dirty = false, c.base = aiContentKey(c), c) : undefined);
  await db.kv.set('aiSync', { fileId: res.id, version: res.version, deleted: m.deleted });
  await clr(localDel);
  hooks.onChange({ ai: true });
}
