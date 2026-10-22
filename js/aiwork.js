// AI 작업 가져오기 · 분류 · 비교 · 작법 교재 — 순수 함수 (AI API 없이, 규칙 기반)
// 원고(episodes)와 완전히 따로: 'aiwork' 저장소에 kind 로 구분해 저장
export const KINDS = { import: '가져온 자료', compare: '비교 기록', lesson: '작법 교재' };
export const DOC_TYPES = ['원고', '수정본', '작법 분석', '기타'];
export const STAGES = ['초고', '재독', '퇴고', '분석', '기타'];
export const CATS = {
  body: { label: '소설 본문', icon: '📖' },
  rev: { label: '재독 수정본', icon: '✎' },
  cmp: { label: '비교 내용', icon: '⇄' },
  theory: { label: '작법 이론/분석', icon: '🎓' },
  memo: { label: '작업 지시/메모', icon: '📝' },
};
export const FIELDS = [
  ['clarity', '정보 명확성 · 서술 초점'],
  ['sensory', '감각 정보 추가/삭제'],
  ['body', '신체 반응 · 행동 인과'],
  ['emotion', '감정 직접 설명'],
  ['inference', '독자 추론 가능 정보'],
  ['blur', '불필요한 묘사로 초점 흐림'],
  ['experience', '독서 경험 변화'],
];
export const DECISIONS = { keep: '원문 유지', revision: '수정안 선택', partial: '부분 채택', compareOnly: '비교만 저장' };

const nl = s => String(s || '').replace(/\r\n?/g, '\n');
export function normForHash(s) { return nl(s).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(); }
// 동기 해시 (FNV-1a 64비트 흉내 두 개) — 중복 찾기용, 보안용 아님
export function hashText(s) {
  const t = normForHash(s); let h1 = 0x811c9dc5, h2 = 0x01000193 ^ t.length;
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519) ^ (h2 >>> 13); }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + t.length.toString(36);
}

// ---------- 가져오기: 입력 방식은 여기에 추가 (붙여넣기 · TXT · 앞으로 DOCX 등) ----------
export const IMPORTERS = [
  { id: 'paste', label: '붙여넣기', accepts: () => true, read: async x => nl(x) },
  { id: 'txt', label: 'TXT 파일', ext: ['.txt', '.md'], accepts: f => /\.(txt|md)$/i.test(f.name || '') || /^text\//.test(f.type || ''), read: async (f, decode) => nl(decode ? await decode(f) : await f.text()) },
];
export const importerFor = f => IMPORTERS.find(i => i.id !== 'paste' && i.accepts(f));

// ---------- 나누기: ChatGPT 답변을 조각으로 ----------
const HEAD_RE = /^\s{0,3}(?:#{1,6}\s+.+|\*\*[^*\n]{1,60}\*\*\s*:?\s*$|【[^】]{1,40}】.*|\[[^\]\n]{1,30}\]\s*$|[■□▶▷●◆◇★☆]\s*.{1,50}$|(?:[0-9]{1,2}|[①-⑳])[.)]\s+.{1,50}[:：]?\s*$|[^\n.。!?]{1,30}[:：]\s*$)/;
const SEP_RE = /^\s*(?:-{3,}|\*{3,}|_{3,}|={3,}|─{3,})\s*$/;
export function isHeading(line) { return HEAD_RE.test(line) && line.trim().length <= 70 && !/[.。!?]["”’』」]?\s*$/.test(line.trim().replace(/[:：]\s*$/, '')); }
export function splitSegments(text) {
  const lines = nl(text).split('\n'); const segs = []; let cur = null;
  const push = () => { if (cur && cur.text.trim()) { cur.text = cur.text.replace(/^\n+|\n+$/g, ''); segs.push(cur); } cur = null; };
  for (const ln of lines) {
    if (SEP_RE.test(ln)) { push(); continue; }
    if (isHeading(ln)) { push(); cur = { head: ln.trim().replace(/^#+\s*|\*\*/g, '').replace(/[:：]\s*$/, '').trim(), text: '' }; continue; }
    if (!cur) cur = { head: '', text: '' };
    cur.text += (cur.text ? '\n' : '') + ln;
  }
  push();
  // 한 조각 안에 섞인 지시문 문단(…해 주세요/써 줘)은 따로 떼기
  const out = [];
  for (const sg of segs) {
    const ps = sg.text.split(/\n{2,}/); if (ps.length < 2) { out.push(sg); continue; }
    let buf = [];
    for (const p of ps) {
      if (MEMO_P.test(p.trim()) && [...p].length < 300) { if (buf.length) out.push({ head: out.length && !buf.length ? '' : sg.head, text: buf.join('\n\n') }); buf = []; out.push({ head: '', text: p, memo: true }); sg.head = ''; }
      else buf.push(p);
    }
    if (buf.length) out.push({ head: sg.head, text: buf.join('\n\n') });
  }
  return out;
}
const MEMO_P = /(?:해 ?주세요|써 ?주세요|해 ?줘|써 ?줘|바꿔 ?줘|고쳐 ?줘|부탁(?:해|드려)|하자|할 것)[.!~ ]*$|^(?:TODO|메모|지시|요청)\s*[:：]/;

// ---------- 분류 (규칙 기반 점수) ----------
const KW = {
  rev: /수정본|수정안|수정 ?후|고친 ?(?:글|버전|본문)|다듬은|재독(?: ?수정)?|퇴고(?:본|안)|개정|리라이트|rewrite|revised/i,
  cmp: /원문|수정 ?전|변경 ?(?:점|사항)|비교|before|after|→|바뀐 ?점|차이/i,
  theory: /서술|시점|초점|독자|긴장|묘사|감정|감각|효과|기법|작법|이론|분석|리듬|개연성|인과|암시|복선|정보|몰입|문체|호흡|장면 ?전환|show|tell|보여주기|말하기/gi,
  memo: /해 ?주세요|해 ?줘|써 ?줘|쓰자|할 것|하기$|TODO|메모|다음 ?(?:회차|화|장면)|체크|확인할|요청|지시|주의|기억할/i,
  body: /[“"「『][^”"」』\n]{1,200}[”"」』]/g,
};
function prosey(t) {
  const s = t.split(/(?<=[.!?。])\s+|\n+/).filter(x => x.trim()); if (!s.length) return 0;
  const end = s.filter(x => /(?:다|요|까|네|지|군|어|아|라|냐)[.!?…]*["”』」]?$/.test(x.trim())).length / s.length;
  const bullets = t.split('\n').filter(x => /^\s*(?:[-*•·]|\d+[.)])\s/.test(x)).length;
  return end - bullets * 0.15;
}
export function scoreSegment(seg) {
  const t = seg.text, h = seg.head || ''; const len = [...t].length || 1;
  const sc = { body: 0, rev: 0, cmp: 0, theory: 0, memo: 0 };
  if (/^(?:원문|원본|원고|수정 ?전|초고|before)$/i.test(h.trim())) sc.body += 8;
  if (KW.rev.test(h)) sc.rev += 6; if (KW.cmp.test(h)) sc.cmp += 5; if (/분석|작법|이론|설명|효과|해설|포인트/.test(h)) sc.theory += 5;
  if (/메모|지시|요청|할 일|다음/.test(h)) sc.memo += 5; if (/본문|원고|초안|장면|\d+\s*화/.test(h) && !KW.rev.test(h)) sc.body += 4;
  const th = (t.match(KW.theory) || []).length; sc.theory += Math.min(6, th * 900 / len);
  const dq = (t.match(KW.body) || []).length; sc.body += Math.min(4, dq * 1.2);
  const p = prosey(t); sc.body += p * 3; sc.rev += p * 0.5;
  if (/^\s*(?:원문|수정 ?전|before)\s*[:：]/im.test(t) && /^\s*(?:수정(?:본|안)?|수정 ?후|after)\s*[:：]/im.test(t)) sc.cmp += 6;
  if ((t.match(/→/g) || []).length >= 2) sc.cmp += 3;
  if (KW.memo.test(t) && len < 400) sc.memo += 3;
  if (/^\s*(?:[-*•·]|\d+[.)])\s/m.test(t)) { sc.theory += 1; sc.body -= 1.5; }
  if (len < 40 && !dq) sc.memo += 1;
  return sc;
}
export function classifySegment(seg, prev) {
  if (seg.memo) return { cat: 'memo', score: 9, sure: true };
  const sc = scoreSegment(seg); let best = 'body', bv = -1e9;
  for (const [k, v] of Object.entries(sc)) if (v > bv) { best = k; bv = v; }
  if (bv < 1) best = prev && !seg.head ? prev : (prosey(seg.text) > .5 ? 'body' : 'memo'); // 약하면 앞 조각을 따라가거나 문장 모양으로
  return { cat: best, score: Math.round(bv * 10) / 10, sure: bv >= 3 };
}
export function analyzeText(text, newId = () => Math.random().toString(36).slice(2, 9)) {
  const segs = splitSegments(text); let prev = null;
  return segs.map(s => { const c = classifySegment(s, prev); prev = c.cat; return { id: newId(), head: s.head || '', text: s.text, cat: c.cat, sure: c.sure }; });
}
export function guessDocType(segs) {
  const n = k => segs.filter(s => s.cat === k).reduce((a, s) => a + s.text.length, 0); const tot = segs.reduce((a, s) => a + s.text.length, 0) || 1;
  if (n('rev') > 0 && n('rev') / tot > .05) return '수정본';
  if ((n('theory') + n('cmp')) / tot > .45) return '작법 분석';
  if (n('body') / tot > .55) return '원고';
  return '기타';
}
// 작품·회차 짐작: 확실할 때만. 모르면 null → 미분류
export function guessTarget(text, works, epsOf) {
  const t = nl(text).slice(0, 3000); let work = null;
  const hits = works.filter(w => w.title && w.title.trim().length >= 2 && t.includes(w.title.trim())).sort((a, b) => b.title.length - a.title.length);
  if (hits.length === 1 || (hits.length > 1 && hits[0].title.length > hits[1].title.length)) work = hits[0];
  const m = t.match(/(?:제\s*)?(\d{1,4})\s*(?:화|회차|회)(?![가-힣]*[0-9])|(?:EP|ep|에피소드)\.?\s*(\d{1,4})|회차\s*[:：]?\s*(\d{1,4})/);
  const no = m ? +(m[1] || m[2] || m[3]) : null;
  let ep = null;
  if (work && no) { const eps = epsOf(work.id) || []; ep = eps[no - 1] || null; }
  return { workId: work?.id || null, episodeId: ep?.id || null, epNo: no, workSure: !!work, epSure: !!ep };
}
export const stagesFor = docType => docType === '수정본' ? '재독' : docType === '작법 분석' ? '분석' : docType === '원고' ? '초고' : '기타';

// ---------- 비교 (문단 → 낱말 단위 diff, 부분 채택용 덩어리) ----------
export function tokenize(s) { return nl(s).match(/\s+|[가-힣ㄱ-ㅎㅏ-ㅣ]+|[A-Za-z0-9]+|[^\s가-힣A-Za-z0-9]/g) || []; }
function lcsOps(a, b, eq = (x, y) => x === y) {
  const n = a.length, m = b.length; if (!n || !m) return [...a.map(x => ['-', x]), ...b.map(x => ['+', x])];
  if (n * m > 4e6) return [...a.map(x => ['-', x]), ...b.map(x => ['+', x])]; // 너무 크면 통째로
  const w = m + 1, L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = eq(a[i], b[j]) ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (eq(a[i], b[j])) { out.push(['=', a[i]]); i++; j++; } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push(['-', a[i++]]); else out.push(['+', b[j++]]); }
  while (i < n) out.push(['-', a[i++]]); while (j < m) out.push(['+', b[j++]]);
  return out;
}
// 결과: parts = [{t:'eq', a} | {t:'chg', id, a, b}]  (a=원문 조각, b=수정 조각)
export function diffParts(orig, rev) {
  const A = nl(orig).split(/(\n)/), B = nl(rev).split(/(\n)/); // 문단(줄)과 줄바꿈을 따로
  const pops = lcsOps(A, B); const parts = []; let k = 0;
  const addEq = s => { if (!s) return; const l = parts[parts.length - 1]; if (l?.t === 'eq') l.a += s; else parts.push({ t: 'eq', a: s }); };
  const addChg = (a, b) => { if (!a && !b) return; parts.push({ t: 'chg', id: 'h' + (k++), a, b }); };
  let da = [], db = [];
  const flush = () => {
    if (!da.length && !db.length) return;
    const ta = tokenize(da.join('')), tb = tokenize(db.join('')); da = []; db = [];
    const ops = lcsOps(ta, tb); let ca = '', cb = '';
    for (const [o, x] of ops) {
      if (o === '=') { if (ca || cb) { if (/^\s+$/.test(x) && (ca || cb)) { ca += x; cb += x; continue; } addChg(ca, cb); ca = cb = ''; } addEq(x); }
      else if (o === '-') ca += x; else cb += x;
    }
    addChg(ca, cb);
  };
  for (const [o, x] of pops) { if (o === '=') { flush(); addEq(x); } else if (o === '-') da.push(x); else db.push(x); }
  flush();
  // 공백만 같은 꼬리 정리
  for (const p of parts) if (p.t === 'chg') { const m = p.a.match(/\s+$/), n2 = p.b.match(/\s+$/); if (m && n2 && m[0] === n2[0]) { p.a = p.a.slice(0, -m[0].length); p.b = p.b.slice(0, -m[0].length); const i = parts.indexOf(p); parts.splice(i + 1, 0, { t: 'eq', a: m[0] }); } }
  return parts;
}
export function hunksOf(parts) { return parts.filter(p => p.t === 'chg'); }
// choice: { [hunkId]: true(수정안) | false(원문) }
export function buildText(parts, choice) { return parts.map(p => p.t === 'eq' ? p.a : (choice[p.id] ? p.b : p.a)).join(''); }
export function decisionText(cmp, parts) {
  if (cmp.decision === 'revision') return nl(cmp.revision);
  if (cmp.decision === 'partial') return buildText(parts, cmp.hunkChoice || {});
  return nl(cmp.original);
}
export function diffStats(parts) { let add = 0, del = 0; for (const p of parts) if (p.t === 'chg') { add += [...p.b.replace(/\s/g, '')].length; del += [...p.a.replace(/\s/g, '')].length; } return { hunks: hunksOf(parts).length, add, del }; }

// ---------- 중립 표시 (판단 없이 숫자만) ----------
export const LEX = {
  emotion: /슬프|슬펐|슬픔|기쁘|기뻤|기쁨|외롭|외로|두렵|두려|무섭|무서|화가 ?났|화났|분노|행복|불안|서럽|서러|그립|그리웠|설레|설렜|괴롭|괴로|우울|질투|부끄|창피|억울|짜증|미안|고마웠|안타까|허탈|공허|쓸쓸|초조|긴장했|당황|놀랐/g,
  sensory: /보였|보인|들렸|들린|소리|냄새|향기|향이|맛이|맛을|차갑|차가|뜨겁|뜨거|따뜻|따스|축축|끈적|거칠|부드럽|부드러|딱딱|미끄|빛|어둠|어두|밝|색|붉|푸르|하얗|검은|까만|시큼|비릿|달콤|짭짤|쓴맛|바람|촉감|감촉|온기|한기/g,
  bodily: /손끝|손가락|손바닥|손을|손이|어깨|숨을|숨이|한숨|심장|가슴이|눈물|떨렸|떨리|떨었|입술|목이|목구멍|주먹|이를 악|침을 삼|식은땀|땀이|얼굴이 붉|고개를|무릎|발끝|등줄기|소름/g,
};
const cnt = (re, s) => (nl(s).match(re) || []).length;
const sentences = s => nl(s).split(/(?<=[.!?。…])\s+|\n+/).filter(x => x.trim());
const dialogs = s => (nl(s).match(/[“"「『][^”"」』\n]{1,300}[”"」』]/g) || []).length;
export function flagsOf(orig, rev) {
  const f = (k, a, b) => ({ k, a, b, d: b - a });
  const so = sentences(orig), sr = sentences(rev);
  const avg = ss => ss.length ? Math.round(ss.reduce((a, x) => a + [...x].length, 0) / ss.length) : 0;
  const words = (re, a, b) => { const A = new Set(nl(a).match(re) || []), B = new Set(nl(b).match(re) || []); return { added: [...B].filter(x => !A.has(x)), removed: [...A].filter(x => !B.has(x)) }; };
  return {
    rows: [f('글자 수', [...nl(orig).replace(/\s/g, '')].length, [...nl(rev).replace(/\s/g, '')].length), f('문장 수', so.length, sr.length), f('문장 평균 길이', avg(so), avg(sr)), f('대사', dialogs(orig), dialogs(rev)),
      f('감정 직접어', cnt(LEX.emotion, orig), cnt(LEX.emotion, rev)), f('감각어', cnt(LEX.sensory, orig), cnt(LEX.sensory, rev)), f('신체 반응어', cnt(LEX.bodily, orig), cnt(LEX.bodily, rev))],
    emotion: words(LEX.emotion, orig, rev), sensory: words(LEX.sensory, orig, rev), bodily: words(LEX.bodily, orig, rev),
  };
}
// 붙여넣은 ChatGPT 분석에서 칸 채우기 (있는 문장만 옮김, 지어내지 않음)
const FIELD_KW = {
  clarity: /명확|선명|초점|서술 ?(?:초점|시점|방향)|시점|정보(?:가| 전달)|모호|헷갈/,
  sensory: /감각|시각|청각|후각|촉각|미각|냄새|소리|색감|질감/,
  body: /신체|몸|행동|인과|반응|동작|제스처|움직임/,
  emotion: /감정(?:을|이)? ?(?:직접|설명|드러|명시|말하)|직접 ?(?:설명|서술)|tell|말하기|감정어/,
  inference: /추론|짐작|암시|여백|독자(?:가|는) ?(?:스스로|알아|느끼|추측)|함축|행간/,
  blur: /불필요|군더더기|산만|흐리|흐려|과하|장황|늘어|분산/,
  experience: /독서 ?경험|읽는 ?(?:경험|느낌|맛)|몰입|체감|여운|호흡|리듬|속도감|긴장감/,
};
export function prefillFromAnalysis(text) {
  const out = Object.fromEntries(FIELDS.map(([k]) => [k, []])); const intent = [], reading = [];
  const units = nl(text).split(/\n+/).flatMap(l => l.length > 160 ? l.split(/(?<=[.!?。])\s+/) : [l]).map(x => x.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim()).filter(x => x.length > 4 && !isHeading(x));
  for (const u of units) {
    if (/의도|노린|작가(?:는|가)|하려고 한|목표는/.test(u)) intent.push(u);
    if (/독자(?:는|가|에게|의)|읽는 ?사람|해석|받아들/.test(u)) reading.push(u);
    let hit = 0; for (const [k] of FIELDS) if (hit < 2 && FIELD_KW[k].test(u)) { out[k].push(u); hit++; }
  }
  const j = a => [...new Set(a)].slice(0, 6).join('\n');
  return { analysis: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, j(v)])), intent: j(intent), reading: j(reading) };
}

// ---------- 작법 교재 ----------
export const TOPICS = ['서술 초점', '감각 묘사', '신체·행동', '감정 표현', '독자 추론', '절제·삭제', '독서 경험', '대사', '문장 리듬'];
const TOPIC_OF = { clarity: '서술 초점', sensory: '감각 묘사', body: '신체·행동', emotion: '감정 표현', inference: '독자 추론', blur: '절제·삭제', experience: '독서 경험' };
export function lessonDraft(cmp, parts, { no = 1, workTitle = '', epLabel = '' } = {}) {
  const hs = hunksOf(parts).filter(h => (h.a + h.b).trim()).sort((x, y) => (y.a.length + y.b.length) - (x.a.length + x.b.length));
  const h = hs[0]; const an = cmp.analysis || {};
  const filled = FIELDS.filter(([k]) => (an[k] || '').trim()); const fl = flagsOf(cmp.original, cmp.revision);
  const topics = filled.map(([k]) => TOPIC_OF[k]);
  if (!topics.length) { const r = fl.rows; if (r[4].d) topics.push('감정 표현'); if (r[5].d) topics.push('감각 묘사'); if (r[6].d) topics.push('신체·행동'); if (r[0].d < 0) topics.push('절제·삭제'); }
  const ctx = (s, i, len) => s.slice(Math.max(0, i - 60), Math.min(s.length, i + len + 60));
  let excerpt = '', change = '';
  if (h) { let pos = 0; for (const p of parts) { if (p === h) break; pos += p.a.length; } excerpt = ctx(nl(cmp.original), pos, h.a.length).trim(); change = `${h.a.trim() || '(없음)'}  →  ${h.b.trim() || '(삭제)'}`; }
  const first = topics[0] || '고쳐 쓰기';
  return {
    no, title: `${first}: ${workTitle || '작품'}${epLabel ? ' ' + epLabel : ''}에서`,
    goal: `${first}${topics[1] ? '·' + topics[1] : ''}이(가) 문장에서 어떻게 달라지는지 직접 비교해 본다.`,
    excerpt: excerpt.slice(0, 600), change: change.slice(0, 600),
    effect: [an.experience, fl.rows.filter(r => r.d && r.k !== '문장 평균 길이').map(r => `${r.k} ${r.a} → ${r.b}`).join(' · ')].filter(Boolean).join('\n'),
    theory: filled.map(([k, l]) => `· ${l}: ${an[k]}`).join('\n'),
    alt: cmp.reading || '', final: [cmp.decision ? '선택: ' + DECISIONS[cmp.decision] : '', cmp.intent ? '의도: ' + cmp.intent : ''].filter(Boolean).join('\n'),
    tags: [...new Set(topics)],
  };
}
export const LESSON_FIELDS = [['goal', '학습 목표'], ['excerpt', '원문 발췌'], ['change', '변경 예시'], ['effect', '효과 비교'], ['theory', '작법 이론'], ['alt', '다른 해석 가능성'], ['final', '작가 최종 선택 · 메모']];
export function lessonToMarkdown(l, { workTitle = '', epLabel = '' } = {}) {
  const o = [`## ${l.no}. ${l.title || '(제목 없음)'}`, ''];
  if (workTitle || epLabel) o.push(`- 작품·회차: ${workTitle}${epLabel ? ' / ' + epLabel : ''}`);
  if (l.tags?.length) o.push(`- 주제: ${l.tags.map(t => '#' + t).join(' ')}`);
  o.push('');
  for (const [k, lab] of LESSON_FIELDS) if ((l[k] || '').trim()) o.push(`### ${lab}`, k === 'excerpt' ? l[k].split('\n').map(x => '> ' + x).join('\n') : l[k], '');
  return o.join('\n');
}
export function lessonToText(l, meta) { return lessonToMarkdown(l, meta).replace(/^#{2,3} /gm, '').replace(/^> /gm, '  ').replace(/^- /gm, '· '); }
export function lessonSearch(l, workTitle = '', epLabel = '') { return [l.no, l.title, workTitle, epLabel, ...(l.tags || []).map(t => '#' + t), ...LESSON_FIELDS.map(([k]) => l[k])].join(' ').toLowerCase(); }

// ---------- 동기화·백업용 ----------
export const AI_KEYS = ['kind', 'title', 'workId', 'episodeId', 'docType', 'stage', 'importedAt', 'source', 'fileName', 'raw', 'hash', 'segments', 'unsorted',
  'importId', 'original', 'revision', 'analysis', 'intent', 'reading', 'decision', 'hunkChoice', 'appliedAt', 'memo',
  'no', 'goal', 'excerpt', 'change', 'effect', 'theory', 'alt', 'final', 'compareId', 'tags', 'createdAt', 'updatedAt'];
export function aiContentOf(r) { const o = {}; for (const k of AI_KEYS) if (r[k] !== undefined) o[k] = r[k]; return o; }
export function aiContentKey(r) { const c = aiContentOf(r); delete c.updatedAt; return JSON.stringify(c, Object.keys(c).sort()) + JSON.stringify(c.segments || []) + JSON.stringify(c.analysis || {}) + JSON.stringify(c.hunkChoice || {}) + JSON.stringify(c.tags || []); }
// 백업 복원: 없는 건 넣고, 같은 건 건너뛰고, 다른 건 덮지 않고 사본으로
export function planRestore(local, incoming, newId) {
  const L = new Map(local.map(r => [r.id, r])); const add = []; let same = 0, copies = 0;
  for (const r of incoming || []) {
    if (!r || !r.id || !KINDS[r.kind]) continue;
    const l = L.get(r.id);
    if (!l) { add.push({ ...aiContentOf(r), id: r.id, dirty: true, base: '' }); continue; }
    if (aiContentKey(l) === aiContentKey(r)) { same++; continue; }
    add.push({ ...aiContentOf(r), id: newId(), title: (r.title || '') + ' (백업 버전)', conflictOf: r.id, dirty: true, base: '', updatedAt: Date.now() }); copies++;
  }
  return { add, same, copies };
}
// ZIP(저장 방식/압축 없음)에서 파일 하나 꺼내기 — 우리 백업 ZIP 은 압축하지 않음
export function readStoredZip(u8, want) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const dec = new TextDecoder();
  let eocd = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const n = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true), fl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lo = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + fl));
    if (want(name)) { if (method !== 0) return { name, error: 'compressed' }; const lfl = dv.getUint16(lo + 26, true), lel = dv.getUint16(lo + 28, true); const st = lo + 30 + lfl + lel; return { name, text: dec.decode(u8.subarray(st, st + csize)) }; }
    off += 46 + fl + el + cl;
  }
  return null;
}
