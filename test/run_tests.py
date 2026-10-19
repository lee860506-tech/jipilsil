# 집필실 E2E 테스트 (Playwright, 모바일+데스크톱, 드라이브는 가짜 서버)
import sys, json, io, os, zipfile, time, re
sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright, expect
from fake_drive import FakeDrive, GIS_STUB
import docx as pydocx

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8793/'
LIVE = 'github.io' in URL
SHOTS = '/workspace/yeonwol-note/shots/' + ('live_' if LIVE else '')
DL = '/tmp/yw_dl/'; os.makedirs(DL, exist_ok=True)
results = []; errors_all = []
def check(name, cond, info=''):
    results.append((name, bool(cond), info)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if info else ''), flush=True)

# 원고가 아닌 테스트용 문장 (실제 원고 파일은 사용하지 않음)
PARA = ['비가 그친 새벽, 골목 끝의 가로등이 한 번 깜빡였다.', '"괜찮아?" 그가 물었다. 대답 대신 나는 고개를 끄덕였다.', '시계는 세 시 십 분을 가리키고 있었고, 창밖으로는 아무도 지나가지 않았다.', '“이번에는 도망치지 마.” 낮은 목소리가 귓가에 남았다.']
LONG = '\n\n'.join(PARA[i % 4] + f' ({i+1})' for i in range(1400))  # 약 6만 자

def ctx_new(b, mobile, drive=None, offline_sr=False, splash=False):
    vp = {'width': 393, 'height': 852} if mobile else {'width': 1440, 'height': 900}
    c = b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1, accept_downloads=True,
                      permissions=['microphone'], locale='ko-KR')
    c.add_init_script("window.__YW_NO_SW = %s;" % ('false' if LIVE else 'true'))
    if not splash: c.add_init_script("sessionStorage.setItem('jpsSplash','1')")
    # 헤드리스에는 실제 음성 엔진이 없으므로, 말하는 중인 상태를 흉내 냄 (끝나지 않음)
    c.add_init_script("window.__spoken=[]; if(window.speechSynthesis){speechSynthesis.speak=u=>{window.__spoken.push(u.text)}; speechSynthesis.cancel=()=>{};}")
    if offline_sr: c.add_init_script("delete window.SpeechRecognition; delete window.webkitSpeechRecognition;")
    if drive:
        c.route('https://www.googleapis.com/**', drive.handle)
    c.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body=GIS_STUB))
    return c

def page_new(c, tag):
    pg = c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append('PE ' + str(e)))
    pg.on('console', lambda m: m.type == 'error' and not re.search(r'favicon|ERR_INTERNET_DISCONNECTED|net::ERR', m.text) and errs.append('C ' + m.text))
    pg._errs = errs; pg._tag = tag
    return pg

def dlg_ok(pg, value='ok'): pg.click(f'#dlg button[value="{value}"]')
def tab(pg, t): pg.click(f'#tabs [data-tab="{t}"]'); pg.wait_for_timeout(250)
def new_work(pg, title):
    if not pg.is_visible('#btnNewWork'): tab(pg, 'note')
    pg.click('#btnNewWork'); pg.fill('#askIn', title); dlg_ok(pg); pg.wait_for_selector('#editorView:not([hidden])')
def paste(pg, text):
    pg.focus('#editor')
    pg.evaluate("""t=>{const dt=new DataTransfer();dt.setData('text/plain',t);const ev=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});document.querySelector('#editor').dispatchEvent(ev)}""", text)
def wait_saved(pg, timeout=8000):
    pg.wait_for_function("()=>{const s=document.querySelector('#saveStatus');return s && !window.__yw.pending && !window.__yw.saving && !s.textContent.includes('저장 중')}", timeout=timeout)
def status(pg): return pg.inner_text('#saveStatus')
def type_end(pg, s):
    pg.focus('#editor'); pg.evaluate("()=>{const e=document.querySelector('#editor');e.setSelectionRange(e.value.length,e.value.length)}"); pg.keyboard.type(s)
def ed_val(pg): return pg.eval_on_selector('#editor', 'e=>e.value')
def sync_now(pg):
    pg.evaluate("()=>document.querySelector('#btnSyncNow')?.click()")
    pg.wait_for_timeout(300)
    pg.wait_for_function("()=>window.__yw.syncState!=='syncing'", timeout=15000); pg.wait_for_timeout(300)
def no_hscroll(pg): return pg.evaluate("()=>document.documentElement.scrollWidth<=innerWidth+1 && document.body.scrollWidth<=innerWidth+1")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])

    # =============== 데스크톱 ===============
    drive = FakeDrive()
    c = ctx_new(b, False, drive); pg = page_new(c, 'desktop')
    pg.goto(URL); pg.wait_for_selector('html.ready')
    check('홈 화면: 이어 쓰기·새 회차·위젯·배너·기능 아이콘', pg.is_visible('#hContinue') and pg.is_visible('#hNewEp') and pg.locator('.wg').count() == 3 and pg.is_visible('.banner.streak') and pg.is_visible('.banner.reread') and pg.locator('.feat').count() == 5)
    pg.screenshot(path=SHOTS + 'desktop_01_home_empty.png')
    pg.click('#installCard [data-install]'); pg.wait_for_selector('#dlg[open] ol.steps'); inst_txt = pg.inner_text('#dlg')
    pg.screenshot(path=SHOTS + 'desktop_01b_install.png'); pg.click('#dlg .dlg-btns button')
    pg.click('#installHide'); pg.wait_for_timeout(200)
    check('설치 안내: 홈 카드 → 방법 안내 → 닫기 기억', '설치' in inst_txt and pg.locator('#installCard').count() == 0 and pg.evaluate("localStorage.getItem('jpsInstallHide')") == '1')
    pg.set_viewport_size({'width': 1440, 'height': 900}); pg.wait_for_timeout(200)
    check('PC 넓은 화면: 홈 2단 배치', pg.evaluate("()=>{const a=document.querySelector('.h-main').getBoundingClientRect(),b=document.querySelector('.h-side').getBoundingClientRect();return b.left>a.right-1 && Math.abs(b.top-a.top)<40}"))
    new_work(pg, 'RE:VERSE')
    check('작품 만들기 → 1화 자동 생성·열림', pg.inner_text('#crumbWork').startswith('RE:VERSE') and '01화' in pg.inner_text('#crumbWork'))
    pg.fill('#epTitle', '붉은 새벽')
    pg.evaluate("()=>{window.__st=[];new MutationObserver(()=>window.__st.push(document.querySelector('#saveStatus').textContent)).observe(document.querySelector('#saveStatus'),{subtree:true,childList:true,characterData:true})}")
    paste(pg, LONG.replace('\n', '\r\n'))
    v = ed_val(pg)
    check('긴 붙여넣기 (CRLF 정리 포함)', len(v) > 50000 and '\r' not in v, f'{len(v)}자')
    pg.wait_for_timeout(300)
    check('저장 상태: 🟡 저장 중 표시', '저장 중' in status(pg) or any('저장 중' in x for x in pg.evaluate("window.__st")), status(pg))
    wait_saved(pg)
    check('저장 상태: 🟢 기기에 저장됨 (드라이브 미연결)', status(pg).strip() == '기기에 저장됨' and ' g' in ' ' + pg.get_attribute('#saveStatus', 'class'), status(pg))
    cnt = pg.inner_text('#cntNoSp'); check('글자 수(공백 제외) 표시', re.search(r'공백 제외 [\d,]+자', cnt) is not None, cnt)
    # 두 번째 회차
    pg.click('.work[data-w] [data-act="addep"]'); pg.wait_for_timeout(300)
    type_end(pg, '두 번째 회차의 첫 문장.'); wait_saved(pg)
    today = pg.evaluate("async()=>{const r=indexedDB.open('jipilsil');await new Promise(x=>r.onsuccess=x);const d=r.result;const t=d.transaction('kv').objectStore('kv').get('daily');await new Promise(x=>t.onsuccess=x);return t.result}")
    tv = list(today.values())[0] if today else 0
    check('오늘의 집필: 직접 쓴 글자만 (붙여넣기 제외)', tv == len('두 번째 회차의 첫 문장.'), str(today))
    check('회차 2개 (01화·02화)', pg.locator('.ep').count() == 2 and '02화' in pg.inner_text('#crumbWork'))
    # 재정렬: 02화를 위로
    eid2 = pg.get_attribute('.ep:nth-child(2)', 'data-e')
    pg.click(f'.ep[data-e="{eid2}"] [data-act="epmenu"]'); dlg_ok(pg, 'up'); pg.wait_for_timeout(400)
    check('회차 순서 바꾸기', pg.get_attribute('.ep:nth-child(1)', 'data-e') == eid2 and pg.inner_text('.ep:nth-child(1) .en') == '01화')
    pg.click(f'.ep[data-e="{eid2}"] [data-act="epmenu"]'); dlg_ok(pg, 'down'); pg.wait_for_timeout(400)
    # 새로고침 후 유지
    pg.click('.ep:nth-child(1) [data-act="open"]'); pg.wait_for_timeout(300)
    pg.reload(); pg.wait_for_selector('html.ready'); pg.wait_for_timeout(500)
    check('새로고침 후 원고 유지 (IndexedDB)', ed_val(pg) == v and pg.input_value('#epTitle') == '붉은 새벽', f'{len(ed_val(pg))}자')
    pg.screenshot(path=SHOTS + 'desktop_02_editor.png')

    # ---- 수정 기록 ----
    pg.click('#btnSnap'); pg.fill('#askIn', '1차 퇴고 전'); dlg_ok(pg); pg.wait_for_timeout(300)
    type_end(pg, '\n\n새로 덧붙인 마지막 문단.'); wait_saved(pg)
    pg.click('#btnPanel'); pg.click('.panel-tabs [data-tab="hist"]'); pg.wait_for_selector('.hv')
    manual = pg.locator('.hv', has=pg.locator('.tag.manual')).first
    manual.locator('[data-h="diff"]').click(); pg.wait_for_selector('#dlg .diff')
    dtxt = pg.inner_text('#dlg .diff')
    check('버전 비교(diff) 보기', '새로 덧붙인 마지막 문단' in dtxt and pg.locator('#dlg .d-add').count() >= 1)
    pg.screenshot(path=SHOTS + 'desktop_03_diff.png')
    dlg_ok(pg, 'restore'); pg.wait_for_timeout(200); dlg_ok(pg); pg.wait_for_timeout(800)
    check('버전 복원', ed_val(pg) == v)
    check('복원 전 현재 원고를 기록으로 남김', pg.locator('.hv .tag.before-restore').count() >= 1)
    pg.screenshot(path=SHOTS + 'desktop_04_history.png')
    pg.click('.panel-tabs [data-tab="memo"]'); pg.fill('#epMemo', '복선: 가로등 깜빡임 → 12화 회수'); pg.click('#editor'); wait_saved(pg)

    # ---- 북마크 ----
    pg.locator('.ep [data-act="open"]').first.click(); pg.wait_for_timeout(300)
    pg.evaluate("()=>{const e=document.querySelector('#editor');const i=e.value.indexOf('(3)');e.focus();e.setSelectionRange(i,i)}")
    pg.click('#btnMark'); pg.wait_for_timeout(300)
    tab(pg, 'home'); bmn = pg.inner_text('#wgMark b')
    pg.click('#wgMark'); pg.wait_for_selector('.bm')
    pg.screenshot(path=SHOTS + 'desktop_05a_bookmarks.png')
    pg.click('.bm [data-open]'); pg.wait_for_timeout(500)
    sel = pg.evaluate("()=>{const e=document.querySelector('#editor');return e.value.slice(e.selectionStart,e.selectionEnd)}")
    check('북마크: 저장 → 보관함 모아 보기 → 그 문단으로 이동', bmn == '1개' and sel.startswith(PARA[2][:10]), sel[:20])
    # ---- 집필 타이머 ----
    pg.click('#btnTimerTb'); pg.wait_for_selector('#timerView:not([hidden])'); t0 = pg.inner_text('#tvTime')
    pg.click('#tvGo'); pg.wait_for_timeout(2300); t1 = pg.inner_text('#tvTime')
    pg.screenshot(path=SHOTS + 'desktop_05b_timer.png')
    pg.evaluate("()=>{window.__jpsTimer.endAt=Date.now()+300}"); pg.wait_for_timeout(1200)
    cheer = pg.locator('.cheer').count() > 0; mode = pg.evaluate("window.__jpsTimer.mode")
    pg.screenshot(path=SHOTS + 'desktop_05c_timer_done.png')
    check('집필 타이머 25:00 → 진행 → 끝나면 축하·쉬는 시간으로', t0 == '25:00' and t1 in ('24:59', '24:58', '24:57') and cheer and mode == 'break', f'{t0}→{t1}, mode={mode}')
    pg.click('#tvClose'); pg.wait_for_timeout(2600)
    # ---- 하루 목표 달성 축하 ----
    tab(pg, 'my'); pg.select_option('#myGoal', '300'); pg.wait_for_timeout(200)
    pg.screenshot(path=SHOTS + 'desktop_05d_my.png')
    tab(pg, 'note'); pg.locator('.ep [data-act="open"]').nth(1).click(); pg.wait_for_timeout(200)
    type_end(pg, ' 한 문장씩 이야기가 된다' * 26); wait_saved(pg); pg.wait_for_timeout(300)
    check('하루 목표 달성 → 「와, 잘했어!!」 축하', pg.locator('.cheer').count() > 0 and '목표' in pg.inner_text('.cheer'))
    pg.screenshot(path=SHOTS + 'desktop_05e_goal.png')
    pg.wait_for_timeout(2800)
    tab(pg, 'home'); pg.wait_for_timeout(300)
    check('홈: 연속 집필 1일 · 오늘 체크', pg.inner_text('.banner.streak h4').startswith('1일') and pg.locator('.day.today.done').count() == 1)
    pg.screenshot(path=SHOTS + 'desktop_05f_home.png')
    tab(pg, 'note'); pg.locator('.ep [data-act="open"]').first.click(); pg.wait_for_timeout(300)

    # ---- 내보내기 ----
    with pg.expect_download() as d: pg.click('#btnExport'); dlg_ok(pg, 'txt')
    f = DL + d.value.suggested_filename; d.value.save_as(f); t = open(f, encoding='utf-8-sig').read()
    check('TXT 내보내기', t.replace('\r\n', '\n') == v, d.value.suggested_filename)
    with pg.expect_download() as d: pg.click('#btnExport'); dlg_ok(pg, 'docx')
    f = DL + d.value.suggested_filename; d.value.save_as(f)
    doc = pydocx.Document(f); paras = [x.text for x in doc.paragraphs]
    check('DOCX 내보내기 (python-docx로 열림)', paras[0] == '01화 붉은 새벽' and paras[1] == PARA[0] + ' (1)' and len(paras) > 2000, f'{len(paras)}문단')
    with pg.expect_download() as d: pg.click('#btnExport'); dlg_ok(pg, 'zip')
    f = DL + d.value.suggested_filename; d.value.save_as(f)
    z = zipfile.ZipFile(f); names = z.namelist(); bad = z.testzip()
    inner = pydocx.Document(io.BytesIO(z.read([n for n in names if n.endswith('.docx')][0])))
    check('작품 전체 ZIP (TXT 회차별 + 메모 + 전체 DOCX)', bad is None and any('01화 붉은 새벽.txt' in n for n in names) and any('02화' in n for n in names) and any('메모' in n for n in names) and len(inner.paragraphs) > 100, ', '.join(names))

    # ---- TXT 가져오기 (CP949/UTF-8 BOM, 파일명 회차 번호) ----
    os.makedirs('/tmp/yw_imp', exist_ok=True)
    open('/tmp/yw_imp/바람의 사수 3화 결전.txt', 'wb').write('세 번째 이야기. 활시위가 울었다.\r\n둘째 줄'.encode('cp949'))
    open('/tmp/yw_imp/바람의 사수 1화.txt', 'wb').write('\ufeff첫 번째 이야기.'.encode('utf-8'))
    open('/tmp/yw_imp/바람의 사수 2화 - 바람.txt', 'wb').write('두 번째 이야기.'.encode('utf-8'))
    pg.set_input_files('#fileImport', ['/tmp/yw_imp/바람의 사수 3화 결전.txt', '/tmp/yw_imp/바람의 사수 1화.txt', '/tmp/yw_imp/바람의 사수 2화 - 바람.txt'])
    pg.wait_for_selector('#impWork'); pg.select_option('#impWork', '__new'); pg.fill('#impNew', '바람의 사수')
    pg.screenshot(path=SHOTS + 'desktop_05_import.png')
    enc = pg.inner_text('table.imp')
    dlg_ok(pg); pg.wait_for_timeout(800)
    w = pg.locator('.work', has=pg.locator('.wt', has_text='바람의 사수'))
    labels = [w.locator('.ep').nth(i).inner_text() for i in range(w.locator('.ep').count())]
    w.locator('.ep').nth(2).locator('[data-act="open"]').click(); pg.wait_for_timeout(300)
    check('TXT 가져오기: 번호 순서·CP949 해독·제목', len(labels) == 3 and '01화' in labels[0] and '결전' in labels[2] and ed_val(pg).startswith('세 번째 이야기. 활시위가 울었다.\n둘째 줄') and 'CP949' in enc, ' | '.join(l.replace('\n', ' ') for l in labels))

    # ---- 검색 ----
    pg.fill('#searchInput', '활시위'); pg.wait_for_timeout(600)
    check('작품 전체 검색', pg.locator('.sr').count() == 1 and '바람의 사수' in pg.inner_text('.sr'))
    pg.fill('#searchInput', '가로등'); pg.wait_for_timeout(600)
    n_sr = pg.locator('.sr').count(); pg.screenshot(path=SHOTS + 'desktop_06_search.png')
    pg.locator('.sr').first.click(); pg.wait_for_timeout(300)
    sel = pg.evaluate("()=>{const e=document.querySelector('#editor');return e.value.slice(e.selectionStart,e.selectionEnd)}")
    check('검색 결과 누르면 그 위치 선택', n_sr > 3 and sel == '가로등', f'{n_sr}곳')
    pg.fill('#searchInput', ''); pg.wait_for_timeout(400)

    # ---- 작품 탭: 회차 목록표 ----
    tab(pg, 'works'); pg.screenshot(path=SHOTS + 'desktop_06a_works.png')
    pg.locator('.wcard', has_text='RE:VERSE').click(); pg.wait_for_selector('table.tbl')
    nrows = pg.locator('table.tbl tbody tr').count()
    pg.locator('table.tbl tbody tr').nth(1).locator('select[data-f="status"]').select_option('edit')
    pg.locator('table.tbl tbody tr').first.locator('select[data-f="status"]').select_option('done'); pg.wait_for_timeout(300)
    cheer = pg.locator('.cheer').count() > 0
    pg.locator('table.tbl tbody tr').first.locator('input[data-f="oneLine"]').fill('가로등 아래 첫 만남'); pg.keyboard.press('Tab'); pg.wait_for_timeout(300)
    pg.click('th[data-k="chars"]'); pg.wait_for_timeout(200); first_small = pg.inner_text('table.tbl tbody tr:first-child td:nth-child(1)')
    pg.click('th[data-k="chars"]'); pg.wait_for_timeout(200); first_big = pg.inner_text('table.tbl tbody tr:first-child td:nth-child(1)')
    total = pg.inner_text('table.tbl tfoot')
    pg.screenshot(path=SHOTS + 'desktop_06b_list_table.png')
    with pg.expect_download() as d: pg.click('#tCsv')
    f = DL + 'list.csv'; d.value.save_as(f); csvt = open(f, encoding='utf-8-sig').read()
    check('회차 목록표: 상태·한줄 메모 편집, 정렬, 합계, CSV', nrows == 2 and cheer and first_small == '02화' and first_big == '01화' and '합계' in total and '완성' in csvt and '수정중' in csvt and '가로등 아래 첫 만남' in csvt, f'{first_small}/{first_big}')
    pg.locator('table.tbl td.open').first.click(); pg.wait_for_timeout(400)
    check('목록표에서 누르면 노트로 열림', pg.is_visible('#editorView') and pg.evaluate("location.hash") == '#note')
    # ---- 인물·설정표 ----
    tab(pg, 'works'); pg.click('.seg [data-p="cast"]'); pg.wait_for_timeout(200)
    for (nm, rel, memo) in [('서하', '주인공', '웃음 뒤에 숨긴 불안'), ('수혁', '서하의 소꿉친구', '말끝을 흐림'), ('삭제할 행', '', '')]:
        pg.click('#cAdd'); pg.wait_for_timeout(200)
        row = pg.locator('table.tbl tbody tr').last
        row.locator('[data-c="name"]').fill(nm); row.locator('[data-c="name"]').dispatch_event('change')
        if rel: row.locator('[data-c="rel"]').fill(rel); row.locator('[data-c="rel"]').dispatch_event('change')
        if memo: row.locator('[data-c="memo"]').fill(memo); row.locator('[data-c="memo"]').dispatch_event('change')
        pg.wait_for_timeout(150)
    pg.locator('table.tbl tbody tr').last.locator('[data-del]').click(); dlg_ok(pg); pg.wait_for_timeout(300)
    pg.screenshot(path=SHOTS + 'desktop_06c_cast.png')
    with pg.expect_download() as d: pg.click('#cCsv')
    f = DL + 'cast.csv'; d.value.save_as(f); csvc = open(f, encoding='utf-8-sig').read()
    check('인물·설정표: 행 추가·삭제·CSV', pg.locator('table.tbl tbody tr').count() == 2 and '서하,주인공,웃음 뒤에 숨긴 불안' in csvc and '삭제할 행' not in csvc, csvc.replace('\r\n', ' | '))
    # ---- 아이디어 사진함 ----
    from PIL import Image
    Image.new('RGB', (3000, 2000), (169, 214, 255)).save('/tmp/yw_photo.png'); Image.new('RGB', (800, 1200), (255, 215, 230)).save('/tmp/yw_photo2.jpg')
    tab(pg, 'vault')
    check('사진 찍기: 카메라 입력 (capture=environment)', pg.get_attribute('#photoCam', 'capture') == 'environment' and pg.get_attribute('#photoCam', 'accept') == 'image/*')
    pg.set_input_files('#photoPick', '/tmp/yw_photo.png'); pg.wait_for_selector('#phCap', timeout=10000)
    info = pg.inner_text('#dlg .dlg-body p.mute')
    pg.fill('#phCap', '7화 옥상 장면 분위기'); pg.fill('#phTags', '배경 옥상'); pg.select_option('#phWork', label='RE:VERSE'); pg.wait_for_timeout(100)
    pg.select_option('#phEp', index=1)
    pg.screenshot(path=SHOTS + 'desktop_07a_photo_edit.png')
    dlg_ok(pg); pg.wait_for_timeout(500)
    pg.set_input_files('#photoPick', '/tmp/yw_photo2.jpg'); pg.wait_for_selector('#phCap', timeout=10000); pg.select_option('#phWork', ''); pg.fill('#phCap', '공통 참고 사진'); dlg_ok(pg); pg.wait_for_timeout(500)
    check('사진 압축 (긴 변 1600px) + 설명·태그·작품/회차 연결', info.startswith('1600×1067') and pg.locator('.ph').count() == 2, info[:40])
    pg.click('.chip[data-pf="#배경"]'); pg.wait_for_timeout(200); ntag = pg.locator('.ph').count(); pg.click('.chip[data-pf="all"]'); pg.wait_for_timeout(200)
    check('사진함 태그 필터', ntag == 1)
    pg.screenshot(path=SHOTS + 'desktop_07b_photo_grid.png')
    tab(pg, 'note')

    # ---- 오디오 (헤드리스: 실제 소리 없이 UI·대체 동작 확인) ----
    pg.locator('.ep[data-e] [data-act="open"]').first.click(); pg.wait_for_timeout(300)
    pg.click('#btnListen'); pg.wait_for_timeout(600)
    rd = pg.locator('#reader p:not(.blank)').count()
    pg.locator('#reader p:not(.blank)').nth(3).click(); pg.wait_for_timeout(500)
    sp = pg.evaluate("()=>[...document.querySelectorAll('#reader p')].findIndex(p=>p.classList.contains('speaking'))")
    spoken = pg.evaluate('window.__spoken.at(-1)')
    check('내 소설 듣기: 문단 표시·누른 문단부터·현재 문단 강조', rd > 1000 and sp == 6 and spoken.startswith(PARA[3][:10]) and pg.is_visible('#ttsBar'), f'speaking idx {sp}, 읽는 문장: {spoken[:24]}')
    pg.fill('#ttsRate', '1.5'); pg.dispatch_event('#ttsRate', 'input')
    check('낭독 속도 0.5–2배', pg.inner_text('#ttsRateOut') == '1.5×')
    pg.screenshot(path=SHOTS + 'desktop_07_listen.png')
    pg.click('#ttsStop'); check('듣기 닫으면 편집기로', pg.is_visible('#editor') and not pg.is_visible('#reader'))
    pg.click('#btnMic'); pg.wait_for_timeout(1500)
    check('받아쓰기 시작/오류 시 안내 (헤드리스)', pg.is_visible('#micBar') or pg.is_visible('#toast'))
    pg.evaluate("()=>document.querySelector('#micStop').click()"); pg.wait_for_timeout(200)
    # 받아쓰기 결과 삽입 (인식 결과를 흉내 내서 커서 위치 삽입 확인)
    pg.click('#btnRecord'); pg.wait_for_timeout(2200)
    rec_on = pg.is_visible('#recBar'); pg.click('#recStop'); pg.wait_for_timeout(800)
    nm = pg.locator('.vm').count()
    check('아이디어 녹음 → 회차에 첨부·재생 목록', rec_on and nm == 1 and pg.locator('.vm audio').count() == 1)
    pg.screenshot(path=SHOTS + 'desktop_08_voice.png')
    pg.click('#btnPanelClose')

    # ---- 오프라인 표시 ----
    c.set_offline(True); pg.wait_for_timeout(300)
    type_end(pg, ' 오프라인 문장.'); wait_saved(pg)
    st = status(pg); check('🔴 인터넷 없음 — 기기에 임시 저장', '인터넷 없음' in st and 'r' in pg.get_attribute('#saveStatus', 'class').split(), st)
    pg.screenshot(path=SHOTS + 'desktop_09_offline.png')
    c.set_offline(False); pg.wait_for_timeout(500)

    # ---- 드라이브 연결·동기화 (가짜 드라이브) ----
    pg.click('#btnSettings'); pg.wait_for_timeout(300)
    check('설정: 기본 클라이언트 ID가 칸에 들어 있음', pg.input_value('#setCid').endswith('.apps.googleusercontent.com') and '기본 ID' in pg.inner_text('#setCidNote'))
    pg.fill('#setCid', 'abc'); pg.click('#setConnect'); pg.wait_for_timeout(400)
    m1 = pg.inner_text('#setMsg') if pg.is_visible('#setMsg') else ''
    top = pg.evaluate("()=>{const t=document.querySelector('#toast');return t.matches(':popover-open') && !t.hidden}")
    m2 = m1
    pg.screenshot(path=SHOTS + 'desktop_10a_settings_error.png')
    check('연결 버튼: ID 없거나 틀리면 설정 창 안에 바로 안내 (+맨 위 토스트)', '아쉽다' in m1 and top and '모양' in m2, f'{m1[:30]} / {m2[:30]}')
    pg.fill('#setCid', '123456789-testclient.apps.googleusercontent.com')
    pg.screenshot(path=SHOTS + 'desktop_10_settings.png')
    pg.click('#setConnect'); pg.wait_for_timeout(500)
    pg.wait_for_function("()=>window.__yw.syncState==='synced'", timeout=20000); pg.wait_for_timeout(500)
    gis = pg.evaluate('window.__gisLast')
    check('GIS 토큰 요청: drive.file 범위·입력한 클라이언트 ID', gis['scope'] == 'https://www.googleapis.com/auth/drive.file' and gis['client_id'] == '123456789-testclient.apps.googleusercontent.com', str(gis))
    root = drive.by('root'); works = drive.by('work'); eps = drive.by('episode'); memos = drive.by('memo'); mf = drive.by('memofolder')
    check('드라이브: 「집필실」 폴더 + 작품 폴더', len(root) == 1 and root[0]['name'] == '집필실' and sorted(w['name'] for w in works) == ['RE:VERSE', '바람의 사수'] and all(w['parents'] == [root[0]['id']] for w in works))
    rv = [w for w in works if w['name'] == 'RE:VERSE'][0]
    rv_eps = sorted([e for e in eps if e['parents'] == [rv['id']]], key=lambda e: e['name'])
    check('드라이브: 회차를 구글 문서(01화 …)로 저장', len(eps) == 5 and all(e['mimeType'] == 'application/vnd.google-apps.document' for e in eps) and rv_eps[0]['name'] == '01화 붉은 새벽' and rv_eps[0]['content'].startswith(PARA[0]) and '오프라인 문장' in rv_eps[0]['content'], ', '.join(e['name'] for e in eps))
    check('드라이브: 회차 메모는 문서 설명에 보관', '12화 회수' in json.loads(rv_eps[0]['description'])['memo'])
    check('드라이브: 음성메모 → <작품>/음성메모/', len(mf) == 1 and mf[0]['name'] == '음성메모' and mf[0]['parents'] == [rv['id']] and len(memos) == 1 and memos[0]['parents'] == [mf[0]['id']] and memos[0]['bytes'] > 1000, memos[0]['name'] if memos else '')
    sheets = drive.by('sheet'); pfs = drive.by('photofolder'); phs = drive.by('photo'); com = drive.by('common')
    lsh = [x for x in sheets if x['name'] == '회차 목록표' and x['parents'] == [rv['id']]]
    csh = [x for x in sheets if x['name'] == '인물·설정표' and x['parents'] == [rv['id']]]
    check('드라이브: 회차 목록표·인물·설정표 → 구글 시트', len(lsh) == 1 and len(csh) == 1 and lsh[0]['mimeType'] == 'application/vnd.google-apps.spreadsheet' and '가로등 아래 첫 만남' in lsh[0]['content'] and '서하' in csh[0]['content'] and '서하' in (rv.get('description') or ''), f'{len(sheets)} sheets, desc={rv.get("description")}')
    rv_pf = [x for x in pfs if x['parents'] == [rv['id']]]; com_pf = [x for x in pfs if com and x['parents'] == [com[0]['id']]]
    check('드라이브: 사진 → <작품>/아이디어 사진/, 공통/아이디어 사진/', len(rv_pf) == 1 and rv_pf[0]['name'] == '아이디어 사진' and len(com_pf) == 1 and com[0]['name'] == '공통' and len(phs) == 2 and any(x['parents'] == [rv_pf[0]['id']] and '옥상' in (x.get('description') or '') for x in phs) and all(x['mimeType'] in ('image/webp', 'image/jpeg') for x in phs), ', '.join(x['name'] for x in phs))
    check('동기화 후 상태 🟢', '드라이브 저장 완료' in pg.inner_text('#syncLine'), pg.inner_text('#syncLine'))
    pg.screenshot(path=SHOTS + 'desktop_11_synced.png')

    # 원격(ChatGPT·다른 기기)에서만 수정 → 받아오기 + 받기 전 기록
    ep1 = rv_eps[0]; cur_id = ep1['appProperties']['ywEpId']
    pg.locator(f'.ep[data-e="{cur_id}"] [data-act="open"]').click(); pg.wait_for_timeout(300)
    drive.remote_edit(ep1['id'], 'ChatGPT가 다듬은 첫 문단.\n\n' + ep1['content'])
    sync_now(pg); pg.wait_for_timeout(400)
    check('드라이브에서만 바뀜 → 기기로 받아옴', ed_val(pg).startswith('ChatGPT가 다듬은 첫 문단.\n\n' + PARA[0]))
    pg.click('#btnPanel'); pg.click('.panel-tabs [data-tab="hist"]'); pg.wait_for_timeout(300)
    check('받기 전에 기기 원고를 기록으로 남김', pg.locator('.hv .tag.before-pull').count() >= 1); pg.click('#btnPanelClose')
    # 양쪽 모두 수정 → 충돌, 몰래 덮어쓰지 않음
    drive.remote_edit(ep1['id'], '드라이브 쪽 수정본.\n' + drive.files[ep1['id']]['content'])
    remote_before = drive.files[ep1['id']]['content']
    type_end(pg, '\n기기 쪽 수정 문장.'); wait_saved(pg)
    sync_now(pg); pg.wait_for_timeout(500)
    check('충돌 감지: 배너 표시', pg.is_visible('.conflict-banner'))
    check('충돌 시 드라이브 원고를 덮어쓰지 않음', drive.files[ep1['id']]['content'] == remote_before)
    check('충돌 시 기기 원고도 그대로', ed_val(pg).endswith('기기 쪽 수정 문장.'))
    pg.click('#btnResolve'); pg.wait_for_selector('#dlg .diff')
    pg.screenshot(path=SHOTS + 'desktop_12_conflict.png')
    dlg_ok(pg, 'both'); pg.wait_for_timeout(1500); pg.wait_for_function("()=>window.__yw.syncState!=='syncing'", timeout=15000); pg.wait_for_timeout(500)
    eps = drive.by('episode'); rv_eps = sorted([e for e in eps if e['parents'] == [rv['id']]], key=lambda e: e['name'])
    copy = [e for e in rv_eps if '드라이브 사본' in e['name']]
    check('충돌 해결 「둘 다 보관」: 사본 회차 + 기기 버전 업로드', len(copy) == 1 and copy[0]['content'].startswith('드라이브 쪽 수정본.') and drive.files[ep1['id']]['content'].endswith('기기 쪽 수정 문장.') and not pg.is_visible('.conflict-banner'), ', '.join(e['name'] for e in rv_eps))
    # 오프라인 대기열 → 온라인 되면 업로드
    c.set_offline(True); pg.wait_for_timeout(200)
    type_end(pg, '\n지하철에서 쓴 문장.'); wait_saved(pg)
    queued = '지하철' not in drive.files[ep1['id']]['content']
    line_off = pg.inner_text('#syncLine')
    c.set_offline(False); pg.wait_for_timeout(2500); pg.wait_for_function("()=>window.__yw.syncState!=='syncing'", timeout=15000); pg.wait_for_timeout(500)
    check('오프라인 대기열 → 다시 연결되면 자동 업로드', queued and '자동 업로드' in line_off and drive.files[ep1['id']]['content'].endswith('지하철에서 쓴 문장.'), line_off)
    # 삭제 → 드라이브 휴지통
    w2 = pg.locator('.work', has=pg.locator('.wt', has_text='바람의 사수'))
    last = w2.locator('.ep').nth(2); del_id = last.get_attribute('data-e')
    last.locator('[data-act="epmenu"]').click(); dlg_ok(pg, 'del'); pg.wait_for_timeout(200); dlg_ok(pg); pg.wait_for_timeout(1800)
    sync_now(pg)
    trashed = [f for f in drive.files.values() if f.get('appProperties', {}).get('ywEpId') == del_id]
    check('회차 삭제 → 드라이브는 휴지통으로 (복구 가능)', len(trashed) == 1 and trashed[0].get('trashed') is True)
    tab(pg, 'vault'); pg.locator('.ph').last.click(); pg.wait_for_selector('#phCap'); dlg_ok(pg, 'del'); pg.wait_for_timeout(200); dlg_ok(pg); pg.wait_for_timeout(500)
    tab(pg, 'note'); sync_now(pg)
    check('사진 삭제(확인 후) → 드라이브 휴지통', len(drive.by('photo')) == 1 and any(f.get('trashed') and f.get('appProperties', {}).get('ywKind') == 'photo' for f in drive.files.values()))
    errors_all += [(pg._tag, e) for e in pg._errs]
    check('데스크톱 JS 오류 없음', not pg._errs, '; '.join(pg._errs[:5]))
    c.close()

    # =============== 새 기기 (PC에서 쓴 원고를 폰에서 이어 쓰기) ===============
    c2 = ctx_new(b, True, drive, splash=True); pg = page_new(c2, 'mobile')
    pg.goto(URL); pg.wait_for_selector('html.ready'); pg.wait_for_timeout(1600)
    check('시작 화면: 로고·마스코트·집필 시작하기', pg.is_visible('#splash') and pg.is_visible('.sp-stk') and '집필 시작하기' in pg.inner_text('#btnStart'))
    pg.screenshot(path=SHOTS + 'mobile_00_splash.png')
    pg.click('#btnStart'); pg.wait_for_timeout(700)
    check('시작하기 → 홈', not pg.is_visible('#splash') and pg.is_visible('#vHome'))
    pg.screenshot(path=SHOTS + 'mobile_00b_home.png')
    tab(pg, 'note')
    check('모바일: 가로 스크롤 없음 (빈 서재)', no_hscroll(pg))
    pg.screenshot(path=SHOTS + 'mobile_01_empty.png')
    pg.click('#btnSettings'); pg.fill('#setCid', '123456789-testclient.apps.googleusercontent.com'); pg.click('#setConnect')
    pg.wait_for_function("()=>window.__yw.syncState==='synced'", timeout=20000); pg.wait_for_timeout(600)
    titles = pg.locator('.wt').all_inner_texts()
    check('새 기기: 드라이브에서 작품·회차 내려받기', sorted(titles) == ['RE:VERSE', '바람의 사수'] and pg.locator('.ep').count() >= 4, ', '.join(titles))
    pg.screenshot(path=SHOTS + 'mobile_02_library.png')
    w_cast = pg.evaluate("()=>window.__yw.works.find(w=>w.title==='RE:VERSE').cast.map(r=>r.name).join(',')")
    st_ = pg.evaluate("()=>[...window.__yw.eps.values()].flat().map(e=>e.status+':'+(e.oneLine||'')).join('|')")
    check('새 기기: 인물·설정표·상태·한줄 메모도 받아옴', w_cast == '서하,수혁' and 'done:가로등 아래 첫 만남' in st_, f'{w_cast} / {st_}')
    nsh0 = len(drive.by('sheet')); pg.evaluate("()=>window.__yw.syncState"); pg.wait_for_timeout(1500)
    check('새 기기: 기존 시트를 이어 씀 (중복 생성 없음)', len(drive.by('sheet')) == nsh0 == 4, f'{nsh0}->{len(drive.by("sheet"))}')
    tab(pg, 'home'); pg.screenshot(path=SHOTS + 'mobile_02b_home.png'); check('모바일 홈 가로 스크롤 없음', no_hscroll(pg))
    tab(pg, 'works'); pg.locator('.wcard', has_text='RE:VERSE').click(); pg.wait_for_selector('table.tbl'); pg.screenshot(path=SHOTS + 'mobile_02c_list_table.png')
    check('모바일 목록표: 페이지 가로 스크롤 없음 (표만 스크롤)', no_hscroll(pg))
    tab(pg, 'my'); pg.screenshot(path=SHOTS + 'mobile_02d_my.png')
    tab(pg, 'vault'); pg.screenshot(path=SHOTS + 'mobile_02e_vault.png')
    tab(pg, 'note')
    pg.locator('.work', has=pg.locator('.wt', has_text='RE:VERSE')).locator('[data-act="toggle"]').click(); pg.wait_for_timeout(200)
    pg.locator('.work', has=pg.locator('.wt', has_text='RE:VERSE')).locator('.ep').first.locator('[data-act="open"]').click(); pg.wait_for_timeout(500)
    check('새 기기: 원고·제목 그대로', ed_val(pg).endswith('지하철에서 쓴 문장.') and pg.input_value('#epTitle') == '붉은 새벽')
    check('모바일: 편집 화면 가로 스크롤 없음', no_hscroll(pg))
    pg.screenshot(path=SHOTS + 'mobile_03_editor.png')
    pg.click('#btnPanel'); pg.wait_for_timeout(200); pg.screenshot(path=SHOTS + 'mobile_04_memo.png')
    check('모바일: 메모도 드라이브에서 받아옴', '12화 회수' in pg.input_value('#epMemo'))
    pg.click('#btnPanelClose')
    pg.click('#btnListen'); pg.wait_for_timeout(600); pg.screenshot(path=SHOTS + 'mobile_05_listen.png')
    check('모바일: 낭독 바가 화면 안에', pg.evaluate("()=>{const r=document.querySelector('#ttsBar').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}"))
    pg.click('#ttsStop')
    pg.click('#btnFocus'); pg.wait_for_timeout(300); pg.screenshot(path=SHOTS + 'mobile_06_focus.png'); pg.click('#btnFocus')
    pg.click('#btnBack'); pg.wait_for_timeout(300)
    check('모바일: ‹ 뒤로 → 목록 (하단 탭 다시 보임)', pg.is_visible('#workList') and not pg.is_visible('#editorView') and pg.is_visible('#tabs'))
    pg.locator('.ep [data-act="open"]').first.click(); pg.wait_for_timeout(300)
    check('모바일 편집 중에는 하단 탭 숨김 (차분한 노트)', not pg.is_visible('#tabs')); pg.click('#btnBack'); pg.wait_for_timeout(200)
    pg.click('#btnSettings'); pg.wait_for_timeout(200); pg.screenshot(path=SHOTS + 'mobile_07_settings.png'); dlg_ok(pg, 'cancel')
    errors_all += [(pg._tag, e) for e in pg._errs]
    check('모바일 JS 오류 없음', not pg._errs, '; '.join(pg._errs[:5]))
    c2.close()

    # =============== 음성 기능 미지원 브라우저 ===============
    c3 = ctx_new(b, True, None, offline_sr=True); pg = page_new(c3, 'nosr')
    pg.goto(URL); pg.wait_for_selector('html.ready'); new_work(pg, '조건반사적 복종')
    pg.click('#btnMic'); pg.wait_for_timeout(300)
    check('받아쓰기 미지원 → 친절한 안내', '지원하지 않아요' in pg.inner_text('#toast') and not pg.is_visible('#micBar'))
    pg.screenshot(path=SHOTS + 'mobile_08_stt_unsupported.png')
    # 라이트 테마
    pg.click('#btnBack'); pg.click('#btnSettings'); pg.select_option('#setTheme', 'dark'); dlg_ok(pg); pg.wait_for_timeout(300)
    pg.locator('.ep [data-act="open"]').first.click(); type_end(pg, '밤 테마에서 쓰는 문장.'); wait_saved(pg)
    pg.screenshot(path=SHOTS + 'mobile_09_dark_editor.png')
    pg.click('#btnBack'); tab(pg, 'home'); pg.screenshot(path=SHOTS + 'mobile_10_dark_home.png')
    errors_all += [(pg._tag, e) for e in pg._errs]
    check('미지원 브라우저 JS 오류 없음', not pg._errs, '; '.join(pg._errs[:5]))
    c3.close()

    # =============== PWA 설치 가능 여부 ===============
    c4 = b.new_context(); pg = c4.new_page(); pg.goto(URL); pg.wait_for_selector('html.ready')
    man = pg.evaluate("async()=>{const r=await fetch(document.querySelector('link[rel=manifest]').href);return r.json()}")
    icons_ok = pg.evaluate("async(ic)=>{for(const i of ic){const r=await fetch(i.src);if(!r.ok)return false}return true}", man['icons'])
    check('PWA 매니페스트: 이름·standalone·192/512/maskable 아이콘', man['display'] == 'standalone' and icons_ok and {'192x192', '512x512'} <= {i['sizes'] for i in man['icons']} and any(i.get('purpose') == 'maskable' for i in man['icons']))
    if LIVE:
        pg.wait_for_timeout(1500)
        swok = pg.evaluate("async()=>{const r=await navigator.serviceWorker.getRegistration();return !!(r&&(r.active||r.installing||r.waiting))}")
        check('서비스워커 등록', swok)
        pg.reload(); pg.wait_for_timeout(1500)
        c4.set_offline(True); pg.reload(); pg.wait_for_selector('html.ready', timeout=10000)
        check('오프라인에서 앱 열림 (서비스워커 캐시)', pg.is_visible('#splash') or pg.is_visible('#vHome'))
        c4.set_offline(False)
        al = pg.evaluate("async()=>{const r=await fetch('https://lee860506-tech.github.io/.well-known/assetlinks.json');return r.json()}")
        check('안드로이드 앱 연결 (assetlinks.json)', any(x['target']['package_name'] == 'com.lee860506.jipilsil' for x in al))
    c4.close()
    b.close()

print('\n==== 결과: %d/%d 통과 ====' % (sum(1 for r in results if r[1]), len(results)))
for r in results:
    if not r[1]: print('  FAIL', r[0], r[2])
json.dump([{'name': n, 'ok': o, 'info': i} for n, o, i in results], open(SHOTS + 'results.json', 'w'), ensure_ascii=False, indent=1)
sys.exit(0 if all(r[1] for r in results) else 1)
