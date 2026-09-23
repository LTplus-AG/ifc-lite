# SPDX-License-Identifier: MPL-2.0
import re,urllib.request,urllib.parse,json,concurrent.futures
origin='https://www.ifclite.com'
html=open('/tmp/ifc-export-spikes/viewer.html').read()
queue=set(re.findall(r'(?:src|href)="([^"]+\.js)"',html));seen=set();found=set()
for depth in range(5):
 batch=sorted(queue-seen);queue=set()
 if not batch:break
 def fetch(p):
  try:return p,urllib.request.urlopen(origin+p,timeout=30).read().decode()
  except Exception as e:return p,str(e)
 with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
  for p,s in pool.map(fetch,batch):
   seen.add(p)
   for x in re.findall(r'["\']([^"\'\s]+\.(?:js|wasm))["\']',s):
    url=urllib.parse.urljoin(p,x)
    if x.endswith('.wasm'):found.add(url)
    elif url.startswith('/assets/'):queue.add(url)
 print(depth,len(seen),sorted(found),flush=True)
 if found:break
json.dump({'scripts':sorted(seen),'wasm':sorted(found)},open('/tmp/ifc-export-spikes/assets.json','w'),indent=2)
