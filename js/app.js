// 집필실 — 메인 앱 (쓰는 오늘, 완성의 내일로)
import * as db from './db.js';
import * as Drive from './drive.js';
import { Dictation, Reader, Recorder, ttsSupported, sttSupported, recSupported, koVoices, onVoicesChanged } from './audio.js';
import { $, $$, esc, pad2, normalizeText, tidyPaste, counts, fmtTime, fmtDur, decodeText, detectEpisodeNo, titleFromFilename,
  makeZip, docxParts, makeDocx, zipBytes, download, safeName, diffHTML, canon } from './util.js';
import { listRows, castRows, toCSV, STATUS, syncLabel } from './tables.js';

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

const REASON = { auto: '자동 저장', manual: '직접 저장', 'before-restore': '복원 전', 'before-pull': '드라이브 받기 전', 'before-paste': '붙여넣기 전', 'before-import': '가져오기 전', 'conflict-local': '충돌 · 이 기기', 'conflict-remote': '충돌 · 드라이브', open: '열었을 때' };

// ================= 공통 UI =================
let toastT;
const STK = { fighting: 'img/fighting.webp', great: 'img/great.webp', oops: 'img/oops.webp', focus: 'img/focus.webp' };
function toast(msg, ms = 2800, stk) {
  const t = $('#toast'); t.innerHTML = (stk ? `<img class="t-stk" src="${STK[stk]}" alt="">` : '') + `<span>${esc(msg)}</span>`; t.hidden = false; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.hidden = true, 250); }, ms);
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
  const id = S.cur; const text = $('#editor').value; const title = $('#epTitle').value.trim(); const memo = $('#epMemo').value;
  try {
    let delta = 0;
    const u = await db.update('episodes', id, c => {
      if (!c) return undefined;
      delta = [...text].length - [...(c.text || '')].length;
      if (c.text === text && (c.title || '') === title && (c.memo || '') === memo) return undefined;
      c.text = text; c.title = title; c.memo = memo; c.rev = (c.rev || 0) + 1; c.dirty = true; c.updatedAt = Date.now();
      return c;
    });
    if (u) {
      const ep = findEp(id); if (ep) Object.assign(ep, u);
      const pasted = S.pasteChars; S.pasteChars = 0;
      if (delta > 0) await addWritten(Math.max(0, delta - pasted)); // 붙여넣은 글자는 '오늘의 집필'에서 빼고 직접 쓴 글자만
      await maybeAutoSnapshot(u); refreshEpRow(id); scheduleSync();
    } else S.pasteChars = 0;
  } catch (e) { console.warn(e); toast('저장 실패: ' + e.message); S.pending = true; }
  S.saving = false; updateStatus();
}
setInterval(() => { if (S.pending && Date.now() - S.lastInput > 3000) flushSave(); }, 3000); // 몇 초마다 자동 저장

function scheduleSync(delay = 5000) {
  clearTimeout(syncT);
  syncT = setTimeout(() => runSync('auto'), delay);
}
async function runSync(why) {
  if (!navigator.onLine) { S.syncState = 'offline'; updateStatus(); return; }
  if (!Drive.hasValidToken()) { S.syncState = (await Drive.wasConnected()) ? 'needauth' : 'idle'; updateStatus(); return; }
  await flushSave();
  try { await Drive.sync(why); }
  catch (e) {
    if (e instanceof Drive.NeedAuth) S.syncState = 'needauth';
    else { S.syncState = 'error'; console.warn('sync', e, e.body); if (why === 'manual') toast('동기화 오류: ' + e.message + ' — 원고는 기기에 안전하게 저장돼 있어요.', 4500, 'oops'); }
  }
  await loadAll(); renderSide(); updateStatus(); refreshConflictBanner(); rerenderTab();
}

async function pendingCount() {
  const eps = await db.all('episodes'); const ms = await db.all('memos'); const tb = await db.all('tombstones');
  return eps.filter(e => e.dirty && !e.conflict).length + ms.filter(m => !m.driveFileId).length + tb.length + S.works.filter(w => w.dirty || !w.driveFolderId).length;
}
async function updateStatus() {
  const el = $('#saveStatus'); if (!el) return;
  let cls, txt;
  if (S.pending || S.saving) { cls = 'y'; txt = '저장 중'; }
  else if (!navigator.onLine) { cls = 'r'; txt = '인터넷 없음 — 기기에 임시 저장'; }
  else if (S.syncState === 'syncing') { cls = 'y'; txt = '저장 중 · 드라이브'; }
  else { cls = 'g'; txt = '저장 완료'; }
  el.className = 'save-status ' + cls; el.querySelector('span').textContent = txt;
  // 하단 드라이브 상태
  const linked = await Drive.wasConnected();
  const n = await pendingCount();
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
    if (ch.episode && ch.episode === S.cur && ch.textChanged) {
      const ep = await db.get('episodes', S.cur);
      if (ep && !S.pending) { const ed = $('#editor'); const pos = ed.selectionStart; ed.value = ep.text; $('#epTitle').value = ep.title || ''; $('#epMemo').value = ep.memo || ''; ed.setSelectionRange(pos, pos); updateCounts(); toast('드라이브에서 바뀐 내용을 불러왔어요 (이전 내용은 수정 기록에 있어요)'); }
    }
  },
  onConflict: ep => { toast(`⚠ ${ep.title || '회차'}: 기기와 드라이브 양쪽에서 바뀌었어요. 비교해서 골라 주세요.`, 5000); refreshConflictBanner(); },
});

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
    { label: '이름 바꾸기', value: 'rename' }, { label: 'TXT 가져오기', value: 'import' }, { label: '작품 전체 내보내기 (ZIP)', value: 'zip' }, { label: '작품 전체 DOCX', value: 'docx' },
    { label: '위로', value: 'up' }, { label: '삭제', value: 'del', cls: 'danger' }, { label: '닫기', value: 'cancel' }] });
  if (r === 'rename') { const t = await ask('작품 이름 바꾸기', '작품 이름', w.title); if (t) { await db.update('works', wid, c => (c.title = t, c.dirty = true, c)); w.title = t; renderSide(); scheduleSync(); } }
  if (r === 'import') pickImport(wid);
  if (r === 'zip') exportWorkZip(wid);
  if (r === 'docx') exportWorkDocx(wid);
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
  if (r === 'title') { const t = await ask('회차 제목', '제목', ep.title || ''); if (t !== null) { await db.update('episodes', eid, c => (c.title = t, c.dirty = true, c.rev++, c)); ep.title = t; if (S.cur === eid) $('#epTitle').value = t; renderSide(); scheduleSync(); } }
  if (r === 'label') { const t = await ask('번호 이름', '비워 두면 자동 번호 (예: 03화)', ep.label || '', '프롤로그'); if (t !== null) { await db.update('episodes', eid, c => (c.label = t, c.dirty = true, c.rev++, c)); ep.label = t; renderSide(); updateCrumb(); scheduleSync(); } }
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
function updateCrumb() { const ep = findEp(S.cur); if (!ep) return; $('#crumbWork').innerHTML = `${esc(workOf(ep)?.title || '')} <b>· ${esc(labelOf(ep))}</b>`; }
async function openEpisode(id) {
  if (S.cur && S.cur !== id) await flushSave();
  stopAllAudio();
  const ep = await db.get('episodes', id); if (!ep) return;
  const cached = findEp(id); if (cached) Object.assign(cached, ep);
  if (S.tab !== 'note') showTab('note', { keep: true });
  S.cur = id; db.kv.set('lastEp', id);
  $('#empty').hidden = true; $('#editorView').hidden = false; document.body.classList.add('editing');
  ed.value = ep.text || ''; $('#epTitle').value = ep.title || ''; $('#epMemo').value = ep.memo || '';
  updateCrumb(); updateCounts(); refreshConflictBanner();
  $$('.ep.cur').forEach(x => x.classList.remove('cur')); document.querySelector(`.ep[data-e="${id}"]`)?.classList.add('cur');
  if (!S.open.has(ep.workId)) { S.open.add(ep.workId); saveOpen(); renderSide(); }
  if (!$('#panel').hidden) renderPanel();
  snapshot(ep, 'open'); // 열 때 기준점 (같은 내용이면 건너뜀)
  updateStatus();
  if (matchMedia('(min-width: 900px)').matches) ed.focus({ preventScroll: true });
}
function closeEditor() { S.cur = null; $('#editorView').hidden = true; $('#empty').hidden = false; document.body.classList.remove('editing'); db.kv.set('lastEp', null); }
$('#btnBack').onclick = async () => { await flushSave(); stopAllAudio(); document.body.classList.remove('editing'); renderSide(); };

function updateCounts() {
  const c = counts(ed.value);
  $('#cntAll').textContent = `${c.all.toLocaleString()}자`; $('#cntNoSp').textContent = `공백 제외 ${c.noSp.toLocaleString()}자`;
  $('#cntWords').textContent = `${c.words.toLocaleString()}단어`; $('#cntPages').textContent = `원고지 ${c.pages.toLocaleString()}매`;
}
let cntT;
ed.addEventListener('input', () => { markPending(); clearTimeout(cntT); cntT = setTimeout(updateCounts, 150); });
$('#epTitle').addEventListener('input', markPending);
$('#epMemo').addEventListener('input', markPending);
ed.addEventListener('blur', flushSave); $('#epTitle').addEventListener('blur', () => { flushSave().then(() => { renderSide(); }); }); $('#epMemo').addEventListener('blur', flushSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); else runSync('focus'); });
window.addEventListener('pagehide', flushSave);
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); manualSnap(); }
  if (e.key === 'Escape' && document.body.classList.contains('focus')) toggleFocus();
});

// 글자 크기·집중 모드
function applySettings() {
  const st = S.settings; const r = document.documentElement;
  r.dataset.theme = st.theme; r.style.setProperty('--ed-size', st.fontSize + 'px'); r.style.setProperty('--ed-lh', st.lineH);
  r.dataset.font = st.font;
  document.querySelector('meta[name=theme-color]').content = st.theme === 'dark' ? '#14132A' : st.theme === 'sepia' ? '#F4EEE2' : '#F7F5FF';
}
async function saveSettings() { await db.kv.set('settings', S.settings); applySettings(); }
$('#btnFontUp').onclick = () => { S.settings.fontSize = Math.min(30, S.settings.fontSize + 1); saveSettings(); toast(`글자 크기 ${S.settings.fontSize}`); };
$('#btnFontDown').onclick = () => { S.settings.fontSize = Math.max(13, S.settings.fontSize - 1); saveSettings(); toast(`글자 크기 ${S.settings.fontSize}`); };
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
  if (paneTab === 'hist') renderHist(); if (paneTab === 'voice') renderVoice();
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
  ed.value = v.text; markPending(); await flushSave(); updateCounts(); renderHist(); toast('복원했어요');
}
async function manualSnap() {
  await flushSave(); const ep = await db.get('episodes', S.cur); if (!ep) return;
  const label = await ask('버전 저장', '메모 (선택)', '', '예: 2차 퇴고 끝'); if (label === null) return;
  await snapshot(ep, 'manual', label); toast('✦ 버전을 저장했어요'); if (!$('#panel').hidden && paneTab === 'hist') renderHist();
}
$('#btnSnap').onclick = manualSnap;

// ================= 충돌 =================
async function refreshConflictBanner() {
  document.querySelector('.conflict-banner')?.remove();
  const ep = S.cur && await db.get('episodes', S.cur); if (!ep?.conflict) return;
  $('.ed-body').insertAdjacentHTML('beforebegin', `<div class="conflict-banner"><span>⚠ 이 회차가 기기와 드라이브(다른 기기·ChatGPT) 양쪽에서 바뀌었어요. 둘 다 안전하게 보관 중이에요.</span><button class="btn small gold" id="btnResolve">비교하고 고르기</button></div>`);
  $('#btnResolve').onclick = () => resolveUI(ep.id);
}
async function resolveUI(id) {
  await flushSave(); const ep = await db.get('episodes', id); if (!ep?.conflict) return;
  const d = diffHTML(ep.conflict.remoteText, ep.text);
  const r = await dialog({ title: '어느 원고를 쓸까요?', wide: true,
    html: `<p class="mute small">－ 드라이브에만 있는 줄 ${d.dels} · ＋ 이 기기에만 있는 줄 ${d.adds}. 무엇을 골라도 두 버전 모두 수정 기록에 남아요.</p><div class="diff">${d.html}</div>`,
    buttons: [{ label: '나중에', value: 'cancel' }, { label: '둘 다 보관 (사본 회차)', value: 'both' }, { label: '드라이브 버전 쓰기', value: 'remote' }, { label: '이 기기 버전 쓰기', value: 'local', cls: 'gold' }] });
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
async function doSearch() {
  const q = $('#searchInput').value.trim(); const box = $('#searchResults');
  if (!q) { box.hidden = true; $('#workList').hidden = false; return; }
  await flushSave(); await loadAll();
  const res = []; const ql = q.toLowerCase();
  for (const w of S.works) for (const [i, e] of (S.eps.get(w.id) || []).entries()) {
    const hay = [['title', e.title || ''], ['text', e.text || ''], ['memo', e.memo || '']];
    for (const [k, h] of hay) {
      let pos = h.toLowerCase().indexOf(ql), n = 0;
      while (pos >= 0 && n < 3) { res.push({ w, e, i, k, pos, h }); n++; pos = h.toLowerCase().indexOf(ql, pos + ql.length); }
    }
  }
  box.hidden = false; $('#workList').hidden = true;
  box.innerHTML = `<div class="sr-head">「${esc(q)}」 ${res.length}곳${res.length >= 200 ? '+' : ''} <button class="btn small ghost" id="srClose">닫기</button></div>` + (res.slice(0, 200).map((r, n) => {
    const a = Math.max(0, r.pos - 30); const snip = esc(r.h.slice(a, r.pos)) + '<mark>' + esc(r.h.slice(r.pos, r.pos + q.length)) + '</mark>' + esc(r.h.slice(r.pos + q.length, r.pos + q.length + 40));
    return `<button class="sr" data-n="${n}"><span class="sr-w">${esc(r.w.title)} · ${esc(Drive.episodeLabel(r.e, r.i))}${r.k === 'memo' ? ' · 메모' : r.k === 'title' ? ' · 제목' : ''}</span><span class="sr-s">${a ? '…' : ''}${snip.replace(/\n/g, ' ⏎ ')}</span></button>`;
  }).join('') || '<p class="mute pad">찾는 글이 없어요.</p>');
  box.onclick = async ev => {
    if (ev.target.id === 'srClose') { $('#searchInput').value = ''; return doSearch(); }
    const b = ev.target.closest('.sr'); if (!b) return; const r = res[+b.dataset.n];
    await openEpisode(r.e.id);
    if (r.k === 'text') { ed.focus(); ed.setSelectionRange(r.pos, r.pos + q.length); scrollToCaret(r.pos); }
    if (r.k === 'memo') showPane('memo');
  };
}
function scrollToCaret(pos) { // 대략적인 위치로 스크롤
  const lines = ed.value.slice(0, pos).split('\n').length; const total = ed.value.split('\n').length || 1;
  ed.scrollTop = Math.max(0, (ed.scrollHeight * (lines / total)) - ed.clientHeight / 3);
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
  fillVoices(); $('#ttsRate').value = S.settings.rate || 1; $('#ttsRateOut').textContent = (+$('#ttsRate').value).toFixed(1) + '×'; $('#ttsDialog').checked = !!S.settings.dialogDiff;
  // 커서가 있던 문단부터
  const startPara = ed.value.slice(0, ed.selectionStart).split('\n').length - 1;
  readerOpts(); reader.play(Math.max(0, Math.min(startPara, paras.length - 1)));
}
function readerOpts() { reader.setOpts({ rate: +$('#ttsRate').value, voiceURI: $('#ttsVoice').value, dialogDiff: $('#ttsDialog').checked, dialogVoiceURI: S.settings.dialogVoiceURI }); }
function stopReader() { if ($('#ttsBar').hidden) return; reader.stop(); $('#reader').hidden = true; ed.hidden = false; $('#ttsBar').hidden = true; $('#btnListen').classList.remove('on'); }
$('#btnListen').onclick = () => $('#ttsBar').hidden ? openReader() : stopReader();
$('#ttsStop').onclick = stopReader;
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
$('#btnExport').onclick = async () => {
  await flushSave(); const ep = await db.get('episodes', S.cur); Object.assign(findEp(S.cur), ep);
  const r = await dialog({ title: '내보내기', html: '<p class="mute">파일은 이 기기의 다운로드 폴더에 저장돼요.</p>', buttons: [
    { label: '이 회차 TXT', value: 'txt' }, { label: '이 회차 DOCX', value: 'docx' }, { label: '작품 전체 ZIP', value: 'zip' }, { label: '작품 전체 DOCX', value: 'wdocx' }, { label: '닫기', value: 'cancel' }] });
  if (r === 'txt') download(new Blob(['\uFEFF' + ep.text.replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' }), epFileBase(ep) + '.txt');
  if (r === 'docx') download(makeDocx([{ heading: `${labelOf(ep)}${ep.title ? ' ' + ep.title : ''}`, text: ep.text }]), epFileBase(ep) + '.docx');
  if (r === 'zip') exportWorkZip(ep.workId);
  if (r === 'wdocx') exportWorkDocx(ep.workId);
};
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
async function exportWorkDocx(wid) {
  await flushSave(); await loadAll();
  const w = S.works.find(x => x.id === wid); const eps = S.eps.get(wid) || [];
  download(makeDocx(eps.map((e, i) => ({ heading: Drive.episodeLabel(e, i) + (e.title ? ' ' + e.title : ''), text: e.text }))), `${safeName(w.title)} 전체.docx`);
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
      <p class="mute small">원고는 <b>이 기기</b>와 <b>아라 님 드라이브</b>에만 저장돼요. 앱 권한은 「이 앱이 만든 파일만」(drive.file)이라 다른 드라이브 파일은 볼 수 없어요. 드라이브에는 「${esc(window.YW_CONFIG?.DRIVE_ROOT_NAME || '집필실')}/작품/01화」 구글 문서로, 목록표·인물표는 구글 시트로, 사진은 「아이디어 사진」 폴더에 저장돼요.</p>
      <label class="fld">OAuth 클라이언트 ID <input id="setCid" value="${esc(cid)}" placeholder="${def ? '기본값 사용 중' : '1234…apps.googleusercontent.com'}" autocomplete="off" spellcheck="false"></label>
      <p class="small"><a href="https://github.com/lee860506-tech/jipilsil/blob/main/DRIVE_SETUP.md" target="_blank" rel="noopener">클라이언트 ID 만드는 방법 (10분)</a></p>
      <div class="row">${linked ? `<button type="button" class="btn gold" id="setConnect">${Drive.hasValidToken() ? '✓ 연결됨 · 다시 연결' : '다시 연결'}</button><button type="button" class="btn" id="setSync">지금 동기화</button><button type="button" class="btn danger" id="setDisc">연결 끊기</button>` : `<button type="button" class="btn gold" id="setConnect">구글 드라이브 연결</button>`}</div>
    </section>
    <section class="set"><h4>✒ 집필 화면</h4>
      <div class="row wrap"><label class="fld">테마 <select id="setTheme"><option value="light">라벤더 (밝게)</option><option value="dark">밤 (어둡게)</option><option value="sepia">세피아</option></select></label>
      <label class="fld">본문 글꼴 <select id="setFont"><option value="serif">고운바탕 (명조)</option><option value="sans">프리텐다드 (고딕)</option></select></label>
      <label class="fld">줄 간격 <select id="setLh"><option>1.6</option><option>1.8</option><option>1.9</option><option>2.1</option><option>2.4</option></select></label>
      <label class="fld">자동 버전 저장 <select id="setSnap"><option value="5">5분마다</option><option value="10">10분마다</option><option value="20">20분마다</option><option value="30">30분마다</option></select></label></div>
      <label class="chk"><input type="checkbox" id="setTidy" ${st.tidy ? 'checked' : ''}> 붙여넣을 때 줄 끝 공백·과한 빈 줄 정리</label>
    </section>
    <section class="set"><h4>💾 이 기기 저장 공간</h4>
      <p class="mute small">${est ? `사용 ${(est.usage / 1048576).toFixed(1)}MB / 가능 ${(est.quota / 1073741824).toFixed(1)}GB · ` : ''}${persisted ? '브라우저가 지우지 않도록 보호됨 ✓' : '홈 화면에 설치하면 더 안전하게 보관돼요'}</p>
      <div class="row"><button type="button" class="btn" id="setBackup">전체 백업 ZIP 받기</button></div>
    </section>`,
    buttons: [{ label: '닫기', value: 'cancel' }, { label: '저장', value: 'ok', cls: 'gold' }],
    onOpen: f => {
      f.querySelector('#setTheme').value = st.theme; f.querySelector('#setFont').value = st.font; f.querySelector('#setLh').value = String(st.lineH); f.querySelector('#setSnap').value = String(st.snapMin);
      f.querySelector('#setTheme').onchange = e => { st.theme = e.target.value; saveSettings(); };
      const saveCid = async () => { const v = f.querySelector('#setCid').value.trim(); await db.kv.set('clientId', v); };
      f.querySelector('#setCid').addEventListener('change', saveCid);
      f.querySelector('#setConnect').onclick = async () => {
        await saveCid();
        try { await Drive.connect(); toast('구글 드라이브에 연결했어요'); $('#dlg').close('cancel'); runSync('manual'); }
        catch (e) { toast(e.message, 5000); }
      };
      f.querySelector('#setSync') && (f.querySelector('#setSync').onclick = () => { $('#dlg').close('cancel'); runSync('manual'); });
      f.querySelector('#setDisc') && (f.querySelector('#setDisc').onclick = async () => { if (await confirmBox('연결 끊기', '드라이브 연결을 끊을까요? 원고는 기기와 드라이브 양쪽에 그대로 남아요.', '끊기', 'danger')) { await Drive.disconnect(); updateStatus(); toast('연결을 끊었어요'); } });
      f.querySelector('#setBackup').onclick = backupAll;
    } });
  if (r === 'ok') {
    const f = $('#dlgForm');
    await db.kv.set('clientId', f.querySelector('#setCid')?.value.trim() || '');
    Object.assign(st, { theme: f.querySelector('#setTheme').value, font: f.querySelector('#setFont').value, lineH: +f.querySelector('#setLh').value, snapMin: +f.querySelector('#setSnap').value, tidy: f.querySelector('#setTidy').checked });
    saveSettings(); toast('설정을 저장했어요');
  }
}
async function backupAll() {
  await flushSave(); await loadAll(); const files = [];
  for (const w of S.works) (S.eps.get(w.id) || []).forEach((e, i) => files.push({ name: `${safeName(w.title)}/${safeName(Drive.episodeLabel(e, i) + (e.title ? ' ' + e.title : ''))}.txt`, data: '\uFEFF' + e.text.replace(/\n/g, '\r\n') }));
  const d = new Date(); download(makeZip(files), `집필실_백업_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.zip`);
}

document.addEventListener('click', async e => {
  if (e.target.id === 'btnReauth') { try { await Drive.connect({ silent: true }); runSync('manual'); } catch (er) { toast(er.message, 5000); } }
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
  $('#vHome').innerHTML = `<div class="wrap">
    <div class="hello"><div><h2>${hi}, 연월 작가님 ♡</h2><p>초안부터 재독까지, 나만의 창작 메이트</p></div><img src="icons/logo.svg" width="46" height="46" alt=""></div>
    <div class="h-top"><div class="h-main">
    <section class="hero">
      <span class="spark" style="left:52%;top:14px">✦</span><span class="spark" style="left:44%;bottom:22px;animation-delay:.8s;color:#FFB5D0">✦</span><span class="spark" style="left:62%;top:46%;animation-delay:1.4s;color:#A9D6FF">✦</span>
      <div class="hero-txt"><h2>쓰는 오늘,<br>완성의 내일로</h2>
        <p>${cur ? `<b>${esc(workOf(cur)?.title || '')}</b> · ${esc(labelOf(cur))}${cur.title ? ' ' + esc(cur.title) : ''}<br><span class="small">${fmtTime(cur.updatedAt)} 마지막 수정 · ${counts(cur.text).noSp.toLocaleString()}자</span>` : '첫 이야기를 시작해 볼까요?'}</p>
        <div class="btns"><button class="btn brand" id="hContinue">${cur ? '이어 쓰기 →' : '집필 시작하기 →'}</button><button class="btn soft" id="hNewEp">＋ 새 회차 만들기</button></div></div>
      <img class="stk" src="${STK.fighting}" alt="오늘도 파이팅!" width="176" height="174">
    </section>
    ${installCardHTML()}
    <div class="widgets">
      <button class="wg" id="wgToday"><span class="ic lav">${ICON.pen}</span><span style="flex:1;min-width:0"><small>오늘의 집필 · 목표 ${goal.toLocaleString()}자</small><b>${today.toLocaleString()}자</b><span class="meter"><i style="width:${Math.min(100, today / goal * 100)}%"></i></span></span></button>
      <button class="wg" id="wgMark"><span class="ic sky">${ICON.mark}</span><span><small>북마크</small><b>${bms.length}개</b></span></button>
      <button class="wg" id="wgTimer"><span class="ic pink">${ICON.clock}</span><span><small>집필 타이머</small><b>${mmss(timeLeft())}</b></span></button>
    </div>
    </div><div class="h-side">
    <div class="sec-t"><h3>오늘의 기록</h3></div>
    <div class="banners">
      <button class="banner streak" id="bStreak"><h4><em>${streak}</em>일 연속 집필!</h4><p>${streak ? '작은 성실이 이야기를 완성해요.' : '오늘 한 문장이면 연속 기록이 시작돼요.'}</p>
        <div class="days">${week.map((d, i) => `<span class="day ${days.has(dkey(d)) ? 'done' : ''} ${i === 6 ? 'today' : ''}"><i>${days.has(dkey(d)) ? '✓' : ''}</i>${'일월화수목금토'[d.getDay()]}</span>`).join('')}</div>
        <img class="stk" src="${STK.great}" alt="" width="120" height="122"></button>
      <button class="banner reread" id="bReread"><h4>오늘의 재독 🎧</h4><p>소리 내어 들으며 문장을 다듬어요.</p><span class="btn brand small">지금 재독하기 →</span>
        <img class="stk" src="${STK.focus}" alt="" width="124" height="118"></button>
    </div>
    </div></div>
    <div class="sec-t"><h3>바로 가기</h3></div>
    <div class="feats">
      <button class="feat" data-f="draft"><span class="ic lav">${ICON.pen}</span>초안 쓰기<small>떠오르는 대로 바로 기록</small></button>
      <button class="feat" data-f="list"><span class="ic pink">${ICON.list}</span>회차 정리<small>작품별·회차별 깔끔하게</small></button>
      <button class="feat" data-f="voice"><span class="ic sky">${ICON.mic}</span>음성 메모<small>말로 남기는 아이디어</small></button>
      <button class="feat" data-f="listen"><span class="ic lav" style="background:#E8E4FF">${ICON.head}</span>낭독 듣기<small>귀로 재독하며 다듬기</small></button>
      <button class="feat" data-f="drive"><span class="ic butter">${ICON.cloud}</span>드라이브 저장<small>구글 드라이브 자동 백업</small></button>
    </div>
    <div class="sec-t"><h3>최근 회차</h3>${all.length ? '<button class="link" id="hAll">작품 보기 →</button>' : ''}</div>
    <div class="recent">${all.slice(0, 5).map(e => `<button class="rc" data-e="${e.id}"><span class="n">${esc(labelOf(e))}</span><span class="t">${esc(workOf(e)?.title || '')}${e.title ? ' · ' + esc(e.title) : ''}</span><span class="pill s-${e.status || 'draft'}">${STATUS[e.status || 'draft']}</span><span class="m">${counts(e.text).noSp.toLocaleString()}자</span></button>`).join('') ||
      `<div class="empty-box card"><img src="${STK.oops}" alt="">아직 회차가 없어요. 「＋ 새 회차 만들기」로 시작해 봐요!</div>`}</div>
  </div>`;
  const v = $('#vHome');
  v.querySelector('#hContinue').onclick = () => cur ? openEpisode(cur.id) : quickNewEpisode('ChatGPT 초안을 붙여 넣거나 바로 써 보세요 ✍️');
  v.querySelector('#hNewEp').onclick = () => quickNewEpisode();
  v.querySelector('#wgToday').onclick = () => showTab('my');
  v.querySelector('#wgMark').onclick = () => { S.vaultTab = 'marks'; showTab('vault'); };
  v.querySelector('#wgTimer').onclick = openTimer;
  v.querySelector('#bStreak').onclick = () => showTab('my');
  v.querySelector('#bReread').onclick = async () => { if (!cur) return toast('먼저 회차를 하나 써 볼까요?', 3000, 'oops'); await openEpisode(cur.id); openReader(); };
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
    <tbody>${cast.map((r, i) => `<tr data-i="${i}"><td><input data-c="name" value="${esc(r.name)}" placeholder="이름"></td><td><input data-c="rel" value="${esc(r.rel)}" placeholder="관계 (예: 수혁의 형)"></td><td><textarea data-c="memo" rows="1" placeholder="성격·말투·떡밥">${esc(r.memo)}</textarea></td><td><button class="icon-btn sm" data-del aria-label="행 삭제">✕</button></td></tr>`).join('') ||
      `<tr><td colspan="4" class="mute" style="text-align:center;padding:20px">인물이나 설정을 추가해 보세요 — 이름 / 관계 / 메모</td></tr>`}</tbody></table></div>`;
    const saveCast = async next => { await db.update('works', w.id, c => c && (c.cast = next, c.dirty = true, c.updatedAt = Date.now(), c)); w.cast = next; scheduleSync(); };
    pane.querySelector('#cAdd').onclick = async () => { await saveCast([...(w.cast || []), { name: '', rel: '', memo: '' }]); renderWorks(); pane.querySelector('tbody tr:last-child input')?.focus(); };
    pane.querySelectorAll('[data-c]').forEach(inp => inp.addEventListener('change', () => { const i = +inp.closest('tr').dataset.i; const next = (w.cast || []).map(r => ({ ...r })); if (!next[i]) return; next[i][inp.dataset.c] = inp.value; saveCast(next); }));
    pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { const i = +b.closest('tr').dataset.i; if (!(await confirmBox('행 삭제', `「${esc(cast[i].name || '이 행')}」을(를) 지울까요?`, '삭제', 'danger'))) return; await saveCast((w.cast || []).filter((_, k) => k !== i)); renderWorks(); });
    pane.querySelector('#cCsv').onclick = () => download(new Blob(['\uFEFF' + toCSV(castRows(w))], { type: 'text/csv;charset=utf-8' }), `${safeName(w.title)} 인물·설정표.csv`);
  }
}

// ---------- 보관함: 아이디어 사진 · 북마크 · 음성 메모 ----------
S.vaultTab = 'photos'; S.photoFilter = 'all';
const vaultURLs = [];
async function renderVault() {
  vaultURLs.splice(0).forEach(u => URL.revokeObjectURL(u));
  const v = $('#vVault'); const vt = S.vaultTab;
  let body = '';
  if (vt === 'photos') {
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
  v.innerHTML = `<div class="wrap"><div class="hello"><div><h2>보관함</h2><p>영감과 아이디어를 모아 두는 곳</p></div></div>
    <div class="seg" style="margin-bottom:12px"><button data-vt="photos" class="${vt === 'photos' ? 'on' : ''}">아이디어 사진함</button><button data-vt="marks" class="${vt === 'marks' ? 'on' : ''}">북마크</button><button data-vt="voice" class="${vt === 'voice' ? 'on' : ''}">음성 메모</button></div>${body}</div>`;
  v.querySelectorAll('[data-vt]').forEach(b => b.onclick = () => { S.vaultTab = b.dataset.vt; renderVault(); });
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

// ---------- 마이 ----------
async function renderMy() {
  const daily = await getDaily(); const focus = await getFocus(); const days = activeDays(daily, focus);
  const all = [...S.eps.values()].flat(); const total = all.reduce((a, e) => a + counts(e.text).noSp, 0);
  const linked = await Drive.wasConnected();
  const heat = Array.from({ length: 28 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - 27 + i); const n = daily[dkey(d)] || 0; const lv = n === 0 ? (focus[dkey(d)] ? 1 : 0) : n < 300 ? 1 : n < 1000 ? 2 : n < 3000 ? 3 : 4; return `<i class="l${lv}" title="${dkey(d)} · ${n.toLocaleString()}자"></i>`; }).join('');
  const st = S.settings;
  const opt = (arr, val, suf) => arr.map(x => `<option value="${x}" ${+val === x ? 'selected' : ''}>${x.toLocaleString()}${suf}</option>`).join('');
  $('#vMy').innerHTML = `<div class="wrap">
    <div class="hello"><div><h2>연월 작가님의 집필실</h2><p class="hand" style="font-size:1.15rem;margin-top:2px">좋은 문장이 좋은 내일을 만든다 ♡</p></div><img src="${STK.great}" width="96" height="98" alt="" style="animation:float 3.6s ease-in-out infinite"></div>
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
      <div class="my-row"><div class="t"><b>시작 화면 보기</b><small>집필실 첫 화면을 다시 봐요</small></div><button class="btn ghost small" id="mySplash">보기</button></div>
    </div>
    <p class="mute small" style="margin-top:18px;line-height:1.6">🔒 원고·사진·음성은 이 기기와 아라 님 구글 드라이브에만 저장돼요. 앱 코드가 올라가는 곳에는 원고가 절대 들어가지 않아요.<br>집필실 · 쓰는 오늘, 완성의 내일로</p>
  </div>`;
  const v = $('#vMy');
  v.querySelector('#myTheme').value = st.theme;
  v.querySelector('#myGoal').onchange = e => { st.goal = +e.target.value; saveSettings(); toast(`하루 목표 ${st.goal.toLocaleString()}자`); };
  v.querySelector('#myFocus').onchange = e => { st.focusMin = +e.target.value; saveSettings(); if (!T.running) setMode(T.mode); };
  v.querySelector('#myBreak').onchange = e => { st.breakMin = +e.target.value; saveSettings(); if (!T.running) setMode(T.mode); };
  v.querySelector('#myTheme').onchange = e => { st.theme = e.target.value; saveSettings(); };
  v.querySelector('#myDrive').onclick = openSettings; v.querySelector('#mySet').onclick = openSettings;
  v.querySelector('#mySplash').onclick = () => { sessionStorage.removeItem('jpsSplash'); showSplash(); };
}

// ---------- 앱 설치 안내 (웹 → 홈 화면 / 안드로이드 앱) ----------
const APK_URL = 'https://github.com/lee860506-tech/jipilsil/releases/latest/download/jipilsil.apk';
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
  $('#btnStart').onclick = () => { sessionStorage.setItem('jpsSplash', '1'); sp.classList.add('out'); setTimeout(() => sp.hidden = true, reduceMotion() ? 0 : 450); };
}
// 집중 모드 친구
$('.ed-body').insertAdjacentHTML('beforeend', `<img class="focus-buddy" src="${STK.focus}" alt="" width="84" height="80">`);
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS.includes(t) && t !== S.tab) showTab(t); });

// ================= 시작 =================
async function boot() {
  await db.openDB(); db.persist();
  S.settings = { ...S.settings, ...((await db.kv.get('settings')) || {}) }; applySettings();
  showSplash();
  S.open = new Set((await db.kv.get('openWorks')) || []);
  await Drive.init(); await loadAll(); renderSide(); updateStatus();
  const last = await db.kv.get('lastEp');
  if (last && findEp(last)) { S.cur = last; } // 홈의 「이어 쓰기」로 바로 열 수 있게
  await restoreTimer();
  showTab((location.hash.slice(1) || 'home'), { initial: true });
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.__YW_NO_SW) navigator.serviceWorker.register('sw.js').catch(() => {});
  runSync('open');
  document.documentElement.classList.add('ready');
}
boot();
