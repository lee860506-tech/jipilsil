# 집필실: 제목·화(번호 이름)·작품 이름 고치기 — 머리줄에서 바로, 메뉴에서, 다른 기기와 동기화
import sys, re, json
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8793/'
SHOTS = '/workspace/yeonwol-note/shots/rename_'
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

def rec(pg,key=None):
    return pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('episodes').objectStore('episodes').getAll();await new Promise(x=>t.onsuccess=x);return t.result.map(e=>[e.title,e.label,e.dirty,e.rev])}""")
def menu(pg, eidx, val, text=None):
    pg.locator('.ep [data-act="epmenu"]').nth(eidx).click(); pg.wait_for_selector('#dlg[open]'); dlg_ok(pg, val)
    pg.wait_for_selector('#askIn')
    if text is not None: pg.fill('#askIn', text)
    dlg_ok(pg); pg.wait_for_timeout(400)
def side_text(pg): return pg.inner_text('.ep-list')

def eps_db(pg):
    return pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('episodes').objectStore('episodes').getAll();await new Promise(x=>t.onsuccess=x);return t.result.sort((a,b)=>a.order-b.order).map(e=>({title:e.title,label:e.label||'',dirty:e.dirty,text:e.text}))}""")
def works_db(pg):
    return pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('works').objectStore('works').getAll();await new Promise(x=>t.onsuccess=x);return t.result.map(w=>w.title)}""")
def menu(pg, eidx, val, text=None):
    pg.locator('.ep [data-act="epmenu"]').nth(eidx).click(); pg.wait_for_selector('#dlg[open]'); dlg_ok(pg, val)
    pg.wait_for_selector('#askIn')
    if text is not None: pg.fill('#askIn', text)
    dlg_ok(pg); pg.wait_for_timeout(400)
def wmenu(pg, text):
    pg.locator('.work [data-act="workmenu"]').first.click(); pg.wait_for_selector('#dlg[open]'); dlg_ok(pg, 'rename'); pg.wait_for_selector('#askIn'); pg.fill('#askIn', text); dlg_ok(pg); pg.wait_for_timeout(400)
def side(pg): return pg.inner_text('.ep-list').replace('\n', ' ')
def list_view(pg):
    if pg.is_visible('#btnBack'): pg.click('#btnBack'); pg.wait_for_timeout(300)
def drive_names(d): return [f['name'] for f in d.by('episode')]
def crumb_edit(pg, which, text, key='Enter'):
    pg.click(f'#crumbWork .{which}'); pg.wait_for_selector('#crumbWork input'); 
    sel = pg.evaluate("()=>{const i=document.querySelector('#crumbWork input');return [i.selectionStart,i.selectionEnd,i.value.length,document.activeElement===i]}")
    if text is not None: pg.fill('#crumbWork input', text)
    pg.keyboard.press(key); pg.wait_for_timeout(500)
    return sel

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    for tag, amob in (('m', True), ('pc', False)):
        print('=====', '360x800' if amob else 'PC 1440')
        drive = FakeDrive()
        ca, A = ctx(b, amob, drive); cb, B = ctx(b, not amob, drive)
        A.goto(URL); A.wait_for_selector('html.ready'); connect(A)
        tab(A, 'note'); A.click('#btnNewWork'); A.fill('#askIn', '수정작'); dlg_ok(A); A.wait_for_selector('#editorView:not([hidden])')
        type_end(A, '첫 회차 글.'); wait_saved(A)
        # 회차 2개 만들기 (목록에서)
        list_view(A); tab(A, 'note'); cur0 = A.evaluate('window.__yw.cur'); A.locator('.work [data-act="addep"]').first.click(); A.wait_for_function('c=>window.__yw.cur&&window.__yw.cur!==c', arg=cur0); A.wait_for_timeout(600); type_end(A, '둘째 글.'); wait_saved(A)
        A.screenshot(path=f'{SHOTS}{tag}_1editor_before.png')
        # 1) 머리줄 제목: 두 번 고쳐도 계속 고쳐짐
        A.fill('#epTitle', '첫 제목'); A.keyboard.press('Tab'); wait_saved(A); A.wait_for_timeout(300)
        check(f'[{tag}] 머리줄 제목 입력 → 저장 + 목록에 보임', eps_db(A)[1]['title'] == '첫 제목' and '첫 제목' in side(A), side(A))
        A.fill('#epTitle', '다시 고친 제목'); A.keyboard.press('Tab'); wait_saved(A); A.wait_for_timeout(300)
        check(f'[{tag}] 제목은 몇 번이든 다시 고칠 수 있음', eps_db(A)[1]['title'] == '다시 고친 제목' and '첫 제목' not in side(A))
        A.fill('#epTitle', ''); A.keyboard.press('Tab'); wait_saved(A)
        check(f'[{tag}] 제목 지우기 가능', eps_db(A)[1]['title'] == '')
        A.fill('#epTitle', '둘째 제목'); A.keyboard.press('Tab'); wait_saved(A)
        # 2) 머리줄 「화」 눌러 바로 고침
        sel = crumb_edit(A, 'cl', '프롤로그')
        check(f'[{tag}] 「화」 누르면 입력칸이 열리고 글자가 선택됨', sel[3] and sel[0] == 0 and sel[1] == sel[2], sel)
        check(f'[{tag}] 「화」 → 프롤로그 (머리줄·목록·기기)', '프롤로그' in A.inner_text('#crumbWork') and eps_db(A)[1]['label'] == '프롤로그' and '프롤로그' in side(A), A.inner_text('#crumbWork'))
        A.screenshot(path=f'{SHOTS}{tag}_2label_set.png')
        sel = crumb_edit(A, 'cl', None, 'Escape')
        check(f'[{tag}] Esc 로 취소하면 그대로', eps_db(A)[1]['label'] == '프롤로그' and not A.locator('#crumbWork input').count())
        A.click('#crumbWork .cl'); A.wait_for_selector('#crumbWork input'); A.screenshot(path=f'{SHOTS}{tag}_3label_editing.png'); A.keyboard.press('Escape')
        crumb_edit(A, 'cl', '')
        check(f'[{tag}] 번호 비우면 자동 번호(02화)로 돌아감', eps_db(A)[1]['label'] == '' and '02화' in A.inner_text('#crumbWork'), A.inner_text('#crumbWork'))
        crumb_edit(A, 'cl', '외전 1'); crumb_edit(A, 'cl', '02화')
        check(f'[{tag}] 자동 번호와 같은 글자를 쓰면 자동으로 돌아감', eps_db(A)[1]['label'] == '')
        crumb_edit(A, 'cl', '외전 1')
        # 3) 작품 이름도 머리줄에서
        crumb_edit(A, 'cw', '수정된 작품')
        check(f'[{tag}] 머리줄에서 작품 이름 고치기', works_db(A) == ['수정된 작품'] and A.inner_text('#crumbWork').startswith('수정된 작품'), works_db(A))
        crumb_edit(A, 'cw', '')
        check(f'[{tag}] 작품 이름을 비우면 그대로 (빈 이름 안 됨)', works_db(A) == ['수정된 작품'])
        # 4) 메뉴
        list_view(A); tab(A, 'note')
        menu(A, 1, 'title', '메뉴로 바꾼 제목'); menu(A, 1, 'label', '외전 2'); wmenu(A, '메뉴로 바꾼 작품')
        check(f'[{tag}] 메뉴: 제목·번호 이름·작품 이름', eps_db(A)[1]['title'] == '메뉴로 바꾼 제목' and eps_db(A)[1]['label'] == '외전 2' and works_db(A) == ['메뉴로 바꾼 작품'] and '외전 2 메뉴로 바꾼 제목' in side(A), side(A))
        menu(A, 1, 'title', ''); check(f'[{tag}] 메뉴: 제목 비우기', eps_db(A)[1]['title'] == '')
        menu(A, 1, 'title', '메뉴 제목 2'); menu(A, 1, 'label', '')
        check(f'[{tag}] 메뉴: 번호 이름 비우면 자동 번호', eps_db(A)[1]['label'] == '' and '02화 메뉴 제목 2' in side(A), side(A))
        # 5) 드라이브에 반영
        sync(A)
        check(f'[{tag}] 드라이브 문서 이름에 반영', '02화 메뉴 제목 2' in drive_names(drive), drive_names(drive))
        check(f'[{tag}] 드라이브 작품 폴더 이름에 반영', any(f['name'] == '메뉴로 바꾼 작품' for f in drive.by('work')), [f['name'] for f in drive.by('work')])
        check(f'[{tag}] 이름만 바꿔도 원고는 그대로', [e['text'] for e in eps_db(A)] == ['첫 회차 글.', '둘째 글.'], [e['text'] for e in eps_db(A)])
        # 6) 다른 기기에서 고치면 → 열려 있는 이쪽 머리줄도 바뀌고, 이어 써도 되돌려지지 않음
        B.goto(URL); B.wait_for_selector('html.ready'); connect(B); sync(B)
        open_ep(A, '메뉴로 바꾼 작품', 1)
        list_view(B); tab(B, 'note')
        w = B.locator('.work', has_text='메뉴로 바꾼 작품')
        if 'open' not in (w.get_attribute('class') or ''): w.locator('[data-act="toggle"]').click()
        menu(B, 1, 'title', '다른 기기 제목'); menu(B, 1, 'label', '번외'); sync(B)
        sync(A)
        check(f'[{tag}] 열려 있던 머리줄이 다른 기기의 제목을 따라감', A.input_value('#epTitle') == '다른 기기 제목' and '번외' in A.inner_text('#crumbWork'), [A.input_value('#epTitle'), A.inner_text('#crumbWork')])
        type_end(A, ' 이어쓰기.'); wait_saved(A); A.wait_for_timeout(500); sync(A)
        check(f'[{tag}] 이어 써도 제목·번호가 옛것으로 되돌아가지 않음', eps_db(A)[1]['title'] == '다른 기기 제목' and eps_db(A)[1]['label'] == '번외' and '번외 다른 기기 제목' in drive_names(drive), [eps_db(A)[1], drive_names(drive)])
        # 같은 시간에 이쪽 머리줄 제목을 직접 고치고 있으면 그 입력이 우선
        A.fill('#epTitle', '내가 쓰는 중'); sync(B); sync(A)
        check(f'[{tag}] 직접 입력 중인 제목은 동기화가 덮지 않음', A.input_value('#epTitle') == '내가 쓰는 중', A.input_value('#epTitle'))
        A.keyboard.press('Tab'); wait_saved(A); sync(A); sync(B)
        check(f'[{tag}] 그 제목도 저장·동기화', eps_db(A)[1]['title'] == '내가 쓰는 중' and '번외 내가 쓰는 중' in drive_names(drive), drive_names(drive))
        A.screenshot(path=f'{SHOTS}{tag}_4after.png')
        check(f'[{tag}] JS 오류 없음', not A._errs and not B._errs, A._errs + B._errs)
        ca.close(); cb.close()
    b.close()
bad = [r for r in results if not r[1]]
print(f'\n{len(results)-len(bad)}/{len(results)} 통과')
for n, ok, i in bad: print('FAIL', n, i)
sys.exit(1 if bad else 0)
