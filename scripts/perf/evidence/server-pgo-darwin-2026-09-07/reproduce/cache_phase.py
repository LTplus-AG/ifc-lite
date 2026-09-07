# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Post-cold cache completion/replay witness. Cold readiness is already frozen."""
import base64,hashlib,io,json,time
from wire import decode_run


def replay(session,url,source_sha,out,now,timeout):
    start=time.monotonic();polls=[]
    def check_deadline():
        if time.monotonic()-start>timeout:raise TimeoutError('Cache readiness/replay deadline')
    replay_out=out/'cache-replay';replay_out.mkdir()
    while True:
        check_deadline()
        r=session.get(url+'/api/v1/cache/check/'+source_sha+'?parquet_layout=flat',timeout=timeout)
        polls.append({'ms':now(),'stage':'check','status':r.status_code})
        if r.status_code not in (200,404):raise RuntimeError(f'Cache check status {r.status_code}')
        if r.status_code==200:
            r=session.post(url+'/api/v1/parse/parquet-stream?parquet_layout=flat&sha256='+source_sha,stream=True,timeout=timeout)
            polls.append({'ms':now(),'stage':'hash-only','status':r.status_code})
            if r.status_code==200:break
            if r.status_code!=404:raise RuntimeError(f'Hash-only replay status {r.status_code}')
            r.close()
        time.sleep(.05)
    result={'cacheReadyMs':now(),'polls':polls,'request':'hash-only POST; no source body'}
    batch=0;complete=False;key=None;payload=[]
    # urllib3 readinto honors decode_content; BufferedReader avoids quadratic
    # repeated splitting of a growing multi-megabyte base64 SSE record.
    r.raw.decode_content=True
    r.raw.auto_close=False
    with r, io.BufferedReader(r.raw,buffer_size=64*1024) as buffered, (replay_out/'events.jsonl').open('w') as f:
        for line in iter(buffered.readline,b''):
            line=line.rstrip(b'\r\n')
            check_deadline()
            if line:
                if line.startswith(b'data:'):payload.append(line[5:].strip())
                continue
            if not payload:continue
            e=json.loads(b'\n'.join(payload));payload=[]
            if complete:raise ValueError('Replay event after complete')
            if e['type']=='start':
                if key is not None:raise ValueError('Duplicate replay start')
                key=e['cache_key']
            elif e['type']=='batch':
                batch+=1
                if e['batch_number']!=batch:raise ValueError('Replay batch sequence mismatch')
                data=base64.b64decode(e.pop('data'),validate=True)
                e['file']=f'batch-{batch:05}.bin';e['wireSha256']=hashlib.sha256(data).hexdigest()
                (replay_out/e['file']).write_bytes(data)
            elif e['type']=='complete':complete=True
            elif e['type']=='error':raise RuntimeError(e['message'])
            elif e['type']!='progress':raise ValueError('Unknown replay event')
            f.write(json.dumps(e)+'\n')
    if payload or not complete or key is None:raise ValueError('Incomplete cache replay')
    r=session.get(url+'/api/v1/parse/data-model/'+key,timeout=timeout)
    if r.status_code!=200:raise RuntimeError('Cached data-model fetch failed')
    (replay_out/'data-model.bin').write_bytes(r.content)
    result['replayCompleteMs']=now()
    return result


def compare_replay(out,cold):
    cached=decode_run(out/'cache-replay',expected_cache=None)
    fields={k:cold[k]==cached[k] for k in cold}
    def raw_batches(path):
        events=[json.loads(line) for line in (path/'events.jsonl').read_text().splitlines()]
        return [e['wireSha256'] for e in events if e['type']=='batch']
    report={'exactDecodedFields':fields,'rawBatchBytesMatch':raw_batches(out)==raw_batches(out/'cache-replay'),
            'rawDataModelBytesMatch':(out/'data-model.bin').read_bytes()==(out/'cache-replay/data-model.bin').read_bytes()}
    (out/'cache-replay-comparison.json').write_text(json.dumps(report,indent=2)+'\n')
    if not all(fields.values()):raise ValueError('Cache replay exact semantic mismatch: '+str(fields))
