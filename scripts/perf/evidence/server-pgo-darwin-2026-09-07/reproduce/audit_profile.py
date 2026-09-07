# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import pathlib,json,subprocess,hashlib,re
import argparse
p=argparse.ArgumentParser();p.add_argument('--experiment',type=pathlib.Path,required=True);p.add_argument('--llvm-profdata',required=True);a=p.parse_args();D=a.experiment.resolve();prof=a.llvm_profdata
raw=sorted((D/'raw').glob('*.profraw'));assert len(raw)==5,[(p.name,p.stat().st_size) for p in raw]
assert not (D/'merged.profdata').exists()
for cmd,name in [([prof,'merge','-o',str(D/'merged.profdata'),*[str(p) for p in raw]],'merge'),([prof,'show','--all-functions','--counts',str(D/'merged.profdata')],'functions'),([prof,'show','--detailed-summary',str(D/'merged.profdata')],'summary')]:
 r=subprocess.run(cmd,capture_output=True,text=True);(D/('profile-'+name+'.stdout.log')).write_text(r.stdout);(D/('profile-'+name+'.stderr.log')).write_text(r.stderr);assert r.returncode==0,(name,r.stderr)
s=(D/'profile-functions.stdout.log').read_text();records=[]
for block in re.split(r'(?m)^  (?=\S)',s)[1:]:
 name=block.splitlines()[0];m=re.search(r'Block counts: \[([^]]*)\]',block)
 if m:records.append((name,[int(x.strip()) for x in m.group(1).split(',') if x.strip()]))
coverage={}
for label,needle in [('scan','next_entity'),('decode','decode_at'),('producer','produce_element_meshes'),('geometrySerialization','build_mesh_tables'),('dataModelSerialization','serialize_data_model_to_parquet')]:
 hits=[(n,c) for n,c in records if needle in n];coverage[label]={'needle':needle,'records':len(hits),'nonzeroRecords':sum(any(c) for n,c in hits),'maxBlockCount':max([max(c,default=0) for n,c in hits],default=0)}
assert all(v['nonzeroRecords'] for v in coverage.values()),coverage
result={'kind':'Continuous counter-only, not full-value profiling','rawSha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in raw},'mergedSha256':hashlib.sha256((D/'merged.profdata').read_bytes()).hexdigest(),'recordCount':len(records),'coverage':coverage,'limitation':'IR block counts prove exercised code, not timings or exact function call counts'}
(D/'coverage-audit.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
