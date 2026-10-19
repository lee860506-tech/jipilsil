// 텍스트·내보내기·비교 유틸리티 (모두 브라우저 안에서 처리, 외부 서비스 없음)

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pad2 = n => String(n).padStart(2, '0');

export function normalizeText(t) {
  return String(t ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}
// 드라이브(구글 문서) 왕복 후에도 같은 원고로 볼 수 있게 비교용으로 정리
export function canon(t) {
  return normalizeText(t).replace(/[ \t\u00a0]+$/gm, '').replace(/\n+$/, '').replace(/^\n+/, '');
}
// 붙여넣기 정리: 줄 끝 공백 제거, 3줄 이상 빈 줄을 1줄로
export function tidyPaste(t) {
  return normalizeText(t).replace(/[ \t\u00a0]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

export function counts(t) {
  const s = t || '';
  const all = [...s.replace(/\n/g, '')].length;
  const noSp = [...s.replace(/\s/g, '')].length;
  const words = (s.trim().match(/\S+/g) || []).length;
  return { all, noSp, words, pages: Math.ceil(all / 200) };
}

export async function hashText(t) {
  const buf = new TextEncoder().encode(t);
  if (crypto.subtle) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261; for (const b of buf) { h ^= b; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16);
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function fmtDur(sec) { sec = Math.round(sec || 0); return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`; }

// ---------- TXT 가져오기 ----------
export function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xFF && u8[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(u8), enc: 'UTF-16' };
  if (u8[0] === 0xFE && u8[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(u8), enc: 'UTF-16' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), enc: 'UTF-8' }; }
  catch (e) { return { text: new TextDecoder('euc-kr').decode(u8), enc: 'CP949' }; } // euc-kr = windows-949(CP949)
}
export function detectEpisodeNo(name) {
  const base = name.replace(/\.[^.]+$/, '');
  let m = base.match(/(\d{1,4})\s*(?:화|회|話)/) || base.match(/(?:제|ep\.?|EP\.?|Ep\.?|chapter|ch\.?)\s*(\d{1,4})/i) || base.match(/^\s*(\d{1,4})(?!\d)/) || base.match(/(\d{1,4})(?!.*\d)/);
  return m ? parseInt(m[1], 10) : null;
}
export function titleFromFilename(name) {
  return name.replace(/\.[^.]+$/, '').replace(/^.*?(\d{1,4})\s*(?:화|회|話)\s*[-_.·:]?\s*/, '').replace(/^\s*\d{1,4}\s*[-_.·:]\s*/, '').trim();
}

// ---------- ZIP (저장 방식, UTF-8 파일명) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

export function makeZip(files) { // files: [{name, data: string|Uint8Array}]
  const enc = new TextEncoder();
  const chunks = []; const central = []; let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), nameB, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---------- DOCX (직접 만든 OOXML) ----------
const xesc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
export function docxParts(sections) { // sections: [{heading, text}]
  let body = '';
  sections.forEach((s, i) => {
    if (s.heading) body += `<w:p><w:pPr><w:pStyle w:val="Heading1"/>${i > 0 ? '<w:pageBreakBefore/>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${xesc(s.heading)}</w:t></w:r></w:p>`;
    for (const line of normalizeText(s.text).split('\n')) {
      body += line ? `<w:p><w:r><w:t xml:space="preserve">${xesc(line)}</w:t></w:r></w:p>` : '<w:p/>';
    }
  });
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1701" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Batang" w:hAnsi="Batang" w:eastAsia="바탕" w:cs="Batang"/><w:sz w:val="22"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`;
  return [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'word/document.xml', data: doc },
    { name: 'word/styles.xml', data: styles },
  ];
}
export function makeDocx(sections) {
  const z = makeZip(docxParts(sections));
  return new Blob([z], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
export async function zipBytes(blob) { return new Uint8Array(await blob.arrayBuffer()); }

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export const safeName = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '제목 없음';

// ---------- 비교(diff) ----------
// 줄 단위 Myers 차이 계산 (O(ND): 긴 원고에서 몇 줄만 바뀐 경우도 빠름)
function myers(a, b, maxD = 6000) {
  const n = a.length, m = b.length, max = n + m, off = max + 1;
  let v = new Int32Array(2 * max + 3); const trace = [];
  maxD = Math.min(maxD, Math.floor(3e7 / (2 * max + 3))); // 메모리 한도
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { // 역추적
        const ops = []; let cx = n, cy = m;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd]; const kk = cx - cy;
          const prevK = (kk === -dd || (kk !== dd && pv[off + kk - 1] < pv[off + kk + 1])) ? kk + 1 : kk - 1;
          const px = pv[off + prevK], py = px - prevK;
          while (cx > px && cy > py) { ops.push({ t: 'same', a: a[--cx] }); cy--; }
          if (cx === px) ops.push({ t: 'add', a: b[--cy] }); else ops.push({ t: 'del', a: a[--cx] });
        }
        while (cx > 0 && cy > 0) { ops.push({ t: 'same', a: a[--cx] }); cy--; }
        return ops.reverse();
      }
    }
  }
  return null; // 너무 많이 다름
}
export function diffLines(a, b) {
  const A = normalizeText(a).split('\n'), B = normalizeText(b).split('\n');
  const r = myers(A, B);
  if (r) return r;
  return [...A.map(t => ({ t: 'del', a: t })), ...B.map(t => ({ t: 'add', a: t }))];
}
// 바뀐 줄 안에서 앞뒤 공통부분 외의 글자만 강조
function inline(a, b) {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return [esc(a.slice(0, s)) + '<mark>' + esc(a.slice(s, a.length - e)) + '</mark>' + esc(a.slice(a.length - e)),
          esc(b.slice(0, s)) + '<mark>' + esc(b.slice(s, b.length - e)) + '</mark>' + esc(b.slice(b.length - e))];
}
export function diffHTML(a, b, ctx = 2) {
  const d = diffLines(a, b);
  // 연속된 del/add 쌍은 줄 내부 강조
  for (let i = 0; i < d.length - 1; i++) {
    if (d[i].t === 'del' && d[i + 1].t === 'add') { const [x, y] = inline(d[i].a, d[i + 1].a); d[i].h = x; d[i + 1].h = y; i++; }
  }
  const keep = d.map(() => false);
  d.forEach((x, i) => { if (x.t !== 'same') for (let k = Math.max(0, i - ctx); k <= Math.min(d.length - 1, i + ctx); k++) keep[k] = true; });
  let html = '', skipped = 0, adds = 0, dels = 0;
  d.forEach((x, i) => {
    if (x.t === 'add') adds++; if (x.t === 'del') dels++;
    if (!keep[i]) { skipped++; return; }
    if (skipped) { html += `<div class="d-skip">… 같은 내용 ${skipped}줄 …</div>`; skipped = 0; }
    const sign = x.t === 'add' ? '＋' : x.t === 'del' ? '－' : ' ';
    html += `<div class="d-${x.t}"><span class="d-sign">${sign}</span>${x.h ?? (esc(x.a) || '&nbsp;')}</div>`;
  });
  if (skipped) html += `<div class="d-skip">… 같은 내용 ${skipped}줄 …</div>`;
  if (!adds && !dels) html = '<div class="d-skip">지금 원고와 같은 내용이에요.</div>';
  return { html, adds, dels };
}

// 대사 판별(따옴표로 시작)
export const isDialogue = p => /^\s*["“”'‘「『]/.test(p);

// 낭독용 문장 나누기 (안드로이드 크롬은 긴 문장을 끊는 일이 있어 200자 이하로)
export function chunkForSpeech(p, max = 180) {
  const parts = p.match(/[^.!?。…？！]+[.!?。…？！"”’」』]*\s*/g) || [p];
  const out = []; let cur = '';
  for (const s of parts) {
    if ((cur + s).length > max && cur) { out.push(cur); cur = ''; }
    if (s.length > max) { for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max)); }
    else cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out.filter(x => x.trim());
}
