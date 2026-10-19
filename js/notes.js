// 설계 노트 — 소스(출처·인용) · 아이디어 · 시퀀스(장면 순서) : 순수 함수 모음
export const NTYPE = { source: { label: '소스', icon: '📎', ph: '인용문, 자료 내용, 참고 메모…' }, idea: { label: '아이디어', icon: '💡', ph: '떠오른 아이디어를 적어 두세요…' }, seq: { label: '시퀀스', icon: '🧭', ph: '이 시퀀스의 의도·감정선 (선택)' } };
// 동기화 비교에 쓰는 "내용" (기기 상태값 제외)
export const CONTENT_KEYS = ['type', 'title', 'body', 'url', 'cite', 'workId', 'episodeId', 'tags', 'beats', 'photoId', 'pinned', 'createdAt', 'updatedAt'];
export function contentOf(n) { const o = {}; for (const k of CONTENT_KEYS) if (n[k] !== undefined) o[k] = n[k]; return o; }
export function contentKey(n) {
  const c = contentOf(n); delete c.updatedAt;
  return JSON.stringify(c, Object.keys(c).sort()) + JSON.stringify((c.beats || []).map(b => [b.id, b.text, !!b.done]));
}
export function searchText(n, workTitle = '') {
  return [n.title, n.body, n.url, n.cite, workTitle, ...(n.tags || []).map(t => '#' + t), ...(n.beats || []).map(b => b.text)].join(' ').toLowerCase();
}
// ChatGPT 로 가져갈 텍스트
export function noteToText(n, { workTitle = '', epLabel = '' } = {}) {
  const T = NTYPE[n.type] || NTYPE.idea; const out = [];
  out.push(`[${T.label}] ${n.title || '(제목 없음)'}`);
  if (workTitle || epLabel) out.push(`[작품] ${workTitle}${epLabel ? ' / [회차] ' + epLabel : ''}`);
  if (n.tags?.length) out.push('[태그] ' + n.tags.map(t => '#' + t).join(' '));
  if (n.cite) out.push('[출처] ' + n.cite);
  if (n.url) out.push('[링크] ' + n.url);
  if (n.body) out.push('', n.body);
  if (n.type === 'seq' && n.beats?.length) { out.push('', '[시퀀스]'); n.beats.forEach((b, i) => out.push(`${i + 1}. ${b.text}${b.done ? ' (완료)' : ''}`)); }
  return out.join('\n');
}
// 드라이브 파일(원격)과 이 기기(로컬)를 노트 단위로 합치기 — 양쪽이 다 바뀐 노트는 덮지 않고 둘 다 남김
// local: 노트 배열 (n.dirty, n.base=마지막으로 맞춘 contentKey), localDel: {id:at}
// remote: {notes:[...], deleted:{id:at}}
// 반환: { put:[노트], del:[id], deleted:{병합된 삭제 목록}, copies:n, changed:bool(원격에 올릴 게 있는지) }
export function mergeNotes(local, localDel, remote, newId) {
  const L = new Map(local.map(n => [n.id, n])); const put = [], del = []; let copies = 0, upload = false;
  const deleted = { ...(remote.deleted || {}) };
  for (const [id, at] of Object.entries(localDel || {})) { if (!deleted[id]) upload = true; deleted[id] = Math.max(at, deleted[id] || 0); }
  const R = new Map();
  for (const r of remote.notes || []) {
    if (deleted[r.id] && !(L.get(r.id)?.dirty)) { if (!localDel?.[r.id]) upload = true; continue; }
    R.set(r.id, r);
    const l = L.get(r.id); const kr = contentKey(r);
    if (!l) { put.push({ ...contentOf(r), id: r.id, dirty: false, base: kr }); continue; }
    const kl = contentKey(l);
    if (kl === kr) { if (l.dirty || l.base !== kr) put.push({ ...l, dirty: false, base: kr }); continue; }
    if (!l.dirty) { put.push({ ...l, ...contentOf(r), dirty: false, base: kr, conflict: undefined }); continue; }
    if (l.base === kr) { upload = true; continue; } // 원격은 그대로 → 내 수정 올림
    // 양쪽 다 바뀜: 내 것은 그대로 두고, 드라이브 버전을 사본으로 따로 보관
    const cid = newId();
    put.push({ ...contentOf(r), id: cid, title: (r.title || '') + ' (다른 기기 버전)', conflictOf: r.id, dirty: true, base: '', updatedAt: Date.now() });
    copies++; upload = true;
  }
  for (const l of local) {
    if (R.has(l.id)) continue;
    if (deleted[l.id]) { if (!l.dirty) { del.push(l.id); continue; } delete deleted[l.id]; upload = true; continue; } // 지워진 노트를 이 기기에서 고쳤으면 살림
    if (l.dirty || !l.base) upload = true;
  }
  return { put, del, deleted, copies, changed: upload };
}
