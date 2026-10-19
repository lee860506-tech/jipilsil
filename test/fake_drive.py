# 테스트용 가짜 구글 드라이브 (Playwright route 로 googleapis.com 요청을 가로챔)
import json, re, itertools, urllib.parse, datetime
class FakeDrive:
    def __init__(self):
        self.files = {}; self.n = itertools.count(1); self.t = itertools.count(1); self.log = []
        self.docs = None  # None | 'plus1' | 'double' : 실제 구글 문서처럼 내보낼 때 줄바꿈 수가 바뀌는 흉내
        self.bump = set()  # 업로드 뒤 변환으로 modifiedTime 이 한 번 더 바뀌는 흉내
    def now(self):
        return (datetime.datetime(2026,10,19,5,0,0)+datetime.timedelta(seconds=next(self.t))).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    def new_id(self): return 'f%03d' % next(self.n)
    def meta(self, f):
        return {k: f[k] for k in ('id','name','mimeType','modifiedTime','appProperties','parents','description','trashed','version') if k in f}
    def remote_edit(self, fid, text):
        self.files[fid]['content'] = text; self.files[fid]['modifiedTime'] = self.now(); self.files[fid]['version'] = str(int(self.files[fid].get('version', '1')) + 1)
    def by(self, kind): return [f for f in self.files.values() if f.get('appProperties',{}).get('ywKind')==kind and not f.get('trashed')]
    def handle(self, route):
        req = route.request; u = urllib.parse.urlparse(req.url); qs = urllib.parse.parse_qs(u.query); path = u.path; m = req.method
        self.log.append((m, path))
        def ok(obj, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(obj))
        if req.headers.get('authorization') != 'Bearer fake-token': return ok({'error':'unauth'}, 401)
        mm = re.match(r'^/drive/v3/files/([^/]+)/export$', path)
        if mm:
            f = self.files.get(mm.group(1))
            if not f: return ok({'error':'nf'},404)
            # 구글 문서 텍스트 내보내기처럼: BOM + CRLF
            c = f['content'] or ''
            if self.docs and f.get('mimeType') == 'application/vnd.google-apps.document':
                c = re.sub(r'\n+', lambda r: '\n' * (len(r.group(0)) + 1 if self.docs == 'plus1' else len(r.group(0)) * 2), c) + '\n'
            return route.fulfill(status=200, content_type='text/plain; charset=utf-8', body=('\ufeff'+c.replace('\n','\r\n')).encode('utf-8'))
        if path == '/drive/v3/files' and m == 'GET':
            q = qs.get('q',[''])[0]
            kind = re.search(r"key='ywKind' and value='([^']+)'", q)
            for fid in list(self.bump): self.files[fid]['modifiedTime'] = self.now(); self.bump.discard(fid)
            res = [self.meta(f) for f in self.files.values() if (not kind or f.get('appProperties',{}).get('ywKind')==kind.group(1)) and not (('trashed=false' in q) and f.get('trashed'))]
            return ok({'files': res})
        if path == '/drive/v3/files' and m == 'POST':
            body = json.loads(req.post_data or '{}'); fid = self.new_id()
            f = {'id':fid,'name':body.get('name'),'mimeType':body.get('mimeType'),'parents':body.get('parents') or [],'appProperties':body.get('appProperties') or {},'description':body.get('description'),'modifiedTime':self.now(),'trashed':False,'content':''}
            self.files[fid]=f; return ok({'id':fid,'modifiedTime':f['modifiedTime']})
        mm = re.match(r'^/drive/v3/files/([^/]+)$', path)
        if mm:
            f = self.files.get(mm.group(1))
            if not f: return ok({'error':'nf'},404)
            if m == 'GET' and qs.get('alt',[''])[0] == 'media': return route.fulfill(status=200, content_type='application/json', body=(f.get('content') or '').encode('utf-8'))
            if m == 'GET': return ok(self.meta(f))
            if m == 'PATCH':
                body = json.loads(req.post_data or '{}'); f.update({k:v for k,v in body.items()}); f['modifiedTime']=self.now(); f['version']=str(int(f.get('version','1'))+1); return ok({'id':f['id'],'modifiedTime':f['modifiedTime']})
        if path.startswith('/upload/drive/v3/files'):
            ctype = req.headers.get('content-type',''); b = re.search(r'boundary=(\S+)', ctype).group(1)
            raw = req.post_data_buffer
            parts = raw.split(('--'+b).encode())
            metaPart = parts[1].split(b'\r\n\r\n',1)[1].rsplit(b'\r\n',1)[0]
            hdr, media = parts[2].split(b'\r\n\r\n',1); media = media[:-2] if media.endswith(b'\r\n') else media
            meta = json.loads(metaPart.decode())
            isText = b'text/plain' in hdr or b'text/csv' in hdr or b'application/json' in hdr
            content = media.decode('utf-8') if isText else None
            mm = re.match(r'^/upload/drive/v3/files/([^/]+)$', path)
            if m == 'POST':
                fid = self.new_id()
                f = {'id':fid,'name':meta.get('name'),'mimeType':meta.get('mimeType') or hdr.split(b'Content-Type: ')[1].split(b'\r\n')[0].decode(),'parents':meta.get('parents') or [],'appProperties':meta.get('appProperties') or {},'description':meta.get('description'),'modifiedTime':self.now(),'trashed':False,'content':content,'bytes':len(media),'version':'1'}
                self.files[fid]=f
                if self.docs: self.bump.add(fid)
                return ok({'id':fid,'modifiedTime':f['modifiedTime'],'version':f['version']})
            if m == 'PATCH' and mm:
                f = self.files.get(mm.group(1))
                if not f: return ok({'error':'nf'},404)
                f.update({k:v for k,v in meta.items()}); f['content']=content; f['modifiedTime']=self.now(); f['version']=str(int(f.get('version','1'))+1)
                if self.docs: self.bump.add(f['id'])
                return ok({'id':f['id'],'modifiedTime':f['modifiedTime'],'version':f['version']})
        return ok({'error':'unhandled '+m+' '+path},400)

GIS_STUB = """
window.google = window.google || {}; window.__gisCalls = 0;
google.accounts = { oauth2: {
  initTokenClient(cfg){ return { requestAccessToken(o){ window.__gisCalls++; window.__gisLast = {client_id: cfg.client_id, scope: cfg.scope, prompt: o && o.prompt};
     setTimeout(()=>cfg.callback({access_token:'fake-token', expires_in: 3599, scope: cfg.scope}), 20); } }; },
  hasGrantedAllScopes(){ return true; }, revoke(t, cb){ cb && cb(); }
}};
"""
