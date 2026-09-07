# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Private HTTP witness v1. Exact decoded values; no geometry tolerance.
All wire columns are retained. Only batch storage offsets/order are normalized;
per-occurrence vertex/triangle order and duplicate occurrence multiplicity remain.
Nonfinite values fail closed rather than accidentally canonicalizing NaN payloads.
"""
import base64, hashlib, io, json, math, struct
import pyarrow.parquet as pq


def encode(x):
    if isinstance(x, float):
        if not math.isfinite(x):
            raise ValueError('Nonfinite value: exact bit witness requires extension')
        return {'float64le': struct.pack('<d', x).hex()}
    if isinstance(x, bytes): return {'bytes': base64.b64encode(x).decode()}
    if isinstance(x, dict): return {k: encode(v) for k,v in sorted(x.items())}
    if isinstance(x, (tuple,list)): return [encode(v) for v in x]
    if x is None or isinstance(x,(str,bool,int)): return x
    raise TypeError(type(x).__name__)


def digest(x):
    return hashlib.sha256(json.dumps(encode(x),sort_keys=True,separators=(',',':')).encode()).hexdigest()


def sections(data, count, tail=0):
    out=[]; at=0
    for _ in range(count):
        if at+4>len(data): raise ValueError('Truncated section length')
        n=struct.unpack_from('<I',data,at)[0]; at+=4
        if at+n>len(data): raise ValueError('Truncated section')
        out.append(data[at:at+n]); at+=n
    if at+tail!=len(data): raise ValueError('Unexpected section remainder')
    return out,data[at:]


def table(data):
    t=pq.read_table(io.BytesIO(data))
    schema=[(f.name,str(f.type),f.nullable) for f in t.schema]
    return schema,t.to_pylist()


def row_witness(data):
    parquet=pq.ParquetFile(io.BytesIO(data))
    schema=[(f.name,str(f.type),f.nullable) for f in parquet.schema_arrow]
    hashes=[]
    for batch in parquet.iter_batches(batch_size=1024):
        hashes.extend(digest(r) for r in batch.to_pylist())
    return {'schema':schema,'rows':len(hashes),'rowDigests':sorted(hashes)}


def geometry(data):
    parts,_=sections(data,3)
    (ms,meshes),(vs,vertices),(ts,triangles)=map(table,parts)
    out=[]; usedv=set(); usedt=set()
    for mesh in meshes:
        m=dict(mesh); v=m.pop('vertex_start'); n=m['vertex_count']; i=m.pop('index_start'); k=m['index_count']
        if i%3 or k%3 or v+n>len(vertices) or (i+k)//3>len(triangles): raise ValueError('Mesh span invalid')
        vv=vertices[v:v+n]; tt=triangles[i//3:(i+k)//3]
        for tri in tt:
            if any(tri[x]>=n for x in ('i0','i1','i2')): raise ValueError('Triangle index out of range')
        usedv.update(range(v,v+n));usedt.update(range(i//3,(i+k)//3))
        out.append({'entity':m['express_id'],'digest':digest([ms,vs,ts,m,vv,tt]),'vertices':n,'triangles':k//3})
    if len(usedv)!=len(vertices) or len(usedt)!=len(triangles): raise ValueError('Unreferenced wire rows')
    return out


def data_model(data):
    parts,_=sections(data,8)
    names=['entities','properties','quantities','relationships','spatial','classifications','materials','documents']
    out={}
    for name,part in zip(names,parts):
        if name=='spatial':
            chunks,tail=sections(part,5,4)
            out[name]={'projectId':struct.unpack('<I',tail)[0], 'tables':[row_witness(c) for c in chunks]}
        else: out[name]=row_witness(part)
    return out


def decode_run(path,expected_cache=False):
    events=[json.loads(line) for line in (path/'events.jsonl').read_text().splitlines()]
    complete=[e for e in events if e['type']=='complete']
    if len(complete)!=1: raise ValueError('Expected one complete event')
    meshes=[]
    for e in events:
        if e['type']=='batch':
            rows=geometry((path/e['file']).read_bytes())
            if len(rows)!=e['mesh_count']: raise ValueError('Batch mesh count differs')
            meshes.extend(rows)
    stats=complete[0]['stats']
    expected={'total_meshes':len(meshes),'total_vertices':sum(m['vertices'] for m in meshes),'total_triangles':sum(m['triangles'] for m in meshes)}
    if any(stats[k]!=v for k,v in expected.items()): raise ValueError('Complete geometry totals disagree with wire')
    if expected_cache is not None and stats['from_cache']!=expected_cache: raise ValueError('Unexpected cache disposition')
    diagnostics={k:v for k,v in stats.items() if not k.endswith('_time_ms') and k not in ('point_cache_hits','point_cache_misses','from_cache')}
    result={'protocol':'http-wire-v1','geometry':sorted(meshes,key=lambda r:(r['entity'],r['digest'])),
            'metadataDigest':digest(complete[0]['metadata']),'diagnostics':diagnostics,
            'symbolicDigest':digest(complete[0].get('symbolic_data')),
            'dataModel':data_model((path/'data-model.bin').read_bytes())}
    (path/'semantic.json').write_text(json.dumps(result,indent=2)+'\n')
    return result
