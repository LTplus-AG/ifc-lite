# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Offline CC BY 4.0 CRAS fixture exploration; never a production ingest path.
# Requires numpy. Usage: python3 cras-prefix-sample.py OUTPUT_DIRECTORY [64|128]
import sys
import urllib.request,zlib,struct,hashlib,json,pathlib,time
import numpy as np
mib=int(sys.argv[2]) if len(sys.argv)>2 else 64
assert mib in (64,128), 'This exploration is capped at 128 MiB compressed bytes'
p=pathlib.Path(sys.argv[1]); p.mkdir(parents=True, exist_ok=True); n=mib*1024*1024
name='cras-broader-sample' if mib==64 else 'cras-expanded-sample'
req=urllib.request.Request('https://zenodo.org/api/records/7948116/files/craslabannotated.zip/content',headers={'Range':f'bytes=0-{n-1}'})
with urllib.request.urlopen(req,timeout=120) as r:
 assert r.status==206 and r.headers.get('Content-Range','').startswith(f'bytes 0-{n-1}/'),(r.status,r.headers)
 b=r.read(n+1)
assert len(b)==n,len(b)
(p/f'cras-prefix-{mib}m.zip.part').write_bytes(b)
print('Downloaded bounded prefix; full archive checksum remains unverified',len(b),flush=True)
h=struct.unpack_from('<4s5H3I2H',b);offset=30+h[-2]+h[-1];dec=zlib.decompressobj(-15)
carry=b'';idx=-2;kept=[];stride=mib;lo=np.full(3,np.inf);hi=-lo;labels={}
for pos in range(offset,len(b),262144):
 raw=carry+dec.decompress(b[pos:pos+262144]);raw,carry=raw.rsplit(b'\n',1);lines=raw.splitlines()
 if idx<0:lines=lines[-idx:];idx=0
 a=np.loadtxt(lines);lo=np.minimum(lo,a[:,:3].min(axis=0));hi=np.maximum(hi,a[:,:3].max(axis=0));u,c=np.unique(a[:,7],return_counts=True)
 for v,k in zip(u,c):labels[str(int(v))]=labels.get(str(int(v)),0)+int(k)
 first=(-idx)%stride
 for j in range(first,len(a),stride):kept.append((idx+j,lines[j]))
 idx+=len(a)
 if (pos-offset)//262144%32==0:print('rows',idx,flush=True)
dst=p/f'{name}.tsv';dst.write_bytes(b'source_index\tx\ty\tz\tr\tg\tb\tintensity\tclass\n'+b'\n'.join(str(i).encode()+b'\t'+line for i,line in kept)+b'\n')
d={'compressed_range':[0,n-1],'compressed_sha256':hashlib.sha256(b).hexdigest(),'complete_source_rows_examined':idx,'source_bounds_metres':[lo.tolist(),hi.tolist()],'source_order_stride':stride,'output_points':len(kept),'labels':labels,'output_sha256':hashlib.sha256(dst.read_bytes()).hexdigest(),'coverage':f'systematic sample of {mib}MiB compressed prefix, not complete archive spatial query','registration':None}
ply=p/f'{name}.ply'
with ply.open('wb') as f:
 f.write(('ply\nformat ascii 1.0\ncomment CRAS CC BY 4.0 doi:10.5281/zenodo.7948116; unregistered bounded prefix sample\n'+f'element vertex {len(kept)}\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uint source_index\nend_header\n').encode())
 for i,line in kept:f.write(b' '.join(line.split()[:6])+b' '+str(i).encode()+b'\n')
d['ply']={'bytes':ply.stat().st_size,'sha256':hashlib.sha256(ply.read_bytes()).hexdigest(),'normals':False,'coordinates':'source metres; no registration applied'}
(p/f'{name}.json').write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d,indent=2),flush=True)
