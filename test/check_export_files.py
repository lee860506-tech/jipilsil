# 내보낸 파일(MD·HWPX·PDF)이 실제 원고와 같은지 따로 열어 확인해요. run_export.py 가 호출해요.
# 사용: python check_export_files.py spec.json  → 결과 JSON을 출력
import sys, json, re, zipfile, subprocess, warnings
warnings.filterwarnings('ignore')
spec = json.load(open(sys.argv[1], encoding='utf-8')); out = []
def ck(name, ok, info=''): out.append([name, bool(ok), str(info)[:300]])
WS = re.compile(r'\s+')
def ns(s): return WS.sub('', s)

def md_unescape(line):  # 한 번에 훑어서 (&nbsp; &lt; &amp; &#126; 와 \기호 를 원래대로)
    ent = {'&nbsp;': ' ', '&lt;': '<', '&amp;': '&', '&#126;': '~'}
    return re.sub(r'&nbsp;|&lt;|&amp;|&#126;|\\([\\`*_#>+\-=.)\[\]])', lambda m: ent.get(m.group(0)) or m.group(1), line)
def check_md(path, title, eps, label):
    t = open(path, encoding='utf-8').read()
    assert '\r' not in t
    lines = t.split('\n'); body = {}; cur = None; heads = []
    for l in lines:
        m = re.match(r'^(#{1,2}) (.*)$', l)
        if m: heads.append((len(m.group(1)), md_unescape(m.group(2)))); cur = m.group(2) if len(m.group(1)) == (2 if title else 1) else cur; body[cur] = []; continue
        if cur is not None: body[cur].append(l)
    ok = True; info = ''
    exp_heads = ([(1, title)] if title else []) + [(2 if title else 1, e['heading']) for e in eps]
    if heads != exp_heads: ok = False; info = f'머리글 {heads[:4]} != {exp_heads[:4]}'
    for e in eps:
        key = [k for k in body if k is not None and md_unescape(k) == e['heading']]
        got = [md_unescape(re.sub(r'  $', '', l)) for l in body[key[0]]] if key else None
        while got and got[0] == '': got = got[1:]
        while got and got[-1] == '': got = got[:-1]
        exp = e['text'].replace('\t', '    ').split('\n')
        while exp and exp[-1] == '': exp = exp[:-1]
        if got != exp: ok = False; info = f'본문 불일치 {e["heading"]}: {(got or [""])[:3]} vs {exp[:3]}'; break
    ck(f'{label} MD 내용 = 원고(기호 가림 풀면 동일)', ok, info)
    try:
        import markdown
        html = markdown.markdown(t)
        nh = len(re.findall(r'<h[1-6][ >]', html)); ck(f'{label} MD를 마크다운으로 읽어도 머리글은 제목+회차뿐 (본문 #·*·1. 가 서식으로 안 바뀜)', nh == len(exp_heads), f'{nh} vs {len(exp_heads)}')
        ck(f'{label} MD 본문 목록/강조/태그로 오인 없음', not re.search(r'<(ul|ol|em|strong|blockquote|script|b)[ >]', html), re.findall(r'<(?:ul|ol|em|strong|blockquote)[ >]', html)[:3])
    except ImportError: pass

def check_hwpx(path, title, eps, label):
    z = zipfile.ZipFile(path); names = z.namelist()
    ck(f'{label} HWPX 압축 규칙 (mimetype 첫 파일·무압축)', names[0] == 'mimetype' and z.infolist()[0].compress_type == 0 and z.read('mimetype') == b'application/hwp+zip' and z.testzip() is None, names[:3])
    from lxml import etree
    for n in names:
        if n.endswith(('.xml', '.hpf', '.rdf')): etree.fromstring(z.read(n))
    ck(f'{label} HWPX XML 모두 올바름 + 필수 파일', all(x in names for x in ['version.xml', 'Contents/header.xml', 'Contents/section0.xml', 'Contents/content.hpf', 'META-INF/container.xml']))
    from hwpx import HwpxDocument
    d = HwpxDocument.open(path); ps = [p.text for p in d.paragraphs]
    exp = ([title] if title else [])
    for e in eps:
        exp.append(e['heading']); t = e['text'].split('\n'); exp += t
    ck(f'{label} HWPX 문단 = 제목+회차+원고 줄 그대로', ps == [re.sub(r'\t', '    ', x) for x in exp], f'{len(ps)} vs {len(exp)}; {[ (a,b) for a,b in zip(ps,exp) if a!=b][:2]}')
    for mod in ('package_validator', 'validator', 'id_integrity'):
        try:
            r = subprocess.run([sys.executable, '-m', f'hwpx.tools.{mod}', path], capture_output=True, text=True, timeout=120)
            ck(f'{label} HWPX 검사도구 {mod} 통과', r.returncode == 0 and 'fail' not in r.stdout.lower().replace('0 fail', '') and 'error' not in r.stdout.lower(), (r.stdout + r.stderr)[-200:])
        except Exception as ex: ck(f'{label} HWPX 검사 {mod}', False, ex)
    ck(f'{label} HWPX 쪽 설정 A4', b'width="59528" height="84186"' in z.read('Contents/section0.xml'))

def check_pdf(path, title, eps, label, strip_re=None, sizes=None):
    import fitz
    d = fitz.open(path)
    ck(f'{label} PDF 열림 · A4 · 쪽수', d.is_pdf and not d.needs_pass and len(d) >= 1 and abs(d[0].rect.width - 595.28) < 1 and abs(d[0].rect.height - 841.89) < 1, f'{len(d)}쪽 {d[0].rect}')
    if sizes: ck(f'{label} PDF 쪽수 범위', sizes[0] <= len(d) <= sizes[1], len(d))
    fonts = d.get_page_fonts(0) if len(d) else []
    ck(f'{label} PDF 글꼴이 파일 안에 포함(서브셋)', bool(fonts) and all(f[1] != 'n/a' for f in fonts) and 'Jipilsil' in fonts[0][3], fonts[:1])
    txt = ''.join(p.get_text('text', clip=fitz.Rect(0, 0, 595.28, 782)) for p in d)
    full = ns(txt)
    ok = True; info = ''
    pos = 0
    allp = ([title] if title else [])
    for e in eps:
        for s in [e['heading'], e['text']]:
            w = ns(re.sub(strip_re, '', s) if strip_re else s)
            i = full.find(w[:2000], pos) if len(w) > 2000 else full.find(w, pos)
            if w and i < 0: ok = False; info = f'못 찾음: {w[:40]}'; break
            if len(w) > 2000:  # 긴 글은 전체를 이어 붙여 비교
                if full[i:i + len(w)] != w: ok = False; info = f'긴 글 불일치 {e["heading"]}'; break
            pos = i + len(w)
        if not ok: break
    ck(f'{label} PDF 글자(복사 가능한 글) = 원고 순서대로 전부', ok, info)
    if title: ck(f'{label} PDF 표지에 작품 제목', title in d[0].get_text())
    toc = d.get_toc()
    if len(eps) > 1: ck(f'{label} PDF 책갈피(회차) {len(eps)}개', [t[1] for t in toc] == [e['heading'] for e in eps], toc[:3])
    ck(f'{label} PDF 메타 제목', (d.metadata.get('title') or '') == (title or eps[0]['heading']), d.metadata.get('title'))
    r = subprocess.run(['pdftotext', path, '-'], capture_output=True, text=True)
    ck(f'{label} PDF pdftotext(poppler)로도 한글이 나옴', r.returncode == 0 and ns(eps[0]['heading']) in ns(r.stdout), r.stderr[-120:])
    r = subprocess.run(['pdffonts', path], capture_output=True, text=True)
    ck(f'{label} PDF pdffonts: emb yes / sub yes / uni yes', re.search(r'CID TrueType\s+Identity-H\s+yes\s+yes\s+yes', r.stdout) is not None, r.stdout[-200:])

for job in spec['jobs']:
    try:
        k = job['kind']
        if k == 'md': check_md(job['path'], job['title'], job['eps'], job['label'])
        if k == 'hwpx': check_hwpx(job['path'], job['title'], job['eps'], job['label'])
        if k == 'pdf': check_pdf(job['path'], job['title'], job['eps'], job['label'], job.get('strip'), job.get('sizes'))
    except Exception as ex:
        import traceback; ck(f'{job["label"]} {job["kind"]} 검사 실행', False, traceback.format_exc()[-300:])
print(json.dumps(out, ensure_ascii=False))
