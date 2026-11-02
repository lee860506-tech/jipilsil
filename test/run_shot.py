# 집필실: 📸 스크린샷 (컴퓨터에서만) — PNG 저장·클립보드, 원고·DB·저장 안 건드림, 바깥으로 아무것도 안 보냄
import sys, re, json, struct, zlib
from playwright.sync_api import sync_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8793/'
SH = '/workspace/yeonwol-note/shots/'
results = []
def check(name, ok, info=''):
    results.append((name, bool(ok), str(info))); print(('PASS' if ok else 'FAIL'), name, f'[{info}]' if info and not ok else '')
def png_info(path):
    b = open(path, 'rb').read(); w, h = struct.unpack('>II', b[16:24]); return b[:8] == b'\x89PNG\r\n\x1a\n', w, h, len(b)
DBSNAP = """async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;const o={};
  for(const s of ['episodes','versions','works']){const t=d.transaction(s).objectStore(s).getAll();await new Promise(x=>t.onsuccess=x);o[s]=t.result.map(r=>JSON.stringify(r)).sort()}
  d.close();return o}"""
LONG = '\n\n'.join(f'{i}번째 문단. 달빛이 창가에 내려앉았다. 서경은 숨을 고르며 펜을 들었다. 「오늘은 끝까지 써 보자.」' for i in range(1, 80))
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    for name, vp, mobile in [('pc', {'width': 1280, 'height': 800}, False), ('360', {'width': 360, 'height': 800}, True)]:
        T = lambda s: f'[{name}] {s}'
        c = b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1, locale='ko-KR', accept_downloads=True,
                          permissions=['clipboard-read', 'clipboard-write'])
        c.add_init_script("window.__YW_NO_SW = true; sessionStorage.setItem('jpsSplash','1');")
        pg = c.new_page(); errs = []; outside = []
        pg.on('pageerror', lambda e: errs.append('PE ' + str(e)))
        pg.on('console', lambda m: m.type == 'error' and not re.search(r'favicon|net::ERR', m.text) and errs.append('C ' + m.text))
        pg.goto(URL); pg.wait_for_selector('html.ready')
        if pg.is_visible('#btnBack'): pg.click('#btnBack')
        pg.click('#tabs [data-tab="note"]'); pg.wait_for_timeout(250)
        pg.click('#btnNewWork'); pg.fill('#askIn', '달빛 서재'); pg.click('#dlg button[value="ok"]'); pg.wait_for_selector('#editorView:not([hidden])')
        pg.fill('#editor', LONG); pg.wait_for_function("()=>!window.__yw.pending && !window.__yw.saving", timeout=8000); pg.wait_for_timeout(600)
        vis = pg.is_visible('#btnShot')
        if mobile:
            check(T('360 휴대폰에서는 📸 버튼이 안 보임'), not vis)
            pg.screenshot(path=SH + 'shot_btn_360_hidden.png')
        else:
            check(T('컴퓨터 화면에 📸 버튼 보임 (머리줄, 되돌리기 옆)'), vis)
            pg.evaluate("()=>{const e=document.querySelector('#editor');e.focus();e.setSelectionRange(500,500);e.scrollTop=1500}"); pg.wait_for_timeout(300)
            pg.screenshot(path=SH + 'shot_btn_pc.png')
            before = pg.evaluate(DBSNAP); sel0 = pg.evaluate("()=>[document.querySelector('#editor').selectionStart,document.querySelector('#editor').scrollTop]")
            pg.on('request', lambda r: (not r.url.startswith(URL) and not r.url.startswith('data:') and not r.url.startswith('blob:')) and outside.append(r.url))
            with pg.expect_download(timeout=20000) as dl:
                pg.click('#btnShot')
            d = dl.value; fn = d.suggested_filename
            check(T('파일 이름 집필실_작품명_YYYYMMDD_HHMM.png'), re.fullmatch(r'집필실_달빛_서재_\d{8}_\d{4}\.png', fn), fn)
            out = SH + 'shot_sample_pc.png'; d.save_as(out)
            ok, w, h, n = png_info(out)
            check(T('PNG · 보이는 화면 크기(1280×800 × 화면 배율)'), ok and (w, h) == (1280, 800) and n > 20000, (w, h, n))
            pg.wait_for_selector('#toast:not([hidden])', timeout=5000)
            tt = pg.inner_text('#toast')
            check(T('귀여운 알림 + 클립보드 복사 버튼'), '찰칵' in tt and pg.locator('#toast .t-act').count() == 1, tt)
            pg.click('#toast .t-act'); pg.wait_for_timeout(800)
            types = pg.evaluate("async()=>{try{const it=await navigator.clipboard.read();return it.flatMap(i=>i.types)}catch(e){return ['ERR '+e]}}")
            check(T('클립보드에 PNG 복사'), 'image/png' in types, types)
            pg.wait_for_timeout(1500)
            after = pg.evaluate(DBSNAP)
            check(T('원고·버전·작품 DB 그대로 (저장·동기화 안 일어남)'), before == after)
            check(T('저장 대기 없음'), pg.evaluate("()=>!window.__yw.pending && !window.__yw.saving"))
            sel1 = pg.evaluate("()=>[document.querySelector('#editor').selectionStart,document.querySelector('#editor').scrollTop]")
            check(T('커서·스크롤 위치 그대로'), sel0 == sel1, (sel0, sel1))
            check(T('바깥으로 보낸 요청 없음'), not [u for u in outside if not re.search(r'fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|hangeul\.pstatic\.net', u)], outside[:3])
            # 찍힌 그림이 보이는 자리(스크롤 내려간 문단)를 담는지: 픽셀 다양성 확인 (빈 화면 아님)
            pix = pg.evaluate("""async(u)=>{const im=new Image();im.src=u;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const x=c.getContext('2d');x.drawImage(im,0,0);
              const d=x.getImageData(0,0,c.width,c.height).data;const set=new Set();for(let i=0;i<d.length;i+=4*97)set.add(d[i]>>4<<8|d[i+1]>>4<<4|d[i+2]>>4);return set.size}""",
              'data:image/png;base64,' + __import__('base64').b64encode(open(out, 'rb').read()).decode())
            check(T('그림이 비어 있지 않음'), pix > 8, pix)
        check(T('JS 오류 없음'), not errs, errs[:3])
        c.close()
    b.close()
print(f"\n{sum(1 for r in results if r[1])}/{len(results)} passed")
sys.exit(0 if all(r[1] for r in results) else 1)
