# 집필실: 「기기와 드라이브 양쪽에서 바뀌었어요」 가짜 충돌 방지 + 진짜 충돌은 고른 뒤 확실히 해제
#: 폰에서 쓰고 저장 → 올리다 끊김, 다른 기기 글, 머리줄·메모만 바꾼 기기, 선택(내 기기/드라이브/둘 다) 뒤 다시 충돌 안 뜸
import sys, re, json
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8793/'
SHOTS = '/workspace/yeonwol-note/shots/conflict_'
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

def idb(pg, js, arg=None):
    return pg.evaluate("""async([js,arg])=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;
      return await (new Function('d','arg','return (async()=>{'+js+'})()'))(d,arg)}""", [js, arg])
GET_EPS = "const t=d.transaction('episodes').objectStore('episodes').getAll();await new Promise(x=>t.onsuccess=x);return t.result"
def eps(pg): return idb(pg, GET_EPS)
def ep_mut(pg, ep_id, body):  # body: JS 문장들, 변수 e 가 회차 기록
    return idb(pg, "const tx=d.transaction('episodes','readwrite');const s=tx.objectStore('episodes');const g=s.get(arg);await new Promise(x=>g.onsuccess=x);const e=g.result;" + body + ";s.put(e);await new Promise(x=>tx.oncomplete=x);return true", ep_id)
def ep_by(pg, work_title):
    return idb(pg, "const w=d.transaction('works').objectStore('works').getAll();await new Promise(x=>w.onsuccess=x);const ids=w.result.filter(x=>x.title===arg).map(x=>x.id);" + GET_EPS.replace('return t.result', 'return t.result.filter(e=>ids.includes(e.workId))'), work_title)
def lossy_handler(drive, flag):
    def h(route):
        r = route.request
        if flag['on'] and r.method in ('PATCH', 'POST') and '/upload/' in r.url and 'episode' in (r.post_data_buffer or b'').decode('utf-8', 'ignore')[:400]:
            class P:  # 드라이브에는 올라갔는데 폰은 응답을 못 받음 (앱이 멈추거나 신호가 끊김)
                request = r
                def fulfill(self, **k): pass
            drive.handle(P()); return route.abort('failed')
        drive.handle(route)
    return h
def conflict_of(pg):
    return [e for e in eps(pg) if e.get('conflict')]
def drive_text(drive): return (drive.by('episode')[0]['content'] or '')
def banner(pg): return pg.locator('.conflict-banner').count()
def lost_upload(ph_ctx, pg, marker, edit_js):
    # 드라이브엔 올라갔는데(marker) 폰은 응답을 못 받고 곧바로 신호가 끊긴 채 더 쓰는 상황 (앱이 멈추거나 닫혀도 같음)
    pg.evaluate("()=>window.dispatchEvent(new Event('focus'))")
    for _ in range(60):
        if marker in drive_text(DRIVE): break
        pg.wait_for_timeout(100)
    ph_ctx.set_offline(True); pg.evaluate(edit_js); wait_saved(pg); flag['on'] = False; pg.wait_for_timeout(300); ph_ctx.set_offline(False)
def settle(*pgs):
    for _ in range(2):
        for p in pgs: storm(p)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    drive = FakeDrive(); DRIVE = drive; flag = {'on': False}
    cpc, pc = ctx(b, False, drive); cph, ph = ctx(b, True, drive)
    cph.unroute('https://www.googleapis.com/**'); cph.route('https://www.googleapis.com/**', lossy_handler(drive, flag))
    pc.goto(URL); pc.wait_for_selector('html.ready'); connect(pc)
    tab(pc, 'note'); pc.click('#btnNewWork'); pc.fill('#askIn', '충돌작'); dlg_ok(pc); pc.wait_for_selector('#editorView:not([hidden])')
    BASE = '첫째 문단입니다.\n\n둘째 문단입니다. 달이 떴다.\n\n셋째 문단입니다.'
    pc.fill('#editor', BASE); pc.dispatch_event('#editor', 'input'); wait_saved(pc); sync(pc)
    ph.goto(URL); ph.wait_for_selector('html.ready'); connect(ph); sync(ph)
    check('준비: 두 기기에 같은 회차', BASE in (ep_by(ph, '충돌작') or [{}])[0].get('text', ''), ep_by(ph, '충돌작'))
    EP = ep_by(pc, '충돌작')[0]['id']

    # 1) 머리줄·메모만 바꾼 기기 (글은 그대로, dirty 만 켜짐) + 다른 기기가 글을 고침 → 충돌이 아니라 그냥 받아야 함
    open_ep(pc, '충돌작'); type_end(pc, ' PC가 덧붙임.'); wait_saved(pc); pc.wait_for_timeout(5500); wait_sync(pc)
    check('1 준비: PC 글이 드라이브에 올라감', 'PC가 덧붙임' in drive_text(drive))
    ep_mut(ph, EP, "e.memo='폰에서 쓴 메모';e.dirty=true;e.updatedAt=Date.now()")
    storm(ph); settle(ph)
    r = ep_by(ph, '충돌작')[0]
    check('1 메모만 바꾼 폰: 충돌 아님', not r.get('conflict') and not conflict_of(ph), r.get('conflict'))
    check('1 폰이 PC 글을 받음 (글 안 잃음)', 'PC가 덧붙임' in r['text'] and '첫째 문단' in r['text'], r['text'])
    check('1 폰 메모도 유지·드라이브 설명에 올라감', r.get('memo') == '폰에서 쓴 메모' and '폰에서 쓴 메모' in (drive.by('episode')[0].get('description') or ''), r.get('memo'))
    check('1 드라이브 글도 그대로 (PC 덧붙임 보존)', 'PC가 덧붙임' in drive_text(drive))

    # 2) 올리다 끊김: 드라이브엔 올라갔는데 폰은 기록 못 함 → 이어 쓰고 다시 동기화 해도 충돌 아님
    sync(pc)
    open_ep(ph, '충돌작'); type_end(ph, ' 폰이 이어씀 A.'); wait_saved(ph)
    flag['on'] = True
    lost_upload(cph, ph, '폰이 이어씀 A', "()=>{const e=document.querySelector('#editor');e.value+=' 폰이 이어씀 B.';e.dispatchEvent(new Event('input',{bubbles:true}))}")
    check('2 준비: 드라이브엔 올라갔는데 폰은 응답 못 받음', '폰이 이어씀 A' in drive_text(drive) and '폰이 이어씀 B' not in drive_text(drive) and ep_by(ph, '충돌작')[0].get('dirty'), ep_by(ph, '충돌작')[0].get('dirty'))
    settle(ph)
    r = ep_by(ph, '충돌작')[0]
    check('2a 이어 쓰기: 충돌 아님·배너 없음', not r.get('conflict') and banner(ph) == 0, r.get('conflict'))
    check('2a 드라이브에 폰 글 전부', '폰이 이어씀 B' in drive_text(drive) and '폰이 이어씀 A' in drive_text(drive), drive_text(drive)[-60:])
    check('2a 버튼이 빨간 비교 필요 아님', '비교' not in ph.inner_text('#btnSave'), ph.inner_text('#btnSave'))
    # 2b: 앞쪽을 고쳤을 때(끝에 이어 쓴 게 아님)
    ph.evaluate("()=>{const e=document.querySelector('#editor');e.value=e.value.replace('둘째 문단','둘째 문단(고침)');e.dispatchEvent(new Event('input',{bubbles:true}))}"); wait_saved(ph)
    flag['on'] = True
    lost_upload(cph, ph, '둘째 문단(고침)', "()=>{const e=document.querySelector('#editor');e.value=e.value.replace('셋째 문단','셋째 문단(또 고침)');e.dispatchEvent(new Event('input',{bubbles:true}))}")
    settle(ph)
    r = ep_by(ph, '충돌작')[0]
    check('2b 앞쪽 고침+끊김+또 고침: 충돌 아님', not r.get('conflict') and banner(ph) == 0, r.get('conflict'))
    check('2b 드라이브에 최신 글', '셋째 문단(또 고침)' in drive_text(drive) and '둘째 문단(고침)' in drive_text(drive))
    sync(pc); settle(pc)
    check('2 PC가 폰 글 받음 (충돌 없음)', '폰이 이어씀 B' in ep_by(pc, '충돌작')[0]['text'] and not conflict_of(pc))

    # 3) 진짜 충돌: 양쪽이 서로 다른 곳을 고침 → 둘 다 보관, 고르면 확실히 해제 (내 기기 것)
    open_ep(pc, '충돌작'); pc.evaluate("()=>{const e=document.querySelector('#editor');e.value=e.value.replace('첫째 문단','첫째 문단 [PC]');e.dispatchEvent(new Event('input',{bubbles:true}))}"); wait_saved(pc)
    ph.evaluate("()=>{const e=document.querySelector('#editor');e.value=e.value.replace('셋째 문단','셋째 문단 [폰]');e.dispatchEvent(new Event('input',{bubbles:true}))}"); wait_saved(ph)
    sync(pc); pc.wait_for_timeout(300); storm(ph); settle(ph)
    r = ep_by(ph, '충돌작')[0]
    check('3 진짜 충돌은 감지·배너', bool(r.get('conflict')) and banner(ph) == 1, r.get('conflict') and 'x')
    allv = ' | '.join(versions(ph))
    check('3 두 버전 모두 수정 기록에 보관', '[PC]' in allv and '[폰]' in allv)
    ph.click('#btnResolve'); ph.wait_for_selector('#dlg[open]'); dlg_ok(ph, 'local'); ph.wait_for_timeout(600); settle(ph, pc)
    r = ep_by(ph, '충돌작')[0]
    check('3 「내 기기 것」: 충돌 표시 해제·배너 없음', not r.get('conflict') and banner(ph) == 0 and not conflict_of(ph), r.get('conflict'))
    check('3 드라이브가 폰 글로 바뀌고 PC도 받음', '[폰]' in drive_text(drive) and '[폰]' in ep_by(pc, '충돌작')[0]['text'] and not conflict_of(pc), drive_text(drive)[:40])
    settle(ph, pc)
    check('3 몇 번 더 동기화해도 다시 충돌 안 뜸', not conflict_of(ph) and not conflict_of(pc) and 'bad' not in ph.inner_text('#btnSave'))
    check('3 저장 버튼 정상', '비교' not in ph.inner_text('#btnSave'), ph.inner_text('#btnSave'))
    ph.screenshot(path=SHOTS + 'mobile_resolved.png')

    # 4) 진짜 충돌 → 「드라이브 것」
    pc.evaluate("()=>{const e=document.querySelector('#editor');e.value=e.value.replace('둘째 문단','둘째 문단 [PC2]');e.dispatchEvent(new Event('input',{bubbles:true}))}"); wait_saved(pc)
    ph.evaluate("()=>{const e=document.querySelector('#editor');e.value=e.value.replace('첫째 문단','첫째 문단 [폰2]');e.dispatchEvent(new Event('input',{bubbles:true}))}"); wait_saved(ph)
    sync(pc); pc.wait_for_timeout(300); storm(ph); settle(ph)
    check('4 두 번째 진짜 충돌 감지', bool(ep_by(ph, '충돌작')[0].get('conflict')))
    ph.screenshot(path=SHOTS + 'mobile_banner.png')
    ph.click('#btnResolve'); ph.wait_for_selector('#dlg[open]'); dlg_ok(ph, 'remote'); ph.wait_for_timeout(600); settle(ph, pc)
    r = ep_by(ph, '충돌작')[0]
    check('4 「드라이브 것」: 해제, 글이 PC 것으로', not r.get('conflict') and '[PC2]' in r['text'] and '[폰2]' not in r['text'] and banner(ph) == 0, r['text'][:50])
    check('4 선택하지 않은 쪽 글도 수정 기록에 남음', '[폰2]' in ' | '.join(versions(ph)))
    settle(ph, pc)
    check('4 이후 충돌 없음 (폰·PC 같은 글)', not conflict_of(ph) and not conflict_of(pc) and ep_by(ph, '충돌작')[0]['text'] == ep_by(pc, '충돌작')[0]['text'] == drive_text(drive).replace('\r', ''))

    # 5) 진짜 충돌 → 「둘 다 보관」
    pc.evaluate("()=>{const e=document.querySelector('#editor');e.value=e.value.replace('셋째 문단','셋째 문단 [PC3]');e.dispatchEvent(new Event('input',{bubbles:true}))}"); wait_saved(pc)
    ph.evaluate("()=>{const e=document.querySelector('#editor');e.value=e.value.replace('둘째 문단','둘째 문단 [폰3]');e.dispatchEvent(new Event('input',{bubbles:true}))}"); wait_saved(ph)
    sync(pc); pc.wait_for_timeout(300); storm(ph); settle(ph)
    n_before = len(ep_by(ph, '충돌작'))
    ph.click('#btnResolve'); ph.wait_for_selector('#dlg[open]'); dlg_ok(ph, 'both'); ph.wait_for_timeout(800); settle(ph, pc)
    es = ep_by(ph, '충돌작')
    check('5 「둘 다 보관」: 사본 회차 생김·원본 충돌 해제', len(es) == n_before + 1 and not conflict_of(ph) and any('[PC3]' in e['text'] for e in es) and any('[폰3]' in e['text'] for e in es), len(es))
    settle(ph, pc)
    check('5 이후 충돌 없음', not conflict_of(ph) and not conflict_of(pc))

    # 6) 이미 저장돼 있던 충돌 표시 정리: (a) 공백만 다름 (b) 드라이브 글이 이 기기 글의 앞부분 (이어 쓴 글에 다 들어 있음)
    cur = ep_by(ph, '충돌작'); main = [e for e in cur if '사본' not in (e.get('title') or '')][0]
    ep_mut(ph, main['id'], "e.conflict={remoteText:e.text.replace(/\\n\\n/g,'\\n')+'\\n',remoteModifiedTime:'2026-01-01T00:00:00.000Z',fileId:e.drive.fileId,at:Date.now()};e.dirty=true")
    open_ep(ph, '충돌작'); storm(ph); settle(ph)
    check('6a 공백·줄바꿈만 다른 옛 충돌 표시는 저절로 해제', not conflict_of(ph) and banner(ph) == 0)
    main = [e for e in ep_by(ph, '충돌작') if '사본' not in (e.get('title') or '')][0]
    ep_mut(ph, main['id'], "e.conflict={remoteText:e.text.slice(0,Math.floor(e.text.length*0.6)),remoteModifiedTime:'2026-01-01T00:00:00.000Z',fileId:e.drive.fileId,at:Date.now()};e.dirty=true")
    keep = main['text']
    open_ep(ph, '충돌작'); storm(ph); settle(ph)
    r = [e for e in ep_by(ph, '충돌작') if e['id'] == main['id']][0]
    check('6b 드라이브 글이 이 기기 글의 앞부분이면(더 쓴 것) 저절로 해제, 글 그대로', not r.get('conflict') and r['text'] == keep and banner(ph) == 0, r.get('conflict') and 'still')
    check('6b 드라이브 쪽 앞부분도 수정 기록에 보관', any(v and keep.startswith(v[:20]) and len(v) < len(keep) for v in versions(ph, 'conflict-remote')), len(versions(ph, 'conflict-remote')))
    # 진짜 충돌 표시는 사용자가 고를 때까지 유지 (자동 해제 금지)
    ep_mut(ph, main['id'], "e.conflict={remoteText:'전혀 다른 글입니다. 마음대로 지우면 안 돼요.',remoteModifiedTime:'2026-01-01T00:00:00.000Z',fileId:e.drive.fileId,at:Date.now()};e.dirty=true")
    open_ep(ph, '충돌작'); storm(ph); settle(ph)
    r = [e for e in ep_by(ph, '충돌작') if e['id'] == main['id']][0]
    check('6c 전혀 다른 글의 충돌은 고를 때까지 유지 (글은 그대로)', r.get('conflict') and r['text'] == keep and banner(ph) == 1)
    ph.click('#btnResolve'); ph.wait_for_selector('#dlg[open]')
    check('6c 비교 창에 안내 문구', '수정 기록' in ph.inner_text('#dlg'))
    dlg_ok(ph, 'local'); ph.wait_for_timeout(600); settle(ph)
    r = [e for e in ep_by(ph, '충돌작') if e['id'] == main['id']][0]
    check('6c 고르면 해제', not r.get('conflict') and r['text'] == keep and banner(ph) == 0)

    check('페이지 오류 없음', not pc._errs and not ph._errs, pc._errs + ph._errs)
    b.close()
print(f"\n{sum(1 for r in results if r[1])}/{len(results)} passed")
sys.exit(0 if all(r[1] for r in results) else 1)
