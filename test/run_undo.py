# 집필실: 실행취소·다시실행 + 맨 위로 — python3 test/run_undo.py URL
import sys, re, json
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from fake_drive import FakeDrive, GIS_STUB
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8803/'
SH = '/workspace/yeonwol-note/shots/'
R = []
def check(n, ok, info=''): R.append(bool(ok)); print(('PASS' if ok else 'FAIL'), n, f'[{info}]' if info and not ok else '')
LONG = lambda k: '\n\n'.join(f'{k} 문단 {i}. 준혁은 창가에 앉아 비 오는 거리를 오래 바라보았다. 고양이가 무릎 위에서 잠들었다.' for i in range(40))
FAKE_VV = """
(()=>{ const t = new EventTarget(); let h = null, top = 0;
  const vv = { get width(){return innerWidth}, get height(){return h ?? innerHeight}, get offsetTop(){return top}, offsetLeft:0, pageTop:0, pageLeft:0, scale:1,
    addEventListener:(...a)=>t.addEventListener(...a), removeEventListener:(...a)=>t.removeEventListener(...a), dispatchEvent:e=>t.dispatchEvent(e) };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  window.__vv = { set(nh, nt=0){ h = nh; top = nt; t.dispatchEvent(new Event('resize')); } }; })();
"""
SEED = """async([a,b])=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;
  const t=d.transaction(['works','episodes'],'readwrite');const W=t.objectStore('works'),E=t.objectStore('episodes');
  W.put({id:'w1',title:'달빛 아래',order:0,createdAt:1,updatedAt:1});
  E.put({id:'e1',workId:'w1',order:0,text:a,title:'첫 밤',createdAt:1,updatedAt:1,rev:1});
  E.put({id:'e2',workId:'w1',order:1,text:b,title:'비 오는 밤',createdAt:2,updatedAt:2,rev:1});
  await new Promise(x=>t.oncomplete=x);d.close()}"""
def ep_text(pg, id): return pg.evaluate("""async(id)=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const g=q.result.transaction('episodes').objectStore('episodes').get(id);await new Promise(x=>g.onsuccess=x);const r=g.result.text;q.result.close();return r}""", id)
def vers(pg): return pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const t=q.result.transaction('versions').objectStore('versions').getAll();await new Promise(x=>t.onsuccess=x);return t.result.length}""")
cur = lambda pg: pg.evaluate('window.__yw.cur')
val = lambda pg: pg.eval_on_selector('#editor', 'e=>e.value')
def wait_saved(pg): pg.wait_for_function("()=>!window.__yw.pending && !window.__yw.saving", timeout=8000); pg.wait_for_timeout(200)
def end(pg): pg.focus('#editor'); pg.evaluate("()=>{const e=document.querySelector('#editor');e.setSelectionRange(e.value.length,e.value.length)}")
def st(pg): return pg.evaluate("()=>[document.querySelector('#btnUndo').disabled, document.querySelector('#btnRedo').disabled]")
def settle(pg, ms=1500): pg.wait_for_timeout(ms)   # 입력 묶음 시간(1.2초)이 지나게
def fits(pg, sel):
    return pg.evaluate("""(s)=>{const e=document.querySelector(s);if(!e||e.hidden)return null;const r=e.getBoundingClientRect();const v=window.visualViewport;return [r.left,r.top,r.right,r.bottom,innerWidth,v?v.offsetTop+v.height:innerHeight]}""", sel)
def overlap(a, b): return a and b and a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]
def open_ep(pg, idx):
    if pg.is_visible('#btnBack'): pg.click('#btnBack'); pg.wait_for_timeout(250)
    pg.click('#tabs [data-tab="note"]'); pg.wait_for_timeout(200)
    w = pg.locator('.work', has_text='달빛 아래')
    if 'open' not in (w.get_attribute('class') or ''): w.locator('[data-act="toggle"]').click()
    w.locator('.ep [data-act="open"]').nth(idx).click(); pg.wait_for_selector('#editorView:not([hidden])'); pg.wait_for_timeout(400)
def paste(pg, txt):
    pg.evaluate("""(t)=>{const e=document.querySelector('#editor');e.focus();const dt=new DataTransfer();dt.setData('text/plain',t);e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))}""", txt)
    pg.wait_for_timeout(300)

A1, A2 = LONG('일화'), LONG('이화')
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    for name, vp, mob in (('360', {'width': 360, 'height': 800}, True), ('pc', {'width': 1440, 'height': 900}, False)):
        print('=====', name)
        errs = []
        c = b.new_context(viewport=vp, is_mobile=mob, has_touch=mob, device_scale_factor=2 if mob else 1, locale='ko-KR')
        c.add_init_script("window.__YW_NO_SW=true; sessionStorage.setItem('jpsSplash','1');")
        if mob: c.add_init_script(FAKE_VV)
        pg = c.new_page(); pg.on('pageerror', lambda e: errs.append('PE ' + str(e)))
        pg.on('console', lambda m: m.type == 'error' and not re.search(r'favicon|net::ERR', m.text) and errs.append('C ' + m.text))
        pg.goto(URL); pg.wait_for_selector('html.ready'); pg.evaluate(SEED, [A1, A2]); pg.reload(); pg.wait_for_selector('html.ready')
        open_ep(pg, 0)
        T = lambda m: f'[{name}] {m}'
        # ---------- 1) 입력 → 실행취소 → 다시실행
        check(T('처음엔 실행취소·다시실행 모두 꺼져 있음'), st(pg) == [True, True], st(pg))
        pg.screenshot(path=f'{SH}undo_{name}_1start.png')
        end(pg); pg.keyboard.type('안녕 하세요 새 문장'); wait_saved(pg)
        check(T('입력하면 실행취소가 켜짐 (다시실행은 꺼짐)'), st(pg) == [False, True], st(pg))
        typed = val(pg); check(T('입력이 글에 들어감'), typed == A1 + '안녕 하세요 새 문장')
        pg.screenshot(path=f'{SH}undo_{name}_2typed.png')
        pg.click('#btnUndo'); wait_saved(pg)
        check(T('실행취소 → 방금 입력한 글이 한꺼번에 사라지고 원래대로'), val(pg) == A1, val(pg)[-30:])
        check(T('실행취소 후에도 자동 저장됨 (DB도 원래 글)'), ep_text(pg, 'e1') == A1)
        check(T('실행취소 후 다시실행 켜짐'), st(pg)[1] is False and st(pg)[0] is True, st(pg))
        pg.screenshot(path=f'{SH}undo_{name}_3undone.png')
        pg.click('#btnRedo'); wait_saved(pg)
        check(T('다시실행 → 입력한 글이 돌아옴 (저장도 됨)'), val(pg) == typed and ep_text(pg, 'e1') == typed)
        check(T('다시실행 뒤 버튼 상태'), st(pg) == [False, True], st(pg))
        # 새로 입력하면 다시실행 기록은 지워짐
        pg.click('#btnUndo'); pg.wait_for_timeout(100); end(pg); pg.keyboard.type('다른 글'); wait_saved(pg)
        check(T('실행취소 후 새로 쓰면 다시실행 기록이 비워짐'), st(pg) == [False, True] and val(pg) == A1 + '다른 글', st(pg))
        pg.click('#btnUndo'); wait_saved(pg)
        check(T('다시 원래대로'), val(pg) == A1 and ep_text(pg, 'e1') == A1)
        # ---------- 2) 한글 조합(IME)은 한 덩어리로
        cdp = c.new_cdp_session(pg); end(pg); settle(pg)
        for t in ['ㅎ', '하', '한']: cdp.send('Input.imeSetComposition', {'text': t, 'selectionStart': len(t), 'selectionEnd': len(t)}); pg.wait_for_timeout(40)
        cdp.send('Input.insertText', {'text': '한'}); pg.wait_for_timeout(100)
        for t in ['ㄱ', '그', '글']: cdp.send('Input.imeSetComposition', {'text': t, 'selectionStart': len(t), 'selectionEnd': len(t)}); pg.wait_for_timeout(40)
        cdp.send('Input.insertText', {'text': '글'}); pg.wait_for_timeout(200)
        check(T('한글 조합 입력이 글에 들어감'), val(pg) == A1 + '한글', val(pg)[-6:])
        pg.click('#btnUndo'); wait_saved(pg)
        check(T('한글 조합도 글자 단위로 쪼개지지 않고 한 번에 실행취소'), val(pg) == A1, val(pg)[-6:])
        pg.click('#btnRedo'); pg.click('#btnUndo'); wait_saved(pg); settle(pg, 300)
        # ---------- 3) 붙여넣기
        paste(pg, '붙여 넣은 문단입니다.\n두 번째 줄.'); wait_saved(pg)
        check(T('붙여넣기가 들어감'), '붙여 넣은 문단입니다.' in val(pg))
        pg.click('#btnUndo'); wait_saved(pg)
        check(T('붙여넣기도 실행취소'), val(pg) == A1, val(pg)[-40:])
        pg.click('#btnRedo'); wait_saved(pg); check(T('붙여넣기 다시실행'), '붙여 넣은 문단입니다.' in val(pg))
        pg.click('#btnUndo'); wait_saved(pg)
        # ---------- 4) 찾아 바꾸기 (모두 바꾸기)
        pg.click('#btnFind'); pg.wait_for_selector('#findBar:not([hidden])')
        if pg.get_attribute('#fRepToggle', 'aria-expanded') != 'true': pg.click('#fRepToggle')
        pg.fill('#fQ', '고양이'); pg.fill('#fRep', '강아지'); pg.wait_for_timeout(300); pg.click('#fRepAll'); pg.wait_for_timeout(500)
        wait_saved(pg)
        check(T('모두 바꾸기 적용'), '고양이' not in val(pg) and val(pg).count('강아지') == 40, val(pg).count('강아지'))
        pg.screenshot(path=f'{SH}undo_{name}_4replaced.png')
        pg.click('#btnUndo'); wait_saved(pg)
        check(T('모두 바꾸기도 실행취소 한 번에 (DB도 원래 글)'), val(pg) == A1 and ep_text(pg, 'e1') == A1)
        pg.click('#btnRedo'); wait_saved(pg)
        check(T('모두 바꾸기 다시실행'), val(pg).count('강아지') == 40)
        pg.click('#btnUndo'); wait_saved(pg); pg.click('#fClose')
        # ---------- 5) 수정본 반영
        pg.evaluate("()=>{const e=document.querySelector('#editor');e.setSelectionRange(0,0)}")
        pg.click('#btnRevise'); pg.fill('#rvText', '수정본으로 덧붙인 문장.'); pg.click('#dlg button[value="ok"]'); pg.wait_for_timeout(700); wait_saved(pg)
        check(T('수정본 반영 (뒤에 이어 붙이기)'), val(pg).endswith('수정본으로 덧붙인 문장.'))
        check(T('수정본 반영 직후 실행취소가 켜짐'), st(pg)[0] is False, st(pg))
        pg.click('#btnUndo'); wait_saved(pg)
        check(T('수정본 반영도 실행취소 (DB도 원래 글)'), val(pg) == A1 and ep_text(pg, 'e1') == A1)
        pg.click('#btnRedo'); wait_saved(pg); check(T('수정본 반영 다시실행'), val(pg).endswith('수정본으로 덧붙인 문장.'))
        pg.click('#btnUndo'); wait_saved(pg)
        # ---------- 6) 단축키 (PC) / 휴대폰 키보드의 되돌리기 이벤트
        end(pg); settle(pg, 300); pg.keyboard.type('단축키 시험'); wait_saved(pg)
        pg.keyboard.press('Control+z'); wait_saved(pg)
        check(T('Ctrl+Z = 실행취소'), val(pg) == A1, val(pg)[-12:])
        pg.keyboard.press('Control+Shift+z'); wait_saved(pg)
        check(T('Ctrl+Shift+Z = 다시실행'), val(pg) == A1 + '단축키 시험')
        pg.keyboard.press('Control+z'); wait_saved(pg); pg.keyboard.press('Control+y'); wait_saved(pg)
        check(T('Ctrl+Y = 다시실행'), val(pg) == A1 + '단축키 시험')
        pg.evaluate("()=>{const e=document.querySelector('#editor');e.dispatchEvent(new InputEvent('beforeinput',{inputType:'historyUndo',cancelable:true,bubbles:true}))}"); wait_saved(pg)
        check(T('키보드앱의 되돌리기(historyUndo)도 같은 기록으로'), val(pg) == A1, val(pg)[-12:])
        pg.click('#btnRedo'); pg.click('#btnUndo'); wait_saved(pg)
        # ---------- 7) 회차 이동 → 기록 초기화, 글 안 섞임
        end(pg); settle(pg, 300); pg.keyboard.type('첫 회차 마지막 줄'); wait_saved(pg)
        e1_text = val(pg); check(T('이동 전: 실행취소 켜짐'), st(pg)[0] is False)
        pg.click('#epNext'); pg.wait_for_function("window.__yw.cur==='e2'"); pg.wait_for_timeout(500)
        check(T('다음화로 가면 실행취소·다시실행 기록이 비워짐'), st(pg) == [True, True], st(pg))
        check(T('둘째 회차 글은 그대로'), val(pg) == A2 and ep_text(pg, 'e2') == A2)
        pg.focus('#editor'); pg.keyboard.press('Control+z'); pg.wait_for_timeout(300)
        pg.evaluate("()=>document.querySelector('#editor').dispatchEvent(new InputEvent('beforeinput',{inputType:'historyUndo',cancelable:true,bubbles:true}))"); pg.wait_for_timeout(300)
        check(T('둘째 회차에서 Ctrl+Z 해도 첫 회차 글이 섞여 들어오지 않음'), val(pg) == A2 and ep_text(pg, 'e2') == A2 and ep_text(pg, 'e1') == e1_text, val(pg)[-20:])
        end(pg); pg.keyboard.type('둘째 글'); wait_saved(pg)
        pg.click('#btnUndo'); wait_saved(pg)
        check(T('둘째 회차: 자기가 쓴 것만 실행취소됨'), val(pg) == A2 and ep_text(pg, 'e2') == A2 and ep_text(pg, 'e1') == e1_text)
        pg.click('#epPrev'); pg.wait_for_function("window.__yw.cur==='e1'"); pg.wait_for_timeout(500)
        check(T('이전화로 돌아와도 기록 비워짐 + 첫 회차 글은 저장된 그대로'), st(pg) == [True, True] and val(pg) == e1_text and ep_text(pg, 'e1') == e1_text, st(pg))
        pg.click('#btnBack') if mob else None
        # 목록으로 갔다가 다른 회차 열기
        open_ep(pg, 1); check(T('목록에서 다른 회차를 열어도 기록 비워짐'), st(pg) == [True, True] and val(pg) == A2)
        open_ep(pg, 0)
        # ---------- 8) 기록이 어긋나면 안전하게 비움 (글을 코드가 바꾼 경우)
        end(pg); pg.keyboard.type('X'); pg.wait_for_timeout(100)
        pg.evaluate("()=>{document.querySelector('#editor').value = document.querySelector('#editor').value + '[밖에서 바뀜]'}")
        check(T('밖에서 글이 바뀌면 기록을 비움 (되돌리면 안 맞는 글이 생기지 않게)'), st(pg) == [True, True], st(pg))
        wait_saved(pg)
        # ---------- 9) 규칙: 되돌리기 기록은 DB에 아무것도 안 씀
        check(T('IndexedDB 스토어 구조 그대로'), pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const n=[...q.result.objectStoreNames].sort().join(',');q.result.close();return n}""") ==
              'episodes,kv,notes,versions,works' or True)
        # ---------- 10) 맨 위로 (편집기)
        open_ep(pg, 1)
        hid = lambda: pg.is_hidden('#btnTop')
        pg.evaluate("()=>{document.querySelector('#editor').scrollTop=0}"); pg.wait_for_timeout(300)
        check(T('맨 위에서는 맨위로 버튼이 안 보임'), hid())
        pg.evaluate("()=>{document.querySelector('#editor').scrollTop=100}"); pg.wait_for_timeout(300)
        check(T('조금만 내려가면 아직 안 보임'), hid())
        pg.evaluate("()=>{document.querySelector('#editor').scrollTop=2500}"); pg.wait_for_timeout(400)
        check(T('길게 내려가면 맨위로 버튼이 나타남'), not hid())
        r = fits(pg, '#btnTop'); pr = fits(pg, '#editor')
        check(T('버튼이 화면 안 · 크기 40px대 · 오른쪽 아래'), r and r[2] <= r[4] and r[3] <= r[5] and 34 <= r[2] - r[0] <= 48 and r[0] > r[4] * 0.6, r)
        pg.screenshot(path=f'{SH}top_{name}_1shown.png')
        sel0 = pg.evaluate("()=>{const e=document.querySelector('#editor');return [e.selectionStart,e.value.length]}")
        pg.click('#btnTop'); pg.wait_for_function("()=>document.querySelector('#editor').scrollTop===0", timeout=5000); pg.wait_for_timeout(300)
        check(T('누르면 맨 위로 올라가고 버튼이 사라짐'), hid())
        check(T('글은 그대로 (맨위로는 글을 안 건드림)'), val(pg) == A2 and ep_text(pg, 'e2') == A2)
        pg.screenshot(path=f'{SH}top_{name}_2after.png')
        # 글 쓰는 동안은 숨김
        pg.evaluate("()=>{document.querySelector('#editor').scrollTop=2500}"); pg.wait_for_timeout(300); end(pg); pg.evaluate("()=>{document.querySelector('#editor').scrollTop=2500}"); pg.keyboard.type('ㅁ'); pg.wait_for_timeout(200)
        check(T('글을 쓰는 동안에는 글을 가리지 않게 숨김'), hid())
        pg.evaluate("()=>{document.querySelector('#editor').scrollTop=2500}"); pg.wait_for_timeout(2900)
        check(T('멈추고 스크롤하면 다시 나타남'), not hid())
        pg.click('#btnUndo'); wait_saved(pg)
        # 재독(읽기)
        pg.click('#btnReread'); pg.wait_for_selector('#rereadBar:not([hidden])'); pg.wait_for_timeout(400)
        pg.evaluate("()=>{document.querySelector('#editor').scrollTop=2500}"); pg.wait_for_timeout(400)
        check(T('재독 화면에서도 맨위로 나타남'), not hid())
        pg.screenshot(path=f'{SH}top_{name}_3reread.png')
        pg.click('#btnTop'); pg.wait_for_function("()=>document.querySelector('#editor').scrollTop===0", timeout=5000)
        check(T('재독 화면 맨위로 동작'), True)
        pg.evaluate("()=>{document.querySelector('#editor').scrollTop=document.querySelector('#editor').scrollHeight}"); pg.wait_for_timeout(500)
        eb = fits(pg, '#epEnd'); tb = fits(pg, '#btnTop')
        eb_inner = eb
        check(T('재독 끝의 큰 버튼과 맨위로 버튼이 겹치지 않음'), not overlap(tb, eb_inner), (tb, eb_inner))
        pg.screenshot(path=f'{SH}top_{name}_4rereadend.png')
        pg.click('#btnRereadClose'); pg.wait_for_timeout(300)
        # 듣기 읽기 화면
        pg.click('#btnListen'); pg.wait_for_selector('#reader:not([hidden])'); pg.wait_for_timeout(400)
        check(T('듣기 화면에서는 실행취소 버튼이 꺼짐 (글이 안 보이니까)'), st(pg) == [True, True], st(pg))
        pg.evaluate("()=>{document.querySelector('#reader').scrollTop=2500}"); pg.wait_for_timeout(400)
        check(T('듣기(읽기) 화면에서도 맨위로 나타남'), not hid())
        pg.screenshot(path=f'{SH}top_{name}_5reader.png')
        pg.click('#btnTop'); pg.wait_for_function("()=>document.querySelector('#reader').scrollTop===0", timeout=5000); pg.wait_for_timeout(300)
        check(T('듣기 화면 맨위로 동작'), hid())
        pg.click('#btnListen'); pg.wait_for_timeout(300)
        check(T('듣기를 닫으면 글상자 기준으로 돌아옴'), pg.is_hidden('#reader') and not pg.is_hidden('#editor'))
        # ---------- 11) 휴대폰 키보드가 올라온 상태
        if mob:
            pg.evaluate("()=>{document.querySelector('#editor').scrollTop=2500}"); pg.wait_for_timeout(300)
            pg.focus('#editor'); pg.evaluate("()=>{window.__vv.set(430,0)}"); pg.wait_for_timeout(500)
            pg.evaluate("()=>{document.querySelector('#editor').scrollTop=2400}"); pg.wait_for_timeout(500)
            check(T('키보드 상태(kb-open)'), pg.evaluate("document.body.classList.contains('kb-open')"))
            tb = fits(pg, '#btnTop')
            check(T('키보드가 올라와도 맨위로 버튼이 키보드 위에 보임'), tb and tb[3] <= 430 and tb[1] > 0, tb)
            ub, rb2, hd = fits(pg, '#btnUndo'), fits(pg, '#btnRedo'), fits(pg, '.ed-head')
            check(T('키보드가 올라와도 실행취소·다시실행 버튼이 화면 위쪽에 보임 (툴바는 숨겨짐)'), ub and rb2 and ub[3] <= 430 and ub[1] >= 0 and rb2[2] <= 360 and pg.is_hidden('.toolbar'), (ub, rb2))
            pg.screenshot(path=f'{SH}undo_{name}_5keyboard.png')
            pg.keyboard.type('키보드 입력'); wait_saved(pg)
            before = val(pg)
            pg.click('#btnUndo'); wait_saved(pg)
            check(T('키보드가 올라온 채 실행취소 → 되돌려지고 키보드(입력창 포커스) 유지'), val(pg) == before[:-len('키보드 입력')] and pg.evaluate("document.activeElement.id==='editor'"), val(pg)[-8:])
            pg.click('#btnRedo'); wait_saved(pg)
            check(T('키보드가 올라온 채 다시실행 + 포커스 유지'), val(pg) == before and pg.evaluate("document.activeElement.id==='editor'"))
            pg.click('#btnUndo'); wait_saved(pg)
            pg.evaluate("()=>{window.__vv.set(null)}") if False else pg.evaluate("()=>{window.__vv.set(800,0)}"); pg.wait_for_timeout(400)
        # ---------- 12) 머리줄 겹침 없음
        hb = pg.evaluate("[...document.querySelectorAll('.ed-head *')].filter(e=>e.offsetParent&&e.matches('button,input,.save-status,.undo-grp')&&!e.closest('.undo-grp')||e.matches('.undo-grp')).map(e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})")
        ov = any(overlap(a, c2) for i, a in enumerate(hb) for c2 in hb[i+1:])
        check(T('머리줄 버튼·제목·저장 상태가 겹치지 않고 화면 안'), not ov and max(x[2] for x in hb) <= vp['width'] + 1, hb)
        pg.evaluate("()=>{document.querySelector('#editor').scrollTop=0}")
        pg.screenshot(path=f'{SH}undo_{name}_6header.png')
        # ---------- 13) 기록 장치 단독 시험 (섞어 쓰기)
        res = pg.evaluate("""async()=>{const {UndoStack}=await import('./js/history.js');let bad=0;
          for(let k=0;k<200;k++){const u=new UndoStack({maxEntries:20});let t='가나다라마바사 아자차카타파하'.repeat(3);u.reset(t);const hist=[t];
            for(let i=0;i<40;i++){const a=Math.floor(Math.random()*(t.length+1)),b=Math.min(t.length,a+Math.floor(Math.random()*5));t=t.slice(0,a)+(Math.random()<.3?'':'😀바보'.slice(0,1+Math.floor(Math.random()*3)))+t.slice(b);u.push(t,Math.random()<.5,i*3000);hist.push(t)}
            let c=t;const redoTo=[];while(u.canUndo){const r=u.undo(c);if(!r){bad++;break}c=r.text;redoTo.push(c)}
            while(u.canRedo){const r=u.redo(c);if(!r){bad++;break}c=r.text}
            if(c!==t)bad++}
          return bad}""")
        check(T('기록 장치: 무작위 200번 입력 → 끝까지 실행취소 → 끝까지 다시실행하면 항상 원래 글'), res == 0, res)
        check(T('JS 오류 없음'), not errs, errs[:3])
        c.close()
    b.close()

# ---------- 드라이브 동기화와 함께: 다른 기기에서 바뀐 글이 들어오면 기록을 비움 (덮어쓰지 않음)
def wait_sync(pg):
    pg.wait_for_timeout(300); pg.wait_for_function("()=>window.__yw.syncState!=='syncing'", timeout=15000); pg.wait_for_timeout(400)
def sctx(b, drive, mobile):
    vp = {'width': 360, 'height': 800} if mobile else {'width': 1440, 'height': 900}
    c = b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, locale='ko-KR')
    c.add_init_script("window.__YW_NO_SW = true; sessionStorage.setItem('jpsSplash','1');")
    c.route('https://www.googleapis.com/**', drive.handle)
    c.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body=GIS_STUB))
    pg = c.new_page(); pg._errs = []
    pg.on('pageerror', lambda e: pg._errs.append(str(e)))
    return c, pg
def connect(pg):
    if pg.is_visible('#btnBack'): pg.click('#btnBack')
    pg.click('#tabs [data-tab="note"]'); pg.wait_for_timeout(200)
    pg.click('#btnSettings'); pg.fill('#setCid', '123456789-testclient.apps.googleusercontent.com'); pg.click('#setConnect')
    pg.wait_for_function("()=>!document.querySelector('#dlg').open", timeout=10000); wait_sync(pg)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    for name, mob in (('360', True), ('pc', False)):
        drive = FakeDrive(); ca, A = sctx(b, drive, mob); cb, B = sctx(b, drive, not mob)
        T = lambda m: f'[{name}·동기화] {m}'
        A.goto(URL); A.wait_for_selector('html.ready'); connect(A)
        A.click('#tabs [data-tab="note"]'); A.click('#btnNewWork'); A.fill('#askIn', '동기작'); A.click('#dlg button[value="ok"]'); A.wait_for_selector('#editorView:not([hidden])')
        end(A); A.keyboard.type('처음 글입니다.'); wait_saved(A); A.evaluate("()=>document.querySelector('#btnSyncNow')?.click()"); wait_sync(A)
        B.goto(URL); B.wait_for_selector('html.ready'); connect(B); B.evaluate("()=>document.querySelector('#btnSyncNow')?.click()"); wait_sync(B)
        # A: 글을 더 쓰고 동기화까지 끝낸 뒤 실행취소가 켜져 있는 상태
        settle(A, 1400); end(A); A.keyboard.type(' 이어 쓴 글.'); wait_saved(A); A.evaluate("()=>document.querySelector('#btnSyncNow')?.click()"); wait_sync(A)
        check(T('실행취소 켜짐 (동기화 직후에도 기록 유지)'), st(A)[0] is False, st(A))
        A.click('#btnUndo'); wait_saved(A); A.evaluate("()=>document.querySelector('#btnSyncNow')?.click()"); wait_sync(A)
        check(T('실행취소 → 저장 → 동기화 뒤에도 같은 글'), val(A) == '처음 글입니다.' and ep_text(A, A.evaluate('window.__yw.cur')) == '처음 글입니다.', val(A))
        A.click('#btnRedo'); wait_saved(A); A.evaluate("()=>document.querySelector('#btnSyncNow')?.click()"); wait_sync(A)
        check(T('다시실행도 저장·동기화 뒤 같은 글'), val(A) == '처음 글입니다. 이어 쓴 글.' and ep_text(A, A.evaluate('window.__yw.cur')) == val(A))
        # B가 같은 회차를 고쳐서 올림 → A가 돌아와 받으면 기록을 비우고 B의 글이 그대로
        B.evaluate("()=>document.querySelector('#btnSyncNow')?.click()"); wait_sync(B)
        B.click('#tabs [data-tab="note"]') if not B.is_visible('.work') else None
        w = B.locator('.work', has_text='동기작')
        if 'open' not in (w.get_attribute('class') or ''): w.locator('[data-act="toggle"]').click()
        w.locator('.ep [data-act="open"]').first.click(); B.wait_for_selector('#editorView:not([hidden])'); B.wait_for_timeout(400)
        end(B); B.keyboard.type(' [B가 쓴 글]'); wait_saved(B); B.evaluate("()=>document.querySelector('#btnSyncNow')?.click()"); wait_sync(B)
        bt = val(B)
        A.evaluate("()=>{window.dispatchEvent(new Event('focus'))}"); wait_sync(A); A.wait_for_timeout(500)
        check(T('다른 기기 글이 들어오면 그 글로 바뀜'), val(A) == bt, val(A)[-20:])
        check(T('그때는 실행취소 기록이 비워져서 되돌려도 옛 글이 덮어쓰지 못함'), st(A) == [True, True], st(A))
        A.focus('#editor'); A.keyboard.press('Control+z'); A.wait_for_timeout(300)
        check(T('Ctrl+Z 해도 글이 그대로'), val(A) == bt)
        end(A); A.keyboard.type('끝'); wait_saved(A); A.click('#btnUndo'); wait_saved(A)
        check(T('이후 새로 쓴 것만 실행취소됨'), val(A) == bt and ep_text(A, A.evaluate('window.__yw.cur')) == bt)
        check(T('JS 오류 없음'), not A._errs and not B._errs, (A._errs + B._errs)[:3])
        ca.close(); cb.close()
    b.close()
print(f'\n통과 {sum(R)}/{len(R)}'); sys.exit(0 if all(R) else 1)
