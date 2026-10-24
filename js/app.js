// 집필실 — 메인 앱 (쓰는 오늘, 완성의 내일로)
import * as db from './db.js';
import * as Drive from './drive.js';
import { Dictation, Reader, Recorder, ttsSupported, sttSupported, recSupported, koVoices, onVoicesChanged } from './audio.js';
import { $, $$, esc, pad2, normalizeText, tidyPaste, counts, fmtTime, fmtDur, decodeText, detectEpisodeNo, titleFromFilename,
  makeZip, docxParts, makeDocx, zipBytes, download, safeName, diffHTML, canon, looseKey } from './util.js';
import * as EX from './exporters.js';
import { UndoStack } from './history.js';
import { listRows, castRows, toCSV, STATUS, syncLabel } from './tables.js';
import { NTYPE, noteToText, searchText } from './notes.js';
import { initAI } from './aiui.js';

const REPO = window.YW_CONFIG?.REPO || 'lee860506-tech/jipilsil';
const penLabel = () => (S.settings.penName || '').trim() ? S.settings.penName.trim() + ' 작가님' : '작가님';
const S = {
  works: [], eps: new Map(),   // workId -> episodes (정렬됨)
  cur: null,                   // 현재 회차 id
  pending: false, saving: false, lastInput: 0,
  syncState: 'idle',           // idle | syncing | synced | offline | needauth | error
  settings: { theme: 'light', fontSize: 18, snapMin: 10, tidy: true, font: 'serif', lineH: 1.9, goal: 1000, focusMin: 25, breakMin: 5 },
  tab: 'home', pasteChars: 0,
  open: new Set(),
};
window.__yw = S; // 테스트·디버그용

const REASON = { 'before-reread': '재독 수정 전', auto: '자동 저장', manual: '직접 저장', 'before-restore': '복원 전', 'before-pull': '드라이브 받기 전', 'before-paste': '붙여넣기 전', 'before-import': '가져오기 전', 'conflict-local': '충돌 · 이 기기', 'conflict-remote': '충돌 · 드라이브', 'before-revise': '수정본 반영 전', 'before-replace': '바꾸기 전', open: '열었을 때' };

// ================= 공통 UI =================
let toastH, toastT;
const STK = { fighting: 'img/fighting.webp', great: 'img/great.webp', oops: 'img/oops.webp', focus: 'img/focus.webp' };
function toast(msg, ms = 2800, stk, action) {
  const t = $('#toast');
  clearTimeout(toastH);
  try { if (t.showPopover) { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); } else { const d = $('#dlg'); (d.open ? d : document.body).appendChild(t); } } catch (e) {} t.innerHTML = (stk ? `<img class="t-stk" src="${STK[stk]}" alt="">` : '') + `<span>${esc(msg)}</span>` + (action ? `<button type="button" class="btn small brand t-act">${esc(action.label)}</button>` : ''); t.hidden = false; t.classList.add('on');
  if (action) t.querySelector('.t-act').onclick = () => { clearTimeout(toastT); t.classList.remove('on'); t.hidden = true; action.fn(); };
  clearTimeout(toastT); clearTimeout(toastH); toastT = setTimeout(() => { t.classList.remove('on'); toastH = setTimeout(() => t.hidden = true, 250); }, ms); // 앞 알림의 숨기기가 새 알림을 지우지 않게
}
function dialog({ title, html = '', buttons = [{ label: '확인', value: 'ok', cls: 'gold' }], wide = false, onOpen }) {
  const d = $('#dlg'); const f = $('#dlgForm');
  d.classList.toggle('wide', wide);
  f.innerHTML = `<h3>${esc(title)}</h3><div class="dlg-body">${html}</div><div class="dlg-btns">${buttons.map(b => `<button value="${esc(b.value)}" class="btn ${b.cls || 'ghost'}">${esc(b.label)}</button>`).join('')}</div>`;
  return new Promise(res => {
    const done = () => { d.removeEventListener('close', done); res(d.returnValue || 'cancel'); };
    d.returnValue = ''; d.addEventListener('close', done);
    d.showModal(); onOpen?.(f);
    const first = f.querySelector('input,textarea,select'); if (first) setTimeout(() => first.focus(), 30);
  });
}
async function ask(title, label, value = '', ph = '') {
  let v = null;
  const r = await dialog({ title, html: `<label class="fld">${esc(label)}<input id="askIn" value="${esc(value)}" placeholder="${esc(ph)}" maxlength="80"></label>`,
    buttons: [{ label: '취소', value: 'cancel' }, { label: '확인', value: 'ok', cls: 'gold' }],
    onOpen: f => { const i = f.querySelector('#askIn'); i.addEventListener('input', () => v = i.value); v = i.value; i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#dlg').close('ok'); } }); } });
  return r === 'ok' ? (v ?? '').trim() : null;
}
const confirmBox = (title, msg, okLabel = '확인', cls = 'gold') => dialog({ title, html: `<p>${msg}</p>`, buttons: [{ label: '취소', value: 'cancel' }, { label: okLabel, value: 'ok', cls }] }).then(r => r === 'ok');

// ================= 데이터 =================
const sortEps = a => a.sort((x, y) => (x.order ?? 0) - (y.order ?? 0) || x.createdAt - y.createdAt);
async function loadAll() {
  S.works = (await db.all('works')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
  const eps = await db.all('episodes'); S.eps = new Map(S.works.map(w => [w.id, []]));
  for (const e of eps) { if (!S.eps.has(e.workId)) S.eps.set(e.workId, []); S.eps.get(e.workId).push(e); }
  for (const a of S.eps.values()) sortEps(a);
}
const findEp = id => { for (const a of S.eps.values()) { const e = a.find(x => x.id === id); if (e) return e; } return null; };
const epIndex = ep => (S.eps.get(ep.workId) || []).findIndex(x => x.id === ep.id);
const labelOf = ep => Drive.episodeLabel(ep, epIndex(ep));
const workOf = ep => S.works.find(w => w.id === ep.workId);

async function newWork(title) {
  const w = { id: db.uid('w'), title, order: S.works.length, createdAt: Date.now(), updatedAt: Date.now(), dirty: true };
  await db.put('works', w); S.works.push(w); S.eps.set(w.id, []); S.open.add(w.id); saveOpen();
  return w;
}
async function newEpisode(workId, { text = '', title = '', order } = {}) {
  const list = S.eps.get(workId) || [];
  const ep = { id: db.uid('e'), workId, order: order ?? (list.length ? (list[list.length - 1].order ?? list.length) + 1 : 0), title, label: '', memo: '', text: normalizeText(text),
    status: 'draft', oneLine: '', createdAt: Date.now(), updatedAt: Date.now(), rev: 1, dirty: true, drive: null };
  await db.put('episodes', ep); list.push(ep); sortEps(list); S.eps.set(workId, list);
  scheduleSync();
  return ep;
}
async function renumber(workId) { // 순서를 0..n 으로 정리하고, 드라이브 이름이 바뀌므로 모두 다시 올림
  const list = sortEps(S.eps.get(workId) || []);
  for (let i = 0; i < list.length; i++) {
    const id = list[i].id;
    const u = await db.update('episodes', id, c => c && (c.order = i, c.dirty = true, c.rev = (c.rev || 0) + 1, c));
    if (u) Object.assign(list[i], u);
  }
  scheduleSync();
}

// ================= 버전 기록 =================
async function versionsOf(epId) { return (await db.byIndex('versions', 'episodeId', epId)).sort((a, b) => b.at - a.at); }
async function snapshot(ep, reason = 'auto', label = '') {
  const vs = await versionsOf(ep.id);
  if (reason === 'auto' || reason === 'open') { if (vs[0] && canon(vs[0].text) === canon(ep.text)) return null; }
  else if (reason !== 'manual') { const same = vs.find(x => x.reason === reason); if (same && canon(same.text) === canon(ep.text)) return null; } // 같은 이유·같은 내용은 한 번만 (여러 번 확인해도 기록이 쌓이지 않게)
  if (!ep.text && !vs.length && reason !== 'manual') return null;
  const v = { id: db.uid('v'), episodeId: ep.id, workId: ep.workId, text: ep.text || '', title: ep.title || '', at: Date.now(), reason, label, chars: counts(ep.text).all };
  await db.put('versions', v);
  const autos = vs.filter(x => x.reason === 'auto' || x.reason === 'open');
  for (const old of autos.slice(80)) await db.del('versions', old.id); // 자동 기록은 최근 80개까지
  if (S.cur === ep.id && !$('#panel').hidden) renderHist();
  return v;
}
async function maybeAutoSnapshot(ep) {
  const vs = await versionsOf(ep.id);
  const last = vs[0]?.at || 0;
  if (Date.now() - last >= S.settings.snapMin * 60_000) await snapshot(ep, 'auto');
}

// ================= 저장 =================
let saveT, syncT;
function markPending() {
  S.pending = true; S.lastInput = Date.now(); updateStatus();
  clearTimeout(saveT); saveT = setTimeout(flushSave, 1200);
}
async function flushSave() {
  clearTimeout(saveT);
  if (!S.pending || !S.cur) { S.pending = false; updateStatus(); return; }
  S.pending = false; S.saving = true; updateStatus();
  const id = S.cur; const pasted0 = S.pasteChars; const text = $('#editor').value; const title = $('#epTitle').value.trim(); const memo = $('#epMemo').value;
  const tEdit = S.titleEdit; S.titleEdit = false; // 제목 칸을 직접 고쳤을 때만 제목을 씀 (다른 기기·메뉴에서 바꾼 제목을 옛 글자로 덮지 않게)
  try {
    let delta = 0;
    const u = await db.update('episodes', id, c => {
      if (!c) return undefined;
      delta = [...text].length - [...(c.text || '')].length;
      const nt = tEdit ? title : (c.title || '');
      if (c.text === text && (c.title || '') === nt && (c.memo || '') === memo) return undefined;
      c.text = text; c.title = nt; c.memo = memo; c.rev = (c.rev || 0) + 1; c.dirty = true; c.updatedAt = Date.now();
      return c;
    });
    if (u) {
      const ep = findEp(id); if (ep) Object.assign(ep, u);
      const pasted = pasted0; S.pasteChars = Math.max(0, S.pasteChars - pasted0); // 이 저장에 들어간 붙여넣기만 빼기
      if (delta > 0) await addWritten(Math.max(0, delta - pasted)); // 붙여넣은 글자는 '오늘의 집필'에서 빼고 직접 쓴 글자만
      await maybeAutoSnapshot(u); refreshEpRow(id); scheduleSync();
    } else S.pasteChars = Math.max(0, S.pasteChars - pasted0);
  } catch (e) { console.warn(e); toast('저장 실패: ' + e.message); S.pending = true; S.titleEdit = S.titleEdit || tEdit; }
  S.saving = false; updateStatus();
}
setInterval(() => { if (S.pending && Date.now() - S.lastInput > 3000) flushSave(); }, 3000); // 몇 초마다 자동 저장

function scheduleSync(delay = 5000) {
  clearTimeout(syncT);
  syncT = setTimeout(() => runSync('auto'), delay);
}
function runSync(why) {
  // 한 번에 하나만: 진행 중이면 끝난 뒤 한 번 더 (focus·visibility·타이머가 겹쳐도 중복 확인 없음)
  if (S.syncP) { S.syncAgain = S.syncAgain || why; return S.syncP; }
  S.syncP = (async () => { try { await runSyncOnce(why); while (S.syncAgain) { const w = S.syncAgain; S.syncAgain = null; await runSyncOnce(w); } } finally { S.syncP = null; } })();
  return S.syncP;
}
async function runSyncOnce(why) {
  if (!navigator.onLine) { S.syncState = 'offline'; updateStatus(); return; }
  if (!Drive.hasValidToken()) { S.syncState = (await Drive.wasConnected()) ? 'needauth' : 'idle'; updateStatus(); if (S.syncState === 'needauth' && why !== 'open') authNag(); return; }
  await flushSave();
  try { await Drive.sync(why); }
  catch (e) {
    if (e instanceof Drive.NeedAuth) S.syncState = 'needauth';
    else { S.syncState = 'error'; console.warn('sync', e, e.body); if (why === 'manual') toast('동기화 오류: ' + e.message + ' — 원고는 기기에 안전하게 저장돼 있어요.', 4500, 'oops'); S.retryN = (S.retryN || 0) + 1; scheduleSync(Math.min(300000, 15000 * 2 ** (S.retryN - 1))); }
  }
  if (S.syncState !== 'error') S.retryN = 0;
  await loadAll(); renderSide(); updateStatus(); refreshConflictBanner(); rerenderTab();
}

async function pendingCount() {
  const eps = await db.all('episodes'); const ms = await db.all('memos'); const tb = await db.all('tombstones'); const nts = await db.all('notes');
  return nts.filter(n => n.dirty || !n.base).length + eps.filter(e => e.dirty && !e.conflict).length + ms.filter(m => !m.driveFileId).length + tb.length + S.works.filter(w => w.dirty || !w.driveFolderId).length;
}
async function updateStatus() {
  const el = $('#saveStatus'); if (!el) return;
  // 위쪽 상태: 「기기에 저장됨」과 「드라이브에 저장됨」을 나눠서 보여 줌
  const linked = await Drive.wasConnected();
  const n = await pendingCount();
  const cur = S.cur ? findEp(S.cur) : null; const lastSync = await db.kv.get('lastSync');
  const hm = t => { const d = new Date(t); return `${d.getHours()}:${pad2(d.getMinutes())}`; };
  let cls, txt, act = null;
  if (S.pending || S.saving) { cls = 'y'; txt = '저장 중…'; }
  else if (!navigator.onLine) { cls = 'r'; txt = '인터넷 없음 — 기기에 임시 저장'; }
  else if (!linked) { cls = 'g'; txt = '기기에 저장됨'; }
  else if (S.syncState === 'needauth' || !Drive.hasValidToken()) { cls = 'o'; txt = '기기에 저장됨 · 드라이브 연결 만료'; act = ['reauth', '다시 연결']; }
  else if (S.syncState === 'syncing') { cls = 'y'; txt = '기기에 저장됨 · 드라이브 올리는 중'; }
  else if (S.syncState === 'error') { cls = 'r'; txt = '기기에 저장됨 · 드라이브 저장 실패'; act = ['retry', '다시 시도']; }
  else if (cur?.conflict) { cls = 'o'; txt = '드라이브와 내용이 달라요'; act = ['resolve', '비교하기']; }
  else if (cur ? cur.dirty : n) { cls = 'y'; txt = '기기에 저장됨 · 드라이브 대기'; }
  else { cls = 'g'; txt = lastSync ? `드라이브 ${hm(lastSync)} 저장` : '드라이브 저장됨'; }
  el.className = 'save-status ' + cls; el.querySelector('span').textContent = txt;
  el.title = linked ? (lastSync ? `마지막 드라이브 동기화: ${fmtTime(lastSync)}` : '아직 드라이브 동기화 전') : '구글 드라이브 미연결 · 이 기기에만 저장 중';
  const ab = $('#btnStatusAct'); if (ab) { ab.hidden = !act; if (act) { ab.dataset.act = act[0]; ab.textContent = act[1]; } }
  const kp = $('#kbPill'); if (kp) { kp.className = 'kb-pill ' + cls; kp.querySelector('span').textContent = txt; }
  let line;
  if (!linked) line = '☁ 드라이브 미연결 · 기기에만 저장 중';
  else if (!navigator.onLine) line = `🔴 오프라인 · 연결되면 ${n}건 자동 업로드`;
  else if (S.syncState === 'needauth' || !Drive.hasValidToken()) line = `☁ 드라이브 다시 연결 필요${n ? ` · 대기 ${n}건` : ''}`;
  else if (S.syncState === 'syncing') line = '🟡 드라이브 동기화 중…';
  else if (S.syncState === 'error') line = `⚠ 동기화 잠시 실패 · 다시 시도할게요${n ? ` (${n}건)` : ''}`;
  else line = n ? `🟡 드라이브 대기 ${n}건` : `🟢 드라이브 저장 완료${(await db.kv.get('lastSync')) ? ' · ' + fmtTime(await db.kv.get('lastSync')) : ''}`;
  const sl = $('#syncLine');
  sl.innerHTML = `<span>${esc(line)}</span>` + (linked && (S.syncState === 'needauth' || !Drive.hasValidToken()) && navigator.onLine ? '<button class="btn small" id="btnReauth">다시 연결</button>' : (linked && navigator.onLine ? '<button class="btn small ghost" id="btnSyncNow">지금 동기화</button>' : ''));
  $('#syncBadge').textContent = line;
}
Drive.setHooks({
  snapshot: (ep, reason, label) => snapshot(ep, reason, label),
  onStatus: s => { S.syncState = s; updateStatus(); },
  onChange: async ch => {
    if (ch.settings) { S.settings = { ...S.settings, ...((await db.kv.get('settings')) || {}) }; applySettings(); if (!['note'].includes(S.tab)) rerenderTab(); return; }
    if (ch.notes) { if (ch.copies) toast(`설계 노트 ${ch.copies}개가 두 기기에서 따로 바뀌어서, 드라이브 버전을 「(다른 기기 버전)」 사본으로 함께 남겼어요`, 6000, 'oops'); if (S.tab === 'vault' && S.vaultTab === 'notes' && !$('#dlg').open) renderVault(); if (!$('#panel').hidden && paneTab === 'notes') renderPaneNotes(); return; }
    if (ch.ai) { if (ch.aiCopies) toast(`AI 작업 ${ch.aiCopies}개가 두 기기에서 따로 바뀌어서, 드라이브 버전을 「(다른 기기 버전)」 사본으로 함께 남겼어요`, 6000, 'oops'); AI.onRemote(); return; }
    if (ch.conflictCleared && ch.episode === S.cur) { refreshConflictBanner(); updateStatus(); }
    if (ch.episode && ch.episode === S.cur && ch.textChanged) {
      const ep = await db.get('episodes', S.cur);
      if (ep && looseKey(ed.value) !== looseKey(ep.text) && (S.pending || canon(ed.value) !== canon(ch.prevText ?? ep.text))) {
        // 받는 사이 이 기기에서도 썼어요 → 덮지 않고 둘 다 보관 + 선택 창
        S.pending = false; clearTimeout(saveT);
        const local = ed.value, title = $('#epTitle').value.trim();
        await snapshot({ ...ep, text: local }, 'conflict-local', '충돌: 이 기기 버전');
        await snapshot(ep, 'conflict-remote', '충돌: 드라이브 버전');
        await db.update('episodes', ep.id, c => c && (c.conflict = { remoteText: c.text, remoteModifiedTime: c.drive?.modifiedTime, fileId: c.drive?.fileId, at: Date.now() }, c.text = local, c.title = (S.titleEdit && title) || c.title, c.rev = (c.rev || 0) + 1, c.dirty = true, c.updatedAt = Date.now(), c));
        await loadAll(); refreshConflictBanner(); updateStatus();
        toast('다른 기기에서 바뀐 내용과 지금 쓰던 내용이 겹쳐요. 둘 다 보관했으니 골라 주세요.', 5000, 'oops');
        return;
      }
      if (ep && !S.pending) { const ed = $('#editor'); const pos = ed.selectionStart; ed.value = ep.text; $('#epTitle').value = ep.title || ''; $('#epMemo').value = ep.memo || ''; ed.setSelectionRange(pos, pos); updateCounts(); toast('드라이브에서 바뀐 내용을 불러왔어요 (이전 내용은 수정 기록에 있어요)'); }
    }
  },
  onConflict: ep => { toast(`⚠ ${ep.title || '회차'}: 기기와 드라이브 양쪽에서 바뀌었어요. 비교해서 골라 주세요.`, 5000); refreshConflictBanner(); },
});

$('#btnStatusAct').addEventListener('click', e => {
  const a = e.currentTarget.dataset.act;
  if (a === 'reauth') reconnect();
  else if (a === 'retry') { S.syncState = 'syncing'; updateStatus(); runSync('manual'); }
  else if (a === 'resolve' && S.cur) resolveUI(S.cur);
});
// 클릭 안에서 바로 로그인 창 열기 (팝업 차단 방지)
// ---------- 자동 재연결: 로그인(1시간)이 끝나기 전, 다음 터치 때 조용히 새로 받기 ----------
// 구글 토큰은 팝업으로만 새로 받을 수 있고, 팝업은 사용자의 터치 안에서만 열려요 → 아무 곳이나 누를 때(원고 입력칸 제외) 미리 갱신
let reauthAt = 0, reauthFails = 0;
document.addEventListener('pointerdown', e => {
  if (!navigator.onLine || !S.clientId || !Drive.gisReady() || $('#dlg').open) return;
  if (e.target.closest?.('#editor,#fQ,#fRep,input,textarea,select')) return;
  if (!Drive.isLinkedSync() || Drive.tokenLeft() > 10 * 60_000) return;
  if (Date.now() - reauthAt < (reauthFails ? Math.min(30, 2 ** reauthFails) * 60_000 : 60_000)) return;
  reauthAt = Date.now();
  Drive.connectNow(S.clientId, { silent: true }).then(() => { reauthFails = 0; S.syncState = 'idle'; updateStatus(); runSync('reauth'); })
    .catch(() => { reauthFails++; if (!Drive.hasValidToken()) authNag(true); });
}, true);
let nagAt = 0;
async function authNag(force) { // 정말 다시 로그인해야 할 때만, 눈에 띄게 한 번
  if (!$('#splash').hidden) { S.nagAfterSplash = true; return; } // 시작 화면 위에는 띄우지 않고, 들어간 뒤 바로 보여 줌
  if (!force && Date.now() - nagAt < 15 * 60_000) return; nagAt = Date.now();
  const n = await pendingCount();
  toast(`드라이브 로그인이 끝났어요${n ? ` · 올릴 것 ${n}건 대기 중` : ''}. 누르면 바로 이어져요 (원고는 기기에 안전해요)`, 12000, 'oops', { label: '다시 연결', fn: reconnect });
}
function reconnect() {
  Drive.connectNow(S.clientId, { silent: true })
    .catch(async er => { if (!er.notReady) throw er; await Drive.loadGIS(); return Drive.connectNow(S.clientId, { silent: true }); })
    .then(() => { toast('드라이브에 다시 연결했어요', 2500, 'great'); runSync('manual'); })
    .catch(er => toast(er.message, 6000, 'oops'));
}

// ================= 서재(사이드바) =================
async function saveOpen() { await db.kv.set('openWorks', [...S.open]); }
function epBadges(e) {
  let b = '';
  if (e.conflict) b += '<span class="bdg warn" title="충돌">⚠</span>';
  else if (e.remoteMissing) b += '<span class="bdg warn" title="드라이브에서 삭제됨">⊘</span>';
  else if (e.dirty) b += '<span class="bdg wait" title="드라이브 대기">●</span>';
  return b;
}
function renderSide() {
  const box = $('#workList');
  if (!S.works.length) {
    box.innerHTML = `<div class="side-empty"><p>아직 작품이 없어요.</p><p class="mute">「＋ 새 작품」을 눌러 RE:VERSE, 조건반사적 복종처럼<br>작품 폴더를 만들어 보세요.</p></div>`;
    return;
  }
  box.innerHTML = S.works.map(w => {
    const eps = S.eps.get(w.id) || []; const open = S.open.has(w.id);
    const total = eps.reduce((a, e) => a + counts(e.text).noSp, 0);
    return `<section class="work ${open ? 'open' : ''}" data-w="${w.id}">
      <div class="work-head"><button class="work-toggle" data-act="toggle" aria-expanded="${open}"><span class="chev">›</span><span class="wt">${esc(w.title)}</span><span class="wc">${eps.length}화 · ${total.toLocaleString()}자</span></button>
      <button class="icon-btn" data-act="workmenu" aria-label="작품 메뉴">⋯</button></div>
      <ol class="ep-list">${eps.map((e, i) => `<li class="ep ${e.id === S.cur ? 'cur' : ''}" data-e="${e.id}"><button class="ep-open" data-act="open"><span class="en">${esc(Drive.episodeLabel(e, i))}</span><span class="et">${esc(e.title || '')}</span><span class="ec">${counts(e.text).noSp.toLocaleString()}</span>${epBadges(e)}</button><button class="icon-btn sm" data-act="epmenu" aria-label="회차 메뉴">⋯</button></li>`).join('')}
      <li class="ep-add"><button data-act="addep">＋ 회차 추가</button></li></ol></section>`;
  }).join('');
  syncHeader();
}
function refreshEpRow(id) {
  const ep = findEp(id); const li = document.querySelector(`.ep[data-e="${id}"]`); if (!ep || !li) return;
  li.querySelector('.et').textContent = ep.title || ''; li.querySelector('.ec').textContent = counts(ep.text).noSp.toLocaleString();
  li.querySelectorAll('.bdg').forEach(b => b.remove()); li.querySelector('.ep-open').insertAdjacentHTML('beforeend', epBadges(ep));
}

$('#workList').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const wEl = b.closest('.work'); const wid = wEl?.dataset.w; const eid = b.closest('.ep')?.dataset.e;
  const act = b.dataset.act;
  if (act === 'toggle') { S.open.has(wid) ? S.open.delete(wid) : S.open.add(wid); saveOpen(); wEl.classList.toggle('open'); b.setAttribute('aria-expanded', S.open.has(wid)); }
  if (act === 'open') openEpisode(eid);
  if (act === 'addep') { const ep = await newEpisode(wid); renderSide(); openEpisode(ep.id); }
  if (act === 'workmenu') workMenu(wid);
  if (act === 'epmenu') epMenu(eid);
});

async function workMenu(wid) {
  const w = S.works.find(x => x.id === wid);
  const r = await dialog({ title: w.title, html: '<p class="mute">작품 메뉴</p>', buttons: [
    { label: '이름 바꾸기', value: 'rename' }, { label: 'TXT 가져오기', value: 'import' }, { label: '내보내기 (TXT·MD·한글·PDF…)', value: 'export' },
    { label: '위로', value: 'up' }, { label: '삭제', value: 'del', cls: 'danger' }, { label: '닫기', value: 'cancel' }] });
  if (r === 'rename') { const t = await ask('작품 이름 바꾸기', '작품 이름', w.title); if (t) await setWorkTitle(wid, t); }
  if (r === 'import') pickImport(wid);
  if (r === 'export') exportDialog(wid, null);
  if (r === 'up') { const i = S.works.indexOf(w); if (i > 0) { [S.works[i - 1], S.works[i]] = [S.works[i], S.works[i - 1]]; for (let k = 0; k < S.works.length; k++) { const id = S.works[k].id; S.works[k].order = k; await db.update('works', id, c => (c.order = k, c)); } renderSide(); } }
  if (r === 'del') {
    const n = (S.eps.get(wid) || []).length;
    if (await confirmBox('작품 삭제', `「${esc(w.title)}」와 회차 ${n}개를 이 기기에서 지울까요?<br>드라이브의 폴더는 <b>휴지통</b>으로 옮겨져 30일 동안 복구할 수 있어요.`, '삭제', 'danger')) {
      if (w.driveFolderId) await db.put('tombstones', { id: wid, kind: 'work', fileId: w.driveFolderId, at: Date.now() });
      for (const ep of S.eps.get(wid) || []) { await db.put('tombstones', { id: ep.id, kind: 'episode', fileId: null, at: Date.now() }); await db.del('episodes', ep.id); }
      await db.del('works', wid);
      if (findEp(S.cur)?.workId === wid) closeEditor();
      await loadAll(); renderSide(); scheduleSync(1000);
    }
  }
}
async function epMenu(eid) {
  const ep = findEp(eid); const i = epIndex(ep); const list = S.eps.get(ep.workId);
  const r = await dialog({ title: `${labelOf(ep)} ${ep.title || ''}`, html: '<p class="mute">회차 메뉴 · 순서를 바꾸면 번호(01화, 02화…)가 자동으로 다시 매겨져요.</p>', buttons: [
    { label: '제목 바꾸기', value: 'title' }, { label: '번호 이름 (예: 프롤로그, 외전 1)', value: 'label' }, { label: '▲ 위로', value: 'up' }, { label: '▼ 아래로', value: 'down' },
    ...(ep.remoteMissing ? [{ label: '드라이브에 다시 올리기', value: 'reup' }] : []), { label: '삭제', value: 'del', cls: 'danger' }, { label: '닫기', value: 'cancel' }] });
  if (r === 'title') { const t = await ask('회차 제목', '제목', ep.title || ''); if (t !== null) await setEpTitle(eid, t); }
  if (r === 'label') { const t = await ask('번호 이름', '비워 두면 자동 번호 (예: 03화)', ep.label || '', '프롤로그'); if (t !== null) await setEpLabel(eid, t); }
  if (r === 'up' || r === 'down') {
    const j = r === 'up' ? i - 1 : i + 1; if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]]; list.forEach((x, k) => x.order = k); await renumber(ep.workId); renderSide(); updateCrumb();
  }
  if (r === 'reup') { await db.update('episodes', eid, c => (c.drive = null, c.remoteMissing = false, c.dirty = true, c)); await loadAll(); renderSide(); runSync('manual'); }
  if (r === 'del') {
    if (await confirmBox('회차 삭제', `「${esc(labelOf(ep))} ${esc(ep.title || '')}」를 지울까요?<br>드라이브의 문서는 휴지통으로 옮겨져 복구할 수 있어요. 이 기기의 수정 기록은 남겨 둘게요.`, '삭제', 'danger')) {
      await snapshot(ep, 'manual', '삭제 직전');
      await db.put('tombstones', { id: eid, kind: 'episode', fileId: ep.drive?.fileId || null, at: Date.now() });
      await db.del('episodes', eid); list.splice(i, 1);
      if (S.cur === eid) closeEditor();
      await renumber(ep.workId); renderSide(); scheduleSync(1000);
    }
  }
}

$('#btnNewWork').onclick = async () => {
  const t = await ask('새 작품', '작품 이름', '', '예: RE:VERSE'); if (!t) return;
  const w = await newWork(t); const ep = await newEpisode(w.id); renderSide(); openEpisode(ep.id); scheduleSync();
};

// ================= 집필 화면 =================
const ed = $('#editor');
// ---------- 이름 바꾸기 (메뉴·머리줄 어디서든 같은 길로: 저장 → 화면 → 드라이브 동기화) ----------
async function setWorkTitle(wid, t) {
  t = (t || '').trim(); const w = S.works.find(x => x.id === wid); if (!w || !t || t === w.title) return;
  await db.update('works', wid, c => c && (c.title = t, c.dirty = true, c)); w.title = t; renderSide(); scheduleSync();
}
async function setEpTitle(eid, t) {
  t = (t || '').trim(); const ep = findEp(eid); if (!ep) return;
  if (S.cur === eid && S.pending) await flushSave(); // 쓰던 글을 먼저 저장
  await db.update('episodes', eid, c => c && (c.title = t, c.dirty = true, c.rev = (c.rev || 0) + 1, c.updatedAt = Date.now(), c)); ep.title = t;
  if (S.cur === eid) { $('#epTitle').value = t; S.titleEdit = false; }
  renderSide(); scheduleSync();
}
async function setEpLabel(eid, t) { // 비우거나 자동 번호와 같으면 자동 번호로 돌아감
  const ep = findEp(eid); if (!ep) return;
  const auto = Drive.episodeLabel({ label: '' }, epIndex(ep)); t = (t || '').trim(); if (t === auto) t = '';
  if (t === (ep.label || '')) { updateCrumb(); return; }
  if (S.cur === eid && S.pending) await flushSave();
  await db.update('episodes', eid, c => c && (c.label = t, c.dirty = true, c.rev = (c.rev || 0) + 1, c.updatedAt = Date.now(), c)); ep.label = t;
  renderSide(); updateCrumb(); scheduleSync();
}
// 머리줄의 제목·화는 그 자리에서 눌러 바로 고침 (제목 칸은 원래 입력칸)
function syncHeader() {
  const ep = S.cur && findEp(S.cur); if (!ep) return;
  const ti = $('#epTitle'); if (!S.titleEdit && document.activeElement !== ti && ti.value !== (ep.title || '')) ti.value = ep.title || '';
  updateCrumb();
}
function updateCrumb() {
  const ep = findEp(S.cur); if (!ep) return;
  const box = $('#crumbWork');
  if (!box.querySelector('input')) box.innerHTML = `<span class="cw" role="button" tabindex="0" title="작품 이름 바꾸기">${esc(workOf(ep)?.title || '')}</span> <b class="cl" role="button" tabindex="0" title="번호 이름 바꾸기 (예: 프롤로그, 외전 1)">· ${esc(labelOf(ep))}</b>`;
  updateEpNav();
}
function crumbEdit(kind) {
  const ep = findEp(S.cur); if (!ep) return; const box = $('#crumbWork'); if (box.querySelector('input')) return;
  const el = box.querySelector(kind === 'work' ? '.cw' : '.cl'); if (!el) return;
  const eid = ep.id; const w = workOf(ep);
  const inp = document.createElement('input'); inp.className = 'crumb-in'; inp.maxLength = 80;
  inp.value = kind === 'work' ? (w?.title || '') : labelOf(ep);
  inp.setAttribute('aria-label', kind === 'work' ? '작품 이름' : '번호 이름 (비우면 자동 번호)'); if (kind === 'label') inp.placeholder = Drive.episodeLabel({ label: '' }, epIndex(ep));
  const fit = () => { inp.style.width = Math.max(5, [...inp.value].length * 1.1 + 1.6) + 'em'; }; fit(); inp.addEventListener('input', fit);
  let done = false;
  const end = async ok => {
    if (done) return; done = true; const v = inp.value;
    inp.remove(); box.innerHTML = ''; updateCrumb();
    if (ok) { if (kind === 'work') await setWorkTitle(w.id, v); else await setEpLabel(eid, v); }
    updateCrumb();
  };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } });
  inp.addEventListener('blur', () => end(true));
  el.replaceWith(inp); inp.focus(); inp.select();
}
$('#crumbWork').addEventListener('click', e => { const t = e.target.closest('.cw,.cl'); if (t) crumbEdit(t.classList.contains('cw') ? 'work' : 'label'); });
$('#crumbWork').addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== ' ') return; const t = e.target.closest?.('.cw,.cl'); if (t) { e.preventDefault(); crumbEdit(t.classList.contains('cw') ? 'work' : 'label'); } });
// ---------- 이전화 / 다음화 (같은 작품 안, 회차 순서대로) ----------
function epSiblings() { const ep = findEp(S.cur); if (!ep) return {}; const list = S.eps.get(ep.workId) || []; const i = list.findIndex(e => e.id === ep.id); return { ep, list, i, prev: list[i - 1] || null, next: list[i + 1] || null }; }
const epName = e => e ? labelOf(e) + (e.title ? ' ' + e.title : '') : '';
function epEndHTML() {
  const { ep, prev, next } = epSiblings(); if (!ep) return '';
  return `<div class="ee-in"><p class="ee-done">${esc(labelOf(ep))} 끝 ♡</p><div class="ee-btns">
    <button type="button" class="ee-b" data-epnav="-1" ${prev ? '' : 'disabled'}><small>‹ 이전화</small><b>${prev ? esc(epName(prev)) : '첫 회차예요'}</b></button>
    ${next ? `<button type="button" class="ee-b next" data-epnav="1"><small>다음화 ›</small><b>${esc(epName(next))}</b></button>` : `<button type="button" class="ee-b new" data-epnew><small>마지막 회차예요</small><b>＋ 새 회차</b></button>`}</div></div>`;
}
function updateEpNav() {
  const { ep, prev, next } = epSiblings(); if (!ep) return;
  $$('[data-epnav="-1"]').forEach(b => { if (!b.closest('.ee-in')) { b.disabled = !prev; b.title = prev ? `이전화: ${epName(prev)} (Alt+←)` : '첫 회차예요'; } });
  $$('[data-epnav="1"]').forEach(b => { if (!b.closest('.ee-in')) { b.disabled = !next; b.title = next ? `다음화: ${epName(next)} (Alt+→)` : '마지막 회차예요'; } });
  $('#rbLabel').textContent = labelOf(ep);
  const end = $('#epEnd'); if (end) end.innerHTML = epEndHTML();
  const rd = $('#reader'); if (rd && !rd.hidden) { rd.querySelector('.ep-end-r')?.remove(); rd.insertAdjacentHTML('beforeend', `<div class="ep-end ep-end-r">${epEndHTML()}</div>`); }
  checkEpEnd();
}
// 재독(읽기)에서 원고 끝까지 내려오면 아래 빈 여백에 큰 버튼 (글은 가리지 않음)
function checkEpEnd() {
  const end = $('#epEnd'); if (!end) return;
  const reading = $('#editorView').classList.contains('rereading') && !ed.hidden;
  const atEnd = ed.scrollTop + ed.clientHeight >= ed.scrollHeight - innerHeight * 0.3;
  end.hidden = !(reading && atEnd);
}
ed.addEventListener('scroll', () => { if ($('#editorView').classList.contains('rereading')) checkEpEnd(); }, { passive: true });
let epNavBusy = false;
async function goEpisode(dir) {
  if (epNavBusy) return; const { ep, prev, next } = epSiblings(); const to = dir < 0 ? prev : next; if (!ep || !to) return;
  epNavBusy = true;
  try {
    const reading = !$('#rereadBar').hidden, listening = !$('#ttsBar').hidden;
    S.pending = true; await flushSave(); // 💾 저장과 같은 길: 바꾸기 전에 이 기기에 먼저 저장
    { const cur = await db.get('episodes', ep.id); if (S.cur === ep.id && cur && cur.text !== ed.value) { toast('저장이 끝나지 않아 이동하지 않았어요. 💾 저장을 눌러 주세요', 3500, 'oops'); return; } }
    scheduleSync(2000);
    await openEpisode(to.id);
    const top = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => { ed.scrollTop = 0; r(); }))); // 위치 기억(restorePos)보다 나중에: 새 회차는 맨 위부터
    const hadPos = !!(await loadPos())[to.id];
    if (!reading && !listening && !hadPos) await top();
    if (reading) { await startReread(); ed.setSelectionRange(0, 0); if (matchMedia('(max-width: 899px)').matches) ed.blur(); await top(); checkEpEnd(); }
    else if (listening) { ed.setSelectionRange(0, 0); openReader(); await top(); $('#reader').scrollTop = 0; }
    if (!$('#findBar').hidden) refind();
  } finally { epNavBusy = false; }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-epnav]'); if (b && !b.disabled) { e.preventDefault(); goEpisode(+b.dataset.epnav); return; }
  const n = e.target.closest('[data-epnew]'); if (n) { e.preventDefault(); const { ep } = epSiblings(); if (ep) flushSave().then(() => newEpisode(ep.workId)).then(x => { renderSide(); return openEpisode(x.id); }).then(() => toast('새 회차를 만들었어요', 1800, 'great')); }
});
document.addEventListener('keydown', e => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  if ($('#editorView').hidden || $('#dlg').open || !S.cur) return;
  if (/Mac|iPhone|iPad/.test(navigator.platform) && e.target === ed) return; // 맥 Option+화살표는 낱말 이동
  e.preventDefault(); goEpisode(e.key === 'ArrowLeft' ? -1 : 1);
});
async function openEpisode(id) {
  if (S.cur && S.cur !== id) { savePos(); await flushSave(); }
  setReread(false);
  stopAllAudio(); await loadPos();
  const ep = await db.get('episodes', id); if (!ep) return;
  const cached = findEp(id); if (cached) Object.assign(cached, ep);
  if (S.tab !== 'note') showTab('note', { keep: true });
  S.cur = id; db.kv.set('lastEp', id);
  $('#empty').hidden = true; $('#editorView').hidden = false; document.body.classList.add('editing');
  ed.value = ep.text || ''; $('#epTitle').value = ep.title || ''; S.titleEdit = false; $('#epMemo').value = ep.memo || '';
  updateCrumb(); updateCounts(); refreshConflictBanner();
  $$('.ep.cur').forEach(x => x.classList.remove('cur')); document.querySelector(`.ep[data-e="${id}"]`)?.classList.add('cur');
  if (!S.open.has(ep.workId)) { S.open.add(ep.workId); saveOpen(); renderSide(); }
  if (!$('#panel').hidden) renderPanel();
  snapshot(ep, 'open'); // 열 때 기준점 (같은 내용이면 건너뜀)
  db.kv.set('lastView', 'editor');
  updateStatus(); await restorePos(id);
  if (matchMedia('(min-width: 900px)').matches) ed.focus({ preventScroll: true });
}
function closeEditor() { setReread(false); savePos(); db.kv.set('lastView', 'list'); S.cur = null; $('#editorView').hidden = true; $('#empty').hidden = false; document.body.classList.remove('editing'); db.kv.set('lastEp', null); }
$('#btnBack').onclick = async () => { savePos(); db.kv.set('lastView', 'list'); await flushSave(); stopAllAudio(); document.body.classList.remove('editing'); renderSide(); };

function updateCounts() {
  const c = counts(ed.value);
  $('#cntAll').textContent = `${c.all.toLocaleString()}자`; $('#cntNoSp').textContent = `공백 제외 ${c.noSp.toLocaleString()}자`;
  $('#cntWords').textContent = `${c.words.toLocaleString()}단어`; $('#cntPages').textContent = `원고지 ${c.pages.toLocaleString()}매`;
}
let cntT;
ed.addEventListener('input', () => { markPending(); clearTimeout(cntT); cntT = setTimeout(updateCounts, 150); });
$('#epTitle').addEventListener('input', () => { S.titleEdit = true; markPending(); });
$('#epMemo').addEventListener('input', markPending);
ed.addEventListener('blur', flushSave); $('#epTitle').addEventListener('blur', () => { flushSave().then(() => { renderSide(); }); }); $('#epMemo').addEventListener('blur', flushSave);
// 기기 바꿔 쓰기: 다시 보거나·창으로 돌아오거나·인터넷이 돌아오면 드라이브 확인 (너무 잦지 않게)
let lastFresh = 0;
function freshCheck(why) { if (Date.now() - lastFresh < 8000) return; lastFresh = Date.now(); runSync(why); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { flushSave(); savePos(); } else freshCheck('focus'); });
window.addEventListener('focus', () => freshCheck('focus'));
setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine && Drive.hasValidToken() && Date.now() - (S.lastInput || 0) > 20000) freshCheck('poll'); }, 90000);
window.addEventListener('pagehide', () => { savePos(); flushSave(); });
window.addEventListener('beforeunload', e => { if (S.pending) { flushSave(); e.preventDefault(); e.returnValue = ''; } });

// 큰 붙여넣기: 줄바꿈 정리 + 많은 양을 덮어쓰면 그 전에 기록 남기기
ed.addEventListener('paste', async e => {
  const txt = e.clipboardData?.getData('text/plain'); if (txt == null) return;
  e.preventDefault();
  const s = ed.selectionStart, en = ed.selectionEnd;
  if (en - s > 200 || (ed.value.length > 200 && en - s >= ed.value.length * 0.5)) { const ep = findEp(S.cur); if (ep) await snapshot({ ...ep, text: ed.value }, 'before-paste', '붙여넣기로 덮기 전'); }
  const ins = S.settings.tidy ? tidyPaste(txt) : normalizeText(txt);
  S.pasteChars += [...ins].length;
  ed.setRangeText(ins, s, en, 'end');
  ed.dispatchEvent(new Event('input'));
  if (ins.length > 2000) { toast(`${ins.length.toLocaleString()}자를 붙여 넣었어요. 자동 저장할게요.`); flushSave(); }
});
// 탭 키는 들여쓰기 대신 전각 공백 (소설 문단 들여쓰기용)
ed.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.shiftKey ? manualSnap() : saveNow(); }
  if (e.key === 'Escape' && document.body.classList.contains('focus')) toggleFocus();
});

// 글자 크기·집중 모드
function applySettings() {
  const st = S.settings; const r = document.documentElement;
  r.dataset.theme = st.theme; r.style.setProperty('--ed-size', st.fontSize + 'px'); r.style.setProperty('--ed-lh', st.lineH);
  r.dataset.font = fontOf(st.font).id; loadFont(st.font);
  r.style.setProperty('--ed-font', fontOf(st.font).fam); r.style.setProperty('--ed-ls', (+st.letterSp || 0) + 'em');
  document.querySelector('meta[name=theme-color]').content = st.theme === 'dark' ? '#14132A' : st.theme === 'sepia' ? '#F4EEE2' : '#F7F5FF';
}
async function saveSettings(local) { await db.kv.set('settings', S.settings); if (!local) { await db.kv.set('settingsAt', Date.now()); scheduleSync(4000); } applySettings(); }
// 글꼴·크기 빠른 설정 (Aa) — 웹 글꼴은 고를 때만 불러옴
const GF = 'https://fonts.googleapis.com/css2?display=swap&family=';
const FONTS = [
  { id: 'serif', name: '고운바탕', kind: '명조', fam: '"Gowun Batang"' },
  { id: 'nmyeongjo', name: '나눔명조', kind: '명조', fam: '"Nanum Myeongjo"', css: GF + 'Nanum+Myeongjo:wght@400;700' },
  { id: 'maruburi', name: '마루부리', kind: '명조', fam: 'MaruBuri', css: 'https://hangeul.pstatic.net/hangeul_static/css/maru-buri.css' },
  { id: 'ridi', name: '리디바탕', kind: '명조', fam: 'RIDIBatang', face: "@font-face{font-family:'RIDIBatang';src:url(https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_twelve@1.0/RIDIBatang.woff) format('woff');font-display:swap}" },
  { id: 'sans', name: '프리텐다드', kind: '고딕', fam: '"Pretendard Variable",Pretendard', css: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css' },
  { id: 'ngothic', name: '나눔고딕', kind: '고딕', fam: '"Nanum Gothic"', css: GF + 'Nanum+Gothic:wght@400;700' },
  { id: 'gdodum', name: '고운돋움', kind: '고딕', fam: '"Gowun Dodum"', css: GF + 'Gowun+Dodum' },
  { id: 'penscript', name: '나눔손글씨 펜', kind: '손글씨', fam: '"Nanum Pen Script"', css: GF + 'Nanum+Pen+Script' },
  { id: 'gaegu', name: '개구쟁이', kind: '손글씨', fam: 'Gaegu' },
];
const FONT_DEF = { font: 'serif', fontSize: 18, lineH: 1.9, letterSp: 0 };
const fontOf = id => FONTS.find(f => f.id === id) || FONTS[0];
const fontLoaded = new Set();
function loadFont(id) {
  const f = fontOf(id); if (fontLoaded.has(f.id)) return; fontLoaded.add(f.id);
  if (f.css) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = f.css; l.dataset.font = f.id; document.head.appendChild(l); }
  if (f.face) { const st = document.createElement('style'); st.dataset.font = f.id; st.textContent = f.face; document.head.appendChild(st); }
}
function setFontSetting(patch) { Object.assign(S.settings, patch); applySettings(); saveSettings(); syncAaPanel(); }
function syncAaPanel() {
  const pn = $('#aaPanel'); if (!pn || pn.hidden) return; const st = S.settings;
  pn.querySelectorAll('.aa-f').forEach(b => b.classList.toggle('on', b.dataset.id === fontOf(st.font).id));
  $('#aaSize').value = st.fontSize; $('#aaSizeOut').textContent = st.fontSize;
  $('#aaLh').value = st.lineH; $('#aaLhOut').textContent = (+st.lineH).toFixed(1);
  $('#aaLs').value = st.letterSp || 0; $('#aaLsOut').textContent = (+(st.letterSp || 0)).toFixed(2);
}
function openAa() {
  let pn = $('#aaPanel');
  if (!pn) {
    pn = document.createElement('div'); pn.id = 'aaPanel'; pn.className = 'aa-panel'; pn.setAttribute('role', 'dialog'); pn.setAttribute('aria-label', '글꼴과 크기');
    pn.innerHTML = `<div class="aa-h"><b>Aa 글꼴과 크기</b><button class="aa-x" id="aaClose" aria-label="닫기">✕</button></div>
      <div class="aa-fonts">${FONTS.map(f => `<button class="aa-f" data-id="${f.id}" style="font-family:${esc(f.fam)},var(--serif)"><span class="aa-k">${f.kind}</span><b>${f.name}</b><i>쓰는 오늘, 완성의 내일로</i></button>`).join('')}</div>
      <div class="aa-row"><span>글자 크기</span><button class="aa-pm" id="aaMinus" aria-label="작게">−</button><input type="range" id="aaSize" min="13" max="30" step="1" aria-label="글자 크기"><button class="aa-pm" id="aaPlus" aria-label="크게">＋</button><output id="aaSizeOut"></output></div>
      <div class="aa-row"><span>줄 간격</span><input type="range" id="aaLh" min="1.4" max="2.6" step="0.1" aria-label="줄 간격"><output id="aaLhOut"></output></div>
      <div class="aa-row"><span>자간</span><input type="range" id="aaLs" min="-0.05" max="0.15" step="0.01" aria-label="자간"><output id="aaLsOut"></output></div>
      <div class="aa-foot"><span class="aa-note">원고 전체에 적용 · 기기끼리 동기화</span><button class="btn ghost sm" id="aaReset">기본값</button></div>`;
    document.body.appendChild(pn);
    pn.addEventListener('click', e => { const b = e.target.closest('.aa-f'); if (b) { loadFont(b.dataset.id); setFontSetting({ font: b.dataset.id }); } });
    pn.addEventListener('pointerenter', e => { const b = e.target.closest?.('.aa-f'); if (b) loadFont(b.dataset.id); }, true);
    $('#aaClose').onclick = closeAa;
    $('#aaMinus').onclick = () => setFontSetting({ fontSize: Math.max(13, S.settings.fontSize - 1) });
    $('#aaPlus').onclick = () => setFontSetting({ fontSize: Math.min(30, S.settings.fontSize + 1) });
    $('#aaSize').oninput = e => setFontSetting({ fontSize: +e.target.value });
    $('#aaLh').oninput = e => setFontSetting({ lineH: Math.round(+e.target.value * 10) / 10 });
    $('#aaLs').oninput = e => setFontSetting({ letterSp: Math.round(+e.target.value * 100) / 100 });
    $('#aaReset').onclick = () => { setFontSetting({ ...FONT_DEF }); toast('글꼴·크기를 기본값으로 돌렸어요'); };
    document.addEventListener('pointerdown', e => { const p = $('#aaPanel'); if (p && !p.hidden && !p.contains(e.target) && !e.target.closest('#btnAa')) closeAa(); }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#aaPanel').hidden) closeAa(); });
  }
  pn.hidden = false; $('#btnAa').classList.add('on'); syncAaPanel();
  // 미리보기용으로 손글씨만 빼고 가볍게: 패널 열 때 지금 글꼴만 확실히
  loadFont(S.settings.font); loadPreviews();
}
// 미리보기: 구글 글꼴은 이름·예문 글자만 담은 아주 작은 조각으로 (몇 KB)
let previewsDone = false;
function loadPreviews() {
  if (previewsDone) return; previewsDone = true;
  const fams = FONTS.filter(f => f.css?.startsWith(GF) && !fontLoaded.has(f.id));
  if (!fams.length) return;
  const txt = encodeURIComponent([...new Set([...FONTS.map(f => f.name).join('') + '쓰는 오늘, 완성의 내일로'])].join(''));
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.dataset.preview = '1';
  l.href = 'https://fonts.googleapis.com/css2?display=swap&' + fams.map(f => 'family=' + f.css.slice(GF.length).split(':')[0]).join('&') + '&text=' + txt;
  document.head.appendChild(l);
}
function closeAa() { const p = $('#aaPanel'); if (p) p.hidden = true; $('#btnAa').classList.remove('on'); }
$('#btnAa').onclick = () => ($('#aaPanel') && !$('#aaPanel').hidden) ? closeAa() : openAa();
function toggleFocus() { document.body.classList.toggle('focus'); $('#btnFocus').classList.toggle('on', document.body.classList.contains('focus')); if (document.body.classList.contains('focus')) toast('집중 모드 · Esc 또는 ◐ 버튼으로 나가기'); }
$('#btnFocus').onclick = toggleFocus;

// ================= 패널: 메모 · 음성 · 기록 =================
let paneTab = 'memo';
$('#btnPanel').onclick = () => { const p = $('#panel'); p.hidden = !p.hidden; $('#btnPanel').classList.toggle('on', !p.hidden); if (!p.hidden) renderPanel(); };
$('#btnPanelClose').onclick = () => { $('#panel').hidden = true; $('#btnPanel').classList.remove('on'); };
$$('.panel-tabs [data-tab]').forEach(b => b.onclick = () => { paneTab = b.dataset.tab; renderPanel(); });
function showPane(tab) { paneTab = tab; $('#panel').hidden = false; $('#btnPanel').classList.add('on'); renderPanel(); }
function renderPanel() {
  $$('.panel-tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === paneTab));
  $$('.panel-body').forEach(p => p.hidden = p.dataset.pane !== paneTab);
  if (paneTab === 'hist') renderHist(); if (paneTab === 'voice') renderVoice(); if (paneTab === 'notes') renderPaneNotes();
}
async function renderHist() {
  const ep = findEp(S.cur); if (!ep) return;
  const vs = await versionsOf(ep.id);
  $('#histList').innerHTML = `<button class="btn gold block" id="histSnap">✦ 지금 버전 저장</button><p class="mute small">자동 기록: ${S.settings.snapMin}분마다 · 드라이브에서 받기 전 · 복원 전 · 큰 붙여넣기 전</p>` +
    (vs.length ? vs.map(v => `<div class="hv" data-v="${v.id}"><div><b>${fmtTime(v.at)}</b> <span class="tag ${v.reason}">${esc(REASON[v.reason] || v.reason)}</span>${v.label ? `<div class="mute small">${esc(v.label)}</div>` : ''}<div class="mute small">${v.chars.toLocaleString()}자</div></div><div class="hv-btns"><button class="btn small ghost" data-h="diff">비교</button><button class="btn small" data-h="restore">복원</button></div></div>`).join('') : '<p class="mute">아직 기록이 없어요.</p>');
}
$('#histList').addEventListener('click', async e => {
  if (e.target.id === 'histSnap') return manualSnap();
  const b = e.target.closest('[data-h]'); if (!b) return;
  const vid = b.closest('.hv').dataset.v; const v = await db.get('versions', vid); await flushSave();
  const ep = await db.get('episodes', S.cur);
  if (b.dataset.h === 'diff') {
    const d = diffHTML(v.text, ep.text);
    const r = await dialog({ title: `${fmtTime(v.at)} 버전 ↔ 지금 원고`, wide: true, html: `<p class="mute small"><span class="d-del-s">－ 그때만 있던 줄 ${d.dels}</span> · <span class="d-add-s">＋ 지금 생긴 줄 ${d.adds}</span></p><div class="diff">${d.html}</div>`, buttons: [{ label: '닫기', value: 'cancel' }, { label: '이 버전으로 복원', value: 'restore', cls: 'gold' }] });
    if (r === 'restore') restoreVersion(v);
  } else restoreVersion(v);
});
async function restoreVersion(v) {
  if (!(await confirmBox('버전 복원', `${fmtTime(v.at)} 버전으로 되돌릴까요?<br>지금 원고는 먼저 「복원 전」 기록으로 저장돼요.`, '복원'))) return;
  await flushSave();
  const ep = await db.get('episodes', S.cur);
  await snapshot(ep, 'before-restore', `${fmtTime(v.at)} 버전 복원 전`);
  uhKeepSet(() => { ed.value = v.text; }); markPending(); await flushSave(); updateCounts(); renderHist(); toast('복원했어요');
}
async function manualSnap() {
  await flushSave(); const ep = await db.get('episodes', S.cur); if (!ep) return;
  const label = await ask('버전 저장', '메모 (선택)', '', '예: 2차 퇴고 끝'); if (label === null) return;
  await snapshot(ep, 'manual', label); toast('✦ 버전을 저장했어요'); if (!$('#panel').hidden && paneTab === 'hist') renderHist();
}
$('#btnSnap').onclick = manualSnap;
// 💾 지금 저장: 기기에 바로 저장 + 드라이브에 바로 올리기 (자동 저장을 기다리지 않음)
const saveLbl = (t, cls) => { const b = $('#btnSave'); b.className = 'tb save-btn ' + (cls || ''); b.querySelector('b').textContent = t; };
let saveBusy = false;
async function saveNow() {
  if (!S.cur || saveBusy) return;
  // 로그인이 끝났으면 이 클릭 안에서 바로 재연결 창 (팝업 차단 방지 — await 전에)
  const linked = Drive.isLinkedSync();
  let reauth = null;
  if (linked && navigator.onLine && !Drive.hasValidToken() && Drive.gisReady() && S.clientId) reauth = Drive.connectNow(S.clientId, { silent: true }).catch(() => null);
  saveBusy = true; saveLbl('저장 중…', 'busy');
  try {
    S.pending = true; await flushSave();
    const hm = () => { const d = new Date(); return `${d.getHours()}:${pad2(d.getMinutes())}`; };
    if (!linked) { saveLbl(`기기 저장 ${hm()}`, 'ok'); toast('💾 이 기기에 저장했어요 (드라이브는 연결 전)', 2200); return; }
    if (!navigator.onLine) { saveLbl('기기 저장 · 오프라인', 'warn'); toast('💾 기기에 저장했어요. 인터넷이 돌아오면 드라이브에 자동으로 올려요', 3500); return; }
    if (reauth) await reauth;
    if (!Drive.hasValidToken()) { saveLbl('기기 저장 · 다시 연결', 'warn'); authNag(true); return; }
    await runSync('manual'); if (S.syncP) await S.syncP;
    const ep = await db.get('episodes', S.cur);
    if (ep?.conflict) { saveLbl('기기 저장 · 비교 필요', 'warn'); toast('💾 기기에 저장했어요. 다른 기기 내용과 달라서 비교해 골라 주세요', 4000, 'oops'); }
    else if (S.syncState === 'error' || ep?.dirty) { saveLbl('기기 저장 · 드라이브 실패', 'warn'); toast('💾 기기에는 저장했어요. 드라이브는 잠시 뒤 다시 시도할게요', 3500, 'oops'); }
    else { saveLbl(`저장됨 ${hm()}`, 'ok'); toast('💾 기기와 드라이브에 저장했어요', 1800, 'great'); }
  } finally { saveBusy = false; }
}
$('#btnSave').addEventListener('click', saveNow);
ed.addEventListener('input', () => { const b = $('#btnSave'); if (b && !saveBusy && !b.classList.contains('dirty')) saveLbl('저장', 'dirty'); });

// ================= ChatGPT로 가져가기 (클립보드 복사) =================
function copyText(text) {
  // 1) 표준 API (https·사용자 클릭 안) → 2) 안 되면 숨은 textarea 선택 + execCommand (옛 모바일 브라우저)
  const fallback = () => {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
    (document.querySelector('dialog[open]') || document.body).appendChild(ta);
    ta.focus({ preventScroll: true }); ta.select(); ta.setSelectionRange(0, text.length);
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove(); return ok;
  };
  if (navigator.clipboard?.writeText && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => fallback());
  return Promise.resolve(fallback());
}
function epHeader(ep) { const w = workOf(ep); return `[작품] ${w?.title || ''} / [회차] ${labelOf(ep)}${ep.title ? ' ' + ep.title : ''}`; }
/** 이어쓰기용: 마지막 n자(문단 경계에서 자름) 또는 마지막 n문단 */
function tailFor(text, mode, n) {
  const t = text.replace(/\s+$/, '');
  if (mode === 'para') { const ps = t.split(/\n\s*\n|\n/).filter(x => x.trim()); return ps.slice(-n).join('\n\n'); }
  if ([...t].length <= n) return t;
  let cut = t.slice(-n); const nl = cut.indexOf('\n');
  if (nl > 0 && nl < cut.length * 0.4) cut = cut.slice(nl + 1); // 문단 중간에서 시작하지 않게
  return cut.replace(/^\s+/, '');
}
function handoffText(kind, ep, text, sel, opt) {
  if (kind === 'all') return text;
  if (kind === 'sel') return sel;
  const tail = tailFor(text, opt.mode, opt.n);
  const size = opt.mode === 'para' ? `마지막 ${opt.n}문단` : `마지막 약 ${[...tail].length.toLocaleString()}자`;
  return `${epHeader(ep)}\n아래는 원고 ${size}입니다. 이 흐름과 문체를 이어서 다음 장면을 써 주세요.\n---\n${tail}`;
}
$('#btnCopy').onclick = async () => {
  await flushSave(); const ep = findEp(S.cur); if (!ep) return;
  const text = ed.value; const s0 = ed.selectionStart, e0 = ed.selectionEnd; const sel = text.slice(s0, e0);
  const st = S.settings; st.hoMode ||= 'chars'; st.hoN ||= 1500;
  const optsHTML = () => (st.hoMode === 'para' ? [3, 5, 10, 20] : [500, 1000, 1500, 2000, 3000]).map(x => `<option value="${x}" ${x === st.hoN ? 'selected' : ''}>${x.toLocaleString()}${st.hoMode === 'para' ? '문단' : '자'}</option>`).join('');
  await dialog({ title: 'ChatGPT로 가져가기', wide: true, html: `
    <p class="mute small">누르면 바로 복사돼요. ChatGPT 입력창에 길게 눌러 「붙여넣기」 하세요. (파일은 만들지 않아요)</p>
    <div class="ho-list">
      <button type="button" class="ho" data-k="all"><b>📄 회차 전체 복사</b><small>${counts(text).all.toLocaleString()}자</small></button>
      <button type="button" class="ho" data-k="sel" ${sel ? '' : 'disabled'}><b>✂ 선택한 부분 복사</b><small>${sel ? `${[...sel].length.toLocaleString()}자 선택됨` : '먼저 원고에서 복사할 부분을 드래그해 선택하세요'}</small></button>
      <button type="button" class="ho" data-k="tail"><b>➜ 이어쓰기용 복사</b><small>작품명·회차명 + 원고 마지막 부분</small></button>
    </div>
    <div class="row wrap ho-opt"><label class="fld">이어쓰기 분량 <select id="hoMode"><option value="chars" ${st.hoMode === 'chars' ? 'selected' : ''}>글자 수로</option><option value="para" ${st.hoMode === 'para' ? 'selected' : ''}>문단 수로</option></select></label>
      <label class="fld">마지막 <select id="hoN">${optsHTML()}</select></label></div>
    <pre class="ho-prev" id="hoPrev"></pre>`,
    buttons: [{ label: '닫기', value: 'cancel' }],
    onOpen: f => {
      const prev = () => { f.querySelector('#hoPrev').textContent = handoffText('tail', ep, text, sel, { mode: st.hoMode, n: st.hoN }).slice(0, 400) + '…'; };
      prev();
      f.querySelector('#hoMode').onchange = e => { st.hoMode = e.target.value; st.hoN = st.hoMode === 'para' ? 5 : 1500; f.querySelector('#hoN').innerHTML = optsHTML(); saveSettings(); prev(); };
      f.querySelector('#hoN').onchange = e => { st.hoN = +e.target.value; saveSettings(); prev(); };
      f.querySelectorAll('.ho').forEach(b => b.onclick = () => {
        const k = b.dataset.k; const out = handoffText(k, ep, text, sel, { mode: st.hoMode, n: st.hoN });
        window.__lastCopy = out; // 테스트 확인용
        copyText(out).then(ok => {
          if (ok) { $('#dlg').close('cancel'); toast(`📋 ${k === 'all' ? '회차 전체' : k === 'sel' ? '선택한 부분' : '이어쓰기용 원고'}를 복사했어요 (${[...out].length.toLocaleString()}자). ChatGPT에 붙여 넣으세요!`, 3200, 'great'); }
          else toast('복사가 막혔어요. 원고를 길게 눌러 직접 복사해 주세요.', 4500, 'oops');
          ed.setSelectionRange(s0, e0);
        });
      });
    } });
};

// ================= 수정본 반영 (ChatGPT에서 고친 글을 안전하게) =================
$('#btnRevise').onclick = async () => {
  await flushSave(); const ep = findEp(S.cur); if (!ep) return;
  const s0 = ed.selectionStart, e0 = ed.selectionEnd; const sel = ed.value.slice(s0, e0);
  const st = S.settings; if (st.reviseKeep == null) st.reviseKeep = true;
  const r = await dialog({ title: '수정본 반영', wide: true, html: `
    <p class="mute small">ChatGPT에서 고친 글을 아래에 붙여 넣고 반영 방법을 골라요. 반영하기 전 원고는 <b>수정 기록</b>에 자동으로 남고, 바로 <b>되돌리기</b>도 돼요.</p>
    <textarea id="rvText" class="rv-text" rows="8" placeholder="여기에 수정본을 붙여 넣으세요"></textarea>
    <div class="rv-modes">
      <label class="rv-m"><input type="radio" name="rvMode" value="append" ${sel ? '' : 'checked'}> <b>뒤에 이어 붙이기</b><small>원고 맨 끝에 새 문단으로 붙여요</small></label>
      <label class="rv-m ${sel ? '' : 'off'}"><input type="radio" name="rvMode" value="replace" ${sel ? 'checked' : 'disabled'}> <b>선택 영역 교체</b><small>${sel ? `선택한 ${[...sel].length.toLocaleString()}자를 바꿔요` : '원고에서 바꿀 부분을 먼저 선택한 뒤 다시 열어 주세요'}</small></label>
    </div>
    ${sel ? `<details class="rv-sel" open><summary>바뀔 부분 (지금 원고)</summary><pre>${esc(sel.length > 1200 ? sel.slice(0, 600) + '\n…\n' + sel.slice(-500) : sel)}</pre></details>` : ''}
    <label class="chk"><input type="checkbox" id="rvKeep" ${st.reviseKeep ? 'checked' : ''}> 붙여 넣은 그대로 (빈 줄·문단 정확히 유지)</label>
    <p class="mute small" id="rvInfo"></p>`,
    buttons: [{ label: '취소', value: 'cancel' }, { label: '반영하기', value: 'ok', cls: 'gold' }],
    onOpen: f => { const t = f.querySelector('#rvText'); setTimeout(() => t.focus(), 50); t.addEventListener('input', () => { f.querySelector('#rvInfo').textContent = t.value ? `${[...t.value].length.toLocaleString()}자` : ''; }); } });
  if (r !== 'ok') { ed.setSelectionRange(s0, e0); return; }
  const f = $('#dlgForm'); const raw = f.querySelector('#rvText').value; const keep = f.querySelector('#rvKeep').checked;
  const mode = f.querySelector('input[name=rvMode]:checked')?.value || 'append';
  st.reviseKeep = keep; saveSettings();
  if (!raw.trim()) return toast('붙여 넣은 내용이 없어요', 2500, 'oops');
  const ins = keep ? raw.replace(/\r\n?/g, '\n') : tidyPaste(raw);
  const before = ed.value;
  await snapshot({ ...ep, text: before }, 'before-revise', mode === 'replace' ? '수정본 교체 전' : '수정본 이어 붙이기 전');
  let next, caret;
  if (mode === 'replace' && e0 > s0) { next = before.slice(0, s0) + ins + before.slice(e0); caret = s0 + ins.length; }
  else { const sep = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'; next = before + sep + ins; caret = next.length; }
  S.pasteChars += [...ins].length;
  uhKeepSet(() => { ed.value = next; }); ed.setSelectionRange(caret, caret); markPending(); updateCounts(); await flushSave();
  if (mode === 'replace') ed.setSelectionRange(s0, caret);
  keepCaretVisible(true);
  toast(mode === 'replace' ? '선택 영역을 수정본으로 바꿨어요' : '수정본을 뒤에 이어 붙였어요', 7000, 'great', { label: '되돌리기', fn: async () => {
    if (S.cur !== ep.id) await openEpisode(ep.id);
    await snapshot({ ...findEp(ep.id), text: ed.value }, 'before-restore', '수정본 되돌리기 전');
    uhKeepSet(() => { ed.value = before; }); ed.setSelectionRange(s0, e0); markPending(); updateCounts(); await flushSave(); toast('반영 전으로 되돌렸어요 (수정 기록에도 남아 있어요)');
  } });
};

// ================= 휴대폰 키보드 · 위치 기억 =================
// 커서가 있는 줄의 위치(textarea 안의 y)를 거울 div로 계산
const mirror = document.createElement('div'); mirror.setAttribute('aria-hidden', 'true');
mirror.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word';
document.body.appendChild(mirror);
function caretY() {
  const cs = getComputedStyle(ed);
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'boxSizing', 'wordBreak', 'tabSize']) mirror.style[k] = cs[k];
  mirror.style.width = ed.clientWidth + 'px';
  mirror.textContent = ed.value.slice(0, ed.selectionEnd); const mk = document.createElement('span'); mk.textContent = '\u200b'; mirror.appendChild(mk);
  return mk.offsetTop + mk.offsetHeight;
}
function visibleEditorBottom() {
  // 키보드에 가려지지 않는 편집창 아래쪽 (편집창 안 좌표)
  const r = ed.getBoundingClientRect(); const vv = window.visualViewport;
  const vb = vv ? vv.offsetTop + vv.height : innerHeight;
  return Math.min(r.height, vb - r.top);
}
function keepCaretVisible(force) {
  if (!S.cur || $('#editorView').hidden || (!force && document.activeElement !== ed)) return;
  const y = caretY(); const lh = parseFloat(getComputedStyle(ed).lineHeight) || 30;
  const top = ed.scrollTop, bottom = top + visibleEditorBottom() - lh * 1.5;
  if (y > bottom) ed.scrollTop = y - visibleEditorBottom() + lh * 2.5;
  else if (y - lh < top) ed.scrollTop = Math.max(0, y - lh * 3);
}
window.__jpsCaret = { caretY, keepCaretVisible, visibleEditorBottom };
const vvMax = {};
function onViewport() {
  const vv = window.visualViewport; if (!vv) return;
  const o = innerWidth > innerHeight ? 'l' : 'p'; vvMax[o] = Math.max(vvMax[o] || 0, vv.height, o === S.vvO ? 0 : innerHeight); S.vvO = o;
  const kb = Math.max(innerHeight, vvMax[o]) - vv.height > 140; // 키보드가 열림 (안드로이드는 화면 자체가 줄어서 최대 높이와 비교)
  document.body.classList.toggle('kb-open', kb);
  document.documentElement.style.setProperty('--vvh', vv.height + 'px');
  document.documentElement.style.setProperty('--vvtop', vv.offsetTop + 'px');
  // 위쪽 저장 상태가 화면 밖(또는 집중 모드로 흐림)이면 떠 있는 작은 상태 표시를 보여 줘요
  const r = $('#saveStatus').getBoundingClientRect(); const hiddenTop = r.bottom < vv.offsetTop + 4 || r.top > vv.offsetTop + vv.height || r.height === 0 || document.body.classList.contains('focus');
  const pill = $('#kbPill'); pill.hidden = !(kb && !$('#editorView').hidden && hiddenTop);
  if (kb) requestAnimationFrame(() => keepCaretVisible());
}
window.visualViewport?.addEventListener('resize', onViewport);
window.visualViewport?.addEventListener('scroll', onViewport);
ed.addEventListener('input', () => { if (document.body.classList.contains('kb-open')) requestAnimationFrame(() => keepCaretVisible()); });

// 회차마다 커서·스크롤 위치 기억 → 다시 열면 그 자리로
let posMap = null, posT;
async function loadPos() { if (!posMap) posMap = (await db.kv.get('epPos')) || {}; return posMap; }
function savePos() {
  if (!S.cur || $('#editorView').hidden || !posMap) return;
  posMap[S.cur] = { sel: ed.selectionStart, end: ed.selectionEnd, top: Math.round(ed.scrollTop), at: Date.now() };
  db.kv.set('epPos', posMap);
}
const queuePos = () => { clearTimeout(posT); posT = setTimeout(savePos, 600); };
ed.addEventListener('scroll', queuePos, { passive: true });
ed.addEventListener('keyup', queuePos); ed.addEventListener('pointerup', queuePos); ed.addEventListener('input', queuePos);
async function restorePos(id) {
  const p = (await loadPos())[id]; if (!p) return;
  const L = ed.value.length; ed.setSelectionRange(Math.min(p.sel, L), Math.min(p.end ?? p.sel, L));
  requestAnimationFrame(() => { ed.scrollTop = p.top || 0; });
}

// ================= 실행취소 · 다시실행 + 맨 위로 =================
// 브라우저 기본 되돌리기는 글을 코드로 바꾸면(수정본 반영·복원·찾아 바꾸기 등) 끊기고, 휴대폰에서는 키보드가 가려서 쓰기 어려워요.
// 그래서 "지금 열려 있는 이 회차의 글"에만 쓰는 되돌리기 기록을 메모리에 따로 둬요. (저장·DB·드라이브와는 관계없음)
// 회차를 옮기거나 드라이브에서 글이 바뀌어 들어오면 기록을 비워서, 다른 회차 글이 섞이지 않아요.
const UH = new UndoStack(); let uhId = null, uhKeep = 0, uhBusy = false, uhComp = false, uhHadFocus = false;
const edValueDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
Object.defineProperty(ed, 'value', { configurable: true, get() { return edValueDesc.get.call(ed); }, set(v) { edValueDesc.set.call(ed, v); if (uhKeep) uhRecord(false); else uhReset(); } });
function uhKeepSet(fn) { uhKeep++; try { fn(); } finally { uhKeep--; } } // 이 안에서 글을 바꾸면 되돌리기 기록에 남겨요 (수정본 반영 등)
function uhSync() {
  const off = !S.cur || ed.hidden || $('#editorView').hidden;
  const u = $('#btnUndo'), r = $('#btnRedo'); if (!u || !r) return;
  u.disabled = off || !UH.canUndo; r.disabled = off || !UH.canRedo;
}
function uhReset() { uhId = S.cur; uhComp = false; UH.reset(ed.value); uhSync(); updateTop(); }
function uhRecord(typing) {
  if (uhBusy) return; if (uhId !== S.cur) return uhReset(); if (uhComp) return;
  UH.push(ed.value, typing); uhSync();
}
ed.addEventListener('input', e => { if (e.isComposing) return; uhRecord(/^(insertText|insertCompositionText|deleteContent)/.test(e.inputType || '')); });
ed.addEventListener('compositionstart', () => { uhComp = true; });
ed.addEventListener('compositionend', () => { uhComp = false; uhRecord(true); }); // 한글 조합 중에는 모았다가 끝나면 한 번에
function uhApply(dir) {
  if (!S.cur || ed.hidden || $('#editorView').hidden) return false;
  if (uhId !== S.cur) uhReset();
  uhComp = false; uhRecord(true); // 방금 입력한 것까지 기록
  const r = dir < 0 ? UH.undo(ed.value) : UH.redo(ed.value);
  if (!r) { uhSync(); return false; }
  uhBusy = true;
  try { ed.setRangeText(r.insert, r.at, r.at + r.remove, 'end'); ed.dispatchEvent(new Event('input')); } finally { uhBusy = false; }
  if (UH.last !== ed.value) uhReset();
  keepCaretVisible(true); uhSync(); return true;
}
function uhBtn(id, dir) {
  const b = $(id); if (!b) return;
  b.addEventListener('pointerdown', () => { uhHadFocus = document.activeElement === ed; });
  b.addEventListener('mousedown', e => e.preventDefault()); // 눌러도 키보드가 내려가지 않게
  b.addEventListener('click', () => { if (b.disabled) return; uhApply(dir); if ((uhHadFocus || matchMedia('(min-width: 900px)').matches) && document.activeElement !== ed) ed.focus({ preventScroll: true }); });
}
uhBtn('#btnUndo', -1); uhBtn('#btnRedo', 1);
// 키보드 단축키·휴대폰 키보드의 되돌리기도 같은 기록을 써요 (기본 되돌리기는 글을 깨뜨릴 수 있어 막아요)
ed.addEventListener('beforeinput', e => { if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); uhApply(e.inputType === 'historyUndo' ? -1 : 1); } });
ed.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return; const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); uhApply(-1); }
  else if ((k === 'z' && e.shiftKey) || (k === 'y' && !e.metaKey)) { e.preventDefault(); uhApply(1); }
});
new MutationObserver(() => { uhSync(); updateTop(); }).observe(ed, { attributes: true, attributeFilter: ['hidden'] });
window.__jpsUndo = { UH, apply: uhApply, reset: uhReset };

// 맨 위로: 길게 내려갔을 때만 나타나는 작은 둥근 버튼 (편집·재독 = 글상자, 듣기 = 읽기 화면)
const topBtn = $('#btnTop'); let topQuiet = 0, topQT;
const topScroller = () => { const rd = $('#reader'); return rd && !rd.hidden ? rd : ed; };
function updateTop() {
  if (!topBtn) return; const el = topScroller();
  const show = !$('#editorView').hidden && !!S.cur && el.scrollHeight > el.clientHeight * 1.6 && el.scrollTop > Math.max(320, el.clientHeight * 0.8) && Date.now() >= topQuiet;
  topBtn.hidden = !show;
  const ee = $('#epEnd'); topBtn.style.bottom = ee && !ee.hidden && ee.offsetHeight ? `${ee.offsetHeight + 36}px` : ''; // 재독 끝의 큰 카드 위로 비켜 줘요
}
ed.addEventListener('scroll', updateTop, { passive: true }); $('#reader')?.addEventListener('scroll', updateTop, { passive: true });
ed.addEventListener('input', e => { if (!e.inputType) return; topQuiet = Date.now() + 2500; updateTop(); clearTimeout(topQT); topQT = setTimeout(updateTop, 2600); }); // 글 쓰는 동안은 글을 가리지 않게 숨겨요
window.addEventListener('resize', updateTop); window.visualViewport?.addEventListener('resize', updateTop);
if ($('#epEnd')) new MutationObserver(updateTop).observe($('#epEnd'), { attributes: true, attributeFilter: ['hidden'] });
if ($('#reader')) new MutationObserver(updateTop).observe($('#reader'), { attributes: true, attributeFilter: ['hidden'] });
if (topBtn) {
  topBtn.addEventListener('pointerdown', e => e.preventDefault()); topBtn.addEventListener('mousedown', e => e.preventDefault()); // 눌러도 키보드·커서 유지
  topBtn.addEventListener('click', () => {
    const el = topScroller();
    // 글상자에 커서가 있으면 브라우저가 커서 쪽으로 다시 끌어내려요 → 커서도 글 맨 앞으로 (글 내용·되돌리기 기록은 그대로)
    if (el === ed && document.activeElement === ed) {
      ed.setSelectionRange(0, 0); el.scrollTop = 0;
      requestAnimationFrame(() => { el.scrollTop = 0; setTimeout(() => { el.scrollTop = 0; updateTop(); }, 120); });
      return;
    }
    el.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}

// ================= 충돌 =================
async function refreshConflictBanner() {
  const id = S.cur; const ep = id && await db.get('episodes', id);
  // 확인이 여러 번 겹쳐도 배너는 회차당 하나: 기다린 뒤 지우고 다시 그림 (덧붙이지 않음)
  document.querySelectorAll('.conflict-banner').forEach(x => x.remove());
  if (!ep?.conflict || S.cur !== id) return;
  $('.ed-body').insertAdjacentHTML('beforebegin', `<div class="conflict-banner" data-ep="${ep.id}"><span>⚠ 이 회차가 기기와 드라이브(다른 기기·ChatGPT) 양쪽에서 바뀌었어요. 둘 다 안전하게 보관 중이에요.</span><button class="btn small gold" id="btnResolve">비교하고 고르기</button></div>`);
  $('#btnResolve').onclick = () => resolveUI(ep.id);
}
async function resolveUI(id) {
  await flushSave(); const ep = await db.get('episodes', id); if (!ep?.conflict) return;
  const d = diffHTML(ep.conflict.remoteText, ep.text);
  const rl = looseKey(ep.conflict.remoteText), ll = looseKey(ep.text);
  const tip = rl && ll.length > rl.length && ll.startsWith(rl) ? '💡 드라이브 글이 이 기기 글의 앞부분이에요. 「내 기기 것」을 고르면 이어 쓴 글이 모두 남아요.'
    : ll && rl.length > ll.length && rl.startsWith(ll) ? '💡 이 기기 글이 드라이브 글의 앞부분이에요. 「드라이브 것」을 고르면 더 쓴 글이 모두 와요.' : '';
  const r = await dialog({ title: '어느 원고를 쓸까요?', wide: true,
    html: `${tip ? `<p class="small">${tip}</p>` : ''}<p class="mute small">－ 드라이브에만 있는 줄 ${d.dels} · ＋ 이 기기에만 있는 줄 ${d.adds}. 무엇을 골라도 두 버전 모두 수정 기록에 남아요.</p><div class="diff">${d.html}</div>`,
    buttons: [{ label: '나중에', value: 'cancel' }, { label: '둘 다 보관 (드라이브 것은 사본 회차로)', value: 'both' }, { label: '드라이브 것', value: 'remote' }, { label: '내 기기 것', value: 'local', cls: 'gold' }] });
  if (r === 'cancel') return;
  const res = await Drive.resolveConflict(id, r, async (e, remoteText) => {
    const cp = await newEpisode(e.workId, { text: remoteText, title: (e.title || labelOf(e)) + ' (드라이브 사본)', order: (e.order ?? 0) + 0.5 });
    await renumber(e.workId); return cp;
  });
  await loadAll(); renderSide();
  if (S.cur === id) { ed.value = res.text; updateCounts(); }
  refreshConflictBanner(); toast('정리했어요'); runSync('manual');
}

// ================= 검색 =================
let srchT;
$('#searchInput').addEventListener('input', () => { clearTimeout(srchT); srchT = setTimeout(doSearch, 220); });
S.srCase = false;
async function doSearch() {
  const q = $('#searchInput').value.trim(); const box = $('#searchResults');
  if (!q) { box.hidden = true; $('#workList').hidden = false; return; }
  await flushSave(); await loadAll();
  const res = []; let total = 0; const cs = S.srCase;
  for (const w of S.works) for (const [i, e] of (S.eps.get(w.id) || []).entries()) {
    for (const [k, h] of [['title', e.title || ''], ['text', e.text || ''], ['memo', e.memo || '']]) {
      const ps = findIdx(h, q, cs); total += ps.length;
      for (const pos of ps) if (res.length < 300) res.push({ w, e, i, k, pos, h });
    }
  }
  const notes = (await db.all('notes')).filter(n => findIdx(searchText(n, noteWorkTitle(n)) + ' ' + [n.title, n.body, n.cite, ...(n.beats || []).map(b => b.text)].join(' '), q, cs).length);
  const textHits = res.filter(r => r.k === 'text').length;
  box.hidden = false; $('#workList').hidden = true;
  const repOpen = box.dataset.rep === '1';
  box.innerHTML = `<div class="sr-head"><span>「${esc(q)}」 <b>${total}곳</b>${notes.length ? ` · 설계 노트 ${notes.length}` : ''}</span><button class="btn small ghost" id="srClose">닫기</button></div>
    <div class="sr-tools"><button type="button" class="chip ${cs ? 'on' : ''}" id="srCase" aria-pressed="${cs}" title="대소문자 구분">Aa 대소문자</button><button type="button" class="chip ${repOpen ? 'on' : ''}" id="srRepT">⇄ 바꾸기</button></div>
    <div class="sr-rep" ${repOpen ? '' : 'hidden'}><input id="srRep" placeholder="바꿀 말" value="${esc(S.srRep || '')}" autocomplete="off"><button type="button" class="btn small brand" id="srRepAll" ${textHits ? '' : 'disabled'}>모든 회차에서 바꾸기</button></div>` +
    (res.map((r, n) => {
      const a = Math.max(0, r.pos - 30); const snip = esc(r.h.slice(a, r.pos)) + '<mark>' + esc(r.h.slice(r.pos, r.pos + q.length)) + '</mark>' + esc(r.h.slice(r.pos + q.length, r.pos + q.length + 40));
      return `<button class="sr" data-n="${n}"><span class="sr-w">${esc(r.w.title)} · ${esc(Drive.episodeLabel(r.e, r.i))}${r.k === 'memo' ? ' · 메모' : r.k === 'title' ? ' · 제목' : ''}</span><span class="sr-s">${a ? '…' : ''}${snip.replace(/\n/g, ' ⏎ ')}</span></button>`;
    }).join('') + (total > res.length ? `<p class="mute small pad">앞의 ${res.length}곳만 보여요</p>` : '') +
    (notes.length ? `<div class="sr-sec">💡 설계 노트</div>` + notes.slice(0, 50).map(n => `<button class="sr" data-note="${n.id}"><span class="sr-w">${(NTYPE[n.type] || NTYPE.idea).icon} ${esc(noteWorkTitle(n) || '공통')}</span><span class="sr-s">${esc(n.title || '(제목 없음)')}</span></button>`).join('') : '') ||
    `<div class="empty-box"><img src="${STK.oops}" alt="">찾는 글이 없어요.</div>`);
  box.querySelector('#srCase').onclick = () => { S.srCase = !S.srCase; doSearch(); };
  box.querySelector('#srRepT').onclick = () => { box.dataset.rep = repOpen ? '' : '1'; doSearch().then(() => box.querySelector('#srRep')?.focus()); };
  const ri = box.querySelector('#srRep'); ri.oninput = () => S.srRep = ri.value;
  box.querySelector('#srRepAll').onclick = () => replaceEverywhere(q, ri.value, S.srCase);
  box.onclick = async ev => {
    if (ev.target.id === 'srClose') { $('#searchInput').value = ''; box.dataset.rep = ''; return doSearch(); }
    const nb = ev.target.closest('[data-note]'); if (nb) return noteEditor(nb.dataset.note);
    const b = ev.target.closest('.sr'); if (!b) return; const r = res[+b.dataset.n];
    await openEpisode(r.e.id);
    if (r.k === 'text') { FIND.cs = S.srCase; $('#fCase').classList.toggle('on', FIND.cs); openFind(q); FIND.i = Math.max(0, FIND.hits.indexOf(r.pos)); gotoHit(FIND.i); }
    if (r.k === 'memo') showPane('memo');
  };
}
function scrollToCaret(pos) { // 대략적인 위치로 스크롤
  const lines = ed.value.slice(0, pos).split('\n').length; const total = ed.value.split('\n').length || 1;
  ed.scrollTop = Math.max(0, (ed.scrollHeight * (lines / total)) - ed.clientHeight / 3);
}

// ================= 찾기 · 바꾸기 =================
// 원칙: 원고는 언제나 편집기 → 평소 저장(flushSave) 경로로만 바뀜. 모두 바꾸기 전에는 수정 기록을 남기고, 되돌리기 제공.
const FIND = { q: '', rep: '', cs: false, hits: [], i: -1 };
const findIdx = (h, q, cs) => { const out = []; if (!q) return out; const H = cs ? h : h.toLowerCase(), Q = cs ? q : q.toLowerCase(); let p = H.indexOf(Q); while (p >= 0) { out.push(p); p = H.indexOf(Q, p + Q.length); } return out; };
const hl = document.createElement('div'); hl.className = 'hl-layer'; hl.setAttribute('aria-hidden', 'true'); ed.parentNode.insertBefore(hl, ed);
const HL_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'borderRightWidth', 'borderBottomWidth', 'boxSizing', 'textIndent', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'textAlign'];
function drawHL() {
  if ($('#findBar').hidden || !FIND.q || ed.hidden) { hl.hidden = true; hl.innerHTML = ''; return; }
  const cs = getComputedStyle(ed); for (const k of HL_PROPS) hl.style[k] = cs[k];
  hl.style.left = ed.offsetLeft + 'px'; hl.style.top = ed.offsetTop + 'px'; hl.style.width = ed.clientWidth + 'px'; hl.style.height = ed.clientHeight + 'px';
  hl.style.borderColor = 'transparent'; hl.style.borderStyle = 'solid';
  const v = ed.value, L = FIND.q.length; let out = '', last = 0;
  FIND.hits.forEach((p, k) => { out += esc(v.slice(last, p)) + `<mark class="${k === FIND.i ? 'cur' : ''}">${esc(v.slice(p, p + L))}</mark>`; last = p + L; });
  hl.innerHTML = out + esc(v.slice(last)) + '\n'; hl.hidden = false; hl.scrollTop = ed.scrollTop;
}
ed.addEventListener('scroll', () => { if (!hl.hidden) hl.scrollTop = ed.scrollTop; });
function refind(keepNear) {
  FIND.hits = findIdx(ed.value, FIND.q, FIND.cs);
  if (!FIND.hits.length) FIND.i = -1;
  else if (keepNear != null) { const k = FIND.hits.findIndex(p => p >= keepNear); FIND.i = k < 0 ? 0 : k; }
  else if (FIND.i >= FIND.hits.length) FIND.i = FIND.hits.length - 1;
  $('#fCount').textContent = FIND.q ? (FIND.hits.length ? `${FIND.i + 1}/${FIND.hits.length}` : '0개') : '';
  $('#fCount').classList.toggle('none', !!FIND.q && !FIND.hits.length);
  drawHL();
}
function gotoHit(k, { select = true } = {}) {
  if (!FIND.hits.length) return; FIND.i = (k + FIND.hits.length) % FIND.hits.length; refind();
  const p = FIND.hits[FIND.i];
  if (select) { ed.focus({ preventScroll: true }); ed.setSelectionRange(p, p + FIND.q.length); }
  const m = hl.querySelector('mark.cur'); if (m) { ed.scrollTop = Math.max(0, m.offsetTop - ed.clientHeight / 3); hl.scrollTop = ed.scrollTop; } else scrollToCaret(p);
}
function openFind(q) {
  const bar = $('#findBar'); bar.hidden = false; $('#btnFind').classList.add('on');
  const sel = ed.value.slice(ed.selectionStart, ed.selectionEnd);
  if (q != null) $('#fQ').value = q; else if (sel && sel.length < 80 && !sel.includes('\n')) $('#fQ').value = sel;
  FIND.q = $('#fQ').value; refind(ed.selectionStart); $('#fQ').focus(); $('#fQ').select();
}
function closeFind() { $('#findBar').hidden = true; $('#btnFind').classList.remove('on'); hl.hidden = true; hl.innerHTML = ''; }
$('#btnFind').onclick = () => $('#findBar').hidden ? openFind() : closeFind();
$('#fClose').onclick = () => { closeFind(); ed.focus({ preventScroll: true }); };
let fT; $('#fQ').addEventListener('input', e => { clearTimeout(fT); fT = setTimeout(() => { FIND.q = e.target.value; refind(ed.selectionStart); if (FIND.hits.length) gotoHit(FIND.i, { select: false }); }, 120); });
$('#fQ').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); FIND.q = $('#fQ').value; refind(); gotoHit(FIND.i + (e.shiftKey ? -1 : 1) - (FIND.i < 0 ? 0 : 0)); } if (e.key === 'Escape') closeFind(); });
$('#fRep').addEventListener('input', e => FIND.rep = e.target.value);
$('#fRep').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); replaceOne(); } if (e.key === 'Escape') closeFind(); });
$('#fPrev').onclick = () => { FIND.q = $('#fQ').value; refind(); gotoHit(FIND.i - 1); };
$('#fNext').onclick = () => { FIND.q = $('#fQ').value; refind(); gotoHit(FIND.i + 1); };
$('#fCase').onclick = () => { FIND.cs = !FIND.cs; $('#fCase').classList.toggle('on', FIND.cs); $('#fCase').setAttribute('aria-pressed', FIND.cs); refind(ed.selectionStart); };
$('#fRepToggle').onclick = () => { const r = $('#findBar').classList.toggle('rep'); $('#fRepToggle').setAttribute('aria-expanded', r); if (r) $('#fRep').focus(); };
function editorReplace(from, to, text) { S.pasteChars += Math.max(0, [...text].length - (to - from)); ed.setRangeText(text, from, to, 'end'); ed.dispatchEvent(new Event('input')); }
function replaceOne() {
  FIND.q = $('#fQ').value; refind(); if (!FIND.hits.length || !S.cur) return;
  const p = FIND.hits[Math.max(0, FIND.i)]; const rep = $('#fRep').value;
  editorReplace(p, p + FIND.q.length, rep); refind(p + rep.length);
  if (FIND.hits.length) gotoHit(FIND.i); toast(FIND.hits.length ? `1곳을 바꿨어요 · 남은 ${FIND.hits.length}곳` : '1곳을 바꿨어요 · 모두 바꿨어요', 1800);
}
async function replaceAllHere() {
  FIND.q = $('#fQ').value; refind(); const n = FIND.hits.length; const ep = S.cur && findEp(S.cur); if (!n || !ep) return;
  const rep = $('#fRep').value; const before = ed.value;
  await flushSave(); await snapshot({ ...(await db.get('episodes', ep.id)), text: before }, 'before-replace', `「${FIND.q}」→「${rep}」 ${n}곳`);
  let out = '', last = 0; for (const p of FIND.hits) { out += before.slice(last, p) + rep; last = p + FIND.q.length; } out += before.slice(last);
  const st = ed.scrollTop; editorReplace(0, before.length, out); ed.setSelectionRange(0, 0); ed.scrollTop = st; await flushSave(); refind();
  toast(`${n}곳을 바꿨어요 (바꾸기 전 원고는 수정 기록에 있어요)`, 7000, 'great', { label: '되돌리기', fn: async () => {
    if (S.cur !== ep.id) await openEpisode(ep.id);
    if (ed.value !== out) { toast('그 뒤로 원고가 바뀌어서 수정 기록에서 복원해 주세요', 4000, 'oops'); return showPane('hist'); }
    editorReplace(0, out.length, before); ed.scrollTop = st; await flushSave(); refind(); toast('바꾸기 전으로 되돌렸어요');
  } });
}
$('#fRepOne').onclick = replaceOne; $('#fRepAll').onclick = replaceAllHere;
ed.addEventListener('input', () => { if (!$('#findBar').hidden && FIND.q) { clearTimeout(fT); fT = setTimeout(() => refind(), 150); } });
window.addEventListener('resize', () => { if (!hl.hidden) drawHL(); });
document.addEventListener('keydown', e => {
  if (S.tab !== 'note' || $('#editorView').hidden || $('#dlg').open) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (k === 'f' || k === 'h')) { e.preventDefault(); openFind(); if (k === 'h' && !$('#findBar').classList.contains('rep')) $('#fRepToggle').click(); }
  else if (e.key === 'F3') { e.preventDefault(); e.shiftKey ? $('#fPrev').click() : $('#fNext').click(); }
});

// ---------- 모든 작품에서 바꾸기 (사이드 검색) ----------
async function replaceEverywhere(q, rep, cs) {
  await flushSave(); await loadAll();
  const targets = [];
  for (const w of S.works) for (const [i, e] of (S.eps.get(w.id) || []).entries()) { if (e.conflict) continue; const n = findIdx(e.text || '', q, cs).length; if (n) targets.push({ w, e, i, n }); }
  const skipped = [...S.eps.values()].flat().filter(e => e.conflict && findIdx(e.text || '', q, cs).length).length;
  const total = targets.reduce((a, t) => a + t.n, 0); if (!total) return toast('바꿀 곳이 없어요');
  const ok = await dialog({ title: '모든 회차에서 바꾸기', html: `<p>「<b>${esc(q)}</b>」 → 「<b>${esc(rep)}</b>」${cs ? ' (대소문자 구분)' : ''}</p>
    <p><b>${targets.length}개 회차 · ${total}곳</b>을 바꿀까요? 회차마다 바꾸기 전 원고를 <b>수정 기록</b>에 남기고, 끝나면 「되돌리기」도 할 수 있어요.</p>
    <div class="rp-list">${targets.slice(0, 30).map(t => `<div>${esc(t.w.title)} · ${esc(Drive.episodeLabel(t.e, t.i))} <b>${t.n}곳</b></div>`).join('')}${targets.length > 30 ? `<div class="mute">… 외 ${targets.length - 30}개 회차</div>` : ''}</div>
    ${skipped ? `<p class="small mute">⚠ 충돌을 고르는 중인 회차 ${skipped}개는 건너뛰어요.</p>` : ''}<p class="small mute">회차 본문만 바꿔요 (제목·메모·설계 노트는 그대로).</p>`,
    buttons: [{ label: '취소', value: 'cancel' }, { label: `${total}곳 모두 바꾸기`, value: 'ok', cls: 'brand' }] });
  if (ok !== 'ok') return;
  const done = [];
  for (const t of targets) {
    const cur = await db.get('episodes', t.e.id); if (!cur || cur.conflict) continue;
    const pos = findIdx(cur.text || '', q, cs); if (!pos.length) continue;
    let out = '', last = 0; for (const p of pos) { out += cur.text.slice(last, p) + rep; last = p + q.length; } out += cur.text.slice(last);
    await snapshot(cur, 'before-replace', `「${q}」→「${rep}」 ${pos.length}곳`);
    const u = await db.update('episodes', cur.id, c => c && c.text === cur.text ? (c.text = out, c.rev = (c.rev || 0) + 1, c.dirty = true, c.updatedAt = Date.now(), c) : undefined);
    if (u) { done.push({ id: cur.id, before: cur.text, after: out, n: pos.length }); if (S.cur === cur.id) { const st = ed.scrollTop; ed.value = out; ed.scrollTop = st; updateCounts(); } }
  }
  await loadAll(); renderSide(); scheduleSync(1500); if (!$('#findBar').hidden) refind();
  const n = done.reduce((a, d) => a + d.n, 0);
  toast(`${done.length}개 회차 · ${n}곳을 바꿨어요`, 8000, 'great', { label: '되돌리기', fn: async () => {
    await flushSave(); let back = 0, miss = 0;
    for (const d of done) { const u = await db.update('episodes', d.id, c => c && c.text === d.after ? (c.text = d.before, c.rev = (c.rev || 0) + 1, c.dirty = true, c.updatedAt = Date.now(), c) : undefined); if (u) { back++; if (S.cur === d.id) { ed.value = d.before; updateCounts(); } } else miss++; }
    await loadAll(); renderSide(); scheduleSync(1500); if (!$('#searchResults').hidden) doSearch();
    toast(miss ? `${back}개 회차를 되돌렸어요 · ${miss}개는 그 뒤로 바뀌어서 수정 기록에서 복원해 주세요` : `${back}개 회차를 바꾸기 전으로 되돌렸어요`, 5000);
  } });
  if (!$('#searchResults').hidden) doSearch();
}

// ================= 오디오: 받아쓰기 =================
const dict = new Dictation({
  onFinal: t => {
    if (!t) return; ed.focus();
    const s = ed.selectionStart; const before = ed.value.slice(0, s);
    const sp = before && !/[\s\n]$/.test(before) ? ' ' : '';
    ed.setRangeText(sp + t, s, ed.selectionEnd, 'end'); ed.dispatchEvent(new Event('input'));
    $('#micText').textContent = '✓ ' + t;
  },
  onInterim: t => { if (t) $('#micText').textContent = '… ' + t; },
  onState: on => { $('#micBar').hidden = !on; $('#btnMic').classList.toggle('on', on); if (on) $('#micText').textContent = '듣고 있어요… 말해 보세요'; },
  onError: m => toast(m, 4500),
});
$('#btnMic').onclick = () => { if (dict.active) return dict.stop(); stopReader(); dict.start(); };
$('#micStop').onclick = () => dict.stop();

// 재독에서도 같은 textarea를 사용해 저장·IME·실행 취소·동기화 경로를 유지한다.
function setReread(on) {
  $('#editorView').classList.toggle('rereading', on);
  $('#rereadBar').hidden = !on;
  $('#btnReread').classList.toggle('on', on);
  $('#btnReread').setAttribute('aria-pressed', String(on));
  checkEpEnd();
}
async function startReread() {
  const id = S.cur;
  const ep = findEp(id);
  if (!ep) return false;
  if (!$('#rereadBar').hidden) return true;
  $('#btnReread').disabled = true;
  try {
    await snapshot({ ...ep, text: ed.value, title: $('#epTitle').value }, 'before-reread', '재독 수정 전');
    if (S.cur !== id) return false;
    stopReader(); setReread(true); ed.focus({ preventScroll: true });
    return true;
  } catch (e) { toast('수정 전 원고를 보관하지 못했어요: ' + e.message); return false; }
  finally { $('#btnReread').disabled = false; }
}
$('#btnReread').onclick = () => {
  if ($('#rereadBar').hidden) startReread();
  else { stopReader(); setReread(false); flushSave(); ed.focus({ preventScroll: true }); }
};
$('#btnRereadClose').onclick = () => { stopReader(); setReread(false); flushSave(); ed.focus({ preventScroll: true }); };
$('#btnRereadHistory').onclick = () => showPane('hist');

// ================= 오디오: 내 소설 듣기 =================
let reader;
function paraEls() { return $$('#reader p'); }
reader = new Reader({
  onPara: i => { paraEls().forEach((p, k) => p.classList.toggle('speaking', k === i)); paraEls()[i]?.scrollIntoView({ block: 'center', behavior: 'smooth' }); },
  onState: s => {
    $('#ttsPlay').textContent = s === 'playing' ? '⏸ 일시정지' : '▶ 이어 듣기';
    if (s === 'ended') { toast('끝까지 읽었어요'); $('#ttsPlay').textContent = '▶ 처음부터'; reader.i = 0; }
    if (s === 'unsupported') toast('이 브라우저는 읽어 주기를 지원하지 않아요.');
    if (s === 'failed') { toast('음성 엔진이 응답하지 않아요. 휴대폰 설정 › 텍스트 음성 변환에서 한국어 음성을 설치해 주세요.', 5000); $('#ttsPlay').textContent = '▶ 다시 듣기'; }
  },
});
function fillVoices() {
  const vs = koVoices(); const sel = $('#ttsVoice'); const saved = S.settings.voiceURI;
  sel.innerHTML = vs.length ? vs.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === saved ? 'selected' : ''}>${esc(v.name)}${/^ko/i.test(v.lang) ? '' : ' (' + v.lang + ')'}</option>`).join('') : '<option value="">기본 목소리</option>';
}
onVoicesChanged(fillVoices);
function openReader() {
  if (!ttsSupported) { toast('이 브라우저는 읽어 주기(TTS)를 지원하지 않아요. 크롬이나 삼성 인터넷에서 써 주세요.', 4500); return; }
  dict.stop(); flushSave();
  const paras = ed.value.split('\n');
  $('#reader').innerHTML = paras.map((p, i) => p.trim() ? `<p data-i="${i}">${esc(p)}</p>` : `<p class="blank" data-i="${i}"></p>`).join('');
  reader.load(paras.map(t => ({ text: t })));
  $('#reader').hidden = false; ed.hidden = true; $('#ttsBar').hidden = false; $('#btnListen').classList.add('on');
  $('#reader').insertAdjacentHTML('beforeend', `<div class="ep-end ep-end-r">${epEndHTML()}</div>`);
  fillVoices(); $('#ttsRate').value = S.settings.rate || 1; $('#ttsRateOut').textContent = (+$('#ttsRate').value).toFixed(1) + '×'; $('#ttsDialog').checked = !!S.settings.dialogDiff;
  // 커서가 있던 문단부터
  const startPara = ed.value.slice(0, ed.selectionStart).split('\n').length - 1;
  readerOpts(); reader.play(Math.max(0, Math.min(startPara, paras.length - 1)));
}
function readerOpts() { reader.setOpts({ rate: +$('#ttsRate').value, voiceURI: $('#ttsVoice').value, dialogDiff: $('#ttsDialog').checked, dialogVoiceURI: S.settings.dialogVoiceURI }); }
function stopReader() { if ($('#ttsBar').hidden) return; reader.stop(); $('#reader').hidden = true; ed.hidden = false; $('#ttsBar').hidden = true; $('#btnListen').classList.remove('on'); }
$('#btnListen').onclick = () => $('#ttsBar').hidden ? openReader() : stopReader();
$('#ttsStop').onclick = stopReader;
$('#ttsEdit').onclick = async () => {
  const id = S.cur;
  const pos = ed.value.split('\n').slice(0, reader.i).reduce((n, p) => n + p.length + 1, 0);
  stopReader();
  if (!(await startReread()) || S.cur !== id) return;
  ed.focus({ preventScroll: true }); ed.setSelectionRange(pos, pos);
  scrollToCaret(pos);
};
$('#ttsPlay').onclick = () => { readerOpts(); reader.playing ? reader.pause() : (reader.i >= reader.paras.length ? reader.play(0) : reader.resume()); };
$('#ttsRate').oninput = () => { $('#ttsRateOut').textContent = (+$('#ttsRate').value).toFixed(1) + '×'; S.settings.rate = +$('#ttsRate').value; saveSettings(); readerOpts(); if (reader.playing) reader.play(reader.i); };
$('#ttsVoice').onchange = () => { S.settings.voiceURI = $('#ttsVoice').value; saveSettings(); readerOpts(); if (reader.playing) reader.play(reader.i); };
$('#ttsDialog').onchange = () => { S.settings.dialogDiff = $('#ttsDialog').checked; saveSettings(); readerOpts(); };
$('#reader').addEventListener('click', e => { const p = e.target.closest('p[data-i]'); if (!p) return; readerOpts(); reader.play(+p.dataset.i); });

// ================= 오디오: 아이디어 녹음 =================
const rec = new Recorder(); let recTimer;
$('#btnRecord').onclick = async () => {
  if (rec.mr) return;
  if (!recSupported) return toast('이 브라우저는 녹음을 지원하지 않아요.', 4000);
  try { await rec.start(); } catch (e) { return toast(e.message, 4500); }
  $('#recBar').hidden = false; $('#btnRecord').classList.add('on');
  recTimer = setInterval(() => $('#recTime').textContent = fmtDur(rec.elapsed()), 500);
};
async function endRec(save) {
  clearInterval(recTimer); const r = await rec.stop(save);
  $('#recBar').hidden = true; $('#btnRecord').classList.remove('on'); $('#recTime').textContent = '00:00';
  if (!r || !S.cur) return;
  const ep = findEp(S.cur); const d = new Date();
  const ext = r.mime.includes('mp4') ? 'm4a' : r.mime.includes('ogg') ? 'ogg' : 'webm';
  const name = `${safeName(labelOf(ep))}_아이디어_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.${ext}`;
  await db.put('memos', { id: db.uid('m'), episodeId: ep.id, workId: ep.workId, blob: r.blob, mime: r.mime, duration: r.duration, createdAt: Date.now(), name, title: '', driveFileId: null });
  toast('🎧 아이디어를 저장했어요'); showPane('voice'); scheduleSync(1500);
}
$('#recStop').onclick = () => endRec(true);
$('#recCancel').onclick = () => endRec(false);
const urls = [];
async function renderVoice() {
  urls.splice(0).forEach(u => URL.revokeObjectURL(u));
  const ms = (await db.byIndex('memos', 'episodeId', S.cur)).sort((a, b) => b.createdAt - a.createdAt);
  $('#voiceList').innerHTML = `<button class="btn gold block" id="voiceRec">⏺ 새 아이디어 녹음</button>` + (ms.length ? ms.map(m => { const u = URL.createObjectURL(m.blob); urls.push(u);
    return `<div class="vm" data-m="${m.id}"><div class="vm-h"><input class="vm-t" value="${esc(m.title || '')}" placeholder="${fmtTime(m.createdAt)} · ${fmtDur(m.duration)}" aria-label="메모 제목"><span class="bdg ${m.driveFileId ? 'ok' : 'wait'}" title="${m.driveFileId ? '드라이브 저장됨' : '드라이브 대기'}">${m.driveFileId ? '☁' : '●'}</span><button class="icon-btn sm" data-v="del" aria-label="삭제">✕</button></div><audio controls preload="metadata" src="${u}"></audio></div>`; }).join('') : '<p class="mute">이 회차에 남긴 음성 메모가 없어요.<br>떠오른 장면을 말로 남겨 두세요.</p>');
}
$('#voiceList').addEventListener('click', async e => {
  if (e.target.id === 'voiceRec') return $('#btnRecord').click();
  const b = e.target.closest('[data-v="del"]'); if (!b) return;
  const id = b.closest('.vm').dataset.m; const m = await db.get('memos', id);
  if (!(await confirmBox('음성 메모 삭제', '이 음성 메모를 지울까요? 드라이브의 파일은 휴지통으로 가요.', '삭제', 'danger'))) return;
  if (m.driveFileId) await db.put('tombstones', { id: m.id, kind: 'memo', fileId: m.driveFileId, at: Date.now() });
  await db.del('memos', id); renderVoice(); scheduleSync(1500);
});
$('#voiceList').addEventListener('change', async e => { const i = e.target.closest('.vm-t'); if (!i) return; const id = i.closest('.vm').dataset.m; await db.update('memos', id, c => c && (c.title = i.value, c)); });

function stopAllAudio() { dict.stop(); stopReader(); if (rec.mr) endRec(true); }

// ================= 내보내기 =================
function epFileBase(ep) { return safeName(`${workOf(ep)?.title || ''} ${labelOf(ep)}${ep.title ? ' ' + ep.title : ''}`); }
// 한 곳에서 고르는 내보내기: 범위(이 회차 / 작품 전체) × 형식(TXT · MD · 한글 · PDF · DOCX · ZIP)
const EXP_FMT = [
  ['txt', 'TXT', '메모장 어디서나 열려요 (UTF-8)'], ['md', 'MD', '마크다운(.md) · 회차는 제목(#)으로 나눠요'],
  ['hwpx', '한글', '한컴오피스 한글(.hwpx) 문서 · 한컴오피스 2014 이상에서 열려요'], ['pdf', 'PDF', '한글 글꼴이 파일 안에 들어가서 어디서 열어도 안 깨져요 (A4) · 한자·이모지는 빠져요'],
  ['docx', 'DOCX', '워드 문서'], ['zip', 'ZIP', '회차별 TXT + 메모 + 전체 DOCX를 한 묶음으로 (작품 전체만)']];
function expSections(wid, ep) {
  const w = S.works.find(x => x.id === wid);
  if (ep) return { title: '', sections: [{ heading: `${labelOf(ep)}${ep.title ? ' ' + ep.title : ''}`, text: ep.text }], base: epFileBase(ep) };
  const eps = S.eps.get(wid) || [];
  return { title: w.title, sections: eps.map((e, i) => ({ heading: Drive.episodeLabel(e, i) + (e.title ? ' ' + e.title : ''), text: e.text })), base: `${safeName(w.title)} 전체` };
}
async function runExport(wid, epId, fmt) {
  await flushSave(); await loadAll();
  const ep = epId ? (await db.get('episodes', epId)) : null; if (ep) Object.assign(findEp(epId), ep);
  const { title, sections, base } = expSections(wid, ep && findEp(epId));
  const w = S.works.find(x => x.id === wid);
  if (!sections.length) return toast('내보낼 회차가 없어요');
  if (fmt === 'zip') return exportWorkZip(wid);
  try {
    if (fmt !== 'txt') toast('파일을 만드는 중이에요…', 20000);
    let blob, ext = fmt, note = '';
    if (fmt === 'txt') blob = EX.makeTxt(title, sections);
    else if (fmt === 'md') blob = EX.makeMd(title, sections);
    else if (fmt === 'hwpx') blob = EX.makeHwpx(title, sections);
    else if (fmt === 'docx') blob = makeDocx(sections);
    else if (fmt === 'pdf') { const F = await EX.loadPdfFont(); const r = await EX.makePdf(title, sections, F); blob = r.blob; if (r.missing) note = ` · 한자·이모지처럼 PDF 글꼴에 없는 글자 ${r.missing}개는 빠졌어요 (한글·DOCX로 저장하면 그대로 있어요)`; }
    download(blob, `${base}.${ext}`);
    toast(`${EXP_FMT.find(f => f[0] === fmt)[1]} 파일을 저장했어요${note}`, note ? 7000 : 2800);
  } catch (err) { console.error(err); toast('내보내지 못했어요: ' + (err.message || err), 5000); }
}
async function exportDialog(wid, epId) {
  const w = S.works.find(x => x.id === wid); const n = (S.eps.get(wid) || []).length;
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('jpsExport') || '{}'); } catch (e) {}
  const st = { scope: epId ? (saved.scope === 'work' ? 'work' : 'ep') : 'work', fmt: EXP_FMT.some(f => f[0] === saved.fmt) ? saved.fmt : 'txt' };
  const draw = f => {
    if (st.scope === 'ep' && st.fmt === 'zip') st.fmt = 'txt';
    f.querySelectorAll('[data-scope]').forEach(b => b.classList.toggle('on', b.dataset.scope === st.scope));
    f.querySelectorAll('[data-fmt]').forEach(b => { b.classList.toggle('on', b.dataset.fmt === st.fmt); if (b.dataset.fmt === 'zip') b.hidden = st.scope === 'ep'; });
    f.querySelector('#expHint').textContent = EXP_FMT.find(x => x[0] === st.fmt)[2];
  };
  const r = await dialog({ title: '내보내기', html:
    (epId ? `<div class="chips" role="group" aria-label="범위"><button type="button" class="chip" data-scope="ep">이 회차</button><button type="button" class="chip" data-scope="work">작품 전체 · ${n}개 회차</button></div>` : `<p class="mute">「${esc(w.title)}」 전체 · ${n}개 회차</p>`) +
    `<div class="chips" role="group" aria-label="형식">${EXP_FMT.map(f => `<button type="button" class="chip" data-fmt="${f[0]}">${f[1]}</button>`).join('')}</div><p class="mute" id="expHint"></p><p class="mute">파일은 이 기기의 다운로드 폴더에 저장돼요. 원고는 밖으로 전송되지 않아요.</p>`,
    buttons: [{ label: '닫기', value: 'cancel' }, { label: '저장', value: 'go', cls: 'gold' }],
    onOpen: f => { draw(f); f.addEventListener('click', e => { const b = e.target.closest('[data-scope],[data-fmt]'); if (!b) return; if (b.dataset.scope) st.scope = b.dataset.scope; if (b.dataset.fmt) st.fmt = b.dataset.fmt; draw(f); }); } });
  if (r !== 'go') return;
  try { localStorage.setItem('jpsExport', JSON.stringify(st)); } catch (e) {}
  await runExport(wid, epId && st.scope === 'ep' ? epId : null, st.fmt);
}
$('#btnExport').onclick = async () => { await flushSave(); const ep = findEp(S.cur); if (ep) exportDialog(ep.workId, ep.id); };
async function exportWorkZip(wid) {
  await flushSave(); await loadAll();
  const w = S.works.find(x => x.id === wid); const eps = S.eps.get(wid) || [];
  const files = [];
  eps.forEach((e, i) => files.push({ name: `${safeName(w.title)}/${safeName(Drive.episodeLabel(e, i) + (e.title ? ' ' + e.title : ''))}.txt`, data: '\uFEFF' + e.text.replace(/\n/g, '\r\n') }));
  eps.forEach((e, i) => { if (e.memo) files.push({ name: `${safeName(w.title)}/메모/${safeName(Drive.episodeLabel(e, i))} 메모.txt`, data: '\uFEFF' + e.memo.replace(/\n/g, '\r\n') }); });
  const docx = await zipBytes(makeDocx(eps.map((e, i) => ({ heading: Drive.episodeLabel(e, i) + (e.title ? ' ' + e.title : ''), text: e.text }))));
  files.push({ name: `${safeName(w.title)}/${safeName(w.title)} 전체.docx`, data: docx });
  download(makeZip(files), `${safeName(w.title)}.zip`); toast(`${eps.length}개 회차를 ZIP으로 묶었어요`);
}

// ================= TXT 가져오기 =================
let importTarget = null;
$('#btnImport').onclick = () => pickImport(findEp(S.cur)?.workId || null);
function pickImport(wid) { importTarget = wid; $('#fileImport').value = ''; $('#fileImport').click(); }
$('#fileImport').addEventListener('change', async e => {
  const files = [...e.target.files]; if (!files.length) return;
  const items = [];
  for (const f of files) { const { text, enc } = decodeText(await f.arrayBuffer()); items.push({ f, text: normalizeText(text), enc, no: detectEpisodeNo(f.name), title: titleFromFilename(f.name) }); }
  items.sort((a, b) => (a.no ?? 1e9) - (b.no ?? 1e9) || a.f.name.localeCompare(b.f.name, 'ko', { numeric: true }));
  const wopts = S.works.map(w => `<option value="${w.id}" ${w.id === importTarget ? 'selected' : ''}>${esc(w.title)}</option>`).join('');
  let target = importTarget || S.works[0]?.id || '__new';
  const r = await dialog({ title: `TXT ${items.length}개 가져오기`, wide: true, html: `
    <label class="fld">넣을 작품 <select id="impWork">${wopts}<option value="__new" ${!S.works.length ? 'selected' : ''}>＋ 새 작품 만들기</option></select></label>
    <label class="fld" id="impNewWrap" ${S.works.length ? 'hidden' : ''}>새 작품 이름<input id="impNew" placeholder="예: 바람의 사수"></label>
    <table class="imp"><thead><tr><th>파일</th><th>회차</th><th>인코딩</th><th>글자</th></tr></thead><tbody>${items.map(it => `<tr><td>${esc(it.f.name)}</td><td>${it.no != null ? it.no + '화' : '<span class="mute">순서대로</span>'}</td><td>${it.enc}</td><td>${counts(it.text).noSp.toLocaleString()}</td></tr>`).join('')}</tbody></table>
    <p class="mute small">파일 이름의 「3화」 같은 번호로 순서를 맞춰요. 기존 회차는 지우지 않아요.</p>`,
    buttons: [{ label: '취소', value: 'cancel' }, { label: '가져오기', value: 'ok', cls: 'gold' }],
    onOpen: f => { const s = f.querySelector('#impWork'); const nw = f.querySelector('#impNewWrap'); s.onchange = () => { target = s.value; nw.hidden = s.value !== '__new'; }; target = s.value; f.querySelector('#impNew').oninput = ev => importTarget = ev.target.value; } });
  if (r !== 'ok') return;
  let wid = target;
  if (wid === '__new') { const name = (typeof importTarget === 'string' && !S.works.find(w => w.id === importTarget) ? importTarget : '') || items[0].f.name.replace(/\s*\d+\s*화.*$/, '').replace(/\.[^.]+$/, '').trim() || '가져온 작품'; wid = (await newWork(name)).id; }
  const list = S.eps.get(wid) || [];
  // 기존 회차는 번호(=위치+1), 가져온 회차는 파일 번호 위치에 끼워 넣음
  list.forEach((x, i) => x.order = i + 1);
  let added = 0;
  for (const it of items) {
    const no = it.no ?? (list.length + 1 + added);
    const empty = list.find((x, i) => i + 1 === no && !x.text.trim() && !x._imp);
    if (empty) { await db.update('episodes', empty.id, c => (c.text = it.text, c.title = c.title || it.title, c.dirty = true, c.rev++, c)); Object.assign(empty, { text: it.text, title: empty.title || it.title, _imp: true }); }
    else { const ep = await newEpisode(wid, { text: it.text, title: it.title, order: no - 0.5 + added * 1e-4 }); ep._imp = true; }
    added++;
  }
  await renumber(wid); await loadAll(); S.open.add(wid); saveOpen(); renderSide();
  toast(`${items.length}개 회차를 가져왔어요`);
  const first = (S.eps.get(wid) || [])[0]; if (first && !S.cur) openEpisode(first.id);
});

// ================= 설정 =================
$('#btnSettings').onclick = openSettings;
async function openSettings() {
  const cid = (await db.kv.get('clientId')) || ''; const def = window.YW_CONFIG?.DEFAULT_CLIENT_ID || '';
  const linked = await Drive.wasConnected(); const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const st = S.settings;
  const r = await dialog({ title: '설정', wide: true, html: `
    <section class="set"><h4>☁ 구글 드라이브</h4>
      <p class="mute small">원고는 <b>이 기기</b>와 <b>내 구글 드라이브</b>에만 저장돼요. 앱 권한은 「이 앱이 만든 파일만」(drive.file)이라 다른 드라이브 파일은 볼 수 없어요. 드라이브에는 「${esc(window.YW_CONFIG?.DRIVE_ROOT_NAME || '집필실')}/작품/01화」 구글 문서로, 목록표·인물표는 구글 시트로, 사진은 「아이디어 사진」 폴더에 저장돼요.</p>
      <label class="fld">OAuth 클라이언트 ID <input id="setCid" value="${esc(cid || def)}" placeholder="1234…apps.googleusercontent.com" autocomplete="off" spellcheck="false" inputmode="url"></label>
      <p class="small mute" id="setCidNote">${def && (!cid || cid === def) ? '✓ 기본 ID가 들어 있어요. 그대로 「구글 드라이브 연결」을 누르면 돼요.' : cid ? '이 기기에 직접 넣은 ID를 쓰고 있어요.' : 'ID를 붙여 넣은 뒤 연결을 눌러 주세요.'}</p>
      <p class="small"><a href="https://github.com/${esc(REPO)}/blob/main/DRIVE_SETUP.md" target="_blank" rel="noopener">클라이언트 ID 만드는 방법 (10분)</a></p>
      <div class="row">${linked ? `<button type="button" class="btn gold" id="setConnect">${Drive.hasValidToken() ? '✓ 연결됨 · 다시 연결' : '다시 연결'}</button><button type="button" class="btn" id="setSync">지금 동기화</button><button type="button" class="btn danger" id="setDisc">연결 끊기</button>` : `<button type="button" class="btn gold" id="setConnect">구글 드라이브 연결</button>`}</div>
      <div class="set-msg" id="setMsg" role="status" aria-live="polite" hidden></div>
    </section>
    <section class="set"><h4>✒ 집필 화면</h4>
      <label class="fld">필명 (인사말에 쓰여요 · 비워도 돼요)<input id="setPen" value="${esc(st.penName || '')}" placeholder="예: 필명" maxlength="20"></label>
      <div class="row wrap"><label class="fld">테마 <select id="setTheme"><option value="light">라벤더 (밝게)</option><option value="dark">밤 (어둡게)</option><option value="sepia">세피아</option></select></label>
      <label class="fld">본문 글꼴 <select id="setFont">${FONTS.map(f => `<option value="${f.id}">${f.name} (${f.kind})</option>`).join('')}</select></label>
      <label class="fld">줄 간격 <select id="setLh">${[...new Set([1.6, 1.8, 1.9, 2.1, 2.4, +st.lineH])].sort((a, b) => a - b).map(v => `<option>${v}</option>`).join('')}</select></label>
      <label class="fld">자동 버전 저장 <select id="setSnap"><option value="5">5분마다</option><option value="10">10분마다</option><option value="20">20분마다</option><option value="30">30분마다</option></select></label></div>
      <label class="chk"><input type="checkbox" id="setTidy" ${st.tidy ? 'checked' : ''}> 붙여넣을 때 줄 끝 공백·과한 빈 줄 정리</label>
    </section>
    <section class="set"><h4>💾 이 기기 저장 공간</h4>
      <p class="mute small">${est ? `사용 ${(est.usage / 1048576).toFixed(1)}MB / 가능 ${(est.quota / 1073741824).toFixed(1)}GB · ` : ''}${persisted ? '브라우저가 지우지 않도록 보호됨 ✓' : '홈 화면에 설치하면 더 안전하게 보관돼요'}</p>
      <div class="row"><button type="button" class="btn" id="setBackup">전체 백업 ZIP 받기</button></div>
    </section>`,
    buttons: [{ label: '닫기', value: 'cancel' }, { label: '저장', value: 'ok', cls: 'gold' }],
    onOpen: f => {
      f.querySelector('#setTheme').value = st.theme; f.querySelector('#setFont').value = fontOf(st.font).id; f.querySelector('#setLh').value = String(st.lineH); f.querySelector('#setSnap').value = String(st.snapMin);
      f.querySelector('#setTheme').onchange = e => { st.theme = e.target.value; saveSettings(); };
      const cidOf = () => f.querySelector('#setCid').value.trim() || def;
      const saveCid = () => { const v = cidOf(); S.clientId = v; return db.kv.set('clientId', v === def ? '' : v); };
      f.querySelector('#setCid').addEventListener('change', saveCid);
      Drive.prepare().catch(() => {}); // 미리 구글 로그인 스크립트 불러오기
      const msg = (t, kind) => { const m = f.querySelector('#setMsg'); if (!m) return; m.hidden = !t; m.className = 'set-msg ' + (kind || ''); m.innerHTML = kind === 'err' ? `<img src="${STK.oops}" alt=""><span>${esc(t)}<br><b>아쉽다, 다시 해보자!</b></span>` : `<span>${esc(t)}</span>`; };
      const btn = f.querySelector('#setConnect');
      btn.onclick = () => {
        const id = cidOf(); saveCid(); // 저장은 뒤에서 — 로그인 창은 클릭 즉시 (팝업 차단 방지)
        const go = () => Drive.connectNow(id);
        let p = go();
        msg('구글 로그인 창을 여는 중… 새 창에서 계정을 고르고 「계속」을 눌러 주세요.'); btn.disabled = true;
        p = p.catch(async e => { if (!e.notReady) throw e; msg('구글 로그인 준비 중…'); await Drive.loadGIS(); return go(); });
        p.then(() => { btn.disabled = false; toast('구글 드라이브에 연결했어요', 3000, 'great'); $('#dlg').close('cancel'); runSync('manual'); updateStatus(); })
         .catch(e => { btn.disabled = false; msg(e.message, 'err'); toast(e.message, 6000, 'oops'); });
      };
      f.querySelector('#setSync') && (f.querySelector('#setSync').onclick = () => { $('#dlg').close('cancel'); runSync('manual'); });
      f.querySelector('#setDisc') && (f.querySelector('#setDisc').onclick = async () => { if (await confirmBox('연결 끊기', '드라이브 연결을 끊을까요? 원고는 기기와 드라이브 양쪽에 그대로 남아요.', '끊기', 'danger')) { await Drive.disconnect(); updateStatus(); toast('연결을 끊었어요'); } });
      f.querySelector('#setBackup').onclick = backupAll;
    } });
  if (r === 'ok') {
    const f = $('#dlgForm');
    { const v = f.querySelector('#setCid')?.value.trim() || def; S.clientId = v; await db.kv.set('clientId', v === def ? '' : v); }
    Object.assign(st, { penName: f.querySelector('#setPen').value.trim(), theme: f.querySelector('#setTheme').value, font: f.querySelector('#setFont').value, lineH: +f.querySelector('#setLh').value, snapMin: +f.querySelector('#setSnap').value, tidy: f.querySelector('#setTidy').checked });
    saveSettings(); toast('설정을 저장했어요');
  }
}
async function backupAll() {
  await flushSave(); await loadAll(); const files = [];
  for (const w of S.works) (S.eps.get(w.id) || []).forEach((e, i) => files.push({ name: `${safeName(w.title)}/${safeName(Drive.episodeLabel(e, i) + (e.title ? ' ' + e.title : ''))}.txt`, data: '\uFEFF' + e.text.replace(/\n/g, '\r\n') }));
  try { const af = await AI.backupFile(); if (af) files.push(af); } catch (e) {} // AI 작업(원고와 따로)도 함께
  const d = new Date(); download(makeZip(files), `집필실_백업_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.zip`);
}

document.addEventListener('click', async e => {
  if (e.target.id === 'btnReauth') reconnect();
  if (e.target.id === 'btnSyncNow') runSync('manual');
});

// ================= 온라인/오프라인 =================
window.addEventListener('online', () => { toast('인터넷이 다시 연결됐어요. 드라이브에 올릴게요.'); updateStatus(); runSync('online'); });
window.addEventListener('offline', () => { S.syncState = 'offline'; updateStatus(); toast('인터넷이 끊겼어요. 원고는 기기에 안전하게 저장돼요.', 3500); });
setInterval(() => { if (document.visibilityState === 'visible') runSync('interval'); }, 90_000); // 다른 기기에서 고친 내용 받아오기

// ================= 집필실: 탭 · 홈 · 작품표 · 보관함 · 마이 · 타이머 · 기록 =================
const TABS = ['home', 'works', 'note', 'vault', 'my'];
const cap = t => t[0].toUpperCase() + t.slice(1);
const isDesk = () => matchMedia('(min-width: 900px)').matches;
const ICON = {
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z"/><path d="M13.5 7.5l3 3"/></svg>',
  list: '<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="M8 8.5h8M8 12h8M8 15.5h5"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5v3"/></svg>',
  head: '<svg viewBox="0 0 24 24"><path d="M4.5 15v-3a7.5 7.5 0 0 1 15 0v3"/><rect x="3.5" y="14" width="4" height="6" rx="1.6"/><rect x="16.5" y="14" width="4" height="6" rx="1.6"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 10 4.3 4.3 0 0 0 7 18.5z"/><path d="M12 15.5v-5M9.8 12.6 12 10.4l2.2 2.2"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 4.5h10.5a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z"/><path d="M5 16.5a3 3 0 0 1 3-3h10.5"/></svg>',
  mark: '<svg viewBox="0 0 24 24"><path d="M7 4h10v16l-5-3.5L7 20z"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.5M9.5 3h5"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z"/><circle cx="12" cy="13.2" r="3.4"/></svg>',
  img: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8 8.5"/></svg>',
};
function showTab(t, { initial, keep } = {}) {
  if (!TABS.includes(t)) t = 'home';
  if (S.tab === 'note' && t !== 'note') { flushSave(); stopAllAudio(); }
  S.tab = t;
  $$('#tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $$('.view').forEach(v => { const on = v.id === 'v' + cap(t); v.hidden = !on; v.classList.toggle('on', on); });
  if (t !== 'note') document.body.classList.remove('editing');
  if (t !== 'note' && !initial) db.kv.set('lastView', 'list');
  else if (!keep && S.cur && isDesk() && $('#editorView').hidden) openEpisode(S.cur);
  if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
  rerenderTab();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
function rerenderTab() {
  if (S.tab === 'home') renderHome(); else if (S.tab === 'works') renderWorks(); else if (S.tab === 'vault') renderVault(); else if (S.tab === 'my') renderMy();
}

// ---------- 기록: 오늘의 집필 · 연속 집필 ----------
const dkey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
async function getDaily() { return (await db.kv.get('daily')) || {}; }
async function getFocus() { return (await db.kv.get('focusDays')) || {}; }
async function addWritten(n) {
  if (!n) return;
  const d = await getDaily(); const k = dkey(); const before = d[k] || 0; d[k] = before + n; await db.kv.set('daily', d);
  const goal = S.settings.goal || 1000;
  if (before < goal && d[k] >= goal) celebrate('great', `오늘의 목표 ${goal.toLocaleString()}자 달성! 와, 잘했어!!`);
  const wg = document.querySelector('#wgToday b'); if (wg) wg.textContent = d[k].toLocaleString() + '자';
}
function activeDays(daily, focus) { const s = new Set(); for (const [k, v] of Object.entries(daily)) if (v > 0) s.add(k); for (const [k, v] of Object.entries(focus)) if (v > 0) s.add(k); return s; }
function streakOf(days) { let n = 0; const t = new Date(); if (!days.has(dkey(t))) t.setDate(t.getDate() - 1); while (days.has(dkey(t))) { n++; t.setDate(t.getDate() - 1); } return n; }

// ---------- 축하 ----------
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function celebrate(stk, msg) {
  document.querySelector('.cheer')?.remove();
  const el = document.createElement('div'); el.className = 'cheer'; el.setAttribute('role', 'status');
  el.innerHTML = `<img src="${STK[stk] || STK.great}" alt=""><br><p>${esc(msg)}</p>`;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2400); setTimeout(() => el.remove(), 3000);
  if (!reduceMotion()) confetti();
  try { navigator.vibrate?.([30, 40, 30]); } catch (e) {}
}
function confetti() {
  const c = $('#confetti'); const x = c.getContext('2d'); const W = c.width = innerWidth, H = c.height = innerHeight;
  const cols = ['#5A64E8', '#9A8BFF', '#C9C2FF', '#A9D6FF', '#CFE8D8', '#FFD7E6', '#FFE38A'];
  const ps = Array.from({ length: 120 }, () => ({ x: W / 2 + (Math.random() - .5) * 120, y: H * .42, vx: (Math.random() - .5) * 11, vy: -Math.random() * 12 - 4, r: Math.random() * 5 + 3, c: cols[Math.random() * cols.length | 0], a: Math.random() * 6, s: Math.random() < .3 }));
  let t = 0; (function f() {
    x.clearRect(0, 0, W, H); t++;
    for (const p of ps) { p.vy += .32; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.a += .15; x.save(); x.translate(p.x, p.y); x.rotate(p.a); x.fillStyle = p.c; x.globalAlpha = Math.max(0, 1 - t / 110);
      if (p.s) { x.beginPath(); for (let i = 0; i < 4; i++) { x.lineTo(0, -p.r * 1.6); x.rotate(Math.PI / 4); x.lineTo(0, -p.r * .5); x.rotate(Math.PI / 4); } x.fill(); } else x.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.6); x.restore(); }
    if (t < 110) requestAnimationFrame(f); else x.clearRect(0, 0, W, H);
  })();
}

// ---------- 집필 타이머 (뽀모도로) ----------
const T = { mode: 'focus', endAt: 0, remain: 0, total: 0, running: false };
window.__jpsTimer = T; // 테스트용
const modeMin = m => (m === 'focus' ? S.settings.focusMin || 25 : S.settings.breakMin || 5);
async function restoreTimer() {
  Object.assign(T, (await db.kv.get('timer')) || {});
  if (!T.total) { T.total = T.remain = modeMin(T.mode) * 60000; }
  if (T.running && T.endAt <= Date.now()) { T.running = false; T.remain = 0; await timerDone(true); }
  tick();
}
const saveTimer = () => db.kv.set('timer', { mode: T.mode, endAt: T.endAt, remain: T.remain, total: T.total, running: T.running });
function timeLeft() { return T.running ? Math.max(0, T.endAt - Date.now()) : T.remain; }
const mmss = ms => { const s = Math.ceil(ms / 1000); return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; };
function tick() {
  const left = timeLeft(); const txt = mmss(left);
  $('#tvTime').textContent = txt;
  $('#tvArc').style.strokeDashoffset = String(339.3 * (1 - (T.total ? left / T.total : 1)));
  $('#tvGo').textContent = T.running ? '일시정지' : (left < T.total && left > 0 ? '계속' : '시작');
  $$('.tv-mode [data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === T.mode));
  $('#tvStk').src = T.mode === 'focus' ? STK.focus : STK.great;
  const tb = $('#tbTimer'); if (tb) tb.textContent = T.running ? txt : '타이머';
  $('#btnTimerTb')?.classList.toggle('on', T.running);
  const wg = document.querySelector('#wgTimer b'); if (wg) wg.textContent = txt;
  if (T.running && left <= 0) { T.running = false; T.remain = 0; saveTimer(); timerDone(false); }
}
setInterval(() => { if (T.running) tick(); }, 500);
function setMode(m) { T.mode = m; T.running = false; T.total = T.remain = modeMin(m) * 60000; saveTimer(); tick(); }
async function timerDone(quiet) {
  if (T.mode === 'focus') {
    const f = await getFocus(); f[dkey()] = (f[dkey()] || 0) + 1; await db.kv.set('focusDays', f);
    if (!quiet) { beep(); celebrate('great', `집중 ${modeMin('focus')}분 완료! 잠깐 쉬어 가요 ♡`); }
    setMode('break');
  } else { if (!quiet) { beep(); toast('쉬는 시간 끝! 다시 한 문장 써 볼까요?', 3500, 'fighting'); } setMode('focus'); }
  updateTimerInfo(); if (S.tab === 'home') renderHome();
}
function beep() {
  try { const a = new (window.AudioContext || window.webkitAudioContext)(); [0, .18, .36].forEach((t, i) => { const o = a.createOscillator(), g = a.createGain(); o.frequency.value = [784, 988, 1175][i]; g.gain.setValueAtTime(.0001, a.currentTime + t); g.gain.exponentialRampToValueAtTime(.18, a.currentTime + t + .02); g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + t + .3); o.connect(g).connect(a.destination); o.start(a.currentTime + t); o.stop(a.currentTime + t + .32); }); } catch (e) {}
}
async function updateTimerInfo() { const f = await getFocus(); $('#tvInfo').textContent = `오늘 집중 ${f[dkey()] || 0}회 · 집중 ${modeMin('focus')}분 / 쉬기 ${modeMin('break')}분`; }
function openTimer() { $('#timerView').hidden = false; updateTimerInfo(); tick(); }
$('#tvClose').onclick = () => $('#timerView').hidden = true;
$('#timerView').addEventListener('click', e => { if (e.target.id === 'timerView') $('#timerView').hidden = true; });
$('#tvGo').onclick = () => {
  if (T.running) { T.remain = timeLeft(); T.running = false; }
  else { if (T.remain <= 0) T.remain = T.total; T.endAt = Date.now() + T.remain; T.running = true; }
  saveTimer(); tick();
};
$('#tvReset').onclick = () => setMode(T.mode);
$$('.tv-mode [data-m]').forEach(b => b.onclick = () => setMode(b.dataset.m));
$('#btnTimerTb').onclick = openTimer;

// ---------- 북마크 ----------
$('#btnMark').onclick = async () => {
  await flushSave(); const ep = findEp(S.cur); if (!ep) return;
  const pos = ed.selectionStart; const v = ed.value;
  const a = v.lastIndexOf('\n', pos - 1) + 1; let b = v.indexOf('\n', pos); if (b < 0) b = v.length;
  let snippet = v.slice(a, b).trim(); if (!snippet) snippet = v.slice(pos, pos + 80).trim() || '(빈 문단)';
  await db.put('bookmarks', { id: db.uid('b'), episodeId: ep.id, workId: ep.workId, pos: a, snippet: snippet.slice(0, 160), at: Date.now() });
  $('#btnMark').classList.add('on'); setTimeout(() => $('#btnMark').classList.remove('on'), 900);
  toast('🔖 이 문단을 북마크했어요 · 보관함에서 모아 볼 수 있어요');
};
async function openBookmark(bm) {
  if (!findEp(bm.episodeId)) return toast('이 북마크의 회차가 지워졌어요', 3000, 'oops');
  await openEpisode(bm.episodeId);
  let i = ed.value.indexOf(bm.snippet.slice(0, 40)); if (i < 0) i = Math.min(bm.pos, ed.value.length);
  ed.focus(); ed.setSelectionRange(i, i + Math.min(bm.snippet.length, 40)); scrollToCaret(i);
}

// ---------- 새 회차 ----------
async function lastWorkId() { const ep = S.cur && findEp(S.cur); if (ep) return ep.workId; let best = null; for (const [wid, a] of S.eps) for (const e of a) if (!best || e.updatedAt > best.updatedAt) best = e; return best?.workId || S.works[0]?.id; }
async function quickNewEpisode(hint) {
  let wid = await lastWorkId();
  if (!S.works.length) { const t = await ask('첫 작품 만들기', '작품 이름', '', '예: RE:VERSE'); if (!t) return; wid = (await newWork(t)).id; }
  else if (S.works.length > 1) {
    let sel = wid;
    const r = await dialog({ title: '＋ 새 회차 만들기', html: `<label class="fld">어느 작품에 만들까요? <select id="nwSel">${S.works.map(w => `<option value="${w.id}" ${w.id === wid ? 'selected' : ''}>${esc(w.title)}</option>`).join('')}</select></label>`,
      buttons: [{ label: '취소', value: 'cancel' }, { label: '만들기', value: 'ok', cls: 'brand' }], onOpen: f => { const s = f.querySelector('#nwSel'); s.onchange = () => sel = s.value; } });
    if (r !== 'ok') return; wid = sel;
  }
  const ep = await newEpisode(wid); renderSide(); await openEpisode(ep.id);
  if (hint) toast(hint, 3500);
}

// ---------- 홈 ----------
async function renderHome() {
  const daily = await getDaily(); const focus = await getFocus(); const days = activeDays(daily, focus); const streak = streakOf(days);
  const today = daily[dkey()] || 0; const goal = S.settings.goal || 1000; const bms = await db.all('bookmarks');
  const all = [...S.eps.values()].flat().sort((a, b) => b.updatedAt - a.updatedAt);
  const cur = (S.cur && findEp(S.cur)) || all[0];
  const week = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - 6 + i); return d; });
  const hr = new Date().getHours(); const hi = hr < 6 ? '깊은 밤에도 반가워요' : hr < 12 ? '좋은 아침이에요' : hr < 18 ? '좋은 오후예요' : '오늘 밤도 함께해요';
  const left = Math.max(0, goal - today);
  $('#vHome').innerHTML = `<div class="wrap home2">
    <div class="hello"><div><h2>${hi}, ${esc(penLabel())} ♡</h2><p>초안부터 재독까지, 나만의 창작 메이트</p></div><img class="h-moon" src="img/moonbook.webp" width="92" height="76" alt=""></div>
    <div class="h-top"><div class="h-main">
    <section class="hero2">
      <img class="h-art" src="img/hero_art.webp" width="560" height="550" alt="오늘도 파이팅! 하는 마스코트와 고양이">
      <span class="spark" style="left:46%;top:16px">✦</span><span class="spark" style="left:8%;bottom:14px;animation-delay:.8s;color:#FFB5D0">✦</span>
      <div class="hero-txt"><h2><span class="hand">쓰는 오늘,</span>완성의 내일로</h2>
        <p>${cur ? `<b>${esc(workOf(cur)?.title || '')} · ${esc(labelOf(cur))}</b>${cur.title ? ' ' + esc(cur.title) : ''}<br><span class="small" title="${fmtTime(cur.updatedAt)}">마지막 수정 · ${counts(cur.text).noSp.toLocaleString()}자</span>` : '첫 이야기를 시작해 볼까요?<br><span class="small">한 문장이면 충분해요</span>'}</p>
        <div class="btns"><button class="btn brand" id="hContinue">${ICON.pen}${cur ? '이어 쓰기 →' : '집필 시작하기 →'}</button><button class="btn soft" id="hNewEp">＋ 새 회차 만들기</button></div></div>
    </section>
    <div class="widgets w3">
      <button class="wg" id="wgToday"><span class="ic lav">${ICON.pen}</span><span class="wgt"><small>오늘의 집필</small><b>${today.toLocaleString()}자</b><em>${left ? `목표 ${goal.toLocaleString()}자` : '목표 달성 ♡'}</em><span class="meter"><i style="width:${Math.min(100, today / goal * 100)}%"></i></span></span></button>
      <button class="wg" id="wgMark"><span class="ic sky">${ICON.mark}</span><span class="wgt"><small>북마크</small><b>${bms.length}개</b><em>모아 둔 문단</em></span></button>
      <button class="wg" id="wgTimer"><span class="ic pink">${ICON.clock}</span><span class="wgt"><small>집필 타이머</small><b>${mmss(timeLeft())}</b><em>${T.running ? '집중하는 중' : '눌러서 시작'}</em></span></button>
    </div>
    </div><div class="h-side">
    <div class="sec-t"><h3>오늘의 기록</h3></div>
    <button class="streak2" id="bStreak"><img class="s-art" src="img/streak_art.webp" width="380" height="317" alt="">
      <h4><em>${streak}일</em> 연속 집필! <span class="spk">✦</span></h4><p>${streak ? '작은 성실이 이야기를 완성해요.' : '오늘 한 문장이면 연속 기록이 시작돼요.'}</p>
      <div class="days">${week.map((d, i) => `<span class="day ${days.has(dkey(d)) ? 'done' : ''} ${i === 6 ? 'today' : ''}"><i>${days.has(dkey(d)) ? '✓' : ''}</i>${'일월화수목금토'[d.getDay()]}</span>`).join('')}</div></button>
    </div></div>
    <div class="sec-t"><h3>바로 가기</h3></div>
    <div class="feats f5">
      <button class="feat" data-f="draft"><span class="ic lav">${ICON.pen}</span>초안 쓰기<small>떠오르는 대로 바로 기록</small></button>
      <button class="feat" data-f="list"><span class="ic pink">${ICON.list}</span>회차 정리<small>작품별·회차별 깔끔하게</small></button>
      <button class="feat" data-f="voice"><span class="ic sky">${ICON.mic}</span>음성 메모<small>말로 남기는 아이디어</small></button>
      <button class="feat" data-f="listen"><span class="ic lav2">${ICON.head}</span>낭독 듣기<small>귀로 재독하며 다듬기</small></button>
      <button class="feat" data-f="drive"><span class="ic butter">${ICON.cloud}</span>드라이브 저장<small>구글 드라이브 자동 백업</small></button>
    </div>
    <div class="sec-t"><h3>최근 회차</h3>${all.length ? '<button class="link" id="hAll">작품 보기 →</button>' : ''}</div>
    <div class="recent r2">${all.slice(0, 5).map(e => `<button class="rc" data-e="${e.id}"><span class="di">${ICON.list}</span><span class="n">${esc(labelOf(e))}</span><span class="t">${esc(workOf(e)?.title || '')}${e.title ? ' · ' + esc(e.title) : ''}</span><span class="pill s-${e.status || 'draft'}">${STATUS[e.status || 'draft']}</span><span class="m">${counts(e.text).noSp.toLocaleString()}자</span><span class="chev">›</span></button>`).join('') ||
      `<div class="empty-box card"><img src="${STK.oops}" alt="">아직 회차가 없어요. 「＋ 새 회차 만들기」로 시작해 봐요!</div>`}</div>
    ${installCardHTML()}
  </div>`;
  const v = $('#vHome');
  v.querySelector('#hContinue').onclick = () => cur ? openEpisode(cur.id) : quickNewEpisode('ChatGPT 초안을 붙여 넣거나 바로 써 보세요 ✍️');
  v.querySelector('#hNewEp').onclick = () => quickNewEpisode();
  v.querySelector('#wgToday').onclick = () => showTab('my');
  v.querySelector('#wgMark').onclick = () => { S.vaultTab = 'marks'; showTab('vault'); };
  v.querySelector('#wgTimer').onclick = openTimer;
  v.querySelector('#bStreak').onclick = () => showTab('my');
  v.querySelector('#hAll')?.addEventListener('click', () => showTab('works'));
  v.querySelectorAll('.rc[data-e]').forEach(b => b.onclick = () => openEpisode(b.dataset.e));
  v.querySelectorAll('.feat').forEach(b => b.onclick = async () => {
    const f = b.dataset.f;
    if (f === 'draft') return quickNewEpisode('ChatGPT 초안을 붙여 넣거나 바로 써 보세요 ✍️');
    if (f === 'list') { S.workSel = cur?.workId || null; S.workPane = 'list'; return showTab('works'); }
    if (f === 'voice') { if (!cur) return quickNewEpisode(); await openEpisode(cur.id); return $('#btnRecord').click(); }
    if (f === 'listen') { if (!cur) return toast('먼저 회차를 하나 써 볼까요?', 3000, 'oops'); await openEpisode(cur.id); return openReader(); }
    if (f === 'drive') return openSettings();
  });
}

// ---------- 작품: 카드 · 회차 목록표 · 인물·설정표 ----------
S.workSel = null; S.workPane = 'list'; S.sort = { key: 'no', dir: 1 };
function renderWorks() {
  const v = $('#vWorks');
  const w = S.workSel && S.works.find(x => x.id === S.workSel);
  if (!w) {
    v.innerHTML = `<div class="wrap"><div class="hello"><div><h2>작품</h2><p>작품마다 회차와 인물을 정리해요</p></div><div class="row" style="flex:none"><button class="btn ghost small" id="wImport">TXT 가져오기</button><button class="btn brand small" id="wNew">＋ 새 작품</button></div></div>
      <div class="work-cards">${S.works.map(w => { const eps = S.eps.get(w.id) || []; const tot = eps.reduce((a, e) => a + counts(e.text).noSp, 0); const n = { draft: 0, edit: 0, done: 0 }; eps.forEach(e => n[e.status || 'draft']++); const t = eps.length || 1;
        return `<button class="wcard" data-w="${w.id}"><h4>${esc(w.title)}</h4><p>${eps.length}화 · ${tot.toLocaleString()}자 · 인물 ${(w.cast || []).length}명</p><p class="small">초안 ${n.draft} · 수정중 ${n.edit} · 완성 ${n.done}</p><span class="bar"><i style="width:${n.done / t * 100}%;background:#7CC9A0"></i><i style="width:${n.edit / t * 100}%;background:#F5C451"></i><i style="width:${n.draft / t * 100}%;background:#A9D6FF"></i></span></button>`; }).join('')}</div>
      ${S.works.length ? '' : `<div class="empty-box card"><img src="${STK.oops}" alt="">아직 작품이 없어요.<br>RE:VERSE, 조건반사적 복종처럼 작품 폴더를 만들어 보세요.</div>`}</div>`;
    v.querySelector('#wNew').onclick = () => $('#btnNewWork').click();
    v.querySelector('#wImport').onclick = () => pickImport(null);
    v.querySelectorAll('.wcard').forEach(b => b.onclick = () => { S.workSel = b.dataset.w; renderWorks(); v.scrollTop = 0; });
    return;
  }
  const eps = S.eps.get(w.id) || [];
  const tot = eps.reduce((a, e) => { const c = counts(e.text); a[0] += c.noSp; a[1] += c.all; return a; }, [0, 0]);
  v.innerHTML = `<div class="wrap"><div class="wd-head"><button class="icon-btn" id="wBack" aria-label="작품 목록">‹</button><h2>${esc(w.title)}</h2>
    <div class="seg" role="tablist"><button data-p="list" class="${S.workPane === 'list' ? 'on' : ''}">회차 목록표</button><button data-p="cast" class="${S.workPane === 'cast' ? 'on' : ''}">인물·설정표</button></div>
    <button class="icon-btn" id="wMenu" aria-label="작품 메뉴">⋯</button></div><div id="wPane"></div></div>`;
  v.querySelector('#wBack').onclick = () => { S.workSel = null; renderWorks(); };
  v.querySelector('#wMenu').onclick = async () => { await workMenu(w.id); renderWorks(); };
  v.querySelectorAll('.seg [data-p]').forEach(b => b.onclick = () => { S.workPane = b.dataset.p; renderWorks(); });
  const pane = v.querySelector('#wPane');
  if (S.workPane === 'list') {
    const rows = eps.map((e, i) => ({ e, i, no: i + 1, title: e.title || '', chars: counts(e.text).noSp, status: e.status || 'draft', one: e.oneLine || '', upd: e.updatedAt, sync: syncLabel(e) }));
    const k = S.sort.key, dir = S.sort.dir; const so = { draft: 0, edit: 1, done: 2 };
    rows.sort((a, b) => { const x = k === 'status' ? so[a.status] - so[b.status] : typeof a[k] === 'number' ? a[k] - b[k] : String(a[k]).localeCompare(String(b[k]), 'ko'); return (x || a.no - b.no) * dir; });
    const th = (key, label) => `<th data-k="${key}">${label}<span class="ar">${S.sort.key === key ? (dir > 0 ? '▲' : '▼') : '↕'}</span></th>`;
    pane.innerHTML = `<div class="tbl-tools"><button class="btn brand small" id="tAdd">＋ 새 회차 만들기</button><button class="btn ghost small" id="tCsv">목록표 CSV</button><span class="mute small" style="align-self:center">머리글을 누르면 정렬 · 번호·제목을 누르면 열려요</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>${th('no', '번호')}${th('title', '제목')}${th('chars', '글자수')}${th('status', '상태')}${th('one', '한줄 메모')}${th('upd', '마지막 수정')}${th('sync', '드라이브')}</tr></thead>
    <tbody>${rows.map(r => `<tr class="trow" data-e="${r.e.id}"><td class="open num">${esc(Drive.episodeLabel(r.e, r.i))}</td><td class="open">${esc(r.title) || '<span class="mute">제목 없음</span>'}</td><td class="num">${r.chars.toLocaleString()}</td>
      <td><select data-f="status" aria-label="상태">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input data-f="oneLine" value="${esc(r.one)}" placeholder="한줄 메모" maxlength="120"></td><td class="num small">${fmtTime(r.upd)}</td><td><span class="pill">${r.sync}</span></td></tr>`).join('')}</tbody>
    <tfoot><tr><td>합계</td><td>${eps.length}화</td><td class="num">${tot[0].toLocaleString()}</td><td colspan="4" class="small">공백 포함 ${tot[1].toLocaleString()}자 · 원고지 ${Math.ceil(tot[1] / 200).toLocaleString()}매</td></tr></tfoot></table></div>`;
    pane.querySelectorAll('th[data-k]').forEach(t => t.onclick = () => { const key = t.dataset.k; S.sort = { key, dir: S.sort.key === key ? -S.sort.dir : 1 }; renderWorks(); });
    pane.querySelectorAll('td.open').forEach(td => td.onclick = () => openEpisode(td.closest('tr').dataset.e));
    pane.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('change', async () => {
      const id = inp.closest('tr').dataset.e; const f = inp.dataset.f; const val = inp.value;
      const u = await db.update('episodes', id, c => c && (c[f] = val, c.dirty = true, c.rev = (c.rev || 0) + 1, c));
      if (u) Object.assign(findEp(id), u);
      if (f === 'status' && val === 'done') celebrate('great', '한 회차 완성! 와, 잘했어!!');
      scheduleSync();
    }));
    pane.querySelector('#tAdd').onclick = async () => { const ep = await newEpisode(w.id); renderSide(); openEpisode(ep.id); };
    pane.querySelector('#tCsv').onclick = () => download(new Blob(['\uFEFF' + toCSV(listRows(eps))], { type: 'text/csv;charset=utf-8' }), `${safeName(w.title)} 회차 목록표.csv`);
  } else {
    const cast = w.cast || [];
    pane.innerHTML = `<div class="tbl-tools"><button class="btn brand small" id="cAdd">＋ 인물·설정 추가</button><button class="btn ghost small" id="cCsv">인물·설정표 CSV</button></div>
    <div class="tbl-wrap"><table class="tbl" style="min-width:560px"><thead><tr><th class="nosort" style="width:22%">이름</th><th class="nosort" style="width:24%">관계</th><th class="nosort">메모</th><th class="nosort" style="width:44px"></th></tr></thead>
    <tbody>${cast.map((r, i) => `<tr data-i="${i}"><td><input data-c="name" value="${esc(r.name)}" placeholder="이름"></td><td><input data-c="rel" value="${esc(r.rel)}" placeholder="관계 (예: 주인공의 소꿉친구)"></td><td><textarea data-c="memo" rows="1" placeholder="성격·말투·떡밥">${esc(r.memo)}</textarea></td><td><button class="icon-btn sm" data-del aria-label="행 삭제">✕</button></td></tr>`).join('') ||
      `<tr><td colspan="4" class="mute" style="text-align:center;padding:20px">인물이나 설정을 추가해 보세요 — 이름 / 관계 / 메모</td></tr>`}</tbody></table></div>`;
    const saveCast = async next => { await db.update('works', w.id, c => c && (c.cast = next, c.dirty = true, c.updatedAt = Date.now(), c)); w.cast = next; scheduleSync(); };
    pane.querySelector('#cAdd').onclick = async () => { await saveCast([...(w.cast || []), { name: '', rel: '', memo: '' }]); renderWorks(); pane.querySelector('tbody tr:last-child input')?.focus(); };
    pane.querySelectorAll('[data-c]').forEach(inp => inp.addEventListener('change', () => { const i = +inp.closest('tr').dataset.i; const next = (w.cast || []).map(r => ({ ...r })); if (!next[i]) return; next[i][inp.dataset.c] = inp.value; saveCast(next); }));
    pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { const i = +b.closest('tr').dataset.i; if (!(await confirmBox('행 삭제', `「${esc(cast[i].name || '이 행')}」을(를) 지울까요?`, '삭제', 'danger'))) return; await saveCast((w.cast || []).filter((_, k) => k !== i)); renderWorks(); });
    pane.querySelector('#cCsv').onclick = () => download(new Blob(['\uFEFF' + toCSV(castRows(w))], { type: 'text/csv;charset=utf-8' }), `${safeName(w.title)} 인물·설정표.csv`);
  }
}

// ---------- 보관함: 아이디어 사진 · 북마크 · 음성 메모 ----------
S.vaultTab = 'notes'; S.photoFilter = 'all'; S.noteType = 'all'; S.noteWork = 'all'; S.noteQ = '';
const vaultURLs = [];
async function renderVault() {
  vaultURLs.splice(0).forEach(u => URL.revokeObjectURL(u));
  const v = $('#vVault'); const vt = S.vaultTab;
  let body = '';
  if (vt === 'notes') body = await notesBody();
  else if (vt === 'photos') {
    const ps = (await db.all('photos')).sort((a, b) => b.createdAt - a.createdAt);
    const tags = [...new Set(ps.flatMap(p => p.tags || []))];
    const f = S.photoFilter;
    const shown = ps.filter(p => f === 'all' || (f === 'common' ? !p.workId : f.startsWith('#') ? (p.tags || []).includes(f.slice(1)) : p.workId === f));
    body = `<div class="tbl-tools"><button class="btn brand" id="pCam">📷 사진 찍기</button><button class="btn soft" id="pPick">🖼 갤러리에서</button></div>
      <p class="mute small">자료 사진·풍경·메모지를 찍어 두세요. 복사한 이미지는 이 화면에서 붙여 넣기(Ctrl+V)도 돼요. 사진은 줄여서(최대 1600px) 저장해요.</p>
      <div class="chips"><button class="chip ${f === 'all' ? 'on' : ''}" data-pf="all">전체 ${ps.length}</button><button class="chip ${f === 'common' ? 'on' : ''}" data-pf="common">공통</button>${S.works.filter(w => ps.some(p => p.workId === w.id)).map(w => `<button class="chip ${f === w.id ? 'on' : ''}" data-pf="${w.id}">${esc(w.title)}</button>`).join('')}${tags.map(t => `<button class="chip ${f === '#' + t ? 'on' : ''}" data-pf="#${esc(t)}">#${esc(t)}</button>`).join('')}</div>
      <div class="photo-grid">${shown.map(p => { const u = URL.createObjectURL(p.blob); vaultURLs.push(u); return `<button class="ph" data-p="${p.id}"><img src="${u}" alt="${esc(p.caption || '아이디어 사진')}" loading="lazy"><span>${esc(p.caption || fmtTime(p.createdAt))}</span>${p.driveFileId ? '<i class="sb">☁</i>' : ''}</button>`; }).join('')}</div>
      ${shown.length ? '' : `<div class="empty-box card"><img src="${STK.oops}" alt="">아직 사진이 없어요. 영감을 준 장면을 찍어 볼까요?</div>`}`;
  } else if (vt === 'marks') {
    const bms = (await db.all('bookmarks')).sort((a, b) => b.at - a.at);
    body = bms.map(b => { const e = findEp(b.episodeId); return `<div class="bm" data-b="${b.id}"><button class="q" style="all:unset;flex:1;cursor:pointer;min-width:0" data-open><span class="w">${e ? esc(workOf(e)?.title || '') + ' · ' + esc(labelOf(e)) : '지워진 회차'} · ${fmtTime(b.at)}</span><span class="q">${esc(b.snippet)}</span></button><button class="icon-btn sm" data-x aria-label="북마크 삭제">✕</button></div>`; }).join('') ||
      `<div class="empty-box card"><img src="${STK.oops}" alt="">북마크가 없어요.<br>노트에서 🔖 북마크를 누르면 그 문단이 여기에 모여요.</div>`;
  } else {
    const ms = (await db.all('memos')).sort((a, b) => b.createdAt - a.createdAt);
    body = ms.map(m => { const e = findEp(m.episodeId); const u = URL.createObjectURL(m.blob); vaultURLs.push(u); return `<div class="vm"><div class="vm-h"><b style="flex:1;font-size:.85rem">${e ? esc(workOf(e)?.title || '') + ' · ' + esc(labelOf(e)) : '지워진 회차'} · ${esc(m.title || fmtTime(m.createdAt))}</b><span class="bdg ${m.driveFileId ? 'ok' : 'wait'}">${m.driveFileId ? '☁' : '●'}</span></div><audio controls preload="metadata" src="${u}"></audio></div>`; }).join('') ||
      `<div class="empty-box card"><img src="${STK.oops}" alt="">음성 메모가 없어요. 노트에서 ⏺ 녹음을 눌러 아이디어를 남겨요.</div>`;
  }
  v.innerHTML = `<div class="wrap"><div class="hello"><div><h2>보관함</h2><p>소스·아이디어·시퀀스, 사진과 북마크를 모아 두는 곳</p></div></div>
    <div class="seg vseg" style="margin-bottom:12px"><button data-vt="notes" class="${vt === 'notes' ? 'on' : ''}">설계 노트</button><button data-vt="photos" class="${vt === 'photos' ? 'on' : ''}">사진함</button><button data-vt="marks" class="${vt === 'marks' ? 'on' : ''}">북마크</button><button data-vt="voice" class="${vt === 'voice' ? 'on' : ''}">음성 메모</button></div>${body}</div>`;
  v.querySelectorAll('[data-vt]').forEach(b => b.onclick = () => { S.vaultTab = b.dataset.vt; renderVault(); });
  if (vt === 'notes') bindNotes(v);
  v.querySelectorAll('[data-pf]').forEach(b => b.onclick = () => { S.photoFilter = b.dataset.pf; renderVault(); });
  v.querySelector('#pCam')?.addEventListener('click', () => { $('#photoCam').value = ''; $('#photoCam').click(); });
  v.querySelector('#pPick')?.addEventListener('click', () => { $('#photoPick').value = ''; $('#photoPick').click(); });
  v.querySelectorAll('.ph').forEach(b => b.onclick = () => photoEditor(b.dataset.p));
  v.querySelectorAll('.bm').forEach(el => {
    el.querySelector('[data-open]').onclick = async () => openBookmark(await db.get('bookmarks', el.dataset.b));
    el.querySelector('[data-x]').onclick = async () => { await db.del('bookmarks', el.dataset.b); renderVault(); toast('북마크를 해제했어요'); };
  });
}
async function compressImage(file, max = 1600) {
  let src, w, h;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = src.width; h = src.height; }
  catch (e) { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('이미지를 읽을 수 없어요')); i.src = URL.createObjectURL(file); }); w = src.naturalWidth; h = src.naturalHeight; }
  const sc = Math.min(1, max / Math.max(w, h)); const cw = Math.round(w * sc), ch = Math.round(h * sc);
  const c = document.createElement('canvas'); c.width = cw; c.height = ch; c.getContext('2d').drawImage(src, 0, 0, cw, ch);
  let blob = await new Promise(r => c.toBlob(r, 'image/webp', .82));
  if (!blob || blob.type !== 'image/webp') blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .85));
  return { blob, mime: blob.type, w: cw, h: ch };
}
async function addPhotos(files) {
  files = [...files].filter(f => f.type.startsWith('image/')); if (!files.length) return;
  const ep = S.cur && findEp(S.cur); let first;
  for (const f of files) {
    try {
      const r = await compressImage(f); const d = new Date();
      const ph = { id: db.uid('p'), blob: r.blob, mime: r.mime, w: r.w, h: r.h, caption: '', tags: [], workId: ep?.workId || null, episodeId: ep?.id || null, createdAt: Date.now(),
        name: `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}_${Math.random().toString(36).slice(2, 5)}.${r.mime === 'image/webp' ? 'webp' : 'jpg'}`, driveFileId: null, metaDirty: false, origBytes: f.size };
      await db.put('photos', ph); first = first || ph.id;
    } catch (e) { toast(e.message, 3500, 'oops'); }
  }
  S.vaultTab = 'photos'; if (S.tab !== 'vault') showTab('vault'); else renderVault();
  if (files.length === 1 && first) photoEditor(first, true); else toast(`사진 ${files.length}장을 보관했어요`);
  scheduleSync(2000);
}
$('#photoCam').addEventListener('change', e => addPhotos(e.target.files));
$('#photoPick').addEventListener('change', e => addPhotos(e.target.files));
document.addEventListener('paste', e => {
  if (S.tab !== 'vault' || e.target.closest?.('input,textarea')) return;
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile());
  if (files.length) { e.preventDefault(); addPhotos(files); }
});
async function photoEditor(id, isNew) {
  const p = await db.get('photos', id); if (!p) return;
  const u = URL.createObjectURL(p.blob);
  let st = { caption: p.caption || '', tags: (p.tags || []).join(' '), workId: p.workId || '', episodeId: p.episodeId || '' };
  const epOpts = wid => `<option value="">회차 없음</option>` + (S.eps.get(wid) || []).map((e, i) => `<option value="${e.id}" ${e.id === st.episodeId ? 'selected' : ''}>${esc(Drive.episodeLabel(e, i))} ${esc(e.title || '')}</option>`).join('');
  const r = await dialog({ title: isNew ? '아이디어 사진 보관' : '아이디어 사진', wide: true, html: `
    <img class="pv-img" src="${u}" alt="">
    <p class="mute small">${p.w}×${p.h} · ${(p.blob.size / 1024).toFixed(0)}KB${p.origBytes ? ` (원본 ${(p.origBytes / 1024).toFixed(0)}KB)` : ''} · ${fmtTime(p.createdAt)}${p.driveFileId ? ' · ☁ 드라이브 저장됨' : ''}</p>
    <label class="fld">설명<input id="phCap" value="${esc(st.caption)}" placeholder="예: 7화 옥상 장면 분위기" maxlength="120"></label>
    <label class="fld">태그 (띄어쓰기로 구분)<input id="phTags" value="${esc(st.tags)}" placeholder="예: 배경 옥상 비"></label>
    <div class="row wrap"><label class="fld" style="flex:1 1 160px">작품<select id="phWork"><option value="">공통 (작품 없음)</option>${S.works.map(w => `<option value="${w.id}" ${w.id === st.workId ? 'selected' : ''}>${esc(w.title)}</option>`).join('')}</select></label>
    <label class="fld" style="flex:1 1 160px">회차<select id="phEp">${epOpts(st.workId)}</select></label></div>`,
    buttons: [{ label: '삭제', value: 'del', cls: 'danger' }, ...(st.episodeId ? [{ label: '회차 열기', value: 'open' }] : []), { label: '닫기', value: 'cancel' }, { label: '저장', value: 'ok', cls: 'brand' }],
    onOpen: f => {
      f.querySelector('#phCap').oninput = e => st.caption = e.target.value; f.querySelector('#phTags').oninput = e => st.tags = e.target.value;
      f.querySelector('#phWork').onchange = e => { st.workId = e.target.value; st.episodeId = ''; f.querySelector('#phEp').innerHTML = epOpts(st.workId); };
      f.querySelector('#phEp').onchange = e => st.episodeId = e.target.value;
      f.querySelector('.pv-img').onclick = () => { const w = window.open(); if (w) { w.document.title = st.caption || '아이디어 사진'; w.document.body.style.cssText = 'margin:0;background:#111;display:grid;place-items:center;min-height:100vh'; const im = w.document.createElement('img'); im.src = u; im.style.cssText = 'max-width:100%;max-height:100vh'; w.document.body.appendChild(im); } };
    } });
  if (r === 'ok') {
    const tags = st.tags.split(/[\s,#]+/).map(t => t.trim()).filter(Boolean).slice(0, 12);
    await db.update('photos', id, c => c && (c.caption = st.caption.trim(), c.tags = tags, c.workId = st.workId || null, c.episodeId = st.episodeId || null, c.metaDirty = !!c.driveFileId, c));
    toast('사진을 보관했어요'); scheduleSync(2000);
  } else if (r === 'del') {
    if (await confirmBox('사진 삭제', '이 사진을 지울까요? 드라이브에 올라간 사진은 휴지통으로 가요.', '삭제', 'danger')) {
      if (p.driveFileId) await db.put('tombstones', { id: p.id, kind: 'photo', fileId: p.driveFileId, at: Date.now() });
      await db.del('photos', id); toast('사진을 지웠어요'); scheduleSync(2000);
    }
  } else if (r === 'open' && st.episodeId) { URL.revokeObjectURL(u); return openEpisode(st.episodeId); }
  URL.revokeObjectURL(u);
  if (S.tab === 'vault') renderVault();
}

// ---------- 설계 노트: 소스 · 아이디어 · 시퀀스 ----------
const noteWorkTitle = n => S.works.find(w => w.id === n.workId)?.title || '';
const noteEpLabel = n => { if (!n.episodeId) return ''; const e = findEp(n.episodeId); return e ? labelOf(e) + (e.title ? ' ' + e.title : '') : ''; };
async function allNotes() { return (await db.all('notes')).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt); }
function noteCard(n) {
  const T = NTYPE[n.type] || NTYPE.idea; const w = noteWorkTitle(n); const el = noteEpLabel(n);
  const prev = n.type === 'seq' ? (n.beats || []).slice(0, 4).map((b, i) => `<li class="${b.done ? 'done' : ''}">${esc(b.text)}</li>`).join('') : '';
  return `<div class="ncard t-${n.type}" data-n="${n.id}"><button class="n-main" data-open>
    <span class="n-top"><span class="n-type">${T.icon} ${T.label}</span>${n.pinned ? '<span class="n-pin">📌</span>' : ''}${w ? `<span class="n-work">${esc(w)}${el ? ' · ' + esc(el) : ''}</span>` : ''}${n.dirty || !n.base ? '<i class="n-sync" title="드라이브 대기">●</i>' : '<i class="n-sync ok" title="드라이브 저장됨">☁</i>'}</span>
    <b class="n-title">${esc(n.title || '(제목 없음)')}</b>
    ${n.type === 'seq' ? `<ol class="n-beats">${prev}</ol>${(n.beats || []).length > 4 ? `<span class="mute small">… 외 ${(n.beats.length - 4)}장면</span>` : ''}` : `<span class="n-body">${esc((n.body || '').slice(0, 160))}</span>`}
    ${n.cite || n.url ? `<span class="n-cite">${esc(n.cite || '')}${n.cite && n.url ? ' · ' : ''}${n.url ? esc(n.url.replace(/^https?:\/\//, '').slice(0, 40)) : ''}</span>` : ''}
    ${n.tags?.length ? `<span class="n-tags">${n.tags.map(t => '#' + esc(t)).join(' ')}</span>` : ''}
  </button><button class="icon-btn sm n-copy" data-copy title="ChatGPT로 가져갈 노트 복사" aria-label="노트 복사">📋</button></div>`;
}
async function notesBody() {
  const ns = await allNotes(); const t = S.noteType, wf = S.noteWork, q = S.noteQ.trim().toLowerCase();
  const shown = ns.filter(n => (t === 'all' || n.type === t) && (wf === 'all' || (wf === 'common' ? !n.workId : n.workId === wf)) && (!q || searchText(n, noteWorkTitle(n)).includes(q)));
  const cnt = k => ns.filter(n => n.type === k).length;
  return `<div class="tbl-tools n-add"><button class="btn brand" data-new="idea">💡 아이디어</button><button class="btn soft" data-new="source">📎 소스</button><button class="btn soft" data-new="seq">🧭 시퀀스</button></div>
    <label class="search n-search"><span aria-hidden="true">⌕</span><input id="noteQ" type="search" placeholder="노트 검색 (제목·내용·#태그·장면)" value="${esc(S.noteQ)}" autocomplete="off"></label>
    <div class="chips"><button class="chip ${t === 'all' ? 'on' : ''}" data-nt="all">전체 ${ns.length}</button>${Object.entries(NTYPE).map(([k, v]) => `<button class="chip ${t === k ? 'on' : ''}" data-nt="${k}">${v.icon} ${v.label} ${cnt(k)}</button>`).join('')}
      <select id="noteWork" class="chip sel" aria-label="작품으로 거르기"><option value="all">모든 작품</option><option value="common" ${wf === 'common' ? 'selected' : ''}>공통 (세계관 설정 등)</option>${S.works.map(w => `<option value="${w.id}" ${wf === w.id ? 'selected' : ''}>${esc(w.title)}</option>`).join('')}</select></div>
    <div class="note-grid">${shown.map(noteCard).join('')}</div>
    ${shown.length ? '' : `<div class="empty-box card"><img src="${STK.focus}" alt="">${ns.length ? '찾는 노트가 없어요.' : '참고한 자료, 번뜩인 아이디어, 장면 순서를 여기에 모아 두세요.<br>노트에서 쓰다가 💡 설계 버튼으로 바로 적을 수도 있어요.'}</div>`}
    <p class="mute small">설계 노트는 이 기기에 먼저 저장되고, 드라이브 「집필실/설계 노트.json」으로 기기끼리 맞춰져요.</p>`;
}
function bindNotes(v) {
  v.querySelectorAll('[data-new]').forEach(b => b.onclick = () => noteEditor(null, { type: b.dataset.new, workId: ['all', 'common'].includes(S.noteWork) ? null : S.noteWork }));
  v.querySelectorAll('[data-nt]').forEach(b => b.onclick = () => { S.noteType = b.dataset.nt; renderVault(); });
  const ws = v.querySelector('#noteWork'); if (ws) ws.onchange = () => { S.noteWork = ws.value; renderVault(); };
  const qi = v.querySelector('#noteQ'); let qt;
  if (qi) qi.oninput = () => { clearTimeout(qt); qt = setTimeout(async () => { S.noteQ = qi.value; const pos = qi.selectionStart; await renderVault(); const n = $('#noteQ'); n.focus(); n.setSelectionRange(pos, pos); }, 250); };
  bindNoteCards(v);
}
function bindNoteCards(root) {
  root.querySelectorAll('.ncard').forEach(c => {
    c.querySelector('[data-open]').onclick = () => noteEditor(c.dataset.n);
    c.querySelector('[data-copy]').onclick = async () => { const n = await db.get('notes', c.dataset.n); if (n) copyNote(n); };
  });
}
async function copyNote(n) { const ok = await copyText(noteToText(n, { workTitle: noteWorkTitle(n), epLabel: noteEpLabel(n) })); toast(ok ? '📋 노트를 복사했어요. ChatGPT에 붙여 넣으세요' : '복사하지 못했어요. 길게 눌러 직접 복사해 주세요', 2800, ok ? 'great' : 'oops'); }
async function renderPaneNotes() {
  const ep = S.cur && findEp(S.cur); const box = $('#paneNotes'); if (!box) return;
  const ns = (await allNotes()).filter(n => !ep || n.workId === ep.workId || !n.workId);
  const mine = ns.filter(n => ep && n.episodeId === ep.id), rest = ns.filter(n => !(ep && n.episodeId === ep.id));
  box.innerHTML = `<button class="btn brand small" id="pnNew" style="width:100%">＋ 설계 노트 적기</button>
    ${mine.length ? `<div class="pn-h">이 회차</div>${mine.map(noteCard).join('')}` : ''}${rest.length ? `<div class="pn-h">이 작품 · 공통</div>${rest.map(noteCard).join('')}` : ''}
    ${ns.length ? '' : '<p class="mute small">이 작품의 설계 노트가 아직 없어요.</p>'}`;
  box.querySelector('#pnNew').onclick = () => quickNote();
  bindNoteCards(box);
}
// 원고에서 바로 적기 — 커서·스크롤 위치를 그대로 돌려놓음
let edBlurAt = 0; ed.addEventListener('blur', () => edBlurAt = Date.now());
async function quickNote() {
  const ep = S.cur && findEp(S.cur); const hadFocus = document.activeElement === ed || Date.now() - edBlurAt < 1000;
  const st = { s: ed.selectionStart, e: ed.selectionEnd, top: ed.scrollTop, wy: scrollY };
  const sel = ed.value.slice(st.s, st.e).trim();
  await noteEditor(null, { type: sel ? 'source' : 'idea', body: sel ? sel : '', workId: ep?.workId || null, episodeId: ep?.id || null, cite: sel && ep ? `${workOf(ep)?.title || ''} ${labelOf(ep)}` : '' });
  if (!ep || S.cur !== ep.id || $('#editorView').hidden) return;
  ed.scrollTop = st.top; scrollTo(0, st.wy);
  if (hadFocus) { ed.focus({ preventScroll: true }); ed.setSelectionRange(st.s, st.e); ed.scrollTop = st.top; }
}
async function noteEditor(id, preset = {}) {
  const old = id ? await db.get('notes', id) : null; if (id && !old) return;
  const n = old ? structuredClone(old) : { id: db.uid('n'), type: 'idea', title: '', body: '', url: '', cite: '', tags: [], beats: [], workId: null, episodeId: null, photoId: null, pinned: false, createdAt: Date.now(), ...preset };
  if (n.type === 'seq' && !n.beats.length) n.beats = [{ id: db.uid('b'), text: '', done: false }];
  let tagStr = (n.tags || []).join(' '); let photoURL = null;
  const epOpts = wid => `<option value="">회차 없음</option>` + (S.eps.get(wid) || []).map((e, i) => `<option value="${e.id}" ${e.id === n.episodeId ? 'selected' : ''}>${esc(Drive.episodeLabel(e, i))} ${esc(e.title || '')}</option>`).join('');
  const beatsHTML = () => n.beats.map((b, i) => `<div class="beat" data-i="${i}"><span class="bn">${i + 1}</span><label class="bchk" title="다 쓴 장면"><input type="checkbox" data-done ${b.done ? 'checked' : ''}></label><textarea data-bt rows="1" placeholder="장면·비트 (예: 옥상, 주인공이 처음 거짓말한다)">${esc(b.text)}</textarea><span class="bbtn"><button type="button" class="icon-btn sm" data-up aria-label="위로" ${i ? '' : 'disabled'}>↑</button><button type="button" class="icon-btn sm" data-dn aria-label="아래로" ${i < n.beats.length - 1 ? '' : 'disabled'}>↓</button><button type="button" class="icon-btn sm" data-del aria-label="장면 삭제">✕</button></span></div>`).join('');
  const photoHTML = async () => { if (!n.photoId) return ''; const p = await db.get('photos', n.photoId); if (!p) return ''; if (photoURL) URL.revokeObjectURL(photoURL); photoURL = URL.createObjectURL(p.blob); return `<div class="n-photo"><img src="${photoURL}" alt=""><button type="button" class="btn small ghost" id="nPhotoX">사진 빼기</button></div>`; };
  const T = () => NTYPE[n.type];
  const html = `<div class="seg n-tseg">${Object.entries(NTYPE).map(([k, v]) => `<button type="button" data-ty="${k}" class="${n.type === k ? 'on' : ''}">${v.icon} ${v.label}</button>`).join('')}</div>
    <label class="fld">제목<input id="nTitle" value="${esc(n.title)}" placeholder="예: 주인공의 첫 거짓말 / 2부 전개 / 참고 논문" maxlength="120"></label>
    <div class="n-src" ${n.type === 'source' ? '' : 'hidden'}><label class="fld">출처 (책·작품·사람)<input id="nCite" value="${esc(n.cite || '')}" placeholder="예: 『사회적 동물』 3장" maxlength="200"></label>
      <label class="fld">링크<input id="nUrl" type="url" inputmode="url" value="${esc(n.url || '')}" placeholder="https://"></label></div>
    <label class="fld"><span id="nBodyL">${n.type === 'seq' ? '의도·감정선' : n.type === 'source' ? '내용·인용' : '내용'}</span><textarea id="nBody" class="n-ta" rows="${n.type === 'seq' ? 2 : 6}" placeholder="${esc(T().ph)}">${esc(n.body || '')}</textarea></label>
    <div class="n-seq" ${n.type === 'seq' ? '' : 'hidden'}><div class="fld" style="margin-bottom:2px">장면 순서 <span class="mute small">(↑↓로 순서 바꾸기)</span></div><div id="nBeats" class="beats">${beatsHTML()}</div><button type="button" class="btn soft small" id="nAddBeat">＋ 장면 추가</button></div>
    <div id="nPhotoBox">${await photoHTML()}</div>
    <label class="fld">태그 (띄어쓰기로 구분)<input id="nTags" value="${esc(tagStr)}" placeholder="예: 세계관 주인공 복선 2부"></label>
    <div class="row wrap"><label class="fld" style="flex:1 1 150px">작품<select id="nWork"><option value="">공통 (작품 없음)</option>${S.works.map(w => `<option value="${w.id}" ${w.id === n.workId ? 'selected' : ''}>${esc(w.title)}</option>`).join('')}</select></label>
      <label class="fld" style="flex:1 1 150px">회차<select id="nEp">${epOpts(n.workId)}</select></label></div>
    <div class="row wrap n-extra"><button type="button" class="btn ghost small" id="nPhoto">📷 사진 붙이기</button><label class="chk"><input type="checkbox" id="nPin" ${n.pinned ? 'checked' : ''}> 📌 위에 고정</label><button type="button" class="btn ghost small" id="nCopy">📋 ChatGPT용 복사</button></div>
    ${old?.conflictOf ? '<p class="mute small">⚠ 두 기기에서 같은 노트를 따로 고쳐서 생긴 드라이브 쪽 사본이에요. 필요한 내용만 옮기고 지워도 돼요.</p>' : ''}`;
  const grow = ta => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 220) + 'px'; };
  const r = await dialog({ title: old ? `${T().icon} 설계 노트` : `${T().icon} 새 설계 노트`, wide: true, html,
    buttons: [...(old ? [{ label: '삭제', value: 'del', cls: 'danger' }] : []), ...(n.episodeId && S.cur !== n.episodeId ? [{ label: '회차 열기', value: 'open' }] : []), { label: '닫기', value: 'cancel' }, { label: '저장', value: 'ok', cls: 'brand' }],
    onOpen: f => {
      const q = s => f.querySelector(s);
      f.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') e.preventDefault(); });
      q('#nTitle').oninput = e => n.title = e.target.value; q('#nBody').oninput = e => { n.body = e.target.value; };
      q('#nCite').oninput = e => n.cite = e.target.value; q('#nUrl').oninput = e => n.url = e.target.value;
      q('#nTags').oninput = e => tagStr = e.target.value; q('#nPin').onchange = e => n.pinned = e.target.checked;
      q('#nWork').onchange = e => { n.workId = e.target.value || null; n.episodeId = null; q('#nEp').innerHTML = epOpts(n.workId); };
      q('#nEp').onchange = e => n.episodeId = e.target.value || null;
      f.querySelectorAll('[data-ty]').forEach(b => b.onclick = () => {
        n.type = b.dataset.ty; f.querySelectorAll('[data-ty]').forEach(x => x.classList.toggle('on', x === b));
        q('.n-src').hidden = n.type !== 'source'; q('.n-seq').hidden = n.type !== 'seq';
        q('#nBodyL').textContent = n.type === 'seq' ? '의도·감정선' : n.type === 'source' ? '내용·인용' : '내용'; q('#nBody').placeholder = T().ph;
        if (n.type === 'seq' && !n.beats.length) { n.beats.push({ id: db.uid('b'), text: '', done: false }); drawBeats(); }
        f.closest('dialog').querySelector('h3').textContent = `${T().icon} ${old ? '' : '새 '}설계 노트`;
      });
      const drawBeats = (focusI) => { q('#nBeats').innerHTML = beatsHTML(); q('#nBeats').querySelectorAll('textarea').forEach(grow); if (focusI != null) { const t = q(`#nBeats [data-i="${focusI}"] textarea`); t?.focus(); t?.scrollIntoView({ block: 'nearest' }); } };
      const beats = q('#nBeats'); beats.querySelectorAll('textarea').forEach(grow);
      beats.addEventListener('input', e => { const row = e.target.closest('.beat'); if (!row) return; const i = +row.dataset.i; if (e.target.matches('[data-bt]')) { n.beats[i].text = e.target.value; grow(e.target); } });
      beats.addEventListener('change', e => { const row = e.target.closest('.beat'); if (row && e.target.matches('[data-done]')) n.beats[+row.dataset.i].done = e.target.checked; });
      beats.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.matches('[data-bt]')) { e.preventDefault(); const i = +e.target.closest('.beat').dataset.i; n.beats.splice(i + 1, 0, { id: db.uid('b'), text: '', done: false }); drawBeats(i + 1); } });
      beats.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return; const i = +b.closest('.beat').dataset.i;
        if (b.matches('[data-up]') && i > 0) { [n.beats[i - 1], n.beats[i]] = [n.beats[i], n.beats[i - 1]]; drawBeats(); q(`#nBeats [data-i="${i - 1}"] [data-up]`)?.focus(); }
        else if (b.matches('[data-dn]') && i < n.beats.length - 1) { [n.beats[i + 1], n.beats[i]] = [n.beats[i], n.beats[i + 1]]; drawBeats(); q(`#nBeats [data-i="${i + 1}"] [data-dn]`)?.focus(); }
        else if (b.matches('[data-del]')) { n.beats.splice(i, 1); drawBeats(); }
      });
      q('#nAddBeat').onclick = () => { n.beats.push({ id: db.uid('b'), text: '', done: false }); drawBeats(n.beats.length - 1); };
      const bindPhotoX = () => { const x = q('#nPhotoX'); if (x) x.onclick = () => { n.photoId = null; q('#nPhotoBox').innerHTML = ''; }; }; bindPhotoX();
      q('#nPhoto').onclick = () => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.onchange = async () => {
        const file = inp.files?.[0]; if (!file) return;
        try { const rr = await compressImage(file); const d = new Date();
          const ph = { id: db.uid('p'), blob: rr.blob, mime: rr.mime, w: rr.w, h: rr.h, caption: n.title || '설계 노트 사진', tags: [], workId: n.workId || null, episodeId: n.episodeId || null, createdAt: Date.now(), name: `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}_${Math.random().toString(36).slice(2, 5)}.${rr.mime === 'image/webp' ? 'webp' : 'jpg'}`, driveFileId: null, metaDirty: false, origBytes: file.size };
          await db.put('photos', ph); n.photoId = ph.id; q('#nPhotoBox').innerHTML = await photoHTML(); bindPhotoX();
        } catch (e) { toast(e.message, 3500, 'oops'); } }; inp.click(); };
      q('#nCopy').onclick = () => copyNote({ ...n, tags: tagStr.split(/[\s,#]+/).filter(Boolean), beats: n.beats.filter(b => b.text.trim()) });
    } });
  if (photoURL) URL.revokeObjectURL(photoURL);
  const tags = tagStr.split(/[\s,#]+/).map(t => t.trim()).filter(Boolean).slice(0, 16);
  if (r === 'ok' || r === 'open') {
    n.title = n.title.trim(); n.tags = tags; n.beats = n.type === 'seq' ? n.beats.filter(b => b.text.trim()) : (n.beats || []).filter(b => b.text.trim());
    const empty = !n.title && !n.body.trim() && !n.url && !n.beats.length && !n.photoId;
    if (!(empty && !old)) {
      if (!old || JSON.stringify({ ...old, dirty: 0, base: 0, updatedAt: 0 }) !== JSON.stringify({ ...n, dirty: 0, base: 0, updatedAt: 0 })) {
        n.updatedAt = Date.now(); n.dirty = true; if (!old) n.base = ''; await db.put('notes', n);
        if (n.photoId) scheduleSync(2000); else scheduleSync(3000);
        if (r === 'ok') toast(`${T().icon} 설계 노트를 저장했어요`, 2000, 'great');
      }
    }
    if (r === 'open' && n.episodeId) { await openEpisode(n.episodeId); return; }
  } else if (r === 'del' && old) {
    if (await confirmBox('설계 노트 삭제', `「${esc(old.title || '제목 없음')}」을 지울까요?`, '삭제', 'danger')) {
      await db.del('notes', old.id); const dl = (await db.kv.get('noteDel')) || {}; dl[old.id] = Date.now(); await db.kv.set('noteDel', dl);
      toast('설계 노트를 지웠어요'); scheduleSync(3000);
    }
  }
  if (S.tab === 'vault' && S.vaultTab === 'notes') renderVault();
  if (!$('#panel').hidden && paneTab === 'notes') renderPaneNotes();
}
$('#btnNote').addEventListener('click', () => quickNote());

// ---------- 마이 ----------
async function renderMy() {
  const daily = await getDaily(); const focus = await getFocus(); const days = activeDays(daily, focus);
  const all = [...S.eps.values()].flat(); const total = all.reduce((a, e) => a + counts(e.text).noSp, 0);
  const linked = await Drive.wasConnected();
  const heat = Array.from({ length: 28 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - 27 + i); const n = daily[dkey(d)] || 0; const lv = n === 0 ? (focus[dkey(d)] ? 1 : 0) : n < 300 ? 1 : n < 1000 ? 2 : n < 3000 ? 3 : 4; return `<i class="l${lv}" title="${dkey(d)} · ${n.toLocaleString()}자"></i>`; }).join('');
  const st = S.settings;
  const opt = (arr, val, suf) => arr.map(x => `<option value="${x}" ${+val === x ? 'selected' : ''}>${x.toLocaleString()}${suf}</option>`).join('');
  $('#vMy').innerHTML = `<div class="wrap">
    <div class="hello"><div><h2>${esc(penLabel())}의 집필실</h2><p class="hand" style="font-size:1.15rem;margin-top:2px">좋은 문장이 좋은 내일을 만든다 ♡</p></div><img src="${STK.great}" width="96" height="98" alt="" style="animation:float 3.6s ease-in-out infinite"></div>
    <div class="stats"><div class="stat"><b>${streakOf(days)}일</b><small>연속 집필</small></div><div class="stat"><b>${(daily[dkey()] || 0).toLocaleString()}</b><small>오늘 쓴 글자</small></div><div class="stat"><b>${total.toLocaleString()}</b><small>전체 글자 (공백 제외)</small></div><div class="stat"><b>${S.works.length} · ${all.length}</b><small>작품 · 회차</small></div></div>
    <div class="sec-t"><h3>최근 4주 집필</h3><span class="mute small">진할수록 많이 썼어요</span></div>
    <div class="card"><div class="heat">${heat}</div></div>
    <div class="sec-t"><h3>설정</h3></div>
    <div class="my-list">
      <div class="my-row"><div class="t"><b>하루 목표</b><small>직접 쓴 글자 기준 (붙여넣기 제외)</small></div><select id="myGoal">${opt([300, 500, 1000, 1500, 2000, 3000, 5000], st.goal, '자')}</select></div>
      <div class="my-row"><div class="t"><b>집필 타이머</b><small>집중 / 쉬기 시간</small></div><select id="myFocus">${opt([15, 25, 30, 45, 50], st.focusMin, '분')}</select><select id="myBreak">${opt([5, 10, 15], st.breakMin, '분')}</select></div>
      <div class="my-row"><div class="t"><b>화면 테마</b><small>노트는 언제나 차분하게</small></div><select id="myTheme"><option value="light">라벤더</option><option value="dark">밤</option><option value="sepia">세피아</option></select></div>
      <div class="my-row"><div class="t"><b>구글 드라이브</b><small>${linked ? (Drive.hasValidToken() ? '연결됨 · 자동 저장 중' : '다시 연결이 필요해요') : '아직 연결 전 · 원고는 기기에만 저장 중'}</small></div><button class="btn brand small" id="myDrive">${linked ? '관리' : '연결하기'}</button></div>
      <div class="my-row"><div class="t"><b>집필 설정 · 백업</b><small>글꼴, 줄 간격, 자동 버전 저장, 전체 백업</small></div><button class="btn soft small" id="mySet">열기</button></div>
      <div class="my-row"><div class="t"><b>앱으로 설치</b><small>${isInstalled() ? '이미 앱으로 쓰고 있어요 ✓' : installHowTo()}</small></div>${isInstalled() ? '' : `<button class="btn soft small" data-install>${INST.evt ? '설치' : '방법'}</button>`}</div>
      <div class="my-row"><div class="t"><b>다른 사람과 공유</b><small>주소만 보내면 돼요. 원고는 각자 기기와 각자 드라이브에만 저장돼서 서로 보이지 않아요.</small></div><button class="btn soft small" id="myShare">공유</button></div>
      <div class="my-row"><div class="t"><b>시작 화면 보기</b><small>집필실 첫 화면을 다시 봐요</small></div><button class="btn ghost small" id="mySplash">보기</button></div>
    </div>
    <p class="mute small" style="margin-top:18px;line-height:1.6">🔒 원고·사진·음성은 이 기기와 내 구글 드라이브에만 저장돼요. 앱 코드가 올라가는 곳에는 원고가 절대 들어가지 않아요.<br>집필실 · 쓰는 오늘, 완성의 내일로</p>
  </div>`;
  const v = $('#vMy');
  v.querySelector('#myTheme').value = st.theme;
  v.querySelector('#myGoal').onchange = e => { st.goal = +e.target.value; saveSettings(); toast(`하루 목표 ${st.goal.toLocaleString()}자`); };
  v.querySelector('#myFocus').onchange = e => { st.focusMin = +e.target.value; saveSettings(); if (!T.running) setMode(T.mode); };
  v.querySelector('#myBreak').onchange = e => { st.breakMin = +e.target.value; saveSettings(); if (!T.running) setMode(T.mode); };
  v.querySelector('#myTheme').onchange = e => { st.theme = e.target.value; saveSettings(); };
  v.querySelector('#myDrive').onclick = openSettings; v.querySelector('#mySet').onclick = openSettings;
  v.querySelector('#myShare').onclick = shareApp;
  v.querySelector('#mySplash').onclick = () => { sessionStorage.removeItem('jpsSplash'); showSplash(); };
}

async function shareApp() {
  const url = location.origin + location.pathname.replace(/index\.html$/, '');
  await dialog({ title: '다른 사람과 공유', html: `<p>아래 주소를 보내면 누구나 바로 쓸 수 있어요. 처음 열면 빈 집필실로 시작하고, 원고는 그 사람의 기기·드라이브에만 저장돼요.</p>
    <label class="fld">주소<input id="shUrl" value="${esc(url)}" readonly></label>
    <p class="small mute">⚠ 구글 드라이브 연결은 앱의 OAuth 설정에 따라 막힐 수 있어요. 그때는 각자 클라이언트 ID를 만들어 [설정]에 넣으면 돼요 → <a href="https://github.com/${esc(REPO)}#readme" target="_blank" rel="noopener">사용·배포 안내</a></p>
    <p class="small mute">직접 배포: <a href="https://github.com/${esc(REPO)}" target="_blank" rel="noopener">저장소</a>를 포크하고 GitHub Pages를 켜면 돼요. <a href="https://github.com/${esc(REPO)}/releases" target="_blank" rel="noopener">ZIP 받기</a></p>`,
    buttons: [{ label: '닫기', value: 'cancel' }, { label: '주소 복사', value: 'copy', cls: 'brand' }] }).then(async r => {
      if (r === 'copy') { if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) { try { await navigator.share({ title: '집필실', url }); return; } catch (e) {} } toast(await copyText(url) ? '주소를 복사했어요' : '복사하지 못했어요'); }
    });
}
// ---------- 앱 설치 안내 (웹 → 홈 화면 / 안드로이드 앱) ----------
const APK_URL = `https://github.com/${REPO}/releases/latest/download/jipilsil.apk`;
const INST = { evt: null };
const UA = navigator.userAgent;
const isAndroid = /Android/i.test(UA), isIOS = /iPhone|iPad|iPod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (document.referrer.startsWith('android-app://')) localStorage.setItem('jpsTWA', '1');
function isInstalled() { return !!localStorage.getItem('jpsTWA') || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true || document.referrer.startsWith('android-app://'); }
function installHowTo() {
  if (isIOS) return 'Safari 아래 공유 버튼 ⬆︎ → 「홈 화면에 추가」';
  if (isAndroid) return '크롬 ⋮ 메뉴 → 「홈 화면에 추가」 또는 「앱 설치」 · 안드로이드 앱(APK)도 있어요';
  return '크롬·엣지 주소창 오른쪽의 설치 아이콘 ⊕ → 「설치」';
}
function installCardHTML() {
  if (isInstalled() || localStorage.getItem('jpsInstallHide')) return '';
  return `<div class="install-card" id="installCard"><img src="icons/logo.svg" width="40" height="40" alt=""><div class="t"><b>집필실을 앱처럼 쓰기</b><small>${esc(installHowTo())}</small></div>
    <div class="ib">${INST.evt ? '<button class="btn brand small" data-install>설치</button>' : '<button class="btn soft small" data-install>방법 보기</button>'}${isAndroid ? `<a class="btn ghost small" href="${APK_URL}" rel="noopener">APK</a>` : ''}<button class="icon-btn sm" id="installHide" aria-label="닫기">✕</button></div></div>`;
}
addEventListener('beforeinstallprompt', e => { e.preventDefault(); INST.evt = e; if (S.tab === 'home' || S.tab === 'my') rerenderTab(); });
addEventListener('appinstalled', () => { INST.evt = null; toast('집필실이 설치됐어요 ♡', 3000, 'great'); rerenderTab(); });
document.addEventListener('click', async e => {
  if (e.target.closest('#installHide')) { localStorage.setItem('jpsInstallHide', '1'); $('#installCard')?.remove(); toast('마이 탭에서 언제든 다시 볼 수 있어요'); return; }
  if (!e.target.closest('[data-install]')) return;
  if (INST.evt) { const ev = INST.evt; INST.evt = null; ev.prompt(); try { await ev.userChoice; } catch (x) {} rerenderTab(); return; }
  const steps = isIOS ? ['Safari로 이 주소를 열어요.', '아래쪽 <b>공유</b> 버튼 ⬆︎ 을 눌러요.', '<b>홈 화면에 추가</b> → <b>추가</b>.']
    : isAndroid ? ['크롬으로 이 주소를 열어요.', '오른쪽 위 <b>⋮</b> 메뉴를 눌러요.', '<b>홈 화면에 추가</b> (또는 <b>앱 설치</b>) → <b>설치</b>.']
    : ['크롬이나 엣지로 이 주소를 열어요.', '주소창 오른쪽 <b>설치 아이콘 ⊕</b> (또는 ⋮ → <b>집필실 설치</b>)을 눌러요.', '<b>설치</b> — 바탕화면·작업 표시줄에서 바로 열려요.'];
  await dialog({ title: '집필실 설치하기', html: `<ol class="steps">${steps.map(x => `<li>${x}</li>`).join('')}</ol>${isAndroid || !isIOS ? `<p class="small mute">안드로이드 폰은 앱(APK)으로도 설치할 수 있어요: <a href="${APK_URL}" rel="noopener">집필실 APK 받기</a><br>(구글 로그인이 되는 크롬 기반 앱이에요. 설치할 때 「출처를 알 수 없는 앱」 허용이 필요할 수 있어요.)</p>` : ''}<p class="small mute">설치해도 원고는 똑같이 이 기기에 저장되고, 드라이브 연결도 그대로예요.</p>`, buttons: [{ value: 'ok', label: '알겠어요', cls: 'brand' }] });
});

// ---------- 시작 화면 ----------
function showSplash() {
  if (sessionStorage.getItem('jpsSplash')) return;
  const sp = $('#splash'); sp.hidden = false; sp.classList.remove('out');
  $('#btnStart').onclick = () => { sessionStorage.setItem('jpsSplash', '1'); sp.classList.add('out'); setTimeout(() => { sp.hidden = true; if (S.nagAfterSplash) { S.nagAfterSplash = false; authNag(true); } }, reduceMotion() ? 0 : 450); };
}
// 집중 모드 친구
$('.ed-body').insertAdjacentHTML('beforeend', `<img class="focus-buddy" src="${STK.focus}" alt="" width="84" height="80">`);
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS.includes(t) && t !== S.tab) showTab(t); });

// ================= AI 작업실 (가져오기·분류·비교·작법 교재) =================
const AI = initAI({ db, S, $, esc, toast, dialog, confirmBox, copyText, download, findEp, labelOf, scheduleSync, decodeText, fmtTime, safeName,
  openEpisode, snapshot, flushSave, markPending, updateCounts, ed, uhKeepSet });
$('#btnAI').onclick = () => AI.open();

// ================= 시작 =================
async function boot() {
  await db.openDB(); db.persist();
  S.settings = { ...S.settings, ...((await db.kv.get('settings')) || {}) }; applySettings();
  showSplash();
  S.open = new Set((await db.kv.get('openWorks')) || []);
  await Drive.init(); S.clientId = await Drive.getClientId(); await loadAll();
  if (S.settings.penName === undefined) { S.settings.penName = S.works.length ? (window.YW_CONFIG?.LEGACY_PEN_NAME || '') : ''; await saveSettings(true); } // 예전부터 쓰던 기기는 필명 유지
  renderSide(); updateStatus(); renderSide(); updateStatus();
  setTimeout(() => { if (navigator.onLine) Drive.prepare().catch(() => {}); }, 2500);
  const last = await db.kv.get('lastEp');
  if (last && findEp(last)) { S.cur = last; } // 홈의 「이어 쓰기」로 바로 열 수 있게
  await restoreTimer();
  showTab((location.hash.slice(1) || 'home'), { initial: true });
  // 다시 열면: 마지막에 쓰던 회차가 열려 있었다면 그 회차·그 자리로 바로
  if (S.cur && ['', '#note', '#home'].includes(location.hash) && (await db.kv.get('lastView')) === 'editor') await openEpisode(S.cur);
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.__YW_NO_SW) {
    const hadCtl = !!navigator.serviceWorker.controller; let reloading = false;
    // 새 버전이 설치되면 원고를 먼저 저장하고 한 번 새로고침 → 예전 화면이 남지 않게
    navigator.serviceWorker.addEventListener('controllerchange', async () => { if (!hadCtl || reloading) return; reloading = true; try { await flushSave(); } catch (e) {} location.reload(); });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => { r.update().catch(() => {}); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') r.update().catch(() => {}); }); }).catch(() => {});
  }
  runSync('open');
  document.documentElement.classList.add('ready');
}
boot();
