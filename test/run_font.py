# Aa 글꼴 패널 테스트: python3 test/run_font.py URL [shotdir]
import sys
from playwright.sync_api import sync_playwright
U=sys.argv[1]; SH=sys.argv[2] if len(sys.argv)>2 else '/tmp'
ok=0; bad=0
def chk(n,c):
    global ok,bad
    print(('PASS ' if c else 'FAIL ')+n); ok+=bool(c); bad+=not c
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome')
    for name,vp,mob in (('mobile',{'width':360,'height':800},True),('desktop',{'width':1440,'height':900},False)):
        errs=[]
        c=b.new_context(viewport=vp,is_mobile=mob,has_touch=mob,device_scale_factor=2 if mob else 1,locale='ko-KR')
        c.add_init_script("window.__YW_NO_SW=true;sessionStorage.setItem('jpsSplash','1')")
        pg=c.new_page(); pg.on('pageerror',lambda e:errs.append(str(e)))
        pg.goto(U); pg.wait_for_selector('html.ready')
        pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const d=q.result;
          const t=d.transaction(['works','episodes'],'readwrite');t.objectStore('works').put({id:'w1',title:'달빛 아래',order:0,createdAt:1,updatedAt:1});
          t.objectStore('episodes').put({id:'e1',workId:'w1',order:0,text:'달이 떴다. 준혁은 창가에 앉아 고양이를 쓰다듬었다.\\n\\n"오늘은 꼭 끝낼 거야." 그가 말했다.\\n'.repeat(6),title:'',createdAt:1,updatedAt:Date.now()});await new Promise(x=>t.oncomplete=x)}""")
        pg.reload(); pg.wait_for_selector('html.ready'); pg.wait_for_timeout(400)
        pg.evaluate("window.__yw.openEpisode ? window.__yw.openEpisode('e1') : null")
        if pg.locator('#editorView').is_hidden(): pg.click('#hContinue')
        pg.wait_for_timeout(400)
        pg.click('#btnAa'); pg.wait_for_timeout(300)
        chk(f'{name}: 패널 열림', pg.locator('#aaPanel').is_visible())
        box=pg.locator('#aaPanel').bounding_box()
        chk(f'{name}: 화면 안에 들어옴', box['x']>=0 and box['x']+box['width']<=vp['width'] and box['y']>=0 and box['y']+box['height']<=vp['height'])
        chk(f'{name}: 글꼴 9개', pg.locator('.aa-f').count()==9)
        chk(f'{name}: 손글씨 글꼴 아직 안 불러옴', pg.evaluate("!document.querySelector('link[data-font=penscript]')"))
        pg.click('.aa-f[data-id=nmyeongjo]'); pg.wait_for_timeout(1500)
        ff=pg.evaluate("getComputedStyle(document.querySelector('#editor')).fontFamily")
        chk(f'{name}: 나눔명조 바로 적용 ({ff[:30]})', 'Nanum Myeongjo' in ff)
        chk(f'{name}: 고를 때 불러옴', pg.evaluate("!!document.querySelector('link[data-font=nmyeongjo]')"))
        chk(f'{name}: 실제 글꼴 로드', pg.evaluate("document.fonts.check('16px \"Nanum Myeongjo\"', '가')"))
        pg.click('#aaPlus'); pg.click('#aaPlus')
        chk(f'{name}: ＋ 두 번 → 20px', pg.evaluate("getComputedStyle(document.querySelector('#editor')).fontSize")=='20px')
        pg.click('#aaMinus'); chk(f'{name}: − → 19px', pg.evaluate("getComputedStyle(document.querySelector('#editor')).fontSize")=='19px')
        pg.fill('#aaSize','24'); pg.dispatch_event('#aaSize','input')
        chk(f'{name}: 슬라이더 24px', pg.evaluate("getComputedStyle(document.querySelector('#editor')).fontSize")=='24px')
        pg.fill('#aaLh','2.2'); pg.dispatch_event('#aaLh','input')
        chk(f'{name}: 줄 간격 2.2', abs(pg.evaluate("parseFloat(getComputedStyle(document.querySelector('#editor')).lineHeight)")-24*2.2)<0.6)
        pg.fill('#aaLs','0.05'); pg.dispatch_event('#aaLs','input')
        chk(f'{name}: 자간 0.05em', abs(pg.evaluate("parseFloat(getComputedStyle(document.querySelector('#editor')).letterSpacing)")-1.2)<0.05)
        pg.wait_for_timeout(300)
        st=pg.evaluate("""async()=>{const q=indexedDB.open('jipilsil');await new Promise(x=>q.onsuccess=x);const r=q.result.transaction('kv').objectStore('kv');const g=k=>new Promise(x=>{const a=r.get(k);a.onsuccess=()=>x(a.result)});return {s:await g('settings'),at:await g('settingsAt')}}""")
        chk(f'{name}: 같은 설정에 저장+동기화 시각', st['s']['font']=='nmyeongjo' and st['s']['fontSize']==24 and st['s']['lineH']==2.2 and st['s']['letterSp']==0.05 and st['at'])
        pg.click('.aa-f[data-id=penscript]'); pg.wait_for_timeout(1200)
        pg.screenshot(path=f'{SH}/font_{name}_panel.png')
        chk(f'{name}: 손글씨 적용', 'Nanum Pen Script' in pg.evaluate("getComputedStyle(document.querySelector('#editor')).fontFamily"))
        # 낭독 화면
        pg.keyboard.press('Escape'); chk(f'{name}: Esc 닫힘', pg.locator('#aaPanel').is_hidden())
        pg.click('#btnListen'); pg.wait_for_timeout(500)
        rs=pg.evaluate("(()=>{const c=getComputedStyle(document.querySelector('#reader'));return [c.fontFamily,c.fontSize,c.letterSpacing]})()")
        chk(f'{name}: 낭독 화면도 같은 글꼴·크기 {rs[1]}', 'Nanum Pen Script' in rs[0] and rs[1]=='24px')
        pg.screenshot(path=f'{SH}/font_{name}_reader.png')
        pg.evaluate("document.querySelector('#ttsStop, #ttsClose') && document.querySelector('#ttsStop, #ttsClose').click()")
        pg.wait_for_timeout(200)
        pg.click('#btnAa'); pg.click('#aaReset'); pg.wait_for_timeout(300)
        chk(f'{name}: 기본값 (고운바탕 18px 1.9 0)', pg.evaluate("(()=>{const c=getComputedStyle(document.querySelector('#editor'));return c.fontFamily.includes('Gowun Batang')&&c.fontSize=='18px'&&Math.abs(parseFloat(c.lineHeight)-34.2)<0.6&&(c.letterSpacing=='normal'||parseFloat(c.letterSpacing)==0)})()"))
        # 바깥 누르면 닫힘
        pg.mouse.click(5, vp['height']//2) if not mob else pg.tap('#editor', position={'x':40,'y':20})
        pg.wait_for_timeout(200); chk(f'{name}: 바깥 터치로 닫힘', pg.locator('#aaPanel').is_hidden())
        chk(f'{name}: 원고 그대로', pg.evaluate("document.querySelector('#editor').value.startsWith('달이 떴다')"))
        chk(f'{name}: JS 오류 없음 {errs}', not errs)
        c.close()
    b.close()
print(f'==== {ok}/{ok+bad} passed ====')
