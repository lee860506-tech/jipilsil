# AI 작업실 (가져오기·분류·비교·작법 교재·동기화·백업) 회귀 테스트: python3 test/run_ai.py URL
import sys, re, json, os, io, zipfile
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8797/'
SH = (sys.argv[2] if len(sys.argv) > 2 else '/workspace/yeonwol-note/shots') + '/ai_'
results = []
def check(name, ok, info=''):
    results.append((name, bool(ok))); print(('PASS' if ok else 'FAIL'), name, f'[{info}]' if info and not ok else '')

SAMPLE = """달빛 아래 2화 재독 결과입니다.

## 원문
준혁은 슬펐다. 그는 창밖을 보았다. 비가 내렸다.

"괜찮아." 그녀가 말했다.

## 수정본
준혁은 주먹을 쥐었다. 그는 창밖을 오래 보았다. 차가운 비가 유리창을 때렸다.

"괜찮아." 그녀가 말했다.

## 분석
- 감정을 직접 설명하던 문장을 신체 반응으로 바꿔 독자가 추론하게 했습니다.
- 감각 정보(차가운 비, 유리창 소리)를 더했습니다.
- 작가의 의도는 슬픔을 말하지 않고 보여주는 것입니다.
- 독자는 준혁의 분노로 해석할 수도 있습니다.
- 독서 경험: 장면의 몰입이 커집니다.

다음 회차에서는 고양이 장면을 더 써 주세요."""
ORIG = '준혁은 슬펐다. 그는 창밖을 보았다. 비가 내렸다.\n\n"괜찮아." 그녀가 말했다.'
E2 = '어젯밤 이야기.\n\n' + ORIG + '\n\n끝.'
SEED_V2 = """async(e2)=>{ // 예전(v2) 앱이 만든 것과 똑같은 저장소 + 원고·노트
  await new Promise(r=>{const x=indexedDB.deleteDatabase('jipilsil');x.onsuccess=x.onerror=x.onblocked=r});
  const q=indexedDB.open('jipilsil',2);
  q.onupgradeneeded=()=>{const d=q.result;d.createObjectStore('works',{keyPath:'id'});d.createObjectStore('episodes',{keyPath:'id'}).createIndex('workId','workId');
    d.createObjectStore('versions',{keyPath:'id'}).createIndex('episodeId','episodeId');d.createObjectStore('memos',{keyPath:'id'}).createIndex('episodeId','episodeId');
    for(const s of ['photos','bookmarks','tombstones','notes'])d.createObjectStore(s,{keyPath:'id'});d.createObjectStore('kv')};
  await new Promise(x=>q.onsuccess=x);const d=q.result;
  const t=d.transaction(['works','episodes','notes','kv'],'readwrite');
  t.objectStore('works').put({id:'w1',title:'달빛 아래',order:0,createdAt:1,updatedAt:1,dirty:true});
  t.objectStore('episodes').put({id:'e1',workId:'w1',order:0,text:'첫 회차 원고입니다.',title:'',createdAt:1,updatedAt:1,rev:1,dirty:true});
  t.objectStore('episodes').put({id:'e2',workId:'w1',order:1,text:e2,title:'비 오는 밤',createdAt:2,updatedAt:2,rev:1,dirty:true});
  t.objectStore('notes').put({id:'n1',type:'idea',title:'고양이 이름',body:'달래',createdAt:1,updatedAt:1,dirty:true});
  t.objectStore('kv').put({penName:'연월',theme:'light',fontSize:18},'settings');
  await new Promise(x=>t.oncomplete=x);d.close();return true}"""
IDB = """async([store])=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;
  if(!d.objectStoreNames.contains(store)){const v=d.version;d.close();return {missing:true,v}}
  const t=d.transaction(store).objectStore(store).getAll();await new Promise(x=>t.onsuccess=x);const r=t.result;const v=d.version;d.close();return {v,rows:r}}"""
def rows(pg, store): return pg.evaluate(IDB, [store]).get('rows', [])
def ctx(b, mobile, drive):
    vp = {'width': 360, 'height': 800} if mobile else {'width': 1440, 'height': 900}
    c = b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1, locale='ko-KR', permissions=['clipboard-read', 'clipboard-write'], accept_downloads=True)
    c.add_init_script("window.__YW_NO_SW = true; sessionStorage.setItem('jpsSplash','1');")
    c.route('https://www.googleapis.com/**', drive.handle)
    c.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body=GIS_STUB))
    pg = c.new_page(); pg._errs = []
    pg.on('pageerror', lambda e: pg._errs.append('PE ' + str(e)))
    pg.on('console', lambda m: m.type == 'error' and not re.search(r'favicon|ERR_INTERNET_DISCONNECTED|net::ERR|status of 500|fonts', m.text) and pg._errs.append('C ' + m.text))
    return c, pg
def tab(pg, t): pg.click(f'#tabs [data-tab="{t}"]'); pg.wait_for_timeout(250)
def wait_sync(pg): pg.wait_for_timeout(300); pg.wait_for_function("()=>window.__yw.syncState!=='syncing'", timeout=15000); pg.wait_for_timeout(400)
def sync(pg): pg.evaluate("()=>window.__yw.runSync ? window.__yw.runSync('manual') : document.querySelector('#btnSyncNow')?.click()"); wait_sync(pg)
def connect(pg):
    if pg.is_visible('#btnBack'): pg.click('#btnBack')
    if not pg.is_visible('#btnSettings'): tab(pg, 'note')
    pg.click('#btnSettings'); pg.fill('#setCid', '123456789-testclient.apps.googleusercontent.com'); pg.click('#setConnect')
    pg.wait_for_function("()=>!document.querySelector('#dlg').open", timeout=10000); wait_sync(pg)
def open_ai(pg):
    if pg.is_visible('#btnBack'): pg.click('#btnBack'); pg.wait_for_timeout(200)
    if pg.evaluate("window.__yw.tab") != 'note': tab(pg, 'note')
    pg.click('#btnAI'); pg.wait_for_selector('#aiw:not([hidden])')
def ai_tab(pg, t): pg.click(f'#aiw [data-at="{t}"]'); pg.wait_for_timeout(250)
def dlg_ok(pg, v='ok'): pg.click(f'#dlg button[value="{v}"]'); pg.wait_for_timeout(250)
def overlaps(pg, sel):
    bs = pg.evaluate("s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent).map(e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})", sel)
    for i in range(len(bs)):
        for j in range(i+1, len(bs)):
            a, c = bs[i], bs[j]
            if a[0] < c[2]-1 and c[0] < a[2]-1 and a[1] < c[3]-1 and c[1] < a[3]-1: return True
    return False
def hscroll(pg): return pg.evaluate("()=>{const b=document.querySelector('#aiwBody');return b.scrollWidth>b.clientWidth+2 || document.documentElement.scrollWidth>innerWidth+2}")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    drive = FakeDrive()
    for mob in (False, True):
        tag = 'mobile' if mob else 'pc'
        c, pg = ctx(b, mob, drive if not mob else FakeDrive())
        # ---- 0) 예전 데이터 그대로 열리는지 (v2 → v3 추가만) ----
        pg.goto(URL + 'manifest.webmanifest'); pg.evaluate(SEED_V2, E2)
        pg.goto(URL); pg.wait_for_selector('html.ready')
        info = pg.evaluate(IDB, ['aiwork'])
        check(f'[{tag}] DB 버전 3 · aiwork 저장소 추가', info.get('v') == 3 and not info.get('missing'), info.get('v'))
        eps = {e['id']: e for e in rows(pg, 'episodes')}
        check(f'[{tag}] 예전 원고 그대로', eps.get('e2', {}).get('text') == E2 and eps.get('e1', {}).get('text') == '첫 회차 원고입니다.')
        check(f'[{tag}] 예전 설계 노트 그대로', any(n['id'] == 'n1' and n['body'] == '달래' for n in rows(pg, 'notes')))
        check(f'[{tag}] 예전 설정(필명) 그대로', '연월' in pg.inner_text('#vHome'))
        # ---- 1) 가져오기 ----
        open_ai(pg)
        pg.fill('#aiRaw', SAMPLE); pg.click('#aiGo'); pg.wait_for_selector('#aiReview .ai-seg')
        cats = pg.eval_on_selector_all('.ai-seg [data-cat]', 'a=>a.map(s=>s.value)')
        heads = pg.eval_on_selector_all('.ai-seg', 'a=>a.map(s=>s.innerText.slice(0,30))')
        check(f'[{tag}] 섞인 답변을 조각으로 나눔 (≥4)', len(cats) >= 4, cats)
        check(f'[{tag}] 원문=소설 본문 · 수정본=재독 수정본 · 분석=작법 · 지시=메모', 'body' in cats and 'rev' in cats and 'theory' in cats and cats[-1] == 'memo', list(zip(cats, heads)))
        check(f'[{tag}] 작품·회차 짐작 (달빛 아래 · 2화)', pg.eval_on_selector('#dWork', 'e=>e.value') == 'w1' and pg.eval_on_selector('#dEp', 'e=>e.value') == 'e2')
        check(f'[{tag}] 자료 유형 짐작 = 수정본', pg.eval_on_selector('#dType', 'e=>e.value') == '수정본')
        check(f'[{tag}] 가져온 날짜 기본 오늘', re.match(r'\d{4}-\d\d-\d\d', pg.eval_on_selector('#dDate', 'e=>e.value') or ''))
        check(f'[{tag}] 원문 미리보기', '고양이 장면' in pg.text_content('#aiReview .ai-prev pre'))
        if not mob: pg.screenshot(path=SH + 'pc_import.png')
        else: pg.screenshot(path=SH + 'mobile_import.png', full_page=False)
        check(f'[{tag}] 가져오기 화면 가로 넘침 없음', not hscroll(pg))
        # 짐작 고치기: 첫 조각 종류 바꾸기
        pg.select_option('.ai-seg >> nth=0 >> [data-cat]', 'memo')
        pg.click('#dSave'); pg.wait_for_timeout(400)
        ims = [r for r in rows(pg, 'aiwork') if r['kind'] == 'import']
        check(f'[{tag}] 자료 저장 (원문 + 조각 따로)', len(ims) == 1 and ims[0]['raw'].startswith('달빛 아래') and len(ims[0]['segments']) >= 4 and ims[0]['segments'][0]['cat'] == 'memo')
        check(f'[{tag}] 저장해도 원고는 그대로', {e['id']: e['text'] for e in rows(pg, 'episodes')}.get('e2') == E2)
        # 중복
        ai_tab(pg, 'import'); pg.fill('#aiRaw', SAMPLE + '\n'); pg.click('#aiGo'); pg.wait_for_selector('#aiReview .ai-warn')
        check(f'[{tag}] 같은 내용이면 중복 경고', '이미 가져온 자료' in pg.inner_text('#aiReview .ai-warn'))
        pg.click('#dSave'); pg.wait_for_selector('#dlg[open]'); dlg_ok(pg, 'cancel')
        check(f'[{tag}] 중복 저장 취소하면 안 생김', len([r for r in rows(pg, 'aiwork') if r['kind'] == 'import']) == 1)
        # 작품 모르는 글 → 미분류
        pg.click('#dCancel'); pg.fill('#aiRaw', '바다가 보이는 언덕에서 그는 오래 서 있었다. 바람이 불었다. 그는 대답하지 않았다.'); pg.click('#aiGo'); pg.wait_for_selector('#aiReview .ai-seg')
        check(f'[{tag}] 작품을 못 찾으면 미분류 안내', '미분류 자료' in pg.inner_text('#aiReview .ai-guess') and pg.eval_on_selector('#dWork', 'e=>e.value') == '')
        pg.click('#dSave'); pg.wait_for_timeout(400)
        un = [r for r in rows(pg, 'aiwork') if r['kind'] == 'import' and r.get('unsorted')]
        check(f'[{tag}] 미분류로 저장 (아무 회차에도 안 들어감)', len(un) == 1 and un[0]['workId'] is None and un[0]['episodeId'] is None)
        check(f'[{tag}] 자료함 미분류 칩', '미분류 1' in pg.inner_text('#aiwBody .chips'))
        # TXT 파일
        ai_tab(pg, 'import')
        pg.set_input_files('#aiFileIn', files=[{'name': '달빛 아래 1화 메모.txt', 'mimeType': 'text/plain', 'buffer': '\ufeff1화 메모\r\n\r\n다음 장면에서는 비를 멈추게 해 주세요.'.encode('utf-8')}])
        pg.wait_for_selector('#aiReview .ai-seg')
        check(f'[{tag}] TXT 파일 열기 + 파일 이름으로 회차 짐작', pg.eval_on_selector('#dEp', 'e=>e.value') == 'e1' and '비를 멈추게' in pg.input_value('#aiRaw'))
        pg.click('#dCancel')
        # ---- 3) 비교 ----
        ai_tab(pg, 'lib'); pg.locator('.ai-item', has_text='달빛 아래').first.click(); pg.wait_for_selector('#dCmp'); pg.click('#dCmp'); pg.wait_for_selector('.cmp-2')
        cmp = [r for r in rows(pg, 'aiwork') if r['kind'] == 'compare'][0]
        check(f'[{tag}] 비교 만들기: 원문·수정본 채워짐', cmp['original'] == ORIG and '주먹을 쥐었다' in cmp['revision'])
        check(f'[{tag}] 분석에서 칸 미리 채움 (감정/감각/경험)', bool(cmp['analysis'].get('sensory')) and bool(cmp['analysis'].get('experience')) and bool(cmp['analysis'].get('emotion') or cmp['analysis'].get('body')))
        check(f'[{tag}] 작가 의도 / 독자 해석 따로', '의도' in (cmp.get('intent') or '') and '독자' in (cmp.get('reading') or ''))
        check(f'[{tag}] 낱말 단위 표시 (원문 삭제·수정 추가)', pg.locator('#colA .hk.d-a').count() >= 2 and '슬펐다' in pg.inner_text('#colA .hk.d-a >> nth=0'))
        fl = pg.inner_text('.ai-flags')
        check(f'[{tag}] 중립 표시: 감정 직접어 1→0, 감각어 증가', bool(re.search(r'감정 직접어\s*1\s*0', fl)) and '－슬펐' in fl and '＋차가' in fl, fl[:300])
        boxes = pg.evaluate("()=>[...document.querySelectorAll('.cmp-col')].map(e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})")
        if mob: check(f'[mobile] 원문·수정본 위아래로 (겹침 없음)', boxes[0][3] <= boxes[1][1] + 1 and boxes[1][2] <= 361, boxes)
        else: check(f'[pc] 원문·수정본 나란히', abs(boxes[0][1] - boxes[1][1]) < 2 and boxes[0][2] <= boxes[1][0])
        check(f'[{tag}] 비교 화면 겹침·가로 넘침 없음', not overlaps(pg, '.cmp-col, .ai-flags, .ai-fields .fld') and not hscroll(pg))
        pg.screenshot(path=SH + f'{tag}_compare.png', full_page=False)
        # 부분 채택
        pg.check('input[name=cDec][value=partial]'); pg.wait_for_selector('.hk-list')
        n_h = pg.locator('[data-pick]').count()
        pg.locator('.hk-row', has_text='오래').locator('[data-pick]').uncheck(); pg.wait_for_timeout(150)
        check(f'[{tag}] 부분 채택: 덩어리마다 고르기 ({n_h}개)', n_h >= 3 and pg.locator('#colB .hk.picked-a').count() == 1)
        el = pg.locator('.ai-fields textarea[data-an=clarity]'); el.fill('정보가 행동으로 옮겨짐')
        pg.fill('#cIntent', (pg.input_value('#cIntent') + '\n말하지 않고 보여주기').strip())
        e2_before = {e['id']: e['text'] for e in rows(pg, 'episodes')}['e2']
        check(f'[{tag}] 고르기만 하면 원고 그대로', e2_before == E2)
        if mob: pg.screenshot(path=SH + 'mobile_partial.png', full_page=False)
        # 원고 반영 (확인창 → 취소 → 그대로)
        pg.click('#cApply'); pg.wait_for_selector('#dlg[open]')
        check(f'[{tag}] 반영 전 확인창 (수정 기록 안내)', '수정 기록' in pg.inner_text('#dlg'))
        dlg_ok(pg, 'cancel')
        check(f'[{tag}] 확인창 취소 → 원고 그대로', {e['id']: e['text'] for e in rows(pg, 'episodes')}['e2'] == E2)
        pg.click('#cApply'); pg.wait_for_selector('#dlg[open]'); dlg_ok(pg, 'ok')
        pg.wait_for_selector('#editorView:not([hidden])'); pg.wait_for_timeout(600)
        t2 = {e['id']: e['text'] for e in rows(pg, 'episodes')}['e2']
        check(f'[{tag}] 반영: 고른 곳만 바뀌고 앞뒤 원고 보존', t2.startswith('어젯밤 이야기.\n\n준혁은 주먹을 쥐었다. 그는 창밖을 보았다.') and t2.endswith('\n\n끝.') and '차가운 비가 유리창을 때렸다' in t2, t2)
        vs = [v for v in rows(pg, 'versions') if v['episodeId'] == 'e2' and v['reason'] == 'before-revise']
        check(f'[{tag}] 반영 전 원고가 수정 기록에', any(v['text'] == E2 for v in vs))
        pg.click('#toast .t-act'); pg.wait_for_timeout(700)
        check(f'[{tag}] 되돌리기 → 원래 원고', {e['id']: e['text'] for e in rows(pg, 'episodes')}['e2'] == E2)
        # ---- 4) 작법 교재 ----
        open_ai(pg); ai_tab(pg, 'cmp'); pg.locator('.ai-item').first.click(); pg.wait_for_selector('#cLesson'); pg.click('#cLesson'); pg.wait_for_selector('[data-lf=excerpt]')
        ls = [r for r in rows(pg, 'aiwork') if r['kind'] == 'lesson']
        L = ls[0] if ls else {}
        check(f'[{tag}] 교안 초안 (번호·제목·목표·발췌·변경·이론)', L.get('no') == 1 and L.get('title') and L.get('goal') and '슬펐다' in (L.get('excerpt') or '') and '→' in (L.get('change') or '') and L.get('theory'), L)
        check(f'[{tag}] 교안: 작품·회차 연결 + 주제 태그', L.get('episodeId') == 'e2' and len(L.get('tags') or []) >= 1)
        pg.fill('[data-lf=final]', '부분 채택: 오래는 빼기로'); pg.fill('#lTags', '감정 표현, 신체·행동'); pg.click('#lSave'); pg.wait_for_timeout(400)
        pg.click('#lNew'); pg.wait_for_selector('#lTitle'); pg.fill('#lTitle', '대사 리듬 연습'); pg.fill('#lTags', '대사'); pg.click('#lSave'); pg.wait_for_timeout(400)
        check(f'[{tag}] 교안 목록 2개', pg.locator('#aiwBody .ai-item').count() == 2)
        pg.fill('#lQ', '2화'); pg.wait_for_timeout(500)
        check(f'[{tag}] 회차로 검색', pg.locator('#aiwBody .ai-item').count() == 1)
        pg.fill('#lQ', ''); pg.wait_for_timeout(500); pg.click('[data-t="대사"]'); pg.wait_for_timeout(200)
        check(f'[{tag}] 주제로 거르기', pg.locator('#aiwBody .ai-item').count() == 1 and '대사 리듬' in pg.inner_text('#aiwBody .ai-list'))
        pg.click('[data-t=""]'); pg.wait_for_timeout(200)
        with pg.expect_download() as dl: pg.click('#lMd')
        md = open(dl.value.path(), encoding='utf-8').read()
        check(f'[{tag}] Markdown 내보내기', md.startswith('# 작법 교재') and '## 1.' in md and '### 원문 발췌' in md and '> ' in md)
        with pg.expect_download() as dl: pg.click('#lTxt')
        tx = open(dl.value.path(), encoding='utf-8-sig').read()
        check(f'[{tag}] TXT 내보내기', '작법 교재' in tx and '원문 발췌' in tx and '##' not in tx)
        pg.screenshot(path=SH + f'{tag}_lessons.png', full_page=False)
        # ---- 백업 ZIP ----
        pg.click('#aiwClose'); tab(pg, 'note')
        if pg.is_visible('#btnBack'): pg.click('#btnBack')
        pg.click('#btnSettings'); pg.wait_for_selector('#setBackup')
        with pg.expect_download() as dl: pg.click('#setBackup')
        zpath = f'/tmp/ai_backup_{tag}.zip'; dl.value.save_as(zpath); z = zipfile.ZipFile(zpath); names = z.namelist()
        dlg_ok(pg, 'cancel') if pg.is_visible('#dlg[open] button[value=cancel]') else pg.keyboard.press('Escape')
        aij = json.loads(z.read('집필실_AI작업.json').decode()) if '집필실_AI작업.json' in names else {}
        check(f'[{tag}] 백업 ZIP: 원고 TXT + AI 작업 JSON', any(n.endswith('.txt') for n in names) and len(aij.get('items', [])) == 5, names)
        # 같은 기기에 복원 → 바뀌는 것 없음 / 하나 고친 뒤 복원 → 사본
        open_ai(pg); ai_tab(pg, 'lib')
        pg.set_input_files('#aiRestoreIn', zpath); pg.wait_for_timeout(500)
        check(f'[{tag}] 같은 백업 복원 → 덮어쓰지 않음', len(rows(pg, 'aiwork')) == 5 and not pg.is_visible('#dlg[open]'))
        pg.close(); c.close()
        if not mob: zip_pc = zpath
        else:
            # 새 기기(빈 상태)에 PC 백업 복원
            c2, p2 = ctx(b, True, FakeDrive()); p2.goto(URL); p2.wait_for_selector('html.ready'); open_ai(p2); ai_tab(p2, 'lib')
            p2.set_input_files('#aiRestoreIn', zip_pc); p2.wait_for_selector('#dlg[open]'); dlg_ok(p2, 'ok'); p2.wait_for_timeout(500)
            check('[새 기기] 백업 ZIP에서 AI 작업 5개 복원 · 원고는 안 건드림', len(rows(p2, 'aiwork')) == 5 and len(rows(p2, 'episodes')) == 0)
            check('[새 기기] JS 오류 없음', not p2._errs, p2._errs[:3]); c2.close()
        check(f'[{tag}] JS 오류 없음', not pg._errs, pg._errs[:3])

    # ---- 6) 드라이브 동기화: 두 기기, 충돌은 사본 ----
    d = FakeDrive()
    cA, A = ctx(b, False, d); A.goto(URL + 'manifest.webmanifest'); A.evaluate(SEED_V2, E2); A.goto(URL); A.wait_for_selector('html.ready'); connect(A)
    open_ai(A); A.fill('#aiRaw', SAMPLE); A.click('#aiGo'); A.wait_for_selector('#dSaveCmp'); A.click('#dSaveCmp'); A.wait_for_selector('.cmp-2'); A.click('#cSave'); A.wait_for_timeout(300)
    A.click('#aiwClose'); sync(A)
    files = d.by('aiwork')
    rj = json.loads(files[0]['content']) if files else {}
    check('[동기화] 「AI 작업.json」 따로 올라감', len(files) == 1 and files[0]['name'] == 'AI 작업.json' and len(rj.get('items', [])) == 2)
    check('[동기화] 설계 노트 파일도 그대로', len(d.by('notes')) == 1)
    check('[동기화] AI 기록은 원고 파일에 안 섞임', all('주먹을 쥐었다' not in (f.get('content') or '') for f in d.files.values() if f.get('appProperties', {}).get('ywKind') not in ('aiwork',)) )
    cB, B = ctx(b, True, d); B.goto(URL); B.wait_for_selector('html.ready'); connect(B); sync(B)
    rb = rows(B, 'aiwork')
    check('[동기화] 폰에서 받음 (자료+비교)', len(rb) == 2 and all(not r.get('dirty') for r in rb))
    # 양쪽에서 같은 비교 기록을 고침
    cid = [r for r in rb if r['kind'] == 'compare'][0]['id']
    for P, txt in ((A, 'PC에서 고친 메모'), (B, '폰에서 고친 메모')):
        P.evaluate("""async([id,t])=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;const s=d.transaction('aiwork','readwrite').objectStore('aiwork');
          const g=s.get(id);await new Promise(x=>g.onsuccess=x);const r=g.result;r.intent=t;r.dirty=true;r.updatedAt=Date.now();s.put(r);await new Promise(x=>s.transaction.oncomplete=x);d.close()}""", [cid, txt])
    sync(A); sync(B); sync(A)
    ra, rb = rows(A, 'aiwork'), rows(B, 'aiwork')
    ints = lambda rs: sorted(r.get('intent') for r in rs if r['kind'] == 'compare')
    check('[동기화] 양쪽 수정 → 덮지 않고 둘 다 남김', ints(ra) == ints(rb) == ['PC에서 고친 메모', '폰에서 고친 메모'], (ints(ra), ints(rb)))
    check('[동기화] 원고는 그대로', {e['id']: e['text'] for e in rows(B, 'episodes')}.get('e2') == E2)
    # 지우기도 맞춰짐
    B.evaluate("""async(id)=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;const t=d.transaction(['aiwork','kv'],'readwrite');t.objectStore('aiwork').delete(id);
      const g=t.objectStore('kv').get('aiDel');g.onsuccess=()=>{const v=g.result||{};v[id]=Date.now();t.objectStore('kv').put(v,'aiDel')};await new Promise(x=>t.oncomplete=x);d.close()}""", [r for r in rb if r['kind'] == 'import'][0]['id'])
    sync(B); sync(A)
    check('[동기화] 지운 자료는 다른 기기에서도 지워짐', len([r for r in rows(A, 'aiwork') if r['kind'] == 'import']) == 0)
    check('[동기화] JS 오류 없음', not A._errs and not B._errs, (A._errs + B._errs)[:3])
    cA.close(); cB.close(); b.close()
ok = sum(1 for _, x in results if x); print(f'==== {ok}/{len(results)} passed ====')
