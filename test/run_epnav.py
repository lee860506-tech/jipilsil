# 이전화/다음화: 집필·재독(읽기)·듣기, 저장, 찾기 유지 — python3 test/run_epnav.py URL
import sys, re
from playwright.sync_api import sync_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8797/'
SH = '/workspace/yeonwol-note/shots/epnav_'
R = []
def check(n, ok, info=''): R.append(bool(ok)); print(('PASS' if ok else 'FAIL'), n, f'[{info}]' if info and not ok else '')
LONG = lambda k: '\n\n'.join(f'{k} 문단 {i}. 준혁은 창가에 앉아 비 오는 거리를 오래 바라보았다. 고양이가 무릎 위에서 잠들었다.' for i in range(40))
SEED = """async([a,b,c])=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;
  const t=d.transaction(['works','episodes'],'readwrite');const W=t.objectStore('works'),E=t.objectStore('episodes');
  W.put({id:'w1',title:'달빛 아래',order:0,createdAt:1,updatedAt:1});W.put({id:'w2',title:'다른 작품',order:1,createdAt:2,updatedAt:2});
  E.put({id:'e1',workId:'w1',order:0,text:a,title:'첫 밤',createdAt:1,updatedAt:1,rev:1});
  E.put({id:'e2',workId:'w1',order:1,text:b,title:'비 오는 밤',createdAt:2,updatedAt:2,rev:1});
  E.put({id:'e3',workId:'w1',order:2,text:c,title:'',createdAt:3,updatedAt:3,rev:1});
  E.put({id:'x1',workId:'w2',order:0,text:'다른 작품 원고',title:'',createdAt:4,updatedAt:4,rev:1});
  await new Promise(x=>t.oncomplete=x);d.close()}"""
def ep_text(pg, id): return pg.evaluate("""async(id)=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const g=q.result.transaction('episodes').objectStore('episodes').get(id);await new Promise(x=>g.onsuccess=x);return g.result.text}""", id)
cur = lambda pg: pg.evaluate('window.__yw.cur')
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    for name, vp, mob in (('360', {'width': 360, 'height': 800}, True), ('412', {'width': 412, 'height': 915}, True), ('pc', {'width': 1440, 'height': 900}, False)):
        errs = []
        c = b.new_context(viewport=vp, is_mobile=mob, has_touch=mob, device_scale_factor=2 if mob else 1, locale='ko-KR')
        c.add_init_script("window.__YW_NO_SW=true; sessionStorage.setItem('jpsSplash','1');")
        pg = c.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(URL); pg.wait_for_selector('html.ready'); pg.evaluate(SEED, [LONG('일화'), LONG('이화'), LONG('삼화')])
        pg.reload(); pg.wait_for_selector('html.ready'); pg.click('#tabs [data-tab="note"]'); pg.wait_for_timeout(200)
        w = pg.locator('.work', has_text='달빛 아래')
        if 'open' not in (w.get_attribute('class') or ''): w.locator('[data-act="toggle"]').click()
        w.locator('.ep [data-act="open"]').nth(0).click(); pg.wait_for_selector('#editorView:not([hidden])'); pg.wait_for_timeout(300)
        check(f'[{name}] 첫 회차: 이전화 꺼짐 · 다음화 켜짐', pg.is_disabled('#epPrev') and pg.is_enabled('#epNext'))
        hb = pg.evaluate("[...document.querySelectorAll('.ed-head > *')].filter(e=>e.offsetParent).map(e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})")
        ov = any(a[0] < c2[2]-1 and c2[0] < a[2]-1 and a[1] < c2[3]-1 and c2[1] < a[3]-1 for i, a in enumerate(hb) for c2 in hb[i+1:])
        check(f'[{name}] 머리줄 버튼 겹침 없음 · 화면 안', not ov and max(x[2] for x in hb) <= vp['width'] + 1, hb)
        tb_before = pg.evaluate("document.querySelector('.toolbar').children.length")
        # 쓰자마자 다음화 → 글 안 잃음
        pg.focus('#editor'); pg.evaluate("()=>{const e=document.querySelector('#editor');e.setSelectionRange(e.value.length,e.value.length)}"); pg.keyboard.type(' 방금 쓴 문장.')
        pg.click('#epNext'); pg.wait_for_function("window.__yw.cur==='e2'"); pg.wait_for_timeout(300)
        check(f'[{name}] 다음화 → 2화', pg.input_value('#editor').startswith('이화'))
        check(f'[{name}] 바꾸기 전에 저장 (방금 쓴 글 보존)', ep_text(pg, 'e1').endswith('방금 쓴 문장.'))
        pg.screenshot(path=SH + f'{name}_editor.png')
        # 끝 회차 → 다른 작품으로 안 넘어감
        if mob: pg.click('#epNext')
        else: pg.keyboard.press('Alt+ArrowRight')
        pg.wait_for_function("window.__yw.cur==='e3'"); pg.wait_for_timeout(250)
        check(f'[{name}] 3화 (PC는 Alt+→)', cur(pg) == 'e3')
        check(f'[{name}] 마지막 회차: 다음화 꺼짐 (다른 작품으로 안 감)', pg.is_disabled('#epNext'))
        if not mob: pg.keyboard.press('Alt+ArrowRight'); pg.wait_for_timeout(300); check('[pc] 마지막에서 Alt+→ 그대로', cur(pg) == 'e3')
        if not mob: pg.keyboard.press('Alt+ArrowLeft'); pg.wait_for_function("window.__yw.cur==='e2'"); check('[pc] Alt+← 이전화', cur(pg) == 'e2')
        else: pg.click('#epPrev'); pg.wait_for_function("window.__yw.cur==='e2'"); check(f'[{name}] 이전화', cur(pg) == 'e2')
        # 찾기 열린 채로 이동
        pg.click('#btnFind'); pg.fill('#fQ', '고양이'); pg.wait_for_timeout(400)
        pg.click('#epNext'); pg.wait_for_function("window.__yw.cur==='e3'"); pg.wait_for_timeout(500)
        fc = pg.inner_text('#fCount')
        check(f'[{name}] 찾기 바 그대로 · 새 회차에서 다시 셈', pg.is_visible('#findBar') and '40' in fc, fc)
        pg.click('#fClose'); pg.click('#epPrev'); pg.wait_for_function("window.__yw.cur==='e2'")
        # 재독(읽기)
        pg.click('#btnReread'); pg.wait_for_selector('#rereadBar:not([hidden])'); pg.wait_for_timeout(300)
        check(f'[{name}] 읽기 위쪽 작은 바: ‹ 이전화 · 2화 · 다음화 ›', pg.is_visible('#rbPrev') and pg.is_visible('#rbNext') and '02화' in pg.inner_text('#rbLabel'))
        check(f'[{name}] 원고 중간에서는 큰 버튼 안 보임', pg.is_hidden('#epEnd'))
        pg.evaluate("()=>{const e=document.querySelector('#editor');e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'))}"); pg.wait_for_timeout(300)
        check(f'[{name}] 원고 끝: 큰 이전화/다음화 버튼', pg.is_visible('#epEnd .ee-b.next') and '3화' in pg.inner_text('#epEnd .ee-b.next').replace('03화', '3화'))
        cover = pg.evaluate("""()=>{const e=document.querySelector('#editor');const m=document.createElement('div');const cs=getComputedStyle(e);for(const k of ['fontFamily','fontSize','lineHeight','letterSpacing','paddingTop','paddingLeft','paddingRight','boxSizing','wordBreak','whiteSpace','overflowWrap'])m.style[k]=cs[k];
          m.style.width=e.clientWidth+'px';m.style.position='absolute';m.style.visibility='hidden';m.textContent=e.value;document.body.appendChild(m);const textBottom=e.getBoundingClientRect().top+m.scrollHeight-parseFloat(cs.paddingBottom||0)-e.scrollTop;m.remove();
          const card=document.querySelector('#epEnd .ee-in').getBoundingClientRect();return [textBottom, card.top]}""")
        check(f'[{name}] 큰 버튼이 글을 가리지 않음 (글 끝 아래)', cover[0] <= cover[1] + 2, cover)
        pg.screenshot(path=SH + f'{name}_read_end.png')
        pg.click('#epEnd .ee-b.next'); pg.wait_for_function("window.__yw.cur==='e3'"); pg.wait_for_timeout(400)
        check(f'[{name}] 다음화로 가도 읽기 모드 유지', pg.is_visible('#rereadBar') and pg.evaluate("document.querySelector('#editorView').classList.contains('rereading')"))
        check(f'[{name}] 다음화는 맨 위부터', pg.evaluate("document.querySelector('#editor').scrollTop") == 0)
        if mob: check(f'[{name}] 읽기 이동 때 키보드 안 올라옴', pg.evaluate("document.activeElement!==document.querySelector('#editor')"))
        pg.screenshot(path=SH + f'{name}_read_top.png')
        pg.evaluate("()=>{const e=document.querySelector('#editor');e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'))}"); pg.wait_for_timeout(300)
        check(f'[{name}] 마지막 회차 끝: ＋ 새 회차', pg.is_visible('#epEnd .ee-b.new') and pg.is_disabled('#rbNext'))
        pg.click('#rbPrev'); pg.wait_for_function("window.__yw.cur==='e2'"); pg.wait_for_timeout(300)
        check(f'[{name}] 위쪽 바 ‹ 이전화도 읽기 유지', pg.is_visible('#rereadBar'))
        pg.click('#btnRereadClose')
        # 듣기(낭독) 화면
        if pg.evaluate("'speechSynthesis' in window"):
            pg.click('#btnListen'); pg.wait_for_selector('#reader:not([hidden])'); pg.wait_for_timeout(300)
            check(f'[{name}] 낭독 화면 끝에 큰 버튼', pg.locator('#reader .ee-b.next').count() == 1)
            pg.locator('#reader .ee-b.next').scroll_into_view_if_needed(); pg.screenshot(path=SH + f'{name}_listen_end.png')
            pg.locator('#reader .ee-b.next').click(); pg.wait_for_function("window.__yw.cur==='e3'"); pg.wait_for_timeout(400)
            check(f'[{name}] 낭독 화면 유지 · 3화 · 맨 위', pg.is_visible('#reader') and pg.inner_text('#reader').startswith('삼화') and pg.evaluate("document.querySelector('#reader').scrollTop") < 5)
            pg.click('#ttsPrev'); pg.wait_for_function("window.__yw.cur==='e2'"); check(f'[{name}] 낭독 바 ‹ 이전화', pg.is_visible('#reader'))
            pg.click('#ttsStop')
        check(f'[{name}] 집필 도구줄 버튼 수 그대로', pg.evaluate("document.querySelector('.toolbar').children.length") == tb_before)
        check(f'[{name}] 다른 회차 원고 그대로', ep_text(pg, 'e2') == LONG('이화') and ep_text(pg, 'e3') == LONG('삼화') and ep_text(pg, 'x1') == '다른 작품 원고')
        check(f'[{name}] JS 오류 없음', not errs, errs[:3])
        c.close()
    b.close()
print(f'==== {sum(R)}/{len(R)} passed ====')
