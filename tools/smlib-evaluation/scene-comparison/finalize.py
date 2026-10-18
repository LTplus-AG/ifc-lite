#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Recheck retained scene records and pin final historical-library evidence."""
import argparse
import json
from pathlib import Path
from run import compare, required_witnesses, sha

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--pins',type=Path,required=True)
    p.add_argument('--build-dir',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--scope',default='pinned base/candidate comparison; see source manifest and library pins')
    p.add_argument('result_dirs',type=Path,nargs='+')
    args=p.parse_args()
    pins=json.loads(args.pins.read_text())
    final_libraries={}
    for label,libraries in pins['libraries'].items():
        final_libraries[label]={}
        for name,library in libraries.items():
            actual=sha(library['path'])
            if actual!=library['sha256']:raise RuntimeError('historical library overwritten: '+library['path'])
            final_libraries[label][name]=actual
    build=json.loads((args.build_dir/'build-receipt.json').read_text())
    source_dir=Path(__file__).parent/'src'
    actual_source={str(path.relative_to(source_dir.parent)):sha(path) for path in sorted(source_dir.glob('*.rs'))}
    if actual_source!=build['harness']:raise RuntimeError('consumer source changed after build')
    for label in ['base','candidate']:
        if sha(args.build_dir/('scene-'+label))!=build[label+'_executable_sha256']:
            raise RuntimeError('consumer executable changed')
    cases=[]
    coverage={}
    for result_dir in args.result_dirs:
        source_summary=json.loads((result_dir/'summary.json').read_text())
        for old in source_summary:
            fixture=Path(old['fixture'])
            case=result_dir/(fixture.stem+'-'+old['input_sha256'][:12]+'-'+old['mode'])
            result=compare(case/'base',case/'candidate')
            repeat=compare(case/'base',case/'base-repeat')
            required=required_witnesses(fixture,result['mode'])
            missing=[label+':'+key for label in ['base','candidate'] for key,n in required.items()
                     if result[label+'_witnesses'].get(key,0)<n]
            for key,n in result['candidate_witnesses'].items():coverage[key]=coverage.get(key,0)+n
            raw={}
            for label in ['base','base-repeat','candidate']:
                raw[label]={}
                for name in ['manifest.json','records.jsonl']:
                    path=case/label/name
                    raw[label][name]={'path':str(path),'bytes':path.stat().st_size,'sha256':sha(path)}
            cases.append({'fixture':str(fixture),'input_sha256':result['input_sha256'],'mode':result['mode'],
                'equal':result['equal'],'base_reproducible':repeat['equal'],'required_witnesses':required,
                'missing_witnesses':missing,'qualified':result['equal'] and repeat['equal'] and not missing,
                'witnesses':result['candidate_witnesses'],'scene_sha256':result['candidate_scene_sha256'],
                'semantic_differences':result['semantic_differences'],
                'capability_difference':result['capability_difference'],
                'execution_differing_records':len(result['execution_differences']),'raw':raw})
    output={'scope':args.scope,
        'source_manifest_sha256':pins['frozen_manifest_sha256'],'source_count':pins['source_count'],
        'cases':cases,'qualified':sum(case['qualified'] for case in cases),'case_count':len(cases),
        'observed_totals':coverage,'unwitnessed':[key for key,n in coverage.items() if not n],
        'final_library_sha256':final_libraries,'consumer_build_receipt_sha256':sha(args.build_dir/'build-receipt.json'),
        'runner_sha256':sha(Path(__file__).with_name('run.py')),'finalizer_sha256':sha(__file__),
        'limitations':['public full-pass aggregates do not expose per-element hashes/refusal chronology',
            'external image reference equality does not prove image resolution',
            'source material-definition graph is not fully exposed; extracted associations are compared',
            'coverage is limited to the listed actual inputs/modes and positive witnesses; no performance claim',
            'IFCX and USD have separate actual-consumer evidence']}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(output,indent=2)+'\n')
    print(f"qualified {output['qualified']}/{len(cases)}, unwitnessed={output['unwitnessed']}")
    if output['qualified']!=len(cases):raise SystemExit(1)
if __name__=='__main__':main()
