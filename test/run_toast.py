# 알림(토스트) 배치 + 시작 화면 위 재연결 안내: python3 test/run_toast.py URL
import sys, re
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8797/'
SH = '/workspace/yeonwol-note/shots/toast_'
results = []
def check(n, ok, info=''): results.append(ok); print(('PASS' if ok else 'FAIL'), n, f'[{info}]' if info and not ok else '')
FAIL_GIS = "()=>{google.accounts.oauth2.initTokenClient=cfg=>({requestAccessToken(){setTimeout(()=>cfg.error_callback({type:'popup_failed_to_open'}),20)}})}"
def kv(pg, k, v=None):
    if v is None: return pg.evaluate("""async(k)=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('kv').objectStore('kv').get(k);await new Promise(x=>t.onsuccess=x);return t.result}""", k)
    pg.evaluate("""async([k,v])=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('kv','readwrite');t.objectStore('kv').put(v,k);await new Promise(x=>t.oncomplete=x)}""", [k, v])
def box(pg):
    return pg.evaluate("""()=>{const t=document.querySelector('#toast'),s=t.querySelector(':scope>span'),a=t.querySelector('.t-act'),r=t.getBoundingClientRect(),sr=s.getBoundingClientRect(),lh=parseFloat(getComputedStyle(s).lineHeight);
      return {w:r.width,l:r.left,r:r.right,sw:sr.width,lines:Math.round(sr.height/lh),btn:a?a.getBoundingClientRect().width:0,btnTop:a?a.getBoundingClientRect().top:0,spanTop:sr.top}}""")
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    for w, h in ((360, 800), (412, 915)):
        d = FakeDrive(); errs = []
        c = b.new_context(viewport={'width': w, 'height': h}, is_mobile=True, has_touch=True, device_scale_factor=2, locale='ko-KR')
        c.add_init_script("window.__YW_NO_SW=true; if(localStorage.getItem('__wantSplash')) sessionStorage.removeItem('jpsSplash'); else sessionStorage.setItem('jpsSplash','1');")
        c.route('https://www.googleapis.com/**', d.handle)
        c.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body=GIS_STUB))
        pg = c.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(URL); pg.wait_for_selector('html.ready')
        pg.click('#tabs [data-tab="note"]'); pg.click('#btnSettings'); pg.fill('#setCid', '123456789-testclient.apps.googleusercontent.com'); pg.click('#setConnect')
        pg.wait_for_function("()=>!document.querySelector('#dlg').open", timeout=10000); pg.wait_for_timeout(1500)
        tok = kv(pg, 'driveToken'); tok['exp'] = pg.evaluate('Date.now()') - 1000; kv(pg, 'driveToken', tok)
        pg.evaluate("localStorage.setItem('__wantSplash','1')"); pg.reload(); pg.wait_for_selector('#splash:not([hidden])')
        pg.wait_for_function("()=>window.google&&window.google.accounts", timeout=10000); pg.evaluate(FAIL_GIS); pg.wait_for_timeout(1500)
        pg.tap('#splash', position={'x': 30, 'y': 300}); pg.wait_for_timeout(1200)
        check(f'[{w}] 시작 화면 위에는 재연결 알림 안 뜸', not pg.is_visible('#toast') or '다시 연결' not in pg.inner_text('#toast'))
        pg.screenshot(path=SH + f'{w}_splash.png')
        pg.evaluate("localStorage.removeItem('__wantSplash')")
        pg.tap('#btnStart'); pg.wait_for_timeout(1200)
        vis = pg.is_visible('#toast') and '다시 연결' in pg.inner_text('#toast')
        check(f'[{w}] 들어가면 바로 재연결 알림', vis)
        if vis:
            bx = box(pg)
            check(f'[{w}] 알림 폭 ≈ 화면 폭 (좌우 16px)', abs(bx['w'] - min(420, w - 32)) < 2 and bx['l'] >= 15 and bx['r'] <= w - 15, bx)
            check(f'[{w}] 글이 세로로 꺾이지 않음 (글 폭 ≥ 200, ≤ 4줄)', bx['sw'] >= 200 and bx['lines'] <= 4, bx)
            check(f'[{w}] 버튼은 글 아래 줄 · 안 잘림', bx['btnTop'] > bx['spanTop'] and bx['btn'] >= 60, bx)
            pg.screenshot(path=SH + f'{w}_nag.png')
        # 짧은 알림(버튼 없음)은 작게
        pg.evaluate("()=>{const t=document.querySelector('#toast');t.querySelector('.t-act')?.remove();t.querySelector(':scope>span').textContent='저장했어요'}"); pg.wait_for_timeout(100)
        bw = pg.evaluate("document.querySelector('#toast').getBoundingClientRect().width")
        check(f'[{w}] 짧은 알림은 화면 가득 안 채움 ({bw:.0f}px)', bw < w - 40)
        check(f'[{w}] JS 오류 없음', not errs, errs[:2])
        c.close()
    # 되돌리기 버튼 알림 (찾기·바꾸기 / 수정본 반영 흐름)
    c = b.new_context(viewport={'width': 360, 'height': 800}, is_mobile=True, has_touch=True, device_scale_factor=2, locale='ko-KR')
    c.add_init_script("window.__YW_NO_SW=true; sessionStorage.setItem('jpsSplash','1');")
    pg = c.new_page(); pg.goto(URL); pg.wait_for_selector('html.ready')
    pg.click('#tabs [data-tab="note"]'); pg.click('#btnNewWork'); pg.fill('#askIn', '알림작'); pg.click('#dlg button[value="ok"]'); pg.wait_for_selector('#editorView:not([hidden])')
    pg.fill('#editor', '첫 문장입니다.'); pg.wait_for_timeout(1500)
    pg.click('#btnRevise'); pg.fill('#rvText', '덧붙인 수정본 문장입니다.'); pg.click('#dlg button[value="ok"]'); pg.wait_for_timeout(600)
    ok = pg.is_visible('#toast .t-act')
    bx = box(pg) if ok else {}
    check('[360] 되돌리기 알림: 버튼 보이고 글 안 꺾임', ok and bx['sw'] >= 200 and bx['lines'] <= 3 and bx['r'] <= 345, bx)
    pg.screenshot(path=SH + '360_undo.png'); c.close(); b.close()
print(f'==== {sum(results)}/{len(results)} passed ====')
