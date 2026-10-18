#!/usr/bin/env python3
import collections,hashlib,json,re,subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
r=json.loads((HERE/'receipt.json').read_text());results={}; raw_tables={}
for label in ['base','candidate']:
    exe=HERE/('alloc-'+label)
    header=subprocess.check_output(['readelf','-h',str(exe)],text=True);assert re.search(r'Type:\s+EXEC',header),header
    sections=subprocess.check_output(['readelf','-W','-S',str(exe)],text=True)
    (HERE/(label+'-elf-header.txt')).write_text(header);(HERE/(label+'-elf-sections.txt')).write_text(sections)
    text=re.search(r'\]\s+\.text\s+PROGBITS\s+([0-9a-fA-F]+)\s+[0-9a-fA-F]+\s+([0-9a-fA-F]+)',sections);assert text
    lo=int(text[1],16);hi=lo+int(text[2],16)
    runs=[run for run in r['runs'] if run['label']==label]
    data=[(run,json.loads(Path(run['data_file']).read_text())) for run in runs]
    addresses=sorted({addr-1 for _,d in data for trace in d['traces']+[{'frames':d['probe_frames']}] for addr in trace['frames'] if lo<=addr-1<hi})
    cmd=['addr2line','-a','-f','-C','-i','-e',str(exe)]
    inp=''.join(hex(a)+'\n' for a in addresses)
    p=subprocess.run(cmd,input=inp,capture_output=True,text=True,check=True)
    (HERE/(label+'-addr2line-input.txt')).write_text(inp);(HERE/(label+'-addr2line-output.txt')).write_text(p.stdout)
    lines=p.stdout.splitlines();symbols={};i=0
    while i<len(lines):
        assert re.fullmatch(r'0x[0-9a-fA-F]+',lines[i]),(i,lines[i])
        addr=int(lines[i],16);i+=1;frames=[]
        while i<len(lines) and not re.fullmatch(r'0x[0-9a-fA-F]+',lines[i]):
            assert i+1<len(lines);frames.append({'function':lines[i],'location':lines[i+1]});i+=2
        symbols[addr]=frames
    assert set(symbols)==set(addresses)
    probe_functions=[f['function'] for _,d in data for addr in d['probe_frames'] for f in symbols.get(addr-1,[])]
    assert any('sampler_probe' in f for f in probe_functions),'Known probe stack unresolved'
    primary={};inclusive={};total=0;resolved=0;unknown=0;perrun=[];evidence=[]
    def add(table,key,t):
        v=table.setdefault(key,{'samples':0,'sampled_requested_bytes':0,'allocation_samples':0,'reallocation_samples':0,'example_stack':[]})
        v['samples']+=1;v['sampled_requested_bytes']+=t['size'];v['reallocation_samples']+=int(t['kind']==2);v['allocation_samples']+=int(t['kind']!=2)
        if not v['example_stack']:v['example_stack']=[{'function':f['function'],'location':f['location']} for addr in t['frames'] for f in symbols.get(addr-1,[])][:32]
    for run,d in data:
        counts=collections.Counter();bytecounts=collections.Counter()
        for t in d['traces']:
            total+=1;frames=[f for addr in t['frames'] for f in symbols.get(addr-1,[])]
            project=[f for f in frames if 'ifc_lite_' in f['function']]
            if project:resolved+=1;key=project[0]['function']
            else:unknown+=1;key='[no project frame]'
            add(primary,key,t);counts[key]+=1;bytecounts[key]+=t['size']
            seen=set()
            for f in project:
                if f['function'] not in seen:add(inclusive,f['function'],t);seen.add(f['function'])
            if project and any(x in f['function'] for f in project for x in ['OwnedJob','DecodedEntity','mapping::','session_state','owned_session']):
                if len(evidence)<100:evidence.append({'event':t['event'],'iteration':t['iteration'],'kind':t['kind'],'size':t['size'],'stack':[{'function':f['function'],'location':f['location']} for f in frames]})
        perrun.append({'order':run['order'],'samples':len(d['traces']),'dropped':d['dropped'],'truncated':sum(t['truncated'] for t in d['traces']),'reentrant_excluded':d['reentrant_excluded'],'successful_events':sum(x['successful_events'] for x in d['iterations']),'requested_bytes_all_events':sum(x['requested_bytes'] for x in d['iterations']),'primary_sites':dict(counts),'primary_sampled_requested_bytes':dict(bytecounts)})
    def rows(table):return [{'function':k,**v,'sample_fraction':v['samples']/total} for k,v in sorted(table.items(),key=lambda x:-x[1]['samples'])]
    results[label]={'text_range':[lo,hi],'unique_symbolized_addresses':len(addresses),'known_probe_resolves':True,'samples':total,'project_frame_samples':resolved,'no_project_frame_samples':unknown,'runs':perrun,'primary_sites':rows(primary),'inclusive_sites':rows(inclusive),'selected_actual_stacks':evidence}
    raw_tables[label]={'primary':primary,'inclusive':inclusive}
comparisons={}
for view in ['primary','inclusive']:
    keys=set(raw_tables['base'][view])|set(raw_tables['candidate'][view]);out=[]
    for k in keys:
        a=raw_tables['base'][view].get(k,{});b=raw_tables['candidate'][view].get(k,{})
        out.append({'function':k,'base_samples':a.get('samples',0),'candidate_samples':b.get('samples',0),'sample_difference':b.get('samples',0)-a.get('samples',0),'base_sampled_requested_bytes':a.get('sampled_requested_bytes',0),'candidate_sampled_requested_bytes':b.get('sampled_requested_bytes',0)})
    comparisons[view]=sorted(out,key=lambda x:-x['sample_difference'])
summary={'method':'Modulo2048 successful request sampling; bounded fixed slots; 96 physical frames; warmed glibc backtrace, recursion guard and in-flight writer drain. NonPIE ET_EXEC; return PCs minus1 resolved with addr2line -a -f -C -i.','sampler_receipt_sha256':sha(HERE/'receipt.json'),'labels':results,'comparisons':comparisons,'limitations':['Modulo sampling can correlate with allocation loops, sizes and phase order. These are observed sampled requests, not unbiased exact site counts or requested-traffic estimates.','Two worker threads interleave requests; exact sample composition and symbol rankings vary across repetitions. Inclusive site totals overlap and must not be summed.','Only Rust GlobalAlloc successful requests during process_geometry are sampled; glibc/libgcc loader/native malloc allocations, frees and post-call result drop are outside stack sampling.','A stack is reconstructed from available executable unwind/debug information, including inlined frames; unresolved external frames are not fabricated.','Atomic/backtrace instrumentation, nonPIE/framepointer compilation and shared-host load perturb execution. No latency/RSS verdict or causal allocation-cost attribution.','New function names/source layout can split attribution between old and new call paths; zero baseline samples in a new function is not the exact number of new allocations.','Sampled requested bytes are request sizes including full new realloc sizes, not bytes actually copied. Large rare allocations may be unsampled.']}
(HERE/'symbolized.json').write_text(json.dumps(summary,indent=2)+'\n');print('symbolized',[(k,v['samples'],v['project_frame_samples']) for k,v in results.items()]);print('Top primary sample differences:');print(json.dumps(comparisons['primary'][:20],indent=2))
