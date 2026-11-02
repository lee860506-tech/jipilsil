// 내보내기 형식: TXT · MD(마크다운) · 한글(HWPX) · PDF — 전부 이 기기(브라우저) 안에서 만들어요.
// 원고는 어디로도 전송되지 않고, 인터넷 없이도 돼요 (PDF 글꼴만 앱이 한 번 받아 둔 파일을 써요).
import { makeZip, normalizeText } from './util.js';
import { HWPX_HEADER, HWPX_SEC_OPEN, HWPX_SECPR_RUN } from './hwpx_tpl.js';

const enc = new TextEncoder();
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const xesc = s => String(s).replace(CTRL, '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const lines = t => normalizeText(t).split('\n');
// sections: [{ heading, text }]   title: 작품 이름(없으면 '')

// ---------- TXT ----------
export function makeTxt(title, sections) {
  let t;
  if (sections.length === 1 && !title) t = normalizeText(sections[0].text);
  else t = (title ? title + '\n\n' : '') + sections.map(s => `[${s.heading}]\n\n${normalizeText(s.text)}`).join('\n\n\n');
  return new Blob(['\uFEFF' + t.replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
}

// ---------- Markdown ----------
// 글이 마크다운 기호로 오해되지 않게 최소한만 가려 줘요 (\ * _ ` [ ] < &코드; ~~ 와 줄 맨 앞의 # - + = 숫자., 줄 맨 앞 공백)
export function mdInline(l) { // 어느 마크다운 프로그램에서도 같게 보이도록: 기호는 \ 로, < & ~~ 는 코드(&lt; &amp; &#126;)로
  return l.replace(/&(?=#?\w+;)/g, '&amp;').replace(/[\\`*_\[\]]/g, c => '\\' + c).replace(/</g, '&lt;').replace(/~~/g, '&#126;&#126;');
}
export function mdEscapeLine(l) {
  let m = l.match(/^[ \t]+/); let lead = '';
  if (m) { lead = m[0].replace(/\t/g, '    ').replace(/ /g, '&nbsp;'); l = l.slice(m[0].length); }
  l = mdInline(l);
  if (/^[#>+\-=]/.test(l)) l = '\\' + l;
  else if (/^\d+[.)]/.test(l)) l = l.replace(/^(\d+)([.)])/, '$1\\$2');
  return lead + l;
}
export function mdBody(text) {
  const a = lines(text).map(mdEscapeLine);
  return a.map((l, i) => (l && a[i + 1] ? l + '  ' : l)).join('\n'); // 이어지는 줄은 줄바꿈 유지(끝 공백 2칸), 빈 줄은 문단 나눔
}
export function makeMd(title, sections) {
  const h = (n, s) => '#'.repeat(n) + ' ' + mdInline(String(s).replace(/[\r\n]+/g, ' '));
  let out = '';
  if (sections.length === 1 && !title) out = h(1, sections[0].heading) + '\n\n' + mdBody(sections[0].text) + '\n';
  else out = (title ? h(1, title) + '\n\n' : '') + sections.map(s => h(2, s.heading) + '\n\n' + mdBody(s.text)).join('\n\n') + '\n';
  return new Blob([out], { type: 'text/markdown;charset=utf-8' });
}

// ---------- 한글 HWPX (한컴오피스 2014 이상) ----------
const NS_HPF = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
export function hwpxParts(title, sections) {
  let id = 0; let first = true;
  const para = (text, { pr = 0, ch = 0, pageBreak = 0 } = {}) => {
    const t = String(text).replace(CTRL, '').replace(/\t/g, '    ');
    const run = t ? `<hp:run charPrIDRef="${ch}"><hp:t>${xesc(t)}</hp:t></hp:run>` : `<hp:run charPrIDRef="${ch}"><hp:t/></hp:run>`;
    const head = first ? HWPX_SECPR_RUN.replace('charPrIDRef="0"', `charPrIDRef="${ch}"`) : ''; first = false;
    return `<hp:p id="${id++}" paraPrIDRef="${pr}" styleIDRef="0" pageBreak="${pageBreak}" columnBreak="0" merged="0">${head}${run}</hp:p>`;
  };
  let body = '';
  const multi = sections.length > 1 || !!title;
  if (multi && title) body += para(title, { pr: 21, ch: 7 });
  sections.forEach((s, i) => {
    body += para(s.heading, { pr: 20, ch: 8, pageBreak: (multi && (title || i > 0)) ? 1 : 0 });
    for (const l of lines(s.text)) body += para(l);
  });
  const section = XML + HWPX_SEC_OPEN + body + '</hs:sec>';
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const docTitle = title || (sections[0] && sections[0].heading) || '';
  const hpf = XML + `<opf:package ${NS_HPF} version="" unique-identifier="" id=""><opf:metadata><opf:title>${xesc(docTitle)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">집필실</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text">집필실</opf:meta><opf:meta name="CreatedDate" content="text">${now}</opf:meta><opf:meta name="ModifiedDate" content="text">${now}</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;
  const prv = (docTitle + '\r\n' + sections.map(s => normalizeText(s.text)).join('\r\n')).replace(CTRL, '').slice(0, 1000);
  return [
    { name: 'mimetype', data: 'application/hwp+zip' }, // 반드시 첫 파일, 압축 없이
    { name: 'version.xml', data: XML + '<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="Hancom Office Hangul" appVersion="13, 0, 0, 1408 WIN32LEWindows_10"/>' },
    { name: 'Contents/header.xml', data: HWPX_HEADER },
    { name: 'Contents/section0.xml', data: section },
    { name: 'Preview/PrvText.txt', data: prv },
    { name: 'settings.xml', data: XML + '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>' },
    { name: 'META-INF/container.rdf', data: XML + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description><rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description><rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description><rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>' },
    { name: 'Contents/content.hpf', data: hpf },
    { name: 'META-INF/container.xml', data: XML + '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/><ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>' },
    { name: 'META-INF/manifest.xml', data: XML + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>' },
  ];
}
export function makeHwpx(title, sections) {
  return new Blob([makeZip(hwpxParts(title, sections))], { type: 'application/hwp+zip' });
}

// ---------- PDF (한글 글꼴을 PDF 안에 넣어서 만들어요) ----------
export const PDF_FONT_URL = 'img/jipilsil-serif.ttf.gz';
let fontP = null;
export function loadPdfFont() {
  if (!fontP) fontP = (async () => {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저에서는 PDF를 만들 수 없어요 (TXT·DOCX·한글은 돼요)');
    const r = await fetch(PDF_FONT_URL); if (!r.ok) throw new Error('PDF 글꼴 파일을 받지 못했어요. 인터넷에 한 번 연결한 뒤 다시 해 주세요');
    let u8 = new Uint8Array(await r.arrayBuffer());
    if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    return parseTtf(u8);
  })().catch(e => { fontP = null; throw e; });
  return fontP;
}
function parseTtf(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint16(4); const T = {};
  for (let i = 0; i < n; i++) { const o = 12 + i * 16; T[String.fromCharCode(...u8.subarray(o, o + 4))] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) }; }
  const head = T.head.off, upem = dv.getUint16(head + 18);
  const numGlyphs = dv.getUint16(T.maxp.off + 4), numHM = dv.getUint16(T.hhea.off + 34), locaFmt = dv.getInt16(head + 50);
  const adv = new Uint16Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) adv[g] = dv.getUint16(T.hmtx.off + 4 * Math.min(g, numHM - 1));
  const cmap = new Map(); const co = T.cmap.off; const nt = dv.getUint16(co + 2); let best = null;
  for (let i = 0; i < nt; i++) {
    const pid = dv.getUint16(co + 4 + i * 8), eid = dv.getUint16(co + 6 + i * 8), off = co + dv.getUint32(co + 8 + i * 8), fmt = dv.getUint16(off);
    const score = fmt === 12 ? 3 : (pid === 3 && eid === 1 && fmt === 4) ? 2 : fmt === 4 ? 1 : 0;
    if (score && (!best || score > best.score)) best = { score, off, fmt };
  }
  if (!best) throw new Error('글꼴 글자표를 읽지 못했어요');
  if (best.fmt === 12) {
    const ng = dv.getUint32(best.off + 12);
    for (let i = 0; i < ng; i++) { const p = best.off + 16 + i * 12; const s = dv.getUint32(p), e = dv.getUint32(p + 4), g0 = dv.getUint32(p + 8); for (let c = s; c <= e; c++) cmap.set(c, g0 + (c - s)); }
  } else {
    const o = best.off, segX2 = dv.getUint16(o + 6), sc = segX2 / 2; const endO = o + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let i = 0; i < sc; i++) {
      const end = dv.getUint16(endO + i * 2), start = dv.getUint16(startO + i * 2), delta = dv.getInt16(deltaO + i * 2), ro = dv.getUint16(rangeO + i * 2);
      for (let c = start; c <= end && c !== 0xFFFF; c++) {
        let g; if (ro === 0) g = (c + delta) & 0xFFFF; else { const gp = rangeO + i * 2 + ro + (c - start) * 2; g = dv.getUint16(gp); if (g) g = (g + delta) & 0xFFFF; }
        if (g) cmap.set(c, g);
      }
    }
  }
  const sgn = o => dv.getInt16(o);
  return { u8, dv, T, upem, numGlyphs, numHM, locaFmt, adv, cmap, bbox: [sgn(head + 36), sgn(head + 38), sgn(head + 40), sgn(head + 42)],
    ascent: sgn(T.hhea.off + 4), descent: sgn(T.hhea.off + 6) };
}
function glyphRange(F, g) {
  const lo = F.T.loca.off, glyf = F.T.glyf.off;
  const a = F.locaFmt ? F.dv.getUint32(lo + g * 4) : F.dv.getUint16(lo + g * 2) * 2, b = F.locaFmt ? F.dv.getUint32(lo + g * 4 + 4) : F.dv.getUint16(lo + g * 2 + 2) * 2;
  return [glyf + a, glyf + b];
}
function subsetTtf(F, used) { // 쓰는 글자 모양만 남기고(번호는 그대로) 나머지는 비움
  const need = new Set([0, ...used]); const stack = [...need];
  while (stack.length) {
    const g = stack.pop(); const [a, b] = glyphRange(F, g); if (b - a < 10) continue;
    if (F.dv.getInt16(a) >= 0) continue;
    let p = a + 10; for (;;) { const fl = F.dv.getUint16(p), gi = F.dv.getUint16(p + 2); if (!need.has(gi)) { need.add(gi); stack.push(gi); } p += 4 + (fl & 1 ? 4 : 2) + (fl & 8 ? 2 : fl & 0x40 ? 4 : fl & 0x80 ? 8 : 0); if (!(fl & 0x20)) break; }
  }
  const N = F.numGlyphs; const loca = new DataView(new ArrayBuffer((N + 1) * 4)); const parts = []; let off = 0;
  for (let g = 0; g < N; g++) {
    loca.setUint32(g * 4, off);
    if (need.has(g)) { const [a, b] = glyphRange(F, g); if (b > a) { const len = (b - a + 3) & ~3; const c = new Uint8Array(len); c.set(F.u8.subarray(a, b)); parts.push(c); off += len; } }
  }
  loca.setUint32(N * 4, off);
  const glyf = new Uint8Array(off); let q = 0; for (const c of parts) { glyf.set(c, q); q += c.length; }
  const hmtx = new DataView(new ArrayBuffer(N * 4));
  for (const g of need) { hmtx.setUint16(g * 4, F.adv[g]); const lsbOff = F.T.hmtx.off + (g < F.numHM ? g * 4 + 2 : F.numHM * 4 + (g - F.numHM) * 2); hmtx.setInt16(g * 4 + 2, F.dv.getInt16(lsbOff)); }
  const cp = t => F.u8.slice(F.T[t].off, F.T[t].off + F.T[t].len);
  const head = cp('head'), hhea = cp('hhea'), maxp = cp('maxp');
  const hd = new DataView(head.buffer); hd.setUint32(8, 0); hd.setInt16(50, 1);
  new DataView(hhea.buffer).setUint16(34, N);
  const tabs = [['glyf', glyf], ['head', head], ['hhea', hhea], ['hmtx', new Uint8Array(hmtx.buffer)], ['loca', new Uint8Array(loca.buffer)], ['maxp', maxp]];
  const dirLen = 12 + tabs.length * 16; let total = dirLen; for (const [, d] of tabs) total += (d.length + 3) & ~3;
  const out = new Uint8Array(total); const od = new DataView(out.buffer);
  od.setUint32(0, 0x00010000); od.setUint16(4, tabs.length); od.setUint16(6, 64); od.setUint16(8, 2); od.setUint16(10, tabs.length * 16 - 64); // 표 6개 기준 검색 값
  let pos = dirLen; let headPos = 0;
  const sum = d => { let s = 0; const v = new DataView(d.buffer, d.byteOffset, d.byteLength - (d.byteLength % 4)); for (let i = 0; i < v.byteLength; i += 4) s = (s + v.getUint32(i)) >>> 0; const r = d.byteLength % 4; if (r) { let x = 0; for (let k = 0; k < 4; k++) x = (x << 8) | (k < r ? d[d.byteLength - r + k] : 0); s = (s + (x >>> 0)) >>> 0; } return s; };
  tabs.forEach(([tag, d], i) => {
    out.set(d, pos); const p = 12 + i * 16; for (let k = 0; k < 4; k++) out[p + k] = tag.charCodeAt(k);
    od.setUint32(p + 4, sum(d)); od.setUint32(p + 8, pos); od.setUint32(p + 12, d.length); if (tag === 'head') headPos = pos; pos += (d.length + 3) & ~3;
  });
  od.setUint32(headPos + 8, (0xB1B0AFBA - sum(out)) >>> 0);
  return out;
}

const NO_START = new Set([...'.,!?:;)]}>”’」』〉》】〕…·~%‰、。，．！？：；ー']);
const NO_END = new Set([...'([{<“‘「『〈《【〔']);
const ZERO = new Set([0x200B, 0x200C, 0x200D, 0xFEFF, 0x2060, 0xFE0F, 0xFE0E, 0xAD]);
async function deflate(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
}
const hex4 = n => n.toString(16).padStart(4, '0');
const u16hex = s => 'FEFF' + [...s].map(ch => { const c = ch.codePointAt(0); if (c > 0xFFFF) { const x = c - 0x10000; return hex4(0xD800 + (x >> 10)) + hex4(0xDC00 + (x & 0x3FF)); } return hex4(c); }).join('');
const f2 = n => (Math.round(n * 100) / 100).toString();

// sections: [{heading, text}] → { blob, missing(글꼴에 없는 글자 수), pages }
export async function makePdf(title, sections, F) {
  const W = 595.28, H = 841.89, MX = 72, MT = 74, MB = 78, SIZE = 11, LH = 1.85, TW = W - MX * 2;
  const cw = new Map(); const gidOf = c => F.cmap.get(c) ?? (c === 0xA0 ? F.cmap.get(0x20) : undefined);
  const adv = c => { let w = cw.get(c); if (w === undefined) { const g = gidOf(c); w = g === undefined ? F.upem * 0.9 : F.adv[g]; cw.set(c, w); } return w / F.upem; };
  const strW = (s, size) => { let w = 0; for (const ch of s) w += adv(ch.codePointAt(0)); return w * size; };
  let missing = 0; const used = new Set(); const uni = new Map();
  const clean = t => { let o = ''; for (const ch of String(t).replace(CTRL, '')) { const c = ch.codePointAt(0); if (ZERO.has(c) || gidOf(c) !== undefined || /\s/u.test(ch)) o += ch; else missing++; } return o; }; // 글꼴에 없는 글자(이모지 등)는 빼고 개수만 세요
  title = clean(title); sections = sections.map(s => ({ heading: clean(s.heading), text: clean(s.text) }));
  const toHex = s => { let h = ''; for (const ch of s) { const c = ch.codePointAt(0); if (ZERO.has(c) || c < 0x20) continue; let g = gidOf(c); if (g === undefined) g = 0; used.add(g); if (g && !uni.has(g)) uni.set(g, c); h += hex4(g); } return h; };
  const wrap = (text, size, maxW) => {
    const out = []; let cur = '', cw_ = 0;
    const push = () => { out.push(cur.replace(/\s+$/u, '')); cur = ''; cw_ = 0; };
    for (const tok of (text.match(/\s+|\S+/gu) || [])) {
      const w = strW(tok, size);
      if (/^\s/u.test(tok)) { if (cur === '' && out.length) continue; if (cw_ + w > maxW) { push(); continue; } cur += tok; cw_ += w; continue; }
      if (cw_ + w <= maxW) { cur += tok; cw_ += w; continue; }
      if (cur.trim() && w <= maxW) { push(); cur = tok; cw_ = w; continue; }
      for (const ch of tok) { // 한 덩어리가 한 줄보다 길면 글자 단위로 (줄 머리에 ) . , 가 오지 않게)
        const c = strW(ch, size);
        if (cw_ + c > maxW && cur) {
          let carry = '';
          if (NO_START.has(ch) && cur.length > 1) { const arr = [...cur]; carry = arr.pop(); cur = arr.join(''); } else if (NO_END.has([...cur].pop())) { const arr = [...cur]; carry = arr.pop(); cur = arr.join(''); }
          push(); cur = carry; cw_ = strW(carry, size);
        }
        cur += ch; cw_ += c;
      }
    }
    if (cur !== '' || !out.length) push();
    return out;
  };
  // 쪽 나누기
  const pages = []; const marks = []; let ops = [], y = 0;
  const newPage = (cover = false) => { ops = []; pages.push({ ops, cover }); y = H - MT; };
  const putLine = (text, size, x, bold) => { const h = toHex(text); if (!h) return; const base = y - size * (0.5 * (LH - 1) + 0.82); ops.push(`q BT /F1 ${size} Tf ${bold ? '2 Tr ' + f2(size * 0.03) + ' w ' : ''}${f2(x)} ${f2(base)} Td <${h}> Tj ET Q`); };
  const room = lh => y - lh >= MB - 8;
  const multi = sections.length > 1 || !!title;
  if (multi && title) {
    newPage(true); const size = 26; const ls = wrap(title, size, TW); y = H * 0.62;
    for (const l of ls) { putLine(l, size, MX + (TW - strW(l, size)) / 2, true); y -= size * 1.5; }
    const sub = `${sections.length}개 회차`; y -= 10; putLine(sub, 12, MX + (TW - strW(sub, 12)) / 2, false);
  }
  sections.forEach((s, si) => {
    newPage();
    marks.push({ title: s.heading, page: pages.length - 1, y: y + 8 });
    const hs = 17; for (const l of wrap(s.heading, hs, TW)) { putLine(l, hs, MX, true); y -= hs * 1.5; }
    y -= hs * 0.7;
    for (const para of lines(s.text)) {
      if (para.trim() === '') { if (!room(SIZE * LH)) newPage(); else y -= SIZE * LH; continue; }
      for (const l of wrap(para.replace(/\t/g, '    '), SIZE, TW)) {
        if (!room(SIZE * LH)) newPage();
        putLine(l, SIZE, MX, false); y -= SIZE * LH;
      }
    }
  });
  // 쪽 번호 (표지가 있으면 표지는 빼고 센다)
  pages.forEach((p, i) => { if (p.cover) return; const label = String(multi && title ? i : i + 1); const h = toHex(label); p.ops.push(`BT /F1 9 Tf ${f2(W / 2 - strW(label, 9) / 2)} ${f2(MB - 34)} Td <${h}> Tj ET`); });
  // ---- 파일 만들기 ----
  const gids = [...used].filter(g => g > 0).sort((a, b) => a - b);
  const fontBin = subsetTtf(F, used); const fontZ = await deflate(fontBin);
  const objs = []; const add = d => { objs.push(d); return objs.length; };
  const stream = (dict, bytes, z) => ({ dict: dict + (z ? ' /Filter /FlateDecode' : '') + ` /Length ${(z || bytes).length}`, bytes: z || bytes });
  const sc = 1000 / F.upem;
  const catalog = add(null), pagesObj = add(null), type0 = add(null), cid = add(null), desc = add(null), ffile = add(null), tou = add(null), info = add(null);
  let w = ''; for (const g of gids) w += `${g} [${Math.round(F.adv[g] * sc)}] `;
  const cmapLines = []; for (let i = 0; i < gids.length; i += 100) { const ch = gids.slice(i, i + 100).filter(g => uni.has(g)); if (ch.length) cmapLines.push(`${ch.length} beginbfchar\n` + ch.map(g => { const c = uni.get(g); const s = c > 0xFFFF ? hex4(0xD800 + ((c - 0x10000) >> 10)) + hex4(0xDC00 + ((c - 0x10000) & 0x3FF)) : hex4(c); return `<${hex4(g)}> <${s}>`; }).join('\n') + '\nendbfchar'); }
  const toUni = enc.encode(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n${cmapLines.join('\n')}\nendcmap CMapName currentdict /CMap defineresource pop end end`);
  const toUniZ = await deflate(toUni);
  objs[type0 - 1] = `<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+JipilsilSerif /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tou} 0 R >>`;
  objs[cid - 1] = `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+JipilsilSerif /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${w}] >>`;
  objs[desc - 1] = `<< /Type /FontDescriptor /FontName /AAAAAA+JipilsilSerif /Flags 4 /FontBBox [${F.bbox.map(v => Math.round(v * sc)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(F.ascent * sc)} /Descent ${Math.round(F.descent * sc)} /CapHeight 700 /StemV 80 /FontFile2 ${ffile} 0 R >>`;
  objs[ffile - 1] = stream(`<< /Length1 ${fontBin.length}`, fontBin, fontZ);
  objs[tou - 1] = stream('<<', toUni, toUniZ);
  const now = new Date(); const d = `D:${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}Z`;
  const docTitle = title || (sections[0] && sections[0].heading) || '';
  objs[info - 1] = `<< /Title <${u16hex(docTitle)}> /Creator <${u16hex('집필실')}> /Producer <${u16hex('집필실 (내 기기에서 만듦)')}> /CreationDate (${d}) >>`;
  const pageIds = [], contentIds = [];
  for (const p of pages) { const pid = add(null); const body = enc.encode(p.ops.join('\n')); const z = await deflate(body); const cid2 = add(stream('<<', body, z)); pageIds.push(pid); contentIds.push(cid2); }
  pages.forEach((p, i) => { objs[pageIds[i] - 1] = `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${type0} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`; });
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`;
  let outlines = '';
  if (marks.length > 1) {
    const root = add(null); const ids = marks.map(() => add(null));
    marks.forEach((m, i) => { objs[ids[i] - 1] = `<< /Title <${u16hex(m.title)}> /Parent ${root} 0 R ${i ? `/Prev ${ids[i - 1]} 0 R ` : ''}${i < ids.length - 1 ? `/Next ${ids[i + 1]} 0 R ` : ''}/Dest [${pageIds[m.page]} 0 R /XYZ 0 ${f2(m.y)} null] >>`; });
    objs[root - 1] = `<< /Type /Outlines /First ${ids[0]} 0 R /Last ${ids[ids.length - 1]} 0 R /Count ${ids.length} >>`; outlines = ` /Outlines ${root} 0 R /PageMode /UseOutlines`;
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${outlines} /Lang (ko-KR) >>`;
  const chunks = [enc.encode('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n')]; const offs = []; let pos = chunks[0].length;
  const push = u => { chunks.push(u); pos += u.length; };
  objs.forEach((o, i) => {
    offs.push(pos);
    if (typeof o === 'string') push(enc.encode(`${i + 1} 0 obj\n${o}\nendobj\n`));
    else { push(enc.encode(`${i + 1} 0 obj\n${o.dict} >>\nstream\n`)); push(o.bytes); push(enc.encode('\nendstream\nendobj\n')); }
  });
  const xref = pos; let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  x += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(enc.encode(x));
  return { blob: new Blob(chunks, { type: 'application/pdf' }), missing, pages: pages.length };
}
