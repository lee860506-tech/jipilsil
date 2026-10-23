// 집필실 서비스워커 — 오프라인에서도 앱이 열리게 (원고 자체는 IndexedDB에 있음)
const VERSION = 'jps-v10g-__BUILD__';
const SHELL = ['./', 'index.html', 'config.js', 'css/app.css', 'js/app.js', 'js/db.js', 'js/drive.js', 'js/audio.js', 'js/util.js',
  'manifest.webmanifest', 'img/fighting.webp', 'img/great.webp', 'img/focus.webp', 'img/oops.webp', 'img/hero_art.webp', 'img/streak_art.webp', 'img/moonbook.webp', 'js/tables.js', 'js/notes.js', 'js/aiwork.js', 'js/aiui.js', 'js/exporters.js', 'js/history.js', 'js/hwpx_tpl.js', 'img/jipilsil-serif.ttf.gz', 'icons/logo.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'hangeul.pstatic.net'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'jps-fonts').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) { // 글꼴: 캐시 우선
    e.respondWith(caches.open('jps-fonts').then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; } catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin !== location.origin) return; // 구글 로그인·드라이브 API는 절대 캐시하지 않음
  if (url.pathname.endsWith('.ttf.gz')) { // PDF용 글꼴(큰 파일): 캐시 우선 — 한 번 받으면 오프라인에서도 PDF가 돼요
    e.respondWith(caches.open(VERSION).then(async c => { const hit = await c.match(req, { ignoreSearch: true }); if (hit) return hit; const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }));
    return;
  }
  // 앱 파일: 네트워크 우선(새 버전 바로 반영), 오프라인이면 캐시
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    try {
      const r = await fetch(req, { cache: 'no-cache' }); // 브라우저 HTTP 캐시(10분)도 건너뛰고 최신 확인
      if (r.ok) c.put(req, r.clone());
      return r;
    } catch (err) {
      return (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? c.match('index.html') : Response.error());
    }
  })());
});
