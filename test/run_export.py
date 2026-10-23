# 집필실: 내보내기(TXT·MD·한글 HWPX·PDF·DOCX·ZIP) — 이 회차 / 작품 전체, 파일 내용이 원고와 같은지, 360x800 + PC
import sys, re, json, os, subprocess, shutil
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8803/'
SHOTS = '/workspace/yeonwol-note/shots/export_'
HERE = __file__.rsplit('/', 1)[0]
PY = '/tmp/hv/bin/python' if os.path.exists('/tmp/hv/bin/python') else sys.executable
results = []
def check(name, ok, info=''):
    results.append((name, bool(ok), str(info))); print(('PASS' if ok else 'FAIL'), name, f'[{info}]' if info and not ok else '')

def ctx(b, mobile, drive, sw=False):
    vp = {'width': 360, 'height': 800} if mobile else {'width': 1440, 'height': 900}
    c = b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1, locale='ko-KR', accept_downloads=True,
                      permissions=['clipboard-read', 'clipboard-write'])
    c.add_init_script(("" if sw else "window.__YW_NO_SW = true; ") + "sessionStorage.setItem('jpsSplash','1');")
    c.route('https://www.googleapis.com/**', drive.handle)
    c.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body=GIS_STUB))
    pg = c.new_page(); pg._errs = []
    pg.on('pageerror', lambda e: pg._errs.append('PE ' + str(e)))
    pg.on('console', lambda m: m.type == 'error' and not re.search(r'favicon|ERR_INTERNET_DISCONNECTED|net::ERR|status of 500|Failed to load resource', m.text) and pg._errs.append('C ' + m.text))
    return c, pg
def dlg_ok(pg, v='ok'): pg.click(f'#dlg button[value="{v}"]')
def tab(pg, t): pg.click(f'#tabs [data-tab="{t}"]'); pg.wait_for_timeout(250)
def wait_saved(pg): pg.wait_for_function("()=>!window.__yw.pending && !window.__yw.saving", timeout=8000); pg.wait_for_timeout(150)
def list_view(pg):
    if pg.is_visible('#btnBack'): pg.click('#btnBack'); pg.wait_for_timeout(300)
def eps_db(pg):
    return pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('episodes').objectStore('episodes').getAll();await new Promise(x=>t.onsuccess=x);return t.result.sort((a,b)=>(a.order??0)-(b.order??0)||a.createdAt-b.createdAt).map(e=>({title:e.title,text:e.text,label:e.label||''}))}""")

EP1 = ('  첫 문장은 들여쓰기로 시작합니다. "따옴표," 그가 말했다. (괄호) — 그리고 ‘작은따옴표’.\n'
       '# 샵으로 시작하는 줄\n* 별표로 시작하는 줄 *강조처럼* 보이는 말\n- 하이픈 줄\n1. 숫자 점 줄\n2) 숫자 괄호 줄\n> 인용처럼 보이는 줄\n'
       '밑줄_이_많은_줄 __굵게__ `코드` <b>태그</b> & 앰퍼샌드 &amp; 엔티티 [링크](http://x.y) ~~취소선~~ 역슬래시 \\ 끝\n'
       '\t탭으로 들여쓴 줄\n\n\n세 번 띄운 뒤 문단.\n---\n===\n한글 자모 ㅋㅋㅋ ㅠㅠ 한자 漢字 日本語 English 123 !?…\n'
       + '\n'.join(('가나다라마바사 ' * 8 + f'{i}번째 줄입니다. 긴 줄은 알아서 줄바꿈이 돼야 해요. ' * 3).strip() for i in range(60)))
EP2 = '둘째 글입니다.\n이모지 😀 와 ☺ 는 글꼴에 없어요.\n마지막 줄.'

def run(b, tag, mob):
    print('=====', '360x800' if mob else 'PC 1440')
    DL = f'/tmp/dl_export/{tag}/'; shutil.rmtree(DL, ignore_errors=True); os.makedirs(DL)
    c, A = ctx(b, mob, FakeDrive())
    A.goto(URL); A.wait_for_selector('html.ready')
    tab(A, 'note'); A.click('#btnNewWork'); A.fill('#askIn', '시험 소설'); dlg_ok(A); A.wait_for_selector('#editorView:not([hidden])')
    A.fill('#epTitle', '첫 *제목*'); A.keyboard.press('Tab')
    A.fill('#editor', EP1); A.dispatch_event('#editor', 'input'); wait_saved(A)
    list_view(A); tab(A, 'note'); cur0 = A.evaluate('window.__yw.cur'); A.locator('.work [data-act="addep"]').first.click(); A.wait_for_function('c=>window.__yw.cur&&window.__yw.cur!==c', arg=cur0); A.wait_for_timeout(600)
    A.fill('#editor', EP2); A.dispatch_event('#editor', 'input'); wait_saved(A)
    eps = eps_db(A)
    check(f'[{tag}] 원고 준비 (2회차)', len(eps) == 2 and eps[0]['text'] == EP1.replace('\r', '') and eps[1]['text'] == EP2, [len(e['text']) for e in eps])
    secs = [{'heading': f'{i + 1:02d}화' + (' ' + e['title'] if e['title'] else ''), 'text': e['text']} for i, e in enumerate(eps)]
    TITLE = '시험 소설'
    jobs = []
    def get(scope, fmt, name_hint=None, menu=False):
        if not menu: A.click('#btnExport')
        A.wait_for_selector('#dlg[open]')
        if scope: A.click(f'#dlg [data-scope="{scope}"]')
        A.click(f'#dlg [data-fmt="{fmt}"]')
        with A.expect_download(timeout=60000) as d: dlg_ok(A, 'go')
        f = DL + f'{scope or "menu"}_{fmt}_' + d.value.suggested_filename; d.value.save_as(f)
        return f, d.value.suggested_filename

    # ---- 대화상자 모양 ----
    A.click('#btnExport'); A.wait_for_selector('#dlg[open]')
    chips = A.eval_on_selector_all('#dlg .chip', 'es=>es.map(e=>[e.dataset.scope||e.dataset.fmt, e.classList.contains("on"), !e.hidden, e.textContent.trim()])')
    check(f'[{tag}] 내보내기 한 곳: 범위 2개 + 형식 6개', [c_[0] for c_ in chips] == ['ep', 'work', 'txt', 'md', 'hwpx', 'pdf', 'docx', 'zip'], chips)
    check(f'[{tag}] 기본은 「이 회차」+ TXT, 이 회차에는 ZIP 숨김', chips[0][1] and chips[2][1] and not chips[7][2], chips)
    A.screenshot(path=f'{SHOTS}{tag}_1dialog.png')
    A.click('#dlg [data-scope="work"]'); A.click('#dlg [data-fmt="pdf"]'); A.wait_for_timeout(100)
    check(f'[{tag}] 작품 전체를 고르면 ZIP이 보임 + PDF 안내', A.is_visible('#dlg [data-fmt="zip"]') and '글꼴' in A.inner_text('#expHint'), A.inner_text('#expHint'))
    A.screenshot(path=f'{SHOTS}{tag}_2dialog_pdf.png')
    dlg_ok(A, 'cancel'); A.wait_for_timeout(200)

    # ---- 이 회차 (현재 = 2회차) ----
    cur = secs[1]
    f, nm = get('ep', 'txt'); t = open(f, encoding='utf-8-sig', newline='').read()
    check(f'[{tag}] 이 회차 TXT = 원고 그대로 ({nm})', t.replace('\r\n', '\n') == EP2 and '\r\n' in t and nm == '시험 소설 02화.txt', nm)
    f, nm = get('ep', 'md'); jobs.append({'kind': 'md', 'path': f, 'title': '', 'eps': [cur], 'label': f'[{tag}] 이 회차'}); md_ep = f
    f, nm = get('ep', 'hwpx'); jobs.append({'kind': 'hwpx', 'path': f, 'title': '', 'eps': [cur], 'label': f'[{tag}] 이 회차'}); check(f'[{tag}] 한글 파일 이름 .hwpx', nm == '시험 소설 02화.hwpx', nm)
    f, nm = get('ep', 'pdf'); jobs.append({'kind': 'pdf', 'path': f, 'title': '', 'eps': [cur], 'label': f'[{tag}] 이 회차', 'strip': '[\U0001F300-\U0001FAFF\u2600-\u27BF\u4E00-\u9FFF\u3040-\u30FF]'}); check(f'[{tag}] PDF 파일 이름', nm == '시험 소설 02화.pdf', nm)
    toast = A.inner_text('#toast')
    check(f'[{tag}] 글꼴에 없는 글자(이모지) 안내', '빠졌' in toast, toast)
    A.screenshot(path=f'{SHOTS}{tag}_3toast.png')
    f, nm = get('ep', 'docx'); import docx as pydocx; ps = [x.text for x in pydocx.Document(f).paragraphs]
    check(f'[{tag}] 이 회차 DOCX 그대로', ps[0] == '02화' and ps[1:4] == ['둘째 글입니다.', '이모지 😀 와 ☺ 는 글꼴에 없어요.', '마지막 줄.'], ps[:4])
    # 마지막으로 고른 값 기억
    A.click('#btnExport'); A.wait_for_selector('#dlg[open]'); on = A.eval_on_selector_all('#dlg .chip.on', 'es=>es.map(e=>e.dataset.scope||e.dataset.fmt)'); dlg_ok(A, 'cancel')
    check(f'[{tag}] 마지막으로 고른 범위·형식을 기억', on == ['ep', 'docx'], on)

    # ---- 작품 전체 (편집기에서) ----
    f, nm = get('work', 'txt'); t = open(f, encoding='utf-8-sig', newline='').read().replace('\r\n', '\n')
    exp = TITLE + '\n\n' + '\n\n\n'.join(f'[{s["heading"]}]\n\n{s["text"]}' for s in secs)
    check(f'[{tag}] 작품 전체 TXT = 제목 + 회차별 원고 그대로 ({nm})', t == exp and nm == '시험 소설 전체.txt', (nm, len(t), len(exp)))
    f, nm = get('work', 'md'); jobs.append({'kind': 'md', 'path': f, 'title': TITLE, 'eps': secs, 'label': f'[{tag}] 작품 전체'})
    f, nm = get('work', 'hwpx'); jobs.append({'kind': 'hwpx', 'path': f, 'title': TITLE, 'eps': secs, 'label': f'[{tag}] 작품 전체'})
    f, nm = get('work', 'pdf'); jobs.append({'kind': 'pdf', 'path': f, 'title': TITLE, 'eps': secs, 'label': f'[{tag}] 작품 전체', 'strip': '[\U0001F300-\U0001FAFF\u2600-\u27BF\u4E00-\u9FFF\u3040-\u30FF]', 'sizes': (6, 12)})
    f, nm = get('work', 'docx'); ps = [x.text for x in pydocx.Document(f).paragraphs]
    check(f'[{tag}] 작품 전체 DOCX', ps[0] == '01화 첫 *제목*' and '02화' in ps, ps[:2])
    f, nm = get('work', 'zip'); import zipfile; z = zipfile.ZipFile(f)
    check(f'[{tag}] 작품 전체 ZIP (그대로 유지)', z.testzip() is None and any(n.endswith('01화 첫 제목.txt') or '01화' in n for n in z.namelist()) and any(n.endswith('.docx') for n in z.namelist()), z.namelist())

    # ---- 작품 메뉴에서 ----
    list_view(A); tab(A, 'note')
    A.locator('.work [data-act="workmenu"]').first.click(); A.wait_for_selector('#dlg[open]')
    btns = A.eval_on_selector_all('#dlg .dlg-btns button', 'es=>es.map(e=>e.value)')
    check(f'[{tag}] 작품 메뉴: 내보내기 한 개로 합쳐짐 (ZIP·DOCX 따로 없음)', 'export' in btns and 'zip' not in btns and 'docx' not in btns, btns)
    A.click('#dlg button[value="export"]'); A.wait_for_selector('#dlg [data-fmt]')
    check(f'[{tag}] 작품 메뉴에서 연 내보내기는 작품 전체 전용(범위 칩 없음)', A.locator('#dlg [data-scope]').count() == 0 and A.is_visible('#dlg [data-fmt="zip"]'))
    A.screenshot(path=f'{SHOTS}{tag}_4workmenu_dialog.png')
    f, nm = get(None, 'hwpx', menu=True); jobs.append({'kind': 'hwpx', 'path': f, 'title': TITLE, 'eps': secs, 'label': f'[{tag}] 작품 메뉴'})

    # ---- 파일 내용 검사 (원고와 대조) ----
    json.dump({'jobs': jobs}, open(DL + 'spec.json', 'w', encoding='utf-8'), ensure_ascii=False)
    r = subprocess.run([PY, HERE + '/check_export_files.py', DL + 'spec.json'], capture_output=True, text=True, timeout=600)
    try: res = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception: res = [['파일 검사 실행', False, r.stdout[-300:] + r.stderr[-300:]]]
    for n, ok, info in res: check(n, ok, info)
    check(f'[{tag}] 원고는 내보낸 뒤에도 그대로', [e['text'] for e in eps_db(A)] == [EP1, EP2])
    check(f'[{tag}] JS 오류 없음', not A._errs, A._errs)
    c.close()

def offline(b):
    print('===== 오프라인(서비스 워커) PDF')
    c, A = ctx(b, False, FakeDrive(), sw=True)
    A.goto(URL); A.wait_for_selector('html.ready')
    A.evaluate("()=>navigator.serviceWorker.ready.then(()=>1)"); A.reload(); A.wait_for_selector('html.ready')
    A.wait_for_function("async()=>!!(await caches.keys()).length && !!(await caches.match('img/jipilsil-serif.ttf.gz'))", timeout=30000)
    tab(A, 'note'); A.click('#btnNewWork'); A.fill('#askIn', '오프라인 소설'); dlg_ok(A); A.wait_for_selector('#editorView:not([hidden])')
    A.fill('#editor', '인터넷이 없어도 PDF가 만들어져요.\n두 번째 줄.'); A.dispatch_event('#editor', 'input'); wait_saved(A)
    c.set_offline(True)
    A.click('#btnExport'); A.click('#dlg [data-scope="ep"]'); A.click('#dlg [data-fmt="pdf"]')
    with A.expect_download(timeout=60000) as d: dlg_ok(A, 'go')
    f = '/tmp/dl_export/offline.pdf'; d.value.save_as(f)
    t = subprocess.run(['pdftotext', f, '-'], capture_output=True, text=True).stdout
    check('오프라인에서도 PDF 저장 (글꼴이 기기에 저장돼 있음)', '인터넷이없어도PDF가만들어져요.' in re.sub(r'\s+', '', t), t[:80])
    check('오프라인 PDF 중 JS 오류 없음', not A._errs, A._errs)
    c.close()

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    for tag, mob in (('m', True), ('pc', False)): run(b, tag, mob)
    offline(b)
    b.close()
bad = [r for r in results if not r[1]]
print(f'\n{len(results)-len(bad)}/{len(results)} 통과')
for n, ok, i in bad: print('FAIL', n, i)
sys.exit(1 if bad else 0)
