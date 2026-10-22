// AI 작업실 화면 — 노트 화면의 「🤖 AI 작업」에서 열림. 원고는 사용자가 확인할 때만, 수정 기록을 남긴 뒤에 바뀜
import * as A from './aiwork.js';

export function initAI(X) {
  const { db, S, $, esc, toast, dialog, confirmBox, copyText, download, findEp, labelOf, scheduleSync, decodeText, fmtTime, safeName } = X;
  const V = { tab: 'import', draft: null, open: null, q: '', work: 'all', topic: '', imFilter: 'all' };
  const workTitle = id => S.works.find(w => w.id === id)?.title || '';
  const epLab = id => { const e = id && findEp(id); return e ? labelOf(e) + (e.title ? ' ' + e.title : '') : ''; };
  const where = (r, none = '<span class="ai-uns">미분류</span>') => r.workId ? `${esc(workTitle(r.workId) || '지워진 작품')}${r.episodeId ? ' · ' + esc(epLab(r.episodeId) || '지워진 회차') : ''}` : none;
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const all = async kind => (await db.all('aiwork')).filter(r => r.kind === kind);
  async function save(r) { r.updatedAt = Date.now(); r.createdAt ||= r.updatedAt; r.dirty = true; await db.put('aiwork', r); scheduleSync(3000); return r; }
  async function remove(r) { await db.del('aiwork', r.id); const d = (await db.kv.get('aiDel')) || {}; d[r.id] = Date.now(); await db.kv.set('aiDel', d); scheduleSync(3000); }
  const workOpts = (sel, none = '미분류 (작품 모름)') => `<option value="">${none}</option>` + S.works.map(w => `<option value="${w.id}" ${sel === w.id ? 'selected' : ''}>${esc(w.title)}</option>`).join('');
  const epOpts = (wid, sel) => `<option value="">회차 모름</option>` + (S.eps.get(wid) || []).map(e => `<option value="${e.id}" ${sel === e.id ? 'selected' : ''}>${esc(labelOf(e) + (e.title ? ' ' + e.title : ''))}</option>`).join('');
  const catOpts = sel => Object.entries(A.CATS).map(([k, c]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('');

  // ---------- 틀 ----------
  const root = document.createElement('section'); root.id = 'aiw'; root.className = 'aiw'; root.hidden = true; root.setAttribute('aria-label', 'AI 작업실');
  root.innerHTML = `<div class="aiw-box"><header class="aiw-head"><button class="icon-btn" id="aiwClose" aria-label="닫기">‹</button><div><h2>🤖 AI 작업실</h2><p>ChatGPT에서 받은 글을 나누고 비교해요 · 원고에는 내가 고를 때만 들어가요</p></div></header>
    <div class="seg aiw-tabs" role="tablist"><button data-at="import">가져오기</button><button data-at="lib">자료함</button><button data-at="cmp">비교</button><button data-at="lesson">작법 교재</button></div>
    <div class="aiw-body" id="aiwBody"></div></div>`;
  document.body.appendChild(root);
  const body = root.querySelector('#aiwBody');
  root.querySelector('#aiwClose').onclick = close;
  root.querySelectorAll('[data-at]').forEach(b => b.onclick = () => { V.tab = b.dataset.at; V.open = null; render(); });
  root.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#dlg').open) close(); });
  function open(tab) { if (tab) V.tab = tab; root.hidden = false; document.body.classList.add('aiw-on'); render(); }
  function close() { root.hidden = true; document.body.classList.remove('aiw-on'); }
  async function render() {
    root.querySelectorAll('[data-at]').forEach(b => b.classList.toggle('on', b.dataset.at === V.tab));
    const n = (await db.all('aiwork')).reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {});
    root.querySelector('[data-at=lib]').textContent = `자료함 ${n.import || 0}`; root.querySelector('[data-at=cmp]').textContent = `비교 ${n.compare || 0}`; root.querySelector('[data-at=lesson]').textContent = `작법 교재 ${n.lesson || 0}`;
    body.scrollTop = 0;
    if (V.tab === 'import') return renderImport();
    if (V.tab === 'lib') return V.open ? renderImportDetail(V.open) : renderLib();
    if (V.tab === 'cmp') return V.open ? renderCompare(V.open) : renderCmpList();
    if (V.tab === 'lesson') return V.open ? renderLesson(V.open) : renderLessons();
  }

  // ---------- 1단계: 가져오기 ----------
  function renderImport() {
    const d = V.draft;
    body.innerHTML = `<div class="card ai-card"><p class="mute small">ChatGPT 답변을 그대로 붙여 넣거나 TXT 파일을 열어요. 본문·수정본·분석·지시를 알아서 나눠 보여 드리고, 저장 전에 다 고칠 수 있어요.</p>
      <textarea id="aiRaw" class="rv-text" rows="7" placeholder="여기에 ChatGPT 답변을 붙여 넣으세요">${esc(d?.raw || '')}</textarea>
      <div class="row wrap ai-btns"><button class="btn soft" id="aiFile">📄 TXT 파일 열기</button><button class="btn brand" id="aiGo">나누고 분류하기</button></div>
      <input type="file" id="aiFileIn" accept=".txt,.md,text/plain" hidden></div>
      <div id="aiReview"></div>`;
    body.querySelector('#aiFile').onclick = () => body.querySelector('#aiFileIn').click();
    body.querySelector('#aiFileIn').onchange = async e => {
      const f = e.target.files[0]; if (!f) return; const im = A.importerFor(f);
      if (!im) return toast('지금은 TXT 파일만 열 수 있어요', 3000, 'oops');
      const txt = await im.read(f, async x => decodeText(await x.arrayBuffer()).text);
      body.querySelector('#aiRaw').value = txt; analyze('txt', f.name);
    };
    body.querySelector('#aiGo').onclick = () => analyze(V.draft?.source === 'txt' && V.draft.raw === body.querySelector('#aiRaw').value ? 'txt' : 'paste', V.draft?.fileName);
    if (d?.segments) renderReview();
  }
  async function analyze(source, fileName) {
    const raw = body.querySelector('#aiRaw').value.replace(/\r\n?/g, '\n');
    if (!raw.trim()) return toast('붙여 넣은 내용이 없어요', 2500, 'oops');
    const segs = A.analyzeText(raw, () => db.uid('s'));
    const g = A.guessTarget((fileName || '') + '\n' + raw, S.works, wid => S.eps.get(wid));
    const docType = A.guessDocType(segs); const hash = A.hashText(raw);
    const dups = (await all('import')).filter(r => r.hash === hash);
    V.draft = { raw, source, fileName: fileName || '', segments: segs, workId: g.workId, episodeId: g.episodeId, guess: g, docType, stage: A.stagesFor(docType), importedAt: today(), hash, dups,
      title: (fileName ? fileName.replace(/\.(txt|md)$/i, '') : '') || (segs[0]?.head || raw.trim().split('\n')[0]).slice(0, 40) };
    renderReview();
  }
  function renderReview() {
    const d = V.draft; const box = body.querySelector('#aiReview');
    const g = d.guess || {}; const cnt = k => d.segments.filter(s => s.cat === k).length;
    box.innerHTML = `<div class="card ai-card">
      <h4 class="ai-h">확인하고 저장하기</h4>
      ${d.dups.length ? `<div class="ai-warn">⚠ 이미 가져온 자료와 내용이 같아요: ${d.dups.map(x => `「${esc(x.title || '제목 없음')}」 (${esc(x.importedAt || '')})`).join(', ')}<br>그래도 저장하면 하나 더 생겨요.</div>` : ''}
      <p class="small ai-guess">짐작: ${g.workSure ? `작품 「${esc(workTitle(g.workId))}」` : '작품 <b>못 찾음</b>'}${g.epNo ? ` · ${g.epNo}화${g.epSure ? '' : ' (회차 목록에 없음)'}` : ''} ${d.workId ? '' : '→ <b>미분류 자료</b>로 저장돼요 (나중에 자료함에서 옮길 수 있어요)'}</p>
      <div class="ai-grid">
        <label class="fld">제목<input id="dTitle" value="${esc(d.title)}" maxlength="80"></label>
        <label class="fld">작품명<select id="dWork">${workOpts(d.workId)}</select></label>
        <label class="fld">회차<select id="dEp" ${d.workId ? '' : 'disabled'}>${epOpts(d.workId, d.episodeId)}</select></label>
        <label class="fld">자료 유형<select id="dType">${A.DOC_TYPES.map(t => `<option ${t === d.docType ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="fld">작업 단계<select id="dStage">${A.STAGES.map(t => `<option ${t === d.stage ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="fld">가져온 날짜<input type="date" id="dDate" value="${esc(d.importedAt)}"></label>
      </div>
      <h4 class="ai-h">나눈 조각 ${d.segments.length}개 <span class="mute small">${Object.entries(A.CATS).filter(([k]) => cnt(k)).map(([k, c]) => `${c.icon}${c.label} ${cnt(k)}`).join(' · ')}</span></h4>
      <p class="mute small">종류가 틀리면 골라서 바꿔 주세요. 원문 전체도 따로 그대로 저장돼요.</p>
      <div class="ai-segs">${d.segments.map((s, i) => segCard(s, i)).join('')}</div>
      <details class="ai-prev"><summary>원문 전체 미리보기 (${[...d.raw].length.toLocaleString()}자)</summary><pre>${esc(d.raw)}</pre></details>
      <div class="row wrap ai-btns"><button class="btn ghost" id="dCancel">지우고 다시</button><button class="btn soft" id="dSaveCmp">저장 + 비교 만들기</button><button class="btn brand" id="dSave">자료함에 저장</button></div></div>`;
    bindSegs(box, d.segments);
    const sync = () => { d.title = box.querySelector('#dTitle').value.trim(); d.docType = box.querySelector('#dType').value; d.stage = box.querySelector('#dStage').value; d.importedAt = box.querySelector('#dDate').value || today(); };
    box.querySelector('#dWork').onchange = e => { d.workId = e.target.value || null; d.episodeId = null; sync(); renderReview(); };
    box.querySelector('#dEp').onchange = e => { d.episodeId = e.target.value || null; };
    box.querySelector('#dCancel').onclick = () => { V.draft = null; renderImport(); };
    const doSave = async thenCmp => {
      sync();
      if (d.dups.length && !(await confirmBox('같은 자료가 있어요', '이미 가져온 자료와 내용이 같아요. 그래도 하나 더 저장할까요?', '그래도 저장'))) return;
      const rec = await save({ id: db.uid('a'), kind: 'import', title: d.title || '가져온 자료', workId: d.workId || null, episodeId: d.workId ? d.episodeId || null : null, unsorted: !d.workId,
        docType: d.docType, stage: d.stage, importedAt: d.importedAt, source: d.source, fileName: d.fileName, raw: d.raw, hash: d.hash, segments: d.segments.map(({ id, head, text, cat }) => ({ id, head, text, cat })) });
      V.draft = null; toast(rec.unsorted ? '미분류 자료로 저장했어요 · 원고는 그대로예요' : '자료함에 저장했어요 · 원고는 그대로예요', 3000, 'great');
      if (thenCmp) { const c = await compareFromImport(rec); V.tab = 'cmp'; V.open = c.id; } else { V.tab = 'lib'; V.open = null; }
      render();
    };
    box.querySelector('#dSave').onclick = () => doSave(false);
    box.querySelector('#dSaveCmp').onclick = () => doSave(true);
  }
  const segCard = (s, i) => `<div class="ai-seg c-${s.cat}" data-s="${s.id}"><div class="ai-seg-h"><span class="ai-no">${i + 1}</span><select class="chip sel" data-cat aria-label="조각 종류">${catOpts(s.cat)}</select>${s.head ? `<b>${esc(s.head)}</b>` : ''}${s.sure === false ? '<span class="mute small">(짐작 약함)</span>' : ''}</div><pre>${esc(s.text.length > 600 ? s.text.slice(0, 560) + ' …' : s.text)}</pre></div>`;
  function bindSegs(box, segs, after) {
    box.querySelectorAll('.ai-seg [data-cat]').forEach(sel => sel.onchange = () => { const card = sel.closest('.ai-seg'); const s = segs.find(x => x.id === card.dataset.s); s.cat = sel.value; s.sure = true; card.className = 'ai-seg c-' + s.cat; after?.(); });
  }

  // ---------- 자료함 ----------
  async function renderLib() {
    const ims = (await all('import')).sort((a, b) => b.createdAt - a.createdAt);
    const f = V.imFilter; const q = V.q.trim().toLowerCase();
    const shown = ims.filter(r => (f === 'all' || (f === 'uns' ? !r.workId : r.workId === f)) && (!q || [r.title, r.raw, workTitle(r.workId), r.docType, r.stage].join(' ').toLowerCase().includes(q)));
    body.innerHTML = `<label class="search"><span aria-hidden="true">⌕</span><input id="libQ" type="search" placeholder="자료 검색" value="${esc(V.q)}"></label>
      <div class="chips"><button class="chip ${f === 'all' ? 'on' : ''}" data-f="all">전체 ${ims.length}</button><button class="chip ${f === 'uns' ? 'on' : ''}" data-f="uns">미분류 ${ims.filter(r => !r.workId).length}</button>${S.works.filter(w => ims.some(r => r.workId === w.id)).map(w => `<button class="chip ${f === w.id ? 'on' : ''}" data-f="${w.id}">${esc(w.title)}</button>`).join('')}</div>
      <div class="ai-list">${shown.map(r => `<button class="ai-item" data-o="${r.id}"><span class="ai-top"><span class="bdg">${esc(r.docType || '기타')}</span><span class="mute small">${where(r)} · ${esc(r.stage || '')} · ${esc(r.importedAt || '')}</span>${r.dirty ? '<i class="n-sync">●</i>' : '<i class="n-sync ok">☁</i>'}</span><b>${esc(r.title || '(제목 없음)')}</b><span class="mute small">${(r.segments || []).map(s => A.CATS[s.cat]?.icon).join(' ')} · ${[...(r.raw || '')].length.toLocaleString()}자</span></button>`).join('')}</div>
      ${shown.length ? '' : `<div class="empty-box card">${ims.length ? '찾는 자료가 없어요.' : '아직 가져온 자료가 없어요. 「가져오기」에서 ChatGPT 답변을 붙여 넣어 보세요.'}</div>`}
      <div class="ai-foot"><button class="btn ghost small" id="aiRestore">백업 ZIP에서 AI 작업 복원</button><input type="file" id="aiRestoreIn" accept=".zip,.json,application/zip,application/json" hidden><span class="mute small">AI 작업은 원고와 따로 저장되고, 드라이브 「집필실/AI 작업.json」으로 기기끼리 맞춰져요. 전체 백업 ZIP에도 들어가요.</span></div>`;
    body.querySelector('#libQ').oninput = e => { V.q = e.target.value; clearTimeout(V.qt); V.qt = setTimeout(() => { renderLib().then(() => { const i = body.querySelector('#libQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 250); };
    body.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { V.imFilter = b.dataset.f; renderLib(); });
    body.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { V.open = b.dataset.o; render(); });
    body.querySelector('#aiRestore').onclick = () => body.querySelector('#aiRestoreIn').click();
    body.querySelector('#aiRestoreIn').onchange = e => restoreFrom(e.target.files[0]);
  }
  async function renderImportDetail(id) {
    const r = await db.get('aiwork', id); if (!r) { V.open = null; return render(); }
    const segs = (r.segments || []).map(s => ({ ...s }));
    body.innerHTML = `<button class="btn ghost small" id="back">‹ 자료함</button>
      <div class="card ai-card"><div class="ai-grid">
        <label class="fld">제목<input id="dTitle" value="${esc(r.title || '')}" maxlength="80"></label>
        <label class="fld">작품명<select id="dWork">${workOpts(r.workId)}</select></label>
        <label class="fld">회차<select id="dEp" ${r.workId ? '' : 'disabled'}>${epOpts(r.workId, r.episodeId)}</select></label>
        <label class="fld">자료 유형<select id="dType">${A.DOC_TYPES.map(t => `<option ${t === r.docType ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="fld">작업 단계<select id="dStage">${A.STAGES.map(t => `<option ${t === r.stage ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="fld">가져온 날짜<input type="date" id="dDate" value="${esc(r.importedAt || '')}"></label></div>
        <div class="ai-segs">${segs.map((s, i) => segCard(s, i)).join('')}</div>
        <details class="ai-prev"><summary>원문 전체 (${[...(r.raw || '')].length.toLocaleString()}자 · 그대로 보관)</summary><pre>${esc(r.raw || '')}</pre></details>
        <div class="row wrap ai-btns"><button class="btn danger" id="dDel">삭제</button><button class="btn soft" id="dCmp">비교 만들기</button><button class="btn brand" id="dSave">저장</button></div></div>`;
    bindSegs(body, segs);
    body.querySelector('#back').onclick = () => { V.open = null; render(); };
    body.querySelector('#dWork').onchange = e => { const s = body.querySelector('#dEp'); s.innerHTML = epOpts(e.target.value, null); s.disabled = !e.target.value; };
    const collect = () => { const w = body.querySelector('#dWork').value || null; return { ...r, title: body.querySelector('#dTitle').value.trim(), workId: w, episodeId: w ? body.querySelector('#dEp').value || null : null, unsorted: !w, docType: body.querySelector('#dType').value, stage: body.querySelector('#dStage').value, importedAt: body.querySelector('#dDate').value, segments: segs.map(({ id, head, text, cat }) => ({ id, head, text, cat })) }; };
    body.querySelector('#dSave').onclick = async () => { await save(collect()); toast('저장했어요'); V.open = null; render(); };
    body.querySelector('#dCmp').onclick = async () => { const rec = await save(collect()); const c = await compareFromImport(rec); V.tab = 'cmp'; V.open = c.id; render(); };
    body.querySelector('#dDel').onclick = async () => { if (await confirmBox('자료 삭제', `「${esc(r.title || '')}」 자료를 지울까요?<br>원고와 비교 기록·작법 교재는 그대로예요.`, '삭제', 'danger')) { await remove(r); V.open = null; render(); } };
  }

  // ---------- 3단계: 비교 ----------
  async function compareFromImport(imp) {
    const segs = imp.segments || []; const join = k => segs.filter(s => s.cat === k).map(s => s.text).join('\n\n');
    let original = join('body'); const revision = join('rev') || (imp.docType === '수정본' ? join('body') : '');
    if (revision && original === revision) original = '';
    let fromEp = false;
    if (!original && imp.episodeId) { const e = await db.get('episodes', imp.episodeId); if (e?.text) { original = e.text; fromEp = true; } }
    const pre = A.prefillFromAnalysis([join('theory'), join('cmp')].join('\n'));
    return save({ id: db.uid('a'), kind: 'compare', importId: imp.id, title: (imp.title || '비교') + ' 비교', workId: imp.workId || null, episodeId: imp.episodeId || null, original, revision, analysis: pre.analysis, intent: pre.intent, reading: pre.reading, decision: null, hunkChoice: {}, memo: fromEp ? '원문: 그때 회차 원고 전체' : '' });
  }
  async function renderCmpList() {
    const cs = (await all('compare')).sort((a, b) => b.updatedAt - a.updatedAt);
    body.innerHTML = `<div class="row wrap ai-btns"><button class="btn brand" id="cNew">＋ 새 비교 (직접 붙여넣기)</button></div>
      <div class="ai-list">${cs.map(c => { const st = A.diffStats(A.diffParts(c.original || '', c.revision || '')); return `<button class="ai-item" data-o="${c.id}"><span class="ai-top"><span class="bdg">${esc(c.decision ? A.DECISIONS[c.decision] : '고르는 중')}</span><span class="mute small">${where(c)}${c.appliedAt ? ' · 원고 반영 ' + esc(fmtTime(c.appliedAt)) : ''}</span>${c.dirty ? '<i class="n-sync">●</i>' : '<i class="n-sync ok">☁</i>'}</span><b>${esc(c.title || '(제목 없음)')}</b><span class="mute small">바뀐 곳 ${st.hunks} · ＋${st.add} －${st.del}자</span></button>`; }).join('')}</div>
      ${cs.length ? '' : '<div class="empty-box card">비교 기록이 없어요. 가져온 자료에서 「비교 만들기」를 누르거나 직접 붙여 넣어 보세요.</div>'}`;
    body.querySelector('#cNew').onclick = async () => { const c = await save({ id: db.uid('a'), kind: 'compare', title: '새 비교', workId: null, episodeId: null, original: '', revision: '', analysis: {}, intent: '', reading: '', decision: null, hunkChoice: {} }); V.open = c.id; render(); };
    body.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { V.open = b.dataset.o; render(); });
  }
  function sideHTML(parts, side, choice, partial) {
    return parts.map(p => {
      if (p.t === 'eq') return esc(p.a);
      const n = +p.id.slice(1) + 1; const t = side === 'a' ? p.a : p.b; const pick = choice[p.id];
      const cls = (side === 'a' ? 'd-a' : 'd-b') + (partial ? (pick ? ' picked-b' : ' picked-a') : '');
      return `<span class="hk ${cls}" data-h="${p.id}"><sup>${n}</sup>${t ? esc(t) : '<i class="hk-empty">∅</i>'}</span>`;
    }).join('');
  }
  async function renderCompare(id) {
    const c = await db.get('aiwork', id); if (!c) { V.open = null; return render(); }
    const st = { ...c, analysis: { ...(c.analysis || {}) }, hunkChoice: { ...(c.hunkChoice || {}) } };
    const draw = () => {
      const parts = A.diffParts(st.original || '', st.revision || ''); const hs = A.hunksOf(parts); const ds = A.diffStats(parts); const fl = A.flagsOf(st.original || '', st.revision || '');
      const partial = st.decision === 'partial';
      const wl = (o, lab) => (o.added.length || o.removed.length) ? `<div class="small">${lab}: ${o.added.map(w => `<span class="fw add">＋${esc(w)}</span>`).join('')}${o.removed.map(w => `<span class="fw del">－${esc(w)}</span>`).join('')}</div>` : '';
      body.innerHTML = `<button class="btn ghost small" id="back">‹ 비교 목록</button>
      <div class="card ai-card"><div class="ai-grid">
        <label class="fld">제목<input id="cTitle" value="${esc(st.title || '')}" maxlength="80"></label>
        <label class="fld">작품명<select id="cWork">${workOpts(st.workId, '작품 없음')}</select></label>
        <label class="fld">회차<select id="cEp" ${st.workId ? '' : 'disabled'}>${epOpts(st.workId, st.episodeId)}</select></label></div>
        <details class="ai-prev" ${st.original && st.revision ? '' : 'open'}><summary>원문·수정본 고치기</summary>
          <div class="cmp-edit"><label class="fld">원문<textarea id="cA" rows="6" placeholder="원문을 붙여 넣으세요">${esc(st.original || '')}</textarea></label>
          <label class="fld">수정본<textarea id="cB" rows="6" placeholder="수정본을 붙여 넣으세요">${esc(st.revision || '')}</textarea></label></div>
          ${st.episodeId ? '<button class="btn small soft" id="cFromEp">원문을 지금 회차 원고로 채우기</button>' : ''}</details>
        <p class="small mute">바뀐 곳 <b>${ds.hunks}</b> · 더한 글자 ＋${ds.add} · 뺀 글자 －${ds.del}${partial ? ' · 숫자를 눌러 하나씩 고르세요 (초록=수정안, 회색=원문)' : ''}</p>
        <div class="cmp-2"><div class="cmp-col"><h5>원문</h5><div class="cmp-txt" id="colA">${sideHTML(parts, 'a', st.hunkChoice, partial)}</div></div><div class="cmp-col"><h5>수정본</h5><div class="cmp-txt" id="colB">${sideHTML(parts, 'b', st.hunkChoice, partial)}</div></div></div>
        <div class="ai-flags"><h5>숫자로 본 변화 <span class="mute small">(좋고 나쁨이 아니라 차이만)</span></h5><table><tr><th></th><th>원문</th><th>수정본</th></tr>${fl.rows.map(r => `<tr><td>${r.k}</td><td>${r.a}</td><td>${r.b}${r.d ? ` <span class="mute">(${r.d > 0 ? '+' : ''}${r.d})</span>` : ''}</td></tr>`).join('')}</table>${wl(fl.emotion, '감정 직접어')}${wl(fl.sensory, '감각어')}${wl(fl.bodily, '신체 반응어')}</div>
      </div>
      <div class="card ai-card"><h4 class="ai-h">분석 노트</h4><p class="mute small">ChatGPT 분석을 붙여 넣으면 해당 칸에 문장을 옮겨 드려요 (빈 칸만). 직접 써도 돼요.</p>
        <details class="ai-prev"><summary>ChatGPT 분석 붙여 넣어 채우기</summary><textarea id="cPaste" rows="4" placeholder="분석 답변 붙여 넣기"></textarea><div class="row wrap ai-btns"><button class="btn small soft" id="cFill">빈 칸 채우기</button><button class="btn small ghost" id="cAsk">📋 ChatGPT 분석 요청 문구 복사</button></div></details>
        <div class="ai-fields">${A.FIELDS.map(([k, l], i) => `<label class="fld">${i + 1}. ${l}<textarea data-an="${k}" rows="2">${esc(st.analysis[k] || '')}</textarea></label>`).join('')}</div>
        <div class="ai-two"><label class="fld">✍ 작가 의도 (내가 노린 것)<textarea id="cIntent" rows="3">${esc(st.intent || '')}</textarea></label><label class="fld">👀 독자 해석 (읽는 사람이 받아들일 것)<textarea id="cReading" rows="3">${esc(st.reading || '')}</textarea></label></div>
      </div>
      <div class="card ai-card"><h4 class="ai-h">무엇을 남길까요?</h4>
        <div class="ai-dec">${Object.entries(A.DECISIONS).map(([k, l]) => `<label class="rv-m"><input type="radio" name="cDec" value="${k}" ${st.decision === k ? 'checked' : ''}> <b>${l}</b></label>`).join('')}</div>
        ${partial ? `<div class="hk-list">${hs.map(h => `<label class="hk-row"><input type="checkbox" data-pick="${h.id}" ${st.hunkChoice[h.id] ? 'checked' : ''}><span class="ai-no">${+h.id.slice(1) + 1}</span><span class="hk-a">${esc(h.a.trim() || '∅').slice(0, 80)}</span>→<span class="hk-b">${esc(h.b.trim() || '∅').slice(0, 80)}</span></label>`).join('')}</div>` : ''}
        <p class="mute small">고르기만 하면 원고는 바뀌지 않아요. 원고에 넣으려면 「원고에 반영…」을 눌러 한 번 더 확인해요 (반영 전 원고는 수정 기록에 남아요).</p>
        <div class="row wrap ai-btns"><button class="btn danger" id="cDel">삭제</button><button class="btn soft" id="cLesson">🎓 작법 교재 초안</button><button class="btn soft" id="cApply" ${(st.decision === 'revision' || st.decision === 'partial') && st.episodeId ? '' : 'disabled'} title="${st.episodeId ? '' : '회차를 먼저 골라 주세요'}">원고에 반영…</button><button class="btn brand" id="cSave">저장</button></div></div>`;
      bind(parts);
    };
    const grab = () => {
      st.title = body.querySelector('#cTitle').value.trim(); st.original = body.querySelector('#cA').value; st.revision = body.querySelector('#cB').value;
      body.querySelectorAll('[data-an]').forEach(t => st.analysis[t.dataset.an] = t.value); st.intent = body.querySelector('#cIntent').value; st.reading = body.querySelector('#cReading').value;
    };
    const bind = parts => {
      body.querySelector('#back').onclick = () => { V.open = null; render(); };
      body.querySelector('#cWork').onchange = e => { grab(); st.workId = e.target.value || null; st.episodeId = null; draw(); };
      body.querySelector('#cEp').onchange = e => { grab(); st.episodeId = e.target.value || null; draw(); };
      ['#cA', '#cB'].forEach(s => body.querySelector(s).onchange = () => { grab(); st.hunkChoice = {}; draw(); body.querySelector('.ai-prev').open = true; });
      body.querySelector('#cFromEp')?.addEventListener('click', async () => { grab(); const e = await db.get('episodes', st.episodeId); st.original = e?.text || ''; st.hunkChoice = {}; draw(); });
      body.querySelectorAll('input[name=cDec]').forEach(r => r.onchange = () => { grab(); st.decision = r.value; if (r.value === 'partial' && !Object.keys(st.hunkChoice).length) A.hunksOf(parts).forEach(h => st.hunkChoice[h.id] = true); draw(); });
      body.querySelectorAll('[data-pick]').forEach(cb => cb.onchange = () => { grab(); st.hunkChoice[cb.dataset.pick] = cb.checked; draw(); });
      body.querySelectorAll('.hk[data-h]').forEach(s => s.onclick = () => { if (st.decision !== 'partial') return; grab(); st.hunkChoice[s.dataset.h] = !st.hunkChoice[s.dataset.h]; draw(); });
      body.querySelector('#cFill').onclick = () => { grab(); const pre = A.prefillFromAnalysis(body.querySelector('#cPaste').value); let n = 0; for (const [k] of A.FIELDS) if (!st.analysis[k]?.trim() && pre.analysis[k]) { st.analysis[k] = pre.analysis[k]; n++; } if (!st.intent?.trim() && pre.intent) { st.intent = pre.intent; n++; } if (!st.reading?.trim() && pre.reading) { st.reading = pre.reading; n++; } draw(); toast(n ? `${n}칸을 채웠어요 · 확인하고 고쳐 주세요` : '옮길 문장을 못 찾았어요. 직접 적어 주세요', 3000); };
      body.querySelector('#cAsk').onclick = () => { grab(); copyText(askPrompt(st)).then(ok => toast(ok ? '📋 분석 요청 문구를 복사했어요. ChatGPT에 붙여 넣고, 답을 위 칸에 다시 붙여 넣으세요' : '복사가 막혔어요', 4000, ok ? 'great' : 'oops')); };
      body.querySelector('#cSave').onclick = async () => { grab(); await save(st); toast('비교 기록을 저장했어요 · 원고는 그대로예요'); V.open = null; render(); };
      body.querySelector('#cDel').onclick = async () => { if (await confirmBox('비교 기록 삭제', '이 비교 기록을 지울까요? 원고는 그대로예요.', '삭제', 'danger')) { await remove(c); V.open = null; render(); } };
      body.querySelector('#cLesson').onclick = async () => { grab(); await save(st); const ls = await all('lesson'); const no = ls.reduce((m, l) => Math.max(m, +l.no || 0), 0) + 1; const d = A.lessonDraft(st, A.diffParts(st.original || '', st.revision || ''), { no, workTitle: workTitle(st.workId), epLabel: epLab(st.episodeId) }); const l = await save({ id: db.uid('a'), kind: 'lesson', compareId: st.id, workId: st.workId, episodeId: st.episodeId, ...d }); toast('작법 교재 초안을 만들었어요 · 고쳐서 저장하세요', 3000, 'great'); V.tab = 'lesson'; V.open = l.id; render(); };
      body.querySelector('#cApply').onclick = async () => { grab(); await save(st); await applyToManuscript(st); };
    };
    draw();
  }
  const askPrompt = c => `아래 원문과 수정본을 비교해서, 각 항목을 「제목:」 아래 한두 문장으로 정리해 주세요. 좋고 나쁨을 단정하지 말고 차이와 효과만 적어 주세요.\n${A.FIELDS.map(([, l], i) => `${i + 1}. ${l}:`).join('\n')}\n8. 작가 의도로 보이는 것:\n9. 독자가 다르게 해석할 수 있는 점:\n\n[원문]\n${c.original}\n\n[수정본]\n${c.revision}`;
  async function applyToManuscript(c) {
    const ep0 = findEp(c.episodeId); if (!ep0) return toast('회차를 찾지 못했어요', 3000, 'oops');
    if (S.cur === c.episodeId) await X.flushSave();
    const ep = await db.get('episodes', c.episodeId); const cur = (ep.text || '').replace(/\r\n?/g, '\n');
    const parts = A.diffParts(c.original || '', c.revision || ''); const out = A.decisionText(c, parts); const orig = (c.original || '').replace(/\r\n?/g, '\n');
    let next = null, how = '';
    if (cur === orig) { next = out; how = '회차 전체'; }
    else if (orig.trim()) { const i = cur.indexOf(orig); if (i >= 0 && cur.indexOf(orig, i + 1) < 0) { next = cur.slice(0, i) + out + cur.slice(i + orig.length); how = '원문과 같은 부분'; } }
    if (next === null) {
      const r = await dialog({ title: '원고에서 원문을 찾지 못했어요', html: `<p>그 뒤로 원고가 바뀌었거나 원문이 원고와 달라서 <b>자동으로 넣지 않았어요</b>. 고른 결과를 복사해서 직접 붙여 넣을 수 있어요.</p>`, buttons: [{ label: '닫기', value: 'cancel' }, { label: '결과 복사', value: 'copy', cls: 'gold' }] });
      if (r === 'copy') copyText(out).then(ok => toast(ok ? '결과를 복사했어요' : '복사가 막혔어요'));
      return;
    }
    if (next === cur) return toast('바뀌는 내용이 없어요');
    const hs = A.hunksOf(parts); const n = c.decision === 'partial' ? hs.filter(h => c.hunkChoice?.[h.id]).length : hs.length;
    if (!(await confirmBox('원고에 반영할까요?', `「${esc(epLab(c.episodeId))}」의 ${how}에 <b>${esc(A.DECISIONS[c.decision])}</b> (${n}곳)을 넣어요.<br>반영 전 원고는 <b>수정 기록</b>에 먼저 저장되고, 바로 되돌릴 수도 있어요.`, '반영하기'))) return;
    close(); await X.openEpisode(c.episodeId);
    const before = X.ed.value;
    if (before.replace(/\r\n?/g, '\n') !== cur) { toast('그 사이 원고가 바뀌어서 반영하지 않았어요. 다시 시도해 주세요', 4000, 'oops'); return; }
    await X.snapshot({ ...ep, text: before }, 'before-revise', 'AI 작업실 비교 반영 전');
    X.ed.value = next; X.markPending(); X.updateCounts(); await X.flushSave();
    c.appliedAt = Date.now(); await save(c);
    toast('비교 결과를 원고에 반영했어요', 7000, 'great', { label: '되돌리기', fn: async () => {
      if (S.cur !== ep.id) await X.openEpisode(ep.id);
      await X.snapshot({ ...findEp(ep.id), text: X.ed.value }, 'before-restore', 'AI 반영 되돌리기 전');
      X.ed.value = before; X.markPending(); X.updateCounts(); await X.flushSave(); toast('반영 전으로 되돌렸어요 (수정 기록에도 남아 있어요)');
    } });
  }

  // ---------- 4단계: 작법 교재 ----------
  async function renderLessons() {
    const ls = (await all('lesson')).sort((a, b) => (+a.no || 0) - (+b.no || 0) || a.createdAt - b.createdAt);
    const q = V.q.trim().toLowerCase(), w = V.work, t = V.topic;
    const shown = ls.filter(l => (w === 'all' || (w === 'none' ? !l.workId : l.workId === w)) && (!t || (l.tags || []).includes(t)) && (!q || A.lessonSearch(l, workTitle(l.workId), epLab(l.episodeId)).includes(q)));
    const topics = [...new Set([...A.TOPICS.filter(x => ls.some(l => (l.tags || []).includes(x))), ...ls.flatMap(l => l.tags || [])])];
    body.innerHTML = `<div class="row wrap ai-btns"><button class="btn brand" id="lNew">＋ 새 교안</button><button class="btn soft" id="lTxt">TXT로 받기</button><button class="btn soft" id="lMd">Markdown으로 받기</button></div>
      <label class="search"><span aria-hidden="true">⌕</span><input id="lQ" type="search" placeholder="교안 검색 (제목·내용·회차·#주제)" value="${esc(V.q)}"></label>
      <div class="chips"><select id="lWork" class="chip sel" aria-label="작품으로 거르기"><option value="all">모든 작품</option><option value="none" ${w === 'none' ? 'selected' : ''}>작품 없음</option>${S.works.map(x => `<option value="${x.id}" ${w === x.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select><button class="chip ${!t ? 'on' : ''}" data-t="">전체 ${ls.length}</button>${topics.map(x => `<button class="chip ${t === x ? 'on' : ''}" data-t="${esc(x)}">#${esc(x)}</button>`).join('')}</div>
      <div class="ai-list">${shown.map(l => `<button class="ai-item" data-o="${l.id}"><span class="ai-top"><span class="bdg">${esc(String(l.no || ''))}강</span><span class="mute small">${where(l, '작품 없음')}</span>${l.dirty ? '<i class="n-sync">●</i>' : '<i class="n-sync ok">☁</i>'}</span><b>${esc(l.title || '(제목 없음)')}</b><span class="mute small">${esc((l.goal || '').slice(0, 80))} ${(l.tags || []).map(x => '#' + esc(x)).join(' ')}</span></button>`).join('')}</div>
      ${shown.length ? '' : `<div class="empty-box card">${ls.length ? '찾는 교안이 없어요.' : '비교 기록에서 「🎓 작법 교재 초안」을 누르면 여기에 쌓여요.'}</div>`}`;
    body.querySelector('#lQ').oninput = e => { V.q = e.target.value; clearTimeout(V.qt); V.qt = setTimeout(() => renderLessons().then(() => { const i = body.querySelector('#lQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 250); };
    body.querySelector('#lWork').onchange = e => { V.work = e.target.value; renderLessons(); };
    body.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { V.topic = b.dataset.t; renderLessons(); });
    body.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { V.open = b.dataset.o; render(); });
    body.querySelector('#lNew').onclick = async () => { const no = ls.reduce((m, l) => Math.max(m, +l.no || 0), 0) + 1; const l = await save({ id: db.uid('a'), kind: 'lesson', no, title: '', tags: [], workId: null, episodeId: null }); V.open = l.id; render(); };
    const exp = md => { if (!shown.length) return toast('받을 교안이 없어요', 2500, 'oops'); const meta = l => ({ workTitle: workTitle(l.workId), epLabel: epLab(l.episodeId) }); const txt = (md ? '# 작법 교재\n\n' : '작법 교재\n\n') + shown.map(l => md ? A.lessonToMarkdown(l, meta(l)) : A.lessonToText(l, meta(l))).join(md ? '\n---\n\n' : '\n────────\n\n'); window.__lastExport = txt; download(new Blob([(md ? '' : '\uFEFF') + txt], { type: md ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' }), `작법 교재.${md ? 'md' : 'txt'}`); toast(`교안 ${shown.length}개를 받았어요`); };
    body.querySelector('#lTxt').onclick = () => exp(false); body.querySelector('#lMd').onclick = () => exp(true);
  }
  async function renderLesson(id) {
    const l = await db.get('aiwork', id); if (!l) { V.open = null; return render(); }
    body.innerHTML = `<button class="btn ghost small" id="back">‹ 작법 교재</button><div class="card ai-card">
      <div class="ai-grid"><label class="fld">번호<input id="lNo" type="number" min="1" value="${esc(String(l.no || 1))}"></label><label class="fld ai-wide">제목<input id="lTitle" value="${esc(l.title || '')}" maxlength="100"></label>
        <label class="fld">작품<select id="lW">${workOpts(l.workId, '작품 없음')}</select></label><label class="fld">회차<select id="lE" ${l.workId ? '' : 'disabled'}>${epOpts(l.workId, l.episodeId)}</select></label>
        <label class="fld ai-wide">주제 (쉼표로)<input id="lTags" value="${esc((l.tags || []).join(', '))}" placeholder="${A.TOPICS.slice(0, 4).join(', ')}"></label></div>
      ${A.LESSON_FIELDS.map(([k, lab]) => `<label class="fld">${lab}<textarea data-lf="${k}" rows="${k === 'excerpt' || k === 'theory' ? 4 : 2}">${esc(l[k] || '')}</textarea></label>`).join('')}
      <div class="row wrap ai-btns"><button class="btn danger" id="lDel">삭제</button><button class="btn soft" id="lCopy">📋 복사</button><button class="btn brand" id="lSave">저장</button></div></div>`;
    body.querySelector('#back').onclick = () => { V.open = null; render(); };
    body.querySelector('#lW').onchange = e => { const s = body.querySelector('#lE'); s.innerHTML = epOpts(e.target.value, null); s.disabled = !e.target.value; };
    const collect = () => { const o = { ...l, no: +body.querySelector('#lNo').value || 1, title: body.querySelector('#lTitle').value.trim(), workId: body.querySelector('#lW').value || null, tags: body.querySelector('#lTags').value.split(/[,#\n]/).map(x => x.trim()).filter(Boolean) }; o.episodeId = o.workId ? body.querySelector('#lE').value || null : null; body.querySelectorAll('[data-lf]').forEach(t => o[t.dataset.lf] = t.value); return o; };
    body.querySelector('#lSave').onclick = async () => { await save(collect()); toast('교안을 저장했어요'); V.open = null; render(); };
    body.querySelector('#lCopy').onclick = () => { const o = collect(); copyText(A.lessonToText(o, { workTitle: workTitle(o.workId), epLabel: epLab(o.episodeId) })).then(ok => toast(ok ? '교안을 복사했어요' : '복사가 막혔어요')); };
    body.querySelector('#lDel').onclick = async () => { if (await confirmBox('교안 삭제', '이 교안을 지울까요?', '삭제', 'danger')) { await remove(l); V.open = null; render(); } };
  }

  // ---------- 백업 ----------
  async function backupFile() { const items = await db.all('aiwork'); return items.length ? { name: '집필실_AI작업.json', data: JSON.stringify({ v: 1, app: 'jipilsil', kind: 'aiwork', savedAt: new Date().toISOString(), items: items.map(r => ({ id: r.id, ...A.aiContentOf(r), ...(r.conflictOf ? { conflictOf: r.conflictOf } : {}) })) }, null, 1) } : null; }
  async function restoreFrom(file) {
    if (!file) return; let txt = null;
    try {
      const u8 = new Uint8Array(await file.arrayBuffer());
      if (u8[0] === 0x50 && u8[1] === 0x4b) { const f = A.readStoredZip(u8, n => /AI작업\.json$/.test(n)); if (!f) return toast('이 ZIP에는 AI 작업이 없어요', 3000, 'oops'); if (f.error) return toast('압축된 ZIP은 못 읽어요. 집필실에서 받은 백업 ZIP을 골라 주세요', 4000, 'oops'); txt = f.text; }
      else txt = new TextDecoder().decode(u8);
      const j = JSON.parse(txt); if (j.kind !== 'aiwork' || !Array.isArray(j.items)) throw new Error('형식');
      const plan = A.planRestore(await db.all('aiwork'), j.items, () => db.uid('a'));
      if (!plan.add.length) return toast(`새로 넣을 게 없어요 (같은 기록 ${plan.same}개)`);
      if (!(await confirmBox('AI 작업 복원', `${plan.add.length - plan.copies}개를 새로 넣고${plan.copies ? `, 이 기기와 다른 ${plan.copies}개는 「(백업 버전)」 사본으로 따로 넣어요` : ''}.<br>지금 있는 자료와 <b>원고는 덮어쓰지 않아요</b>.`, '복원'))) return;
      for (const r of plan.add) { r.createdAt ||= Date.now(); r.updatedAt ||= Date.now(); await db.put('aiwork', r); }
      scheduleSync(3000); toast(`AI 작업 ${plan.add.length}개를 복원했어요`, 3000, 'great'); render();
    } catch (e) { toast('백업 파일을 읽지 못했어요', 3000, 'oops'); }
  }
  return { open, close, render, backupFile, isOpen: () => !root.hidden, onRemote: () => { if (!root.hidden && !V.open && V.tab !== 'import') render(); } };
}
