# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, unquote
import json, mimetypes, threading
ROOTS={5327:Path('/home/louistrue/wt/6537-foreground-base-session6503/apps/viewer/dist'),5328:Path('/home/louistrue/wt/6537-owner-cache-foreground-main-session6503/apps/viewer/dist')}
MODELS=Path('/home/louistrue/.t3/worktrees/ifc-lite/t3code-41de0393/tests/models')
FIXTURES={'ac20':MODELS/'ara3d/AC20-FZK-Haus.ifc','holter':MODELS/'ara3d/ISSUE_053_20181220Holter_Tower_10.ifc','os1':MODELS/'various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc'}
BOOT="""<script>globalThis.__perfCapture={logs:[],errors:[],startedAt:null};for(const level of ['log','info','warn','error']){const original=console[level].bind(console);console[level]=(...args)=>{const text=args.map(a=>typeof a==='string'?a:a instanceof Error?a.message:String(a)).join(' ');if(__perfCapture.logs.length<2000)__perfCapture.logs.push({t:performance.now(),level,text});original(...args)}};addEventListener('error',e=>__perfCapture.errors.push({t:performance.now(),message:e.message}));addEventListener('unhandledrejection',e=>__perfCapture.errors.push({t:performance.now(),message:String(e.reason)}));</script>"""
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  path=unquote(urlsplit(self.path).path)
  if path=='/__prepare':self.send_bytes(b'<!doctype html><title>Perf cache preparation</title>', 'text/html');return
  if path.startswith('/__fixture/'):
   p=FIXTURES.get(path.rsplit('/',1)[-1]);
   if p is None:self.send_error(404);return
  else:
   root=ROOTS[self.server.server_port].resolve();p=(root/path.lstrip('/')).resolve()
   if not p.is_relative_to(root):self.send_error(403);return
   if path=='/':p=root/'index.html'
  if not p.is_file():self.send_error(404);return
  if p.name=='index.html':self.send_bytes(p.read_text().replace('<head>','<head>'+BOOT,1).encode(), 'text/html');return
  self.send_response(200);self.send_common_headers(mimetypes.guess_type(str(p))[0] or 'application/octet-stream',p.stat().st_size);self.end_headers()
  try:
   with p.open('rb') as f:
    while data:=f.read(1024*1024):self.wfile.write(data)
  except (BrokenPipeError, ConnectionResetError) as e:print('Client disconnected',self.path,str(e),flush=True)
 def send_common_headers(self,mime,size):
  self.send_header('Content-Type',mime);self.send_header('Content-Length',str(size));self.send_header('Cache-Control','no-store');self.send_header('Cross-Origin-Opener-Policy','same-origin');self.send_header('Cross-Origin-Embedder-Policy','credentialless')
 def send_bytes(self,data,mime):self.send_response(200);self.send_common_headers(mime,len(data));self.end_headers();self.wfile.write(data)
 def log_message(self,format,*args):
  if self.path=='/' or self.path.startswith('/__fixture/'):print(self.server.server_port,format%args,flush=True)
servers=[ThreadingHTTPServer(('0.0.0.0',port),Handler) for port in ROOTS]
for s in servers:threading.Thread(target=s.serve_forever,daemon=True).start()
print('Frozen source servers listening on 5327 base and 5328 branch',flush=True)
threading.Event().wait()
