# 집필실 v3: 구글 문서 줄바꿈 왕복·가짜 충돌·배너 중복 방지
#: PC ↔ 폰 (같은 가짜 드라이브), 충돌, 복사, 수정본 반영, 키보드, 위치 기억
import sys, re, json
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8793/'
SHOTS = '/workspace/yeonwol-note/shots/notes_'
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


def notes(pg):
    return pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;
      const t=d.transaction('notes').objectStore('notes').getAll();await new Promise(x=>t.onsuccess=x);return t.result}""")
def open_note(pg, title):
    tab(pg, 'vault'); pg.click('.vseg [data-vt="notes"]'); pg.wait_for_timeout(200)
    pg.locator('.ncard', has_text=title).first.locator('[data-open]').click(); pg.wait_for_selector('#dlg[open]')
def remote_notes(drive):
    f=[x for x in drive.by('notes')]; return (json.loads(f[0]['content']) if f else None), len(f)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    drive = FakeDrive()
    cpc, pc = ctx(b, False, drive); cph, ph = ctx(b, True, drive)
    pc.goto(URL); pc.wait_for_selector('html.ready'); connect(pc)
    tab(pc, 'note'); pc.click('#btnNewWork'); pc.fill('#askIn', '밤하늘'); dlg_ok(pc); pc.wait_for_selector('#editorView:not([hidden])')
    text = '\n'.join(f'{i}번째 문단. 시안은 창밖을 보았다.' for i in range(60))
    pc.focus('#editor'); pc.evaluate("t=>{const e=document.querySelector('#editor');e.value=t;e.dispatchEvent(new Event('input'))}", text); wait_saved(pc)
    # 1) 원고 중간 선택 → 💡 설계 → 소스로 저장 → 커서·스크롤 그대로
    s0 = text.index('30번째'); s1 = s0 + len('30번째 문단.')
    pc.evaluate("([a,b])=>{const e=document.querySelector('#editor');e.focus();e.setSelectionRange(a,b);e.scrollTop=400}", [s0, s1])
    top0 = pc.eval_on_selector('#editor', 'e=>e.scrollTop')
    pc.click('#btnNote'); pc.wait_for_selector('#dlg[open]')
    check('빠른 적기: 선택 글 → 소스 타입', pc.eval_on_selector('[data-ty="source"]', 'b=>b.classList.contains("on")'))
    check('빠른 적기: 선택 글이 내용에', pc.input_value('#nBody') == '30번째 문단.', pc.input_value('#nBody'))
    pc.fill('#nTitle', '창밖 모티프'); pc.fill('#nTags', '복선 우주'); pc.fill('#nUrl', 'https://example.com/ref')
    pc.screenshot(path=SHOTS + 'desktop_quick.png')
    dlg_ok(pc); pc.wait_for_timeout(300)
    st = pc.evaluate("()=>{const e=document.querySelector('#editor');return [document.activeElement===e,e.selectionStart,e.selectionEnd,e.scrollTop]}")
    check('빠른 적기 후 커서·선택 복원', st[0] and st[1] == s0 and st[2] == s1, st)
    check('빠른 적기 후 스크롤 유지', abs(st[3] - top0) < 5, (st[3], top0))
    check('원고는 그대로', ed_val(pc) == text)
    n = notes(pc); check('노트 저장 (작품·회차·태그 연결)', len(n) == 1 and n[0]['workId'] and n[0]['episodeId'] and n[0]['tags'] == ['복선', '우주'], n)
    # 2) 시퀀스: 장면 추가·순서 바꾸기
    tab(pc, 'vault'); pc.click('[data-new="seq"]'); pc.wait_for_selector('#dlg[open]')
    pc.fill('#nTitle', '2부 시퀀스')
    pc.fill('#nBeats [data-i="0"] textarea', '옥상 재회'); pc.press('#nBeats [data-i="0"] textarea', 'Enter')
    pc.keyboard.type('첫 거짓말'); pc.click('#nAddBeat'); pc.keyboard.type('비 오는 밤')
    pc.click('#nBeats [data-i="2"] [data-up]')
    beats = pc.eval_on_selector_all('#nBeats textarea', 'a=>a.map(t=>t.value)')
    check('시퀀스: Enter로 장면 추가 + ↑ 순서 변경', beats == ['옥상 재회', '비 오는 밤', '첫 거짓말'], beats)
    pc.screenshot(path=SHOTS + 'desktop_seq.png')
    dlg_ok(pc); pc.wait_for_timeout(300)
    # 3) 아이디어(공통)
    pc.click('[data-new="idea"]'); pc.wait_for_selector('#dlg[open]'); pc.fill('#nTitle', '우주 연표 아이디어'); pc.fill('#nBody', '달태양과 리버스 사이 3년 공백'); dlg_ok(pc); pc.wait_for_timeout(300)
    check('보관함 카드 3개', pc.locator('.ncard').count() == 3)
    pc.fill('#noteQ', '거짓말'); pc.wait_for_timeout(700)
    check('검색: 장면 내용으로 찾기', pc.locator('.ncard').count() == 1 and '2부' in pc.inner_text('.ncard'))
    pc.fill('#noteQ', '#복선'); pc.wait_for_timeout(700); check('검색: #태그', pc.locator('.ncard').count() == 1)
    pc.fill('#noteQ', ''); pc.wait_for_timeout(700)
    pc.click('[data-nt="seq"]'); pc.wait_for_timeout(300); check('타입 필터', pc.locator('.ncard').count() == 1); pc.click('[data-nt="all"]'); pc.wait_for_timeout(300)
    pc.screenshot(path=SHOTS + 'desktop_vault.png')
    # 4) 복사
    pc.locator('.ncard', has_text='2부 시퀀스').locator('[data-copy]').click(); pc.wait_for_timeout(300)
    clip = pc.evaluate('navigator.clipboard.readText()')
    check('ChatGPT용 복사 형식', clip.startswith('[시퀀스] 2부 시퀀스') and '1. 옥상 재회\n2. 비 오는 밤\n3. 첫 거짓말' in clip, clip)
    # 5) 드라이브 동기화
    sync(pc); r, cnt = remote_notes(drive)
    check('드라이브: 설계 노트.json 1개 생성', cnt == 1 and r and len(r['notes']) == 3, (cnt, r and len(r['notes'])))
    check('업로드 후 대기 없음', all(not x.get('dirty') and x.get('base') for x in notes(pc)))
    v0 = drive.by('notes')[0]['version']; nlog = len(drive.log); sync(pc)
    check('변경 없으면 다시 올리지 않음', drive.by('notes')[0]['version'] == v0 and not any(m == 'PATCH' and 'upload' in pth for m, pth in drive.log[nlog:]))
    # 6) 폰에서 받기
    ph.goto(URL); ph.wait_for_selector('html.ready'); connect(ph); sync(ph)
    check('폰: 노트 3개 받음', len(notes(ph)) == 3, len(notes(ph)))
    tab(ph, 'vault'); ph.wait_for_timeout(300); ph.screenshot(path=SHOTS + 'mobile_vault.png')
    ov = ph.evaluate("document.documentElement.scrollWidth > innerWidth + 1"); check('폰 360: 가로 넘침 없음', not ov)
    open_note(ph, '2부 시퀀스'); ph.screenshot(path=SHOTS + 'mobile_seq.png')
    ov = ph.evaluate("(()=>{const d=document.querySelector('#dlg');return d.scrollWidth>d.clientWidth+1})()"); check('폰: 노트 창 가로 넘침 없음', not ov)
    ph.click('#nBeats [data-i="0"] [data-dn]'); dlg_ok(ph); ph.wait_for_timeout(200); sync(ph)
    sync(pc); seq = [x for x in notes(pc) if x['title'] == '2부 시퀀스'][0]
    check('폰에서 바꾼 순서가 PC로', [b['text'] for b in seq['beats']] == ['비 오는 밤', '옥상 재회', '첫 거짓말'], seq['beats'])
    # 7) 양쪽에서 같은 노트 수정 → 덮어쓰기 없이 둘 다
    open_note(pc, '우주 연표'); pc.fill('#nBody', 'PC 수정'); dlg_ok(pc); pc.wait_for_timeout(200)
    open_note(ph, '우주 연표'); ph.fill('#nBody', '폰 수정'); dlg_ok(ph); ph.wait_for_timeout(200)
    sync(pc); sync(ph)
    bodies = sorted(x['body'] for x in notes(ph) if '우주 연표' in x['title'])
    check('충돌: 폰에 두 버전 모두 남음', bodies == ['PC 수정', '폰 수정'], bodies)
    check('충돌 사본 제목 표시', any('다른 기기 버전' in x['title'] for x in notes(ph)))
    sync(pc); bodies = sorted(x['body'] for x in notes(pc) if '우주 연표' in x['title'])
    check('충돌: PC에도 두 버전', bodies == ['PC 수정', '폰 수정'], bodies)
    # 8) 삭제 전파
    open_note(pc, '창밖 모티프'); pc.click('#dlg button[value="del"]'); pc.wait_for_selector('#dlg[open]'); dlg_ok(pc); pc.wait_for_timeout(200)
    sync(pc); sync(ph)
    check('삭제가 폰에도', not any(x['title'] == '창밖 모티프' for x in notes(ph)))
    # 9) 폰: 편집기 패널 설계 탭 + 빠른 적기 (키보드)
    open_ep(ph, '밤하늘'); ph.click('#btnPanel'); ph.click('.panel-tabs [data-tab="notes"]'); ph.wait_for_timeout(300)
    check('패널 설계 탭: 이 작품 노트 표시', ph.locator('#paneNotes .ncard').count() >= 1)
    ph.click('#btnPanelClose')
    ph.focus('#editor'); ph.evaluate("()=>{const e=document.querySelector('#editor');e.setSelectionRange(10,10)}")
    ph.click('#btnNote'); ph.wait_for_selector('#dlg[open]'); ph.screenshot(path=SHOTS + 'mobile_quick.png')
    ph.fill('#nTitle', '폰 메모'); dlg_ok(ph); ph.wait_for_timeout(300)
    check('폰 빠른 적기 후 커서 자리 유지', ph.eval_on_selector('#editor', 'e=>e.selectionStart') == 10)
    check('페이지 오류 없음', not pc._errs and not ph._errs, pc._errs + ph._errs)
    b.close()
print(f"\n{sum(1 for r in results if r[1])}/{len(results)} passed")
sys.exit(0 if all(r[1] for r in results) else 1)
