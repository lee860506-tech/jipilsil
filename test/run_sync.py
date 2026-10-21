# 집필실 v3: 구글 문서 줄바꿈 왕복·가짜 충돌·배너 중복 방지
#: PC ↔ 폰 (같은 가짜 드라이브), 충돌, 복사, 수정본 반영, 키보드, 위치 기억
import sys, re, json
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8793/'
SHOTS = '/workspace/yeonwol-note/shots/sync_'
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



def kvget(pg, k):
    return pg.evaluate("""async(k)=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('kv').objectStore('kv').get(k);await new Promise(x=>t.onsuccess=x);return t.result}""", k)
def kvset(pg, k, v):
    pg.evaluate("""async([k,v])=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('kv','readwrite');t.objectStore('kv').put(v,k);await new Promise(x=>t.oncomplete=x)}""", [k, v])
def expire_soon(pg, ms):
    tok = kvget(pg, 'driveToken'); tok['exp'] = int(pg.evaluate('Date.now()')) + ms; kvset(pg, 'driveToken', tok)
    pg.reload(); pg.wait_for_selector('html.ready'); pg.wait_for_function("()=>window.google&&window.google.accounts", timeout=10000); pg.wait_for_timeout(3000)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    drive = FakeDrive()
    cpc, pc = ctx(b, False, drive); cph, ph = ctx(b, True, drive)
    pc.goto(URL); pc.wait_for_selector('html.ready'); connect(pc)
    tab(pc, 'note'); pc.click('#btnNewWork'); pc.fill('#askIn', '동기화작'); dlg_ok(pc); pc.wait_for_selector('#editorView:not([hidden])')
    type_end(pc, '첫 문장.'); wait_saved(pc)
    pc.click('#btnSettings'); pc.fill('#setPen', '연월'); dlg_ok(pc); pc.wait_for_timeout(300)
    pc.evaluate("()=>{document.querySelector('#btnBack')?.click()}")
    tab(pc, 'my'); pc.select_option('#myGoal', '2000'); pc.wait_for_timeout(300)
    sync(pc)
    ph.goto(URL); ph.wait_for_selector('html.ready'); connect(ph); sync(ph)
    st = kvget(ph, 'settings')
    check('설정 동기화: 새 기기가 필명·목표 받음 (빈 필명으로 덮지 않음)', st.get('penName') == '연월' and st.get('goal') == 2000, st)
    tab(ph, 'home'); check('새 기기 홈 인사말에 필명', '연월 작가님' in ph.inner_text('#vHome .hello h2'))
    # 폰에서 목표 바꾸면 PC로
    tab(ph, 'my'); ph.select_option('#myGoal', '3000'); ph.wait_for_timeout(300); sync(ph); sync(pc)
    check('설정: 나중에 바꾼 쪽이 이김 (폰→PC)', kvget(pc, 'settings').get('goal') == 3000)
    # 자동 받기: PC에서 쓰고 → 폰은 돌아오기만 해도
    open_ep(pc, '동기화작'); type_end(pc, ' PC에서 덧붙임.'); wait_saved(pc); pc.wait_for_timeout(5500); wait_sync(pc)
    check('수정 후 자동 올리기 (누르지 않아도)', '덧붙임' in (drive.by('episode')[0]['content'] or ''))
    ph.wait_for_timeout(8500); refocus(ph)
    open_ep(ph, '동기화작'); check('폰: 앱으로 돌아오면 자동 받기', '덧붙임' in ed_val(ph), ed_val(ph))
    # 토큰 만료 직전 → 다음 터치에 조용히 갱신
    if ph.is_visible('#btnBack'): ph.click('#btnBack')
    expire_soon(ph, 5 * 60_000); n0 = ph.evaluate('window.__gisCalls')
    tab(ph, 'home'); ph.wait_for_timeout(800)
    check('만료 10분 전: 터치하면 조용히 재연결 (prompt 없음)', ph.evaluate('window.__gisCalls') == n0 + 1 and ph.evaluate('window.__gisLast.prompt') == '', ph.evaluate('[window.__gisCalls, window.__gisLast]'))
    tok = kvget(ph, 'driveToken'); check('새 토큰 약 1시간', tok['exp'] - ph.evaluate('Date.now()') > 50 * 60_000)
    tab(ph, 'works'); ph.wait_for_timeout(500); check('갱신은 한 번만 (연속 터치에 팝업 반복 없음)', ph.evaluate('window.__gisCalls') == n0 + 1)
    # 원고 입력 중 터치는 건드리지 않음
    expire_soon(ph, 5 * 60_000); n1 = ph.evaluate('window.__gisCalls')
    open_ep(ph, '동기화작'); n2 = ph.evaluate('window.__gisCalls'); ph.click('#editor'); ph.wait_for_timeout(300)
    check('원고 칸을 누를 때는 로그인 창 안 엶', ph.evaluate('window.__gisCalls') == n2)
    # 이미 만료 + 조용한 갱신 실패 → 눈에 띄는 다시 연결 안내, 원고는 대기
    if ph.is_visible('#btnBack'): ph.click('#btnBack')
    expire_soon(ph, -1000)
    ph.evaluate("""()=>{google.accounts.oauth2.initTokenClient=cfg=>({requestAccessToken(){window.__gisCalls++;setTimeout(()=>cfg.error_callback({type:'popup_failed_to_open'}),20)}})}""")
    tab(ph, 'home'); ph.wait_for_timeout(800)
    t = ph.inner_text('#toast') if ph.is_visible('#toast') else ''
    check('재연결 실패 시 「다시 연결」 안내', '다시 연결' in t and '로그인' in t, t)
    check('상태 표시: 연결 만료', '만료' in ph.evaluate("document.querySelector('#saveStatus span').textContent") or '다시 연결' in ph.inner_text('#syncLine'), ph.inner_text('#syncLine'))
    # 다시 정상 GIS → 다시 연결 누르면 대기분 올라감
    ph.evaluate("""()=>{google.accounts.oauth2.initTokenClient=cfg=>({requestAccessToken(o){window.__gisCalls++;window.__gisLast={prompt:o&&o.prompt};setTimeout(()=>cfg.callback({access_token:'fake-token',expires_in:3599,scope:cfg.scope}),20)}})}""")
    open_ep(ph, '동기화작'); type_end(ph, ' 폰 오프라인 문장.'); wait_saved(ph)
    if ph.is_visible('#btnStatusAct'): ph.click('#btnStatusAct')
    wait_sync(ph); ph.wait_for_timeout(1500); wait_sync(ph)
    check('다시 연결하면 대기 원고 올라감', '폰 오프라인 문장' in (drive.by('episode')[0]['content'] or ''))
    # 💾 지금 저장: 기다리지 않고 바로 드라이브까지
    sync(pc); type_end(pc, ' 바로저장문장.'); pc.click('#btnSave'); pc.wait_for_function("()=>/저장됨 \\d/.test(document.querySelector('#btnSave b').textContent)", timeout=10000)
    check('💾 저장: 즉시 드라이브에 올라감 + 저장됨 HH:MM', '바로저장문장' in (drive.by('episode')[0]['content'] or ''), pc.inner_text('#btnSave'))
    pc.focus('#editor'); type_end(pc, ' 컨트롤에스.'); pc.keyboard.press('Control+s'); pc.wait_for_timeout(1500); wait_sync(pc)
    check('Ctrl+S: 저장 + 올리기 (버전 창 안 뜸)', '컨트롤에스' in (drive.by('episode')[0]['content'] or '') and not pc.evaluate("document.querySelector('#dlg').open"))
    pc.screenshot(path=SHOTS + 'desktop_save.png')
    expire_soon(ph, -1000)
    ph.evaluate("()=>{google.accounts.oauth2.initTokenClient=cfg=>({requestAccessToken(){window.__gisCalls++;setTimeout(()=>cfg.error_callback({type:'popup_closed'}),20)}})}")
    open_ep(ph, '동기화작')
    type_end(ph, ' 만료저장.'); ph.click('#btnSave'); ph.wait_for_timeout(1200)
    saved = ph.evaluate("async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('episodes').objectStore('episodes').getAll();await new Promise(x=>t.onsuccess=x);return t.result.map(e=>e.text).join('')}")
    check('💾 저장: 로그인 끝났으면 기기 저장 + 다시 연결 안내', '다시 연결' in ph.inner_text('#btnSave') and '만료저장' in saved, repr(ph.inner_text('#btnSave')) + str('만료저장' in saved))
    ph.screenshot(path=SHOTS + 'mobile_save_reauth.png')
    ph.evaluate("()=>{google.accounts.oauth2.initTokenClient=cfg=>({requestAccessToken(o){window.__gisCalls++;setTimeout(()=>cfg.callback({access_token:'fake-token',expires_in:3599,scope:cfg.scope}),20)}})}")
    ph.click('#btnSave'); ph.wait_for_timeout(2500); wait_sync(ph)
    check('💾 저장을 다시 누르면 그 자리에서 재연결 + 올라감', '만료저장' in (drive.by('episode')[0]['content'] or ''), repr(ph.inner_text('#btnSave')))
    # 동시 수정: 원고 잃지 않음
    open_ep(pc, '동기화작'); type_end(pc, ' PC 동시.'); wait_saved(pc)
    type_end(ph, ' 폰 동시.'); wait_saved(ph)
    sync(ph); sync(pc); sync(pc)
    allv = pc.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('versions').objectStore('versions').getAll();await new Promise(x=>t.onsuccess=x);return t.result.map(v=>v.text).join('|')}""") + ed_val(pc)
    check('동시 수정: 두 기기 문장 모두 남음 (수정 기록·충돌 보관)', 'PC 동시' in allv and '폰 동시' in allv)
    check('페이지 오류 없음', not pc._errs and not ph._errs, pc._errs + ph._errs)
    b.close()
print(f"\n{sum(1 for r in results if r[1])}/{len(results)} passed")
sys.exit(0 if all(r[1] for r in results) else 1)
