// 회차 목록표 · 인물·설정표 (CSV 내보내기와 드라이브 구글 시트에 함께 사용)
import { counts, pad2 } from './util.js';

export const STATUS = { draft: '초안', edit: '수정중', done: '완성' };
const label = (ep, i) => ep.label?.trim() || `${pad2(i + 1)}화`;
const day = ts => { if (!ts) return ''; const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
export const syncLabel = ep => ep.conflict ? '충돌' : ep.remoteMissing ? '드라이브에 없음' : ep.dirty ? '대기' : ep.drive?.fileId ? '저장됨' : '기기만';

export function listRows(eps) {
  const head = ['번호', '제목', '글자수(공백 제외)', '글자수(공백 포함)', '상태', '한줄 메모', '마지막 수정'];
  const rows = eps.map((e, i) => { const c = counts(e.text); return [label(e, i), e.title || '', c.noSp, c.all, STATUS[e.status || 'draft'], e.oneLine || '', day(e.updatedAt)]; });
  const tot = eps.reduce((a, e) => { const c = counts(e.text); a[0] += c.noSp; a[1] += c.all; return a; }, [0, 0]);
  return [head, ...rows, ['합계', `${eps.length}화`, tot[0], tot[1], '', '', '']];
}
export function castRows(work) {
  return [['이름', '관계', '메모'], ...(work.cast || []).map(r => [r.name || '', r.rel || '', r.memo || ''])];
}
export function toCSV(rows) {
  return rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
}
