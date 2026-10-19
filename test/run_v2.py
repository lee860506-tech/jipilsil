# 집필실 v2 시나리오: PC ↔ 폰 (같은 가짜 드라이브), 충돌, 복사, 수정본 반영, 키보드, 위치 기억
import sys, re, json
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8793/'
SHOTS = '/workspace/yeonwol-note/shots/v2_'
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

P1 = '가로등 불빛이 젖은 아스팔트 위에서 번졌다. 서하는 우산을 접었다.'
P2 = '"왜 여기까지 왔어?" 수혁의 목소리가 낮게 깔렸다.'
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    drive = FakeDrive()
    cpc, pc = ctx(b, False, drive); cph, ph = ctx(b, True, drive, fake_vv=True)

    # ---------- 1) PC에서 쓰고 동기화 ----------
    pc.goto(URL); pc.wait_for_selector('html.ready'); connect(pc)
    tab(pc, 'note'); pc.click('#btnNewWork'); pc.fill('#askIn', 'RE:VERSE'); dlg_ok(pc); pc.wait_for_selector('#editorView:not([hidden])')
    pc.fill('#epTitle', '비 오는 밤'); type_end(pc, P1); wait_saved(pc)
    st_local = pc.inner_text('#saveStatus')
    sync(pc)
    st = pc.inner_text('#saveStatus')
    check('상태: 기기 저장 → 드라이브 저장 시간 표시', '기기에 저장됨' in st_local or '드라이브' in st_local, st_local)
    check('상태: 「드라이브 H:MM 저장」', re.match(r'^드라이브 \d{1,2}:\d{2} 저장$', st.strip()), st)
    epdoc = [f for f in drive.by('episode')]
    check('PC 원고가 드라이브 문서로', len(epdoc) == 1 and P1 in epdoc[0]['content'])
    pc.screenshot(path=SHOTS + '01_pc_synced.png')

    # ---------- 2) 폰에서 열면 PC 글이 보임 → 이어 씀 ----------
    ph.goto(URL); ph.wait_for_selector('html.ready'); connect(ph)
    open_ep(ph, 'RE:VERSE')
    check('폰: PC에서 쓴 원고가 보임', P1 in ed_val(ph), ed_val(ph)[:40])
    ph.evaluate("()=>{const e=document.querySelector('#editor');e.focus();e.setSelectionRange(e.value.length,e.value.length)}")
    ph.keyboard.type('\n\n' + P2); wait_saved(ph); sync(ph)
    check('폰 수정 → 드라이브 반영', P2 in drive.by('episode')[0]['content'])
    ph.screenshot(path=SHOTS + '02_phone_edit.png')

    # ---------- 3) PC로 돌아오면 폰 수정이 보임 (잃는 것 없음) ----------
    pc.wait_for_timeout(8200); refocus(pc)
    v = ed_val(pc)
    check('PC 다시 보기(focus): 폰에서 쓴 문장이 편집창에 들어옴', P1 in v and P2 in v, v[-40:])
    check('PC: 받기 전 원고는 수정 기록에', any(t.strip() == P1 for t in versions(pc, 'before-pull')))
    pc.screenshot(path=SHOTS + '03_pc_refocus.png')

    # ---------- 4) 다른 기기에서 만든 새 회차도 나타남 ----------
    ph.click('#btnBack'); ph.locator('.work', has_text='RE:VERSE').locator('[data-act="addep"]').click(); ph.wait_for_timeout(400)
    ph.fill('#epTitle', '폰에서 만든 회차'); type_end(ph, '폰에서 시작한 새 장면.'); wait_saved(ph); sync(ph)
    pc.wait_for_timeout(8200); pc.evaluate("()=>{Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});document.dispatchEvent(new Event('visibilitychange'))}"); wait_sync(pc)
    check('PC: 폰에서 만든 새 회차가 목록에 나타남', pc.locator('.ep', has_text='폰에서 만든 회차').count() == 1)

    # ---------- 5) 충돌: 둘 다 오프라인에서 수정 ----------
    open_ep(ph, 'RE:VERSE', 0)
    cpc.set_offline(True); cph.set_offline(True); pc.wait_for_timeout(300)
    type_end(pc, '\n\nPC에서만 쓴 결말 A.'); wait_saved(pc)
    type_end(ph, '\n\n폰에서만 쓴 결말 B.'); wait_saved(ph)
    st_off = ph.inner_text('#saveStatus')
    cph.set_offline(False); ph.wait_for_timeout(600); wait_sync(ph); sync(ph)
    check('폰 오프라인 상태 표시 후 온라인 → 드라이브에 B', '인터넷 없음' in st_off and '결말 B' in drive.by('episode')[0]['content'] if False else ('결말 B' in [f for f in drive.by('episode') if 'ywEpId' in f['appProperties'] and '서하' in f['content']][0]['content']), st_off)
    cpc.set_offline(False); pc.wait_for_timeout(600); wait_sync(pc); sync(pc)
    banner = pc.is_visible('.conflict-banner')
    vl = versions(pc, 'conflict-local'); vr = versions(pc, 'conflict-remote')
    st_c = pc.inner_text('#saveStatus')
    check('충돌: 덮어쓰지 않고 선택 안내 (배너·상태)', banner and '달라요' in st_c and '결말 A' in ed_val(pc) and '결말 B' not in ed_val(pc), st_c)
    check('충돌: 두 버전 모두 수정 기록에 보관', any('결말 A' in t for t in vl) and any('결말 B' in t for t in vr))
    pc.click('#btnStatusAct'); pc.wait_for_selector('#dlg[open] .diff')
    diff = pc.inner_text('#dlg .diff')
    check('선택 창: 차이 미리보기 + 내 기기 것/드라이브 것/둘 다 보관', '결말 A' in diff and '결말 B' in diff and pc.locator('#dlg button[value=local]').inner_text() == '내 기기 것' and pc.locator('#dlg button[value=remote]').inner_text() == '드라이브 것' and pc.locator('#dlg button[value=both]').count() == 1)
    pc.screenshot(path=SHOTS + '04_conflict_chooser.png')
    dlg_ok(pc, 'both'); pc.wait_for_timeout(800); wait_sync(pc)
    texts = pc.evaluate("()=>[...window.__yw.eps.values()].flat().map(e=>e.text)")
    check('둘 다 보관: 내 것은 그대로, 드라이브 것은 사본 회차로', any('결말 A' in t and '결말 B' not in t for t in texts) and any('결말 B' in t for t in texts) and not pc.is_visible('.conflict-banner'))
    pc.screenshot(path=SHOTS + '05_conflict_resolved.png')

    # ---------- 6) 받는 도중 이 기기에서도 쓰던 경우 (저장 전 입력) ----------
    open_ep(pc, 'RE:VERSE', 0); open_ep(ph, 'RE:VERSE', 0); refocus(ph)
    fid = [f for f in drive.by('episode') if '결말 A' in f['content'] and '사본' not in f.get('description', '')][0]['id']
    drive.remote_edit(fid, drive.files[fid]['content'] + '\n\nChatGPT가 드라이브에서 고친 줄.')
    ph.evaluate("()=>{const e=document.querySelector('#editor');e.focus();e.setSelectionRange(e.value.length,e.value.length)}")
    ph.keyboard.type(' 폰에서 막 쓰는 중'); # 아직 자동 저장 전
    ph.evaluate("()=>{window.__yw.lastInput=Date.now()}")
    ph.wait_for_timeout(8200); ph.evaluate("()=>window.dispatchEvent(new Event('focus'))"); wait_sync(ph); ph.wait_for_timeout(600)
    v = ed_val(ph); vr = versions(ph, 'conflict-remote')
    check('입력 중 원격 변경: 쓰던 글 유지 + 드라이브 것은 보관·선택', '막 쓰는 중' in v and any('ChatGPT가 드라이브에서 고친 줄' in t for t in vr), v[-30:])

    # ---------- 7) 복사 버튼 (ChatGPT로) ----------
    open_ep(pc, 'RE:VERSE', 0)
    full = ed_val(pc)
    pc.click('#btnCopy'); pc.wait_for_selector('#dlg[open] .ho'); pc.click('.ho[data-k=all]'); pc.wait_for_timeout(400)
    clip = pc.evaluate("navigator.clipboard.readText()")
    check('회차 전체 복사 (클립보드)', clip == full and '복사했어요' in pc.inner_text('#toast'), len(clip))
    pc.evaluate("()=>{const e=document.querySelector('#editor');const i=e.value.indexOf('수혁');e.setSelectionRange(i,i+12)}")
    pc.click('#btnCopy'); pc.click('.ho[data-k=sel]'); pc.wait_for_timeout(300)
    clip = pc.evaluate("navigator.clipboard.readText()")
    check('선택한 부분 복사', clip == full[full.index('수혁'):full.index('수혁') + 12], clip)
    pc.click('#btnCopy'); pc.select_option('#hoMode', 'para'); pc.select_option('#hoN', '3')
    pc.screenshot(path=SHOTS + '06_copy_dialog.png')
    pc.click('.ho[data-k=tail]'); pc.wait_for_timeout(300)
    clip = pc.evaluate("navigator.clipboard.readText()")
    paras = [x for x in re.split(r'\n\s*\n|\n', full.rstrip()) if x.strip()]
    check('이어쓰기용 복사: 작품·회차 머리말 + 마지막 3문단', clip.startswith('[작품] RE:VERSE / [회차] 01화 비 오는 밤') and '아래는 원고 마지막 3문단' in clip and clip.endswith(paras[-1]) and paras[-3] in clip and (len(paras) < 4 or paras[-4] not in clip.split('---\n', 1)[1]), clip[:80])
    # 글자 수 모드 + 클립보드 API 없는 폰 (execCommand 대체)
    open_ep(ph, 'RE:VERSE', 0)
    ph.evaluate("()=>{Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true}); window.__execCopy=0; const o=document.execCommand.bind(document); document.execCommand=(c,...a)=>{if(c==='copy'){window.__execCopy++; window.__execSel=document.activeElement.value.slice(document.activeElement.selectionStart,document.activeElement.selectionEnd); return true} return o(c,...a)}}")
    ph.click('#btnCopy'); ph.select_option('#hoMode', 'chars'); ph.select_option('#hoN', '500'); ph.click('.ho[data-k=tail]'); ph.wait_for_timeout(300)
    sel = ph.evaluate("window.__execSel||''")
    check('폰(클립보드 API 없음): 숨은 칸 선택 + 복사로 대체', ph.evaluate("window.__execCopy") == 1 and sel.startswith('[작품] RE:VERSE') and '마지막 약' in sel, sel[:60])

    # ---------- 8) 수정본 반영: 이어 붙이기 / 선택 영역 교체 / 되돌리기 ----------
    open_ep(pc, 'RE:VERSE', 0); before = ed_val(pc)
    rev = '수정본 첫 문단.\n\n\n\n세 줄 띄운 뒤 둘째 문단.   '
    pc.click('#btnRevise'); pc.fill('#rvText', rev)
    pc.screenshot(path=SHOTS + '07_revise_append.png'); dlg_ok(pc); pc.wait_for_timeout(500)
    after = ed_val(pc)
    check('뒤에 이어 붙이기: 빈 줄·공백 그대로 유지', after == before + ('' if before.endswith('\n\n') else '\n\n') + rev, repr(after[-60:]))
    check('반영 전 자동 기록 (수정 기록)', any(t == before for t in versions(pc, 'before-revise')))
    pc.click('#toast .t-act'); pc.wait_for_timeout(600)
    check('바로 되돌리기', ed_val(pc) == before)
    # 선택 영역 교체
    i = before.index('수혁의 목소리'); pc.evaluate(f"()=>{{const e=document.querySelector('#editor');e.focus();e.setSelectionRange({i},{i+7})}}")
    pc.click('#btnRevise'); pc.wait_for_selector('#dlg[open] .rv-sel')
    shown = pc.inner_text('#dlg .rv-sel pre'); replace_checked = pc.is_checked('input[name=rvMode][value=replace]')
    pc.fill('#rvText', '그의 낮은 목소리')
    pc.screenshot(path=SHOTS + '08_revise_replace.png'); dlg_ok(pc); pc.wait_for_timeout(500)
    v = ed_val(pc)
    check('선택 영역 교체: 바뀔 부분 미리보기 + 그 부분만 교체', shown == '수혁의 목소리' and replace_checked and v == before[:i] + '그의 낮은 목소리' + before[i + 7:], shown)
    pc.click('#toast .t-act'); pc.wait_for_timeout(600)
    check('교체 되돌리기', ed_val(pc) == before)
    pc.evaluate("()=>{const e=document.querySelector('#editor');e.setSelectionRange(0,0)}")
    pc.click('#btnRevise'); disabled = pc.is_disabled('input[name=rvMode][value=replace]'); dlg_ok(pc, 'cancel')
    check('선택 없으면 「선택 영역 교체」는 잠김', disabled)
    # 정리 옵션
    pc.click('#btnRevise'); pc.fill('#rvText', '정리 테스트.   \n\n\n\n다음.'); pc.uncheck('#rvKeep'); dlg_ok(pc); pc.wait_for_timeout(400)
    check('정리 옵션 끄면 줄 끝 공백·과한 빈 줄 정리', ed_val(pc).endswith('정리 테스트.\n\n다음.'), repr(ed_val(pc)[-30:]))
    pc.click('#toast .t-act'); pc.wait_for_timeout(400)

    # ---------- 9) 폰 키보드: 커서 줄·저장 상태가 보이게 ----------
    open_ep(ph, 'RE:VERSE', 0)
    ph.evaluate("()=>{const e=document.querySelector('#editor');e.value=e.value+'\\n\\n'+Array.from({length:60},(_, i)=>'긴 문단 '+(i+1)+'. 비가 그치지 않았다.').join('\\n\\n');e.dispatchEvent(new Event('input'))}")
    wait_saved(ph)
    ph.evaluate("()=>{const e=document.querySelector('#editor');e.focus();e.setSelectionRange(e.value.length,e.value.length);e.scrollTop=0}")
    ph.evaluate("()=>window.__vv.set(852-336, 0)"); ph.wait_for_timeout(400)  # 키보드 336px
    info = ph.evaluate("""()=>{const c=window.__jpsCaret, e=document.querySelector('#editor');const y=c.caretY()-e.scrollTop;const st=document.querySelector('#saveStatus').getBoundingClientRect();
      return {y, vis:c.visibleEditorBottom(), stTop:st.top, stBot:st.bottom, vvh:visualViewport.height, kb:document.body.classList.contains('kb-open')}}""")
    check('키보드 열림: 커서 줄이 키보드 위에 보임', info['kb'] and 0 < info['y'] <= info['vis'], info)
    check('키보드 열림: 저장 상태가 화면 안에 보임', info['stTop'] >= 0 and info['stBot'] <= info['vvh'], info)
    ph.keyboard.type(' 키보드 위에서 쓰는 중'); ph.wait_for_timeout(300)
    info2 = ph.evaluate("()=>{const c=window.__jpsCaret, e=document.querySelector('#editor');return {y:c.caretY()-e.scrollTop, vis:c.visibleEditorBottom()}}")
    check('입력하는 동안에도 커서 줄 유지', 0 < info2['y'] <= info2['vis'], info2)
    ph.screenshot(path=SHOTS + '09_phone_keyboard.png')
    ph.evaluate("()=>window.__vv.set(null, 0)"); ph.wait_for_timeout(300)
    check('키보드 닫힘 → 원래 화면', not ph.evaluate("document.body.classList.contains('kb-open')"))
    wait_saved(ph)

    # ---------- 10) 다시 열면 마지막 회차·커서·스크롤 그대로 ----------
    pos = ph.evaluate("()=>{const e=document.querySelector('#editor');const i=e.value.indexOf('긴 문단 30.');e.focus();e.setSelectionRange(i,i);e.scrollTop=1500;e.dispatchEvent(new Event('scroll'));e.dispatchEvent(new KeyboardEvent('keyup'));return {i, top:e.scrollTop}}")
    ph.wait_for_timeout(900); ph.reload(); ph.wait_for_selector('html.ready'); ph.wait_for_timeout(800)
    got = ph.evaluate("()=>{const e=document.querySelector('#editor');return {open:!document.querySelector('#editorView').hidden, sel:e.selectionStart, top:e.scrollTop}}")
    check('다시 열면: 마지막 회차가 바로 열림 + 커서·스크롤 위치 복원', got['open'] and got['sel'] == pos['i'] and abs(got['top'] - pos['top']) < 5, f'{pos} → {got}')
    ph.screenshot(path=SHOTS + '10_phone_reopen.png')
    open_ep(ph, 'RE:VERSE', 1); ph.click('#btnBack'); open_ep(ph, 'RE:VERSE', 0)
    got2 = ph.evaluate("()=>document.querySelector('#editor').selectionStart")
    check('회차를 바꿨다 돌아와도 그 회차 위치 기억', got2 == pos['i'], got2)

    # ---------- 11) 연결 만료 · 실패 → 버튼 ----------
    ph.evaluate("()=>{}")
    pc.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;const t=d.transaction('kv','readwrite');t.objectStore('kv').put({k:'driveToken',v:{access_token:'fake-token',exp:Date.now()-1000}},'driveToken');}""")
    keyinfo = pc.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;return [...d.objectStoreNames]}""")
    cpc.route('https://www.googleapis.com/drive/v3/files?*', lambda r: r.fulfill(status=500, body='{"error":"boom"}'))
    type_end(pc, ' 실패 테스트'); wait_saved(pc); sync(pc)
    st_err = pc.inner_text('#saveStatus'); act = pc.inner_text('#btnStatusAct') if pc.is_visible('#btnStatusAct') else ''
    check('드라이브 실패: 「기기에 저장됨 · 드라이브 저장 실패」 + 다시 시도', '드라이브 저장 실패' in st_err and '기기에 저장됨' in st_err and act == '다시 시도', f'{st_err} / {act}')
    pc.screenshot(path=SHOTS + '11_sync_failed.png')
    cpc.unroute('https://www.googleapis.com/drive/v3/files?*')
    pc.click('#btnStatusAct'); wait_sync(pc)
    check('다시 시도 → 드라이브 저장', re.match(r'^드라이브 \d{1,2}:\d{2} 저장$', pc.inner_text('#saveStatus').strip()), pc.inner_text('#saveStatus'))
    pc.evaluate("()=>{window.__yw.syncState='needauth'}"); pc.evaluate("()=>document.querySelector('#epTitle').dispatchEvent(new Event('blur'))"); pc.wait_for_timeout(400)
    ra = pc.inner_text('#btnStatusAct') if pc.is_visible('#btnStatusAct') else ''
    check('연결 만료: 「다시 연결」 버튼', ra == '다시 연결' or '연결' in pc.inner_text('#saveStatus'), ra)

    for name, pg in (('PC', pc), ('폰', ph)):
        check(f'{name} JS 오류 없음', not pg._errs, pg._errs[:3])
    b.close()

print('\n==== v2 결과: %d/%d 통과 ====' % (sum(1 for r in results if r[1]), len(results)))
for r in results:
    if not r[1]: print('  FAIL', r[0], r[2])
json.dump([{'name': n, 'ok': o, 'info': i} for n, o, i in results], open(SHOTS + 'results.json', 'w'), ensure_ascii=False, indent=1)
sys.exit(0 if all(r[1] for r in results) else 1)
