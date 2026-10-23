# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from pathlib import Path
import hashlib,json,subprocess,time
out=Path(__file__).parent
pair=json.loads((out/'source-pair.json').read_text())
for name,head in [('candidate',pair['candidate']),('base',pair['control'])]:
 root=Path('/home/louistrue/build-workers/worker-state/checkouts')/head
 status=subprocess.check_output(['git','-C',str(root),'status','--porcelain'],text=True)
 if status: raise RuntimeError(f'{name} source changed: {status}')
 files=sorted(p for p in (root/'apps/viewer/dist').rglob('*') if p.is_file())
 if not files or not (root/'apps/viewer/dist/index.html').exists():raise RuntimeError('Missing viewer build')
 files+=sorted(p for p in (root/'packages/wasm/pkg').iterdir() if p.is_file() and p.suffix in ['.wasm','.js','.ts'])
 artifacts=[{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
 wasm=root/'packages/wasm/pkg/ifc-lite_bg.wasm'
 rust=list((root/'rust').rglob('*.rs'))
 proof={'capturedAt':time.time(),'head':head,'checkout':str(root),'artifacts':artifacts,'wasmMtime':wasm.stat().st_mtime,'latestRustMtime':max(p.stat().st_mtime for p in rust)}
 assert proof['wasmMtime']>=proof['latestRustMtime']
 (out/f'{name}-build-manifest.json').write_text(json.dumps(proof,indent=2)+'\n')
 print(name,head,len(artifacts),hashlib.sha256(wasm.read_bytes()).hexdigest())
base=json.loads((out/'base-build-manifest.json').read_text());branch=json.loads((out/'candidate-build-manifest.json').read_text())
for suffix in ['packages/wasm/pkg/ifc-lite_bg.wasm','packages/wasm/pkg/ifc-lite.js','packages/wasm/pkg/ifc-lite.d.ts']:
 values=[next(a['sha256'] for a in m['artifacts'] if a['path']==suffix) for m in [base,branch]]
 assert values[0]==values[1],(suffix,values)
print('Source-matched WASM, JS and declarations identical across arms')
