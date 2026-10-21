# 집필실 v3: 구글 문서 줄바꿈 왕복·가짜 충돌·배너 중복 방지
#: PC ↔ 폰 (같은 가짜 드라이브), 충돌, 복사, 수정본 반영, 키보드, 위치 기억
import sys, re, json
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8793/'
SHOTS = '/workspace/yeonwol-note/shots/find_'
results = []
def check(name, ok, info=''):
    results.append((name, bool(ok), str(info))); print(('PASS' if ok else 'FAIL'), name, f'[{info}]' if info and not ok else '')

FAKE_VV = """
(()=>{ // 키보드 흉내: visualViewport 를 조절 가능한 가짜로
  const t = new EventTarget(); let h = null, top = 0;
  const vv = { get width(){return innerWidth}, get height(){return h ?? innerHeight}, get offsetTop(){return top}, offsetLeft:0, pageTop:0, pageLeft:0, scale:1,
    addEventListener:(...a)=>t.addEventListener(...a), removeEventListener:(...a)=>t.removeEventListener(...a), dispatchEvent:e=>t.dispatchEvent(e) };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  window.__vv = { set(nh, nt=0){ h = nh; top = nt; t.dispatchEvent(new Event('resize')); } };
})();
"""
def ctx(b, mobile, drive, fake_vv=False):
    vp = {'width': 360, 'height': 800} if mobile else {'width': 1440, 'height': 900}
    c = b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1, locale='ko-KR',
                      permissions=['clipboard-read', 'clipboard-write'])
    c.add_init_script("window.__YW_NO_SW = true; sessionStorage.setItem('jpsSplash','1');")
    if fake_vv: c.add_init_script(FAKE_VV)
    c.route('https://www.googleapis.com/**', drive.handle)
    c.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body=GIS_STUB))
    pg = c.new_page(); pg._errs = []
    pg.on('pageerror', lambda e: pg._errs.append('PE ' + str(e)))
    pg.on('console', lambda m: m.type == 'error' and not re.search(r'favicon|ERR_INTERNET_DISCONNECTED|net::ERR|status of 500', m.text) and pg._errs.append('C ' + m.text))
    return c, pg
def dlg_ok(pg, v='ok'): pg.click(f'#dlg button[value="{v}"]')
def tab(pg, t): pg.click(f'#tabs [data-tab="{t}"]'); pg.wait_for_timeout(250)
def ed_val(pg): return pg.eval_on_selector('#editor', 'e=>e.value')
def wait_saved(pg): pg.wait_for_function("()=>!window.__yw.pending && !window.__yw.saving", timeout=8000); pg.wait_for_timeout(150)
def type_end(pg, s):
    pg.focus('#editor'); pg.evaluate("()=>{const e=document.querySelector('#editor');e.setSelectionRange(e.value.length,e.value.length)}"); pg.keyboard.type(s)
def wait_sync(pg):
    pg.wait_for_timeout(300); pg.wait_for_function("()=>window.__yw.syncState!=='syncing'", timeout=15000); pg.wait_for_timeout(400)
def sync(pg): pg.evaluate("()=>document.querySelector('#btnSyncNow')?.click()"); wait_sync(pg)
def connect(pg):
    if pg.is_visible('#btnBack'): pg.click('#btnBack')
    if not pg.is_visible('#btnSettings'): tab(pg, 'note')
    pg.click('#btnSettings'); pg.fill('#setCid', '123456789-testclient.apps.googleusercontent.com'); pg.click('#setConnect')
    pg.wait_for_function("()=>!document.querySelector('#dlg').open", timeout=10000); wait_sync(pg)
def refocus(pg):  # 다른 앱/창에서 돌아옴
    pg.evaluate("()=>{window.dispatchEvent(new Event('focus'))}"); wait_sync(pg)
def open_ep(pg, work, idx=0):
    if pg.is_visible('#btnBack'): pg.click('#btnBack'); pg.wait_for_timeout(200)
    if pg.evaluate("window.__yw.tab") != 'note': tab(pg, 'note')
    w = pg.locator('.work', has_text=work)
    if 'open' not in (w.get_attribute('class') or ''): w.locator('[data-act="toggle"]').click()
    w.locator('.ep [data-act="open"]').nth(idx).click(); pg.wait_for_selector('#editorView:not([hidden])'); pg.wait_for_timeout(300)
def versions(pg, reason=None):
    return pg.evaluate("""async(r)=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;
      const t=d.transaction('versions').objectStore('versions').getAll();await new Promise(x=>t.onsuccess=x);return t.result.filter(v=>!r||v.reason===r).map(v=>v.text)}""", reason)


def ep_rec(pg):
    return pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;
      const t=d.transaction('episodes').objectStore('episodes').get(window.__yw.cur);await new Promise(x=>t.onsuccess=x);return t.result}""")
def storm(pg):  # focus·visibility·온라인·타이머가 한꺼번에
    pg.evaluate("""()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));document.querySelector('#btnSyncNow')?.click()}""")
    pg.wait_for_timeout(500); wait_sync(pg); pg.wait_for_timeout(600); wait_sync(pg)



def ep_texts(pg):
    return pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;
      const t=d.transaction('episodes').objectStore('episodes').getAll();await new Promise(x=>t.onsuccess=x);return Object.fromEntries(t.result.map(e=>[e.title||e.id,[e.text,e.dirty]]))}""")
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    drive = FakeDrive()
    for mobile in (False, True):
        tag = 'mobile' if mobile else 'desktop'
        c, pg = ctx(b, mobile, drive)
        pg.goto(URL); pg.wait_for_selector('html.ready')
        if not mobile: connect(pg)
        tab(pg, 'note')
        if mobile and pg.is_visible('#btnBack'): pg.click('#btnBack')
        pg.click('#btnNewWork'); pg.fill('#askIn', '찾기작'); dlg_ok(pg); pg.wait_for_selector('#editorView:not([hidden])')
        T1 = '\n'.join(f'{i}. 시안은 Rain 속에서 웃었다. rain 이 그쳤다.' for i in range(80))
        pg.evaluate("t=>{const e=document.querySelector('#editor');e.value=t;e.dispatchEvent(new Event('input'))}", T1); pg.fill('#epTitle', '첫화'); wait_saved(pg)
        # 1) 회차 안 찾기
        pg.click('#btnFind'); pg.wait_for_selector('#findBar:not([hidden])'); pg.fill('#fQ', 'rain'); pg.wait_for_timeout(300)
        check(f'[{tag}] 찾기: 개수 (대소문자 무시)', pg.inner_text('#fCount').endswith('/160'), pg.inner_text('#fCount'))
        check(f'[{tag}] 하이라이트 표시', pg.locator('.hl-layer mark').count() == 160)
        pg.click('#fCase'); pg.wait_for_timeout(200)
        check(f'[{tag}] 대소문자 구분', pg.inner_text('#fCount').endswith('/80'), pg.inner_text('#fCount'))
        for _ in range(40): pg.click('#fNext')
        st = pg.evaluate("()=>{const e=document.querySelector('#editor');return [e.selectionStart,e.scrollTop,e.value.slice(e.selectionStart,e.selectionEnd)]}")
        check(f'[{tag}] 다음으로 이동 + 스크롤', st[2] == 'rain' and st[1] > 300, st)
        idx = pg.inner_text('#fCount'); pg.click('#fPrev'); check(f'[{tag}] 이전', pg.inner_text('#fCount') != idx, pg.inner_text('#fCount'))
        mtop = pg.evaluate("()=>{const m=document.querySelector('.hl-layer mark.cur').getBoundingClientRect();const e=document.querySelector('#editor');const r=e.getBoundingClientRect();return m.top>=r.top&&m.bottom<=r.bottom}")
        check(f'[{tag}] 현재 결과가 화면 안', mtop)
        pg.screenshot(path=SHOTS + tag + '_find.png')
        # 2) 하나 바꾸기
        pg.click('#fRepToggle'); pg.fill('#fRep', '비'); pg.click('#fRepOne'); wait_saved(pg)
        check(f'[{tag}] 하나 바꾸기', pg.inner_text('#fCount').endswith('/79') and ed_val(pg).count('비 이') + ed_val(pg).count('비 이 그쳤') >= 1, pg.inner_text('#fCount'))
        pg.screenshot(path=SHOTS + tag + '_replace.png')
        # 3) 모두 바꾸기 + 되돌리기
        before = ed_val(pg); pg.click('#fRepAll'); pg.wait_for_timeout(800); wait_saved(pg)
        v = ed_val(pg); check(f'[{tag}] 모두 바꾸기 (대소문자 구분: Rain 그대로)', 'rain' not in v and v.count('Rain') == 80 and v.count('비') == 80, (v.count('rain'), v.count('Rain')))
        check(f'[{tag}] 바꾸기 후 저장됨(dirty)', ep_texts(pg)['첫화'] == [v, True] or ep_texts(pg)['첫화'][0] == v)
        check(f'[{tag}] 바꾸기 전 원고가 수정 기록에', pg.evaluate("""async(b)=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('versions').objectStore('versions').getAll();await new Promise(x=>t.onsuccess=x);return t.result.some(x=>x.reason==='before-replace'&&x.text===b)}""", before))
        pg.click('#toast .t-act'); pg.wait_for_timeout(800); wait_saved(pg)
        check(f'[{tag}] 모두 바꾸기 되돌리기', ed_val(pg) == before and ep_texts(pg)['첫화'][0] == before)
        pg.click('#fClose')
        # 4) 전체 검색 (하나 바꾼 뒤라 rain 159곳)
        # 노트 하나
        if pg.is_visible('#btnBack'): pg.click('#btnBack'); pg.wait_for_timeout(200)
        tab(pg, 'vault'); pg.click('[data-new="idea"]'); pg.fill('#nTitle', 'rain 모티프'); dlg_ok(pg); pg.wait_for_timeout(300)
        tab(pg, 'note')
        if pg.is_visible('#btnBack'): pg.click('#btnBack')
        pg.fill('#searchInput', 'rain'); pg.wait_for_timeout(700)
        check(f'[{tag}] 전체 검색: 개수·결과 목록', '159곳' in pg.inner_text('.sr-head') and pg.locator('.sr[data-n]').count() >= 100, pg.inner_text('.sr-head'))
        check(f'[{tag}] 전체 검색: 설계 노트도', pg.locator('.sr[data-note]').count() == 1)
        pg.click('#srCase'); pg.wait_for_timeout(500); check(f'[{tag}] 전체 검색 대소문자', '79곳' in pg.inner_text('.sr-head'), pg.inner_text('.sr-head'))
        pg.click('#srCase'); pg.wait_for_timeout(500)
        pg.screenshot(path=SHOTS + tag + '_global.png')
        pg.locator('.sr[data-n]').nth(51).click(); pg.wait_for_selector('#editorView:not([hidden])'); pg.wait_for_timeout(400)
        st = pg.evaluate("()=>{const e=document.querySelector('#editor');return [e.value.slice(e.selectionStart,e.selectionEnd).toLowerCase(),e.scrollTop, document.querySelector('#fCount').textContent]}")
        check(f'[{tag}] 결과 누르면 그 자리로', st[0] == 'rain' and st[1] > 200 and st[2].startswith('52/'), st)
        pg.click('#fClose')
        if pg.is_visible('#btnBack'): pg.click('#btnBack')
        pg.fill('#searchInput', 'rain'); pg.wait_for_timeout(700)
        pg.click('#srRepT'); pg.wait_for_timeout(300); pg.fill('#srRep', 'RAIN'); pg.click('#srRepAll'); pg.wait_for_selector('#dlg[open]')
        check(f'[{tag}] 전체 바꾸기 확인창', '159곳' in pg.inner_text('#dlg'))
        pg.screenshot(path=SHOTS + tag + '_confirm.png')
        pg.click('#dlg button[value="cancel"]'); pg.wait_for_timeout(300)
        check(f'[{tag}] 취소하면 그대로', ep_texts(pg)['첫화'][0] == before)
        pg.click('#srRepAll'); pg.wait_for_selector('#dlg[open]'); dlg_ok(pg); pg.wait_for_timeout(1000)
        v = ep_texts(pg)['첫화']; check(f'[{tag}] 전체 바꾸기 적용 + 동기화 대기 표시', v[0].count('RAIN') == 159 and v[1] is True, (v[0].count('RAIN'), v[1]))
        check(f'[{tag}] 노트는 그대로', pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('notes').objectStore('notes').getAll();await new Promise(x=>t.onsuccess=x);return t.result[0].title}""") == 'rain 모티프')
        pg.click('#toast .t-act'); pg.wait_for_timeout(1000)
        check(f'[{tag}] 전체 바꾸기 되돌리기', ep_texts(pg)['첫화'][0] == before)
        if not mobile:
            sync(pg); f = [x for x in drive.by('episode')][0]
            check('드라이브: 되돌린 원고가 올라감', (f['content'] or '').count('Rain') == 80 and (f['content'] or '').count('rain') == 79 and 'RAIN' not in (f['content'] or ''))
        else:
            check('폰 360: 가로 넘침 없음', not pg.evaluate("document.documentElement.scrollWidth > innerWidth + 1"))
        check(f'[{tag}] 페이지 오류 없음', not pg._errs, pg._errs)
        c.close()
    b.close()
print(f"\n{sum(1 for r in results if r[1])}/{len(results)} passed")
sys.exit(0 if all(r[1] for r in results) else 1)
