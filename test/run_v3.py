# 집필실 v3: 구글 문서 줄바꿈 왕복·가짜 충돌·배너 중복 방지
#: PC ↔ 폰 (같은 가짜 드라이브), 충돌, 복사, 수정본 반영, 키보드, 위치 기억
import sys, re, json
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8793/'
SHOTS = '/workspace/yeonwol-note/shots/v3_'
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
    vp = {'width': 393, 'height': 852} if mobile else {'width': 1440, 'height': 900}
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

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    for mode in ('plus1', 'double'):
        drive = FakeDrive(); drive.docs = mode
        cpc, pc = ctx(b, False, drive); cph, ph = ctx(b, True, drive)
        pc.goto(URL); pc.wait_for_selector('html.ready'); connect(pc)
        tab(pc, 'note'); pc.click('#btnNewWork'); pc.fill('#askIn', '리버스'); dlg_ok(pc); pc.wait_for_selector('#editorView:not([hidden])')
        # 편집기 자체: 엔터 한 번 = \n 한 개
        pc.focus('#editor'); pc.keyboard.type('첫 줄'); pc.keyboard.press('Enter'); pc.keyboard.type('둘째 줄'); pc.keyboard.press('Enter'); pc.keyboard.press('Enter'); pc.keyboard.type('셋째 문단')
        wait_saved(pc); want = '첫 줄\n둘째 줄\n\n셋째 문단'
        check(f'[{mode}] 편집기: 엔터 1번 = 줄바꿈 1개', ed_val(pc) == want, repr(ed_val(pc)))
        sync(pc)
        fid = drive.by('episode')[0]['id']
        for i in range(4): refocus(pc); storm(pc)
        check(f'[{mode}] PC: 왕복 여러 번 후에도 줄바꿈 그대로', ed_val(pc) == want, repr(ed_val(pc)))
        check(f'[{mode}] PC: 내가 올린 걸 원격 변경으로 착각 안 함 (배너 없음)', pc.locator('.conflict-banner').count() == 0)
        # 폰에서 열기 → 똑같이
        ph.goto(URL); ph.wait_for_selector('html.ready'); connect(ph); open_ep(ph, '리버스')
        check(f'[{mode}] 폰: 드라이브에서 받아도 줄바꿈 그대로', ed_val(ph) == want, repr(ed_val(ph)))
        ph.focus('#editor'); ph.evaluate("()=>{const e=document.querySelector('#editor');e.setSelectionRange(e.value.length,e.value.length)}")
        ph.keyboard.press('Enter'); ph.keyboard.type('폰에서 한 줄'); wait_saved(ph); sync(ph)
        want2 = want + '\n폰에서 한 줄'
        for i in range(3): refocus(ph); storm(ph)
        check(f'[{mode}] 폰: 왕복 후 그대로', ed_val(ph) == want2, repr(ed_val(ph)))
        refocus(pc); storm(pc)
        check(f'[{mode}] PC: 폰 수정 받아도 줄바꿈 그대로', ed_val(pc) == want2, repr(ed_val(pc)))
        pc.focus('#editor'); pc.evaluate("()=>{const e=document.querySelector('#editor');e.setSelectionRange(e.value.length,e.value.length)}")
        pc.keyboard.press('Enter'); pc.keyboard.type('PC 다시'); wait_saved(pc); sync(pc); want3 = want2 + '\nPC 다시'
        refocus(ph); storm(ph); refocus(pc); storm(pc); refocus(ph)
        check(f'[{mode}] 3번째 왕복: PC·폰 같은 글, 줄바꿈 1개씩', ed_val(pc) == want3 and ed_val(ph) == want3, repr(ed_val(ph)))
        # 구글 문서(ChatGPT)에서 직접 고친 것 → 줄바꿈 규칙 되돌려 받기
        docs_text = want3.replace('셋째 문단', '셋째 문단을 고쳤다') + '\n문서에서 추가'
        drive.remote_edit(fid, docs_text); refocus(pc); storm(pc)
        check(f'[{mode}] 구글 문서에서 고친 글: 줄바꿈 수 그대로 받음', ed_val(pc) == docs_text, repr(ed_val(pc)))
        check(f'[{mode}] 그때도 충돌 아님', pc.locator('.conflict-banner').count() == 0)
        # 예전 가짜 충돌(줄바꿈만 다름)이 남아 있으면 → 저절로 정리, 글 그대로
        pc.evaluate("""async(rt)=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;
          const tx=d.transaction('episodes','readwrite');const st=tx.objectStore('episodes');const g=st.get(window.__yw.cur);await new Promise(x=>g.onsuccess=x);
          const e=g.result;e.conflict={remoteText:rt,remoteModifiedTime:'x',fileId:e.drive.fileId,at:Date.now()};st.put(e);await new Promise(x=>tx.oncomplete=x)}""", docs_text.replace('\n', '\n\n\n'))
        pc.reload(); pc.wait_for_selector('html.ready'); pc.wait_for_timeout(800)
        if not pc.is_visible('#editorView:not([hidden])'): open_ep(pc, '리버스')
        storm(pc); pc.wait_for_timeout(500)
        check(f'[{mode}] 줄바꿈만 다른 예전 충돌 배너 → 자동 정리', pc.locator('.conflict-banner').count() == 0 and not ep_rec(pc).get('conflict'), pc.locator('.conflict-banner').count())
        check(f'[{mode}] 정리 후 글 그대로', ed_val(pc) == docs_text, repr(ed_val(pc)))
        # 진짜 충돌: 배너 1개, 기록 1쌍만 (여러 트리거가 겹쳐도)
        cpc.set_offline(True); pc.wait_for_timeout(200)
        pc.focus('#editor'); pc.evaluate("()=>{const e=document.querySelector('#editor');e.setSelectionRange(e.value.length,e.value.length)}"); pc.keyboard.type(' 결말 A'); wait_saved(pc)
        drive.remote_edit(fid, docs_text + '\n결말 B')
        cpc.set_offline(False); pc.wait_for_timeout(300)
        for i in range(3): storm(pc)
        nb = pc.locator('.conflict-banner').count()
        check(f'[{mode}] 진짜 충돌: 배너는 딱 1개', nb == 1, nb)
        cr, cl = versions(pc, 'conflict-remote'), versions(pc, 'conflict-local')
        check(f'[{mode}] 충돌 사본: 트리거 여러 번이어도 1쌍', len(cr) == 1 and len(cl) == 1, (len(cr), len(cl)))
        check(f'[{mode}] 충돌 사본 내용 (둘 다 보관, 줄바꿈 정상)', '결말 A' in cl[0] and cr[0] == docs_text + '\n결말 B', repr(cr[:1]))
        pc.screenshot(path=SHOTS + f'{mode}_conflict_one_banner.png')
        # 붙여넣기: CRLF/lone CR → 한 줄씩
        pc.evaluate("""()=>{const e=document.querySelector('#editor');e.focus();e.setSelectionRange(0,0);const dt=new DataTransfer();dt.setData('text/plain','가\\r\\n나\\r다\\u000b라\\n');e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))}""")
        pc.wait_for_timeout(200)
        check(f'[{mode}] 붙여넣기: CRLF·CR·세로탭 → 줄바꿈 1개씩', ed_val(pc).startswith('가\n나\n다\n라\n'), repr(ed_val(pc)[:12]))
        check(f'[{mode}] JS 오류 없음', not pc._errs and not ph._errs, (pc._errs + ph._errs)[:3])
        cpc.close(); cph.close()
    b.close()
bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} passed')
sys.exit(1 if bad else 0)
