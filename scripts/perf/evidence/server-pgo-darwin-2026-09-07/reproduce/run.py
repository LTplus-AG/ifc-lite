# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

#!/usr/bin/env python3
"""Private actual HTTP server qualification. Never a viewer-readiness claim.
Raw wire persistence and RSS sampling run during timing; decoding runs afterward.
Fresh process/cache per invocation. No implicit artifact selection or retries.
"""
import argparse,base64,hashlib,http.client,json,os,socket,subprocess,threading,time,traceback
from pathlib import Path
import psutil,requests,pyarrow,platform
from wire import decode_run
from cache_phase import replay,compare_replay


def sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()


def run(a):
    out=Path(a.out).resolve();out.mkdir(exist_ok=False,parents=True)
    fixture=Path(a.fixture).resolve();binary=Path(a.binary).resolve()
    provenance=json.loads(Path(a.provenance).read_text())
    actual=sha(binary)
    if provenance['binarySha256']!=actual:raise ValueError('Frozen binary digest mismatch')
    (out/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
    result={'success':False,'binarySha256':actual,'fixtureSha256':sha(fixture),'sourceBytes':fixture.stat().st_size,
            'harnessSha256':{name:sha(Path(__file__).with_name(name)) for name in ('run.py','wire.py','cache_phase.py')},
            'dependencies':{'python':platform.python_version(),'pyarrow':pyarrow.__version__,'requests':requests.__version__,'psutil':psutil.__version__},
            'startedAtUnixSeconds':time.time(),'workers':a.workers,'clock':'monotonic wall; startup and upload/readiness origins reported separately',
            'limits':'HTTP server readiness, not browser render/search/picking; RSS is not physical footprint',
            'rawPersistenceDuringTiming':True,'decoderAfterTiming':True}
    cache=out/'cache';cache.mkdir()
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    env=os.environ.copy()
    # Pin inherited controls that could change admission, cache or geometry batching.
    settings={'PORT':str(port),'CACHE_DIR':str(cache),'WORKER_THREADS':str(a.workers),
      'MAX_FILE_SIZE_MB':str(max(16,(fixture.stat().st_size+1048575)//1048576+1)),
      'REQUEST_TIMEOUT_SECS':str(a.timeout),'IFC_MAX_CONCURRENT_PARSES':str(a.workers),
      'IFC_MEM_BUDGET_MB':'0','IFC_ADMISSION_QUEUE_DEPTH':str(2*a.workers),
      'IFC_ADMISSION_QUEUE_TIMEOUT_SECS':'5','IFC_MEM_SHED_PCT':'85','RUST_LOG':'info',
      'INITIAL_BATCH_SIZE':'100','MAX_BATCH_SIZE':'1000','IFC_SERVER_API_TOKEN':'','API_TOKEN':''}
    env.update(settings);result['environment']=settings
    result['instrumentationEnvironment']={k:env[k] for k in ('LLVM_PROFILE_FILE',) if k in env}
    session=requests.Session();session.trust_env=False
    start=time.monotonic();now=lambda:round((time.monotonic()-start)*1000,3)
    log=open(out/'server.log','wb');proc=subprocess.Popen([str(binary)],cwd=out,env=env,stdout=log,stderr=subprocess.STDOUT)
    stop=threading.Event();samples=[]
    def sample():
        p=psutil.Process(proc.pid)
        while not stop.is_set():
            try:samples.append({'ms':now(),'rss':p.memory_info().rss})
            except psutil.NoSuchProcess:break
            stop.wait(.05)
    monitor=threading.Thread(target=sample,daemon=True);monitor.start()
    timed_out=threading.Event()
    def kill_deadline():
        timed_out.set()
        if proc.poll() is None:proc.kill()
    watchdog=threading.Timer(a.timeout+30,kill_deadline);watchdog.start()
    try:
        url=f'http://127.0.0.1:{port}'
        while True:
            if proc.poll() is not None:raise RuntimeError('Server exited before readiness')
            try:
                response=session.get(url+'/api/v1/ready',timeout=1)
                if response.status_code==200:break
            except requests.ConnectionError:pass
            if now()>30000:raise TimeoutError('Startup deadline')
            time.sleep(.02)
        result['startupReadyMs']=now()
        boundary='ifc-http-qualification-v1'
        head=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.ifc"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
        tail=f'\r\n--{boundary}--\r\n'.encode()
        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=a.timeout)
        result['requestStartMs']=now()
        conn.putrequest('POST','/api/v1/parse/parquet-stream?parquet_layout=flat')
        conn.putheader('Content-Type',f'multipart/form-data; boundary={boundary}')
        conn.putheader('Content-Length',len(head)+fixture.stat().st_size+len(tail));conn.endheaders();conn.send(head)
        with fixture.open('rb') as f:
            for b in iter(lambda:f.read(1024*1024),b''):conn.send(b)
        conn.send(tail);result['uploadSentMs']=now()
        response=conn.getresponse();result['httpStatus']=response.status
        if response.status!=200:raise RuntimeError(f'Upload status {response.status}: {response.read(4096)!r}')
        cache_key=None;batch=0;completed=False;payload=[]
        with (out/'events.jsonl').open('w') as events:
            while True:
                line=response.readline()
                if not line:break
                if line.strip():
                    if line.startswith(b'data:'):payload.append(line[5:].strip())
                    continue
                if not payload:continue
                event=json.loads(b'\n'.join(payload));payload=[];kind=event['type']
                if completed:raise ValueError('Event after complete')
                if kind=='start':
                    if cache_key is not None:raise ValueError('Duplicate start')
                    cache_key=event['cache_key']
                elif kind=='batch':
                    batch+=1
                    if event['batch_number']!=batch:raise ValueError('Batch sequence mismatch')
                    if batch==1:result['firstBatchMs']=now()
                    result['lastBatchMs']=now()
                    data=base64.b64decode(event.pop('data'),validate=True)
                    event['file']=f'batch-{batch:05}.bin';event['wireSha256']=hashlib.sha256(data).hexdigest()
                    (out/event['file']).write_bytes(data)
                elif kind=='complete':completed=True;result['streamCompleteMs']=now()
                elif kind=='error':raise RuntimeError(event['message'])
                elif kind!='progress':raise ValueError('Unknown SSE event')
                events.write(json.dumps(event)+'\n');events.flush()
        conn.close()
        if payload or not completed or cache_key is None:raise ValueError('Incomplete SSE')
        result['sseEofMs']=now();polls=[]
        while True:
            r=session.get(url+'/api/v1/parse/data-model/'+cache_key,timeout=a.timeout)
            polls.append({'ms':now(),'status':r.status_code})
            if r.status_code==200:
                result['dataModelReceivedMs']=now();(out/'data-model.bin').write_bytes(r.content);break
            if r.status_code!=202:raise RuntimeError(f'Data model status {r.status_code}')
            if timed_out.is_set():raise TimeoutError('Data model deadline')
            time.sleep(.05)
        result['dataModelPolls']=polls
        result['httpFeatureReadyMs']=result['dataModelReceivedMs']-result['requestStartMs']
        result['loadSuccess']=True
        result['cacheReplay']=replay(session,url,result['fixtureSha256'],out,now,a.timeout)
        result['cacheReplaySuccess']=True
    except Exception as error:
        result['error']=str(error);result['traceback']=traceback.format_exc()
    finally:
        watchdog.cancel();result['deadlineKilled']=timed_out.is_set();result['shutdownStartMs']=now()
        if proc.poll() is None:proc.terminate()
        try:result['exitCode']=proc.wait(timeout=10);result['shutdownTimedOut']=False
        except subprocess.TimeoutExpired:
            proc.kill();result['exitCode']=proc.wait();result['shutdownTimedOut']=True
        result['shutdownEndMs']=now();stop.set();monitor.join();log.close();session.close()
        result['memorySamples']=samples;result['peakSampledRss']=max((s['rss'] for s in samples),default=0)
        result['peakSampledRssThroughColdReady']=max((s['rss'] for s in samples if s['ms']<=result.get('dataModelReceivedMs',float('inf'))),default=0)
        result['shutdownNote']='Owned process terminated after response completion; SIGTERM exit does not establish PGO profile flush.'
    result['transportSuccess']=bool(result.get('loadSuccess') and result.get('cacheReplaySuccess')) and not result['shutdownTimedOut'] and not result['deadlineKilled'] and 'error' not in result
    result['offlineStatus']='pending' if a.defer_offline else 'running'
    # Persist complete transport clocks and cleanup BEFORE any offline decoding.
    (out/'timing-checkpoint.json').write_text(json.dumps(result,indent=2)+'\n')
    if result.get('loadSuccess') and not a.defer_offline:
        try:
            witness=decode_run(out)
            result['decodedMeshes']=len(witness['geometry'])
            if result.get('cacheReplaySuccess'):compare_replay(out,witness)
            result['success']=bool(result.get('cacheReplaySuccess')) and not result['shutdownTimedOut'] and not result['deadlineKilled'] and 'error' not in result
        except Exception as error:result['decodeError']=str(error);result['traceback']=traceback.format_exc()
    if not a.defer_offline:result['offlineStatus']='passed' if result['success'] else 'failed'
    (out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k in ['success','error','decodeError','httpFeatureReadyMs','decodedMeshes']}))
    return 0 if result['success'] or (a.defer_offline and result['transportSuccess']) else 1


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--fixture',required=True)
    p.add_argument('--out',required=True);p.add_argument('--provenance',required=True);p.add_argument('--workers',type=int,default=15);p.add_argument('--timeout',type=int,default=300);p.add_argument('--defer-offline',action='store_true')
    raise SystemExit(run(p.parse_args()))
