#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independent data/Git replay; no archived scripts, builds, models or browsers."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys

sys.dont_write_bytecode = True
from cohort_archive import verified_members

BASE = '187a72e3302447fc49f2264111501223238a24a7'
CANDIDATE = '672f1e09c06ce777507244d2f2c4403d7b38c098'
SDK_CONTROLLER = '4d47506a23e304ed4b772f7890e27e37843e8914'
NATIVE_CONTROLLER = '9baab5249df8dbce2ae3f461ef9a95ba5d726f7e'
RUNTIME = {'hardwareConcurrency': 4, 'deviceMemory': 16, 'sab': True,
           'crossOriginIsolated': True, 'overrides': [], 'browserVersion': '154.0.8037.57'}
SDK = 'sdk-raw/artifacts/sdk-worker-37167109427-1/'
NATIVE = 'native-raw/artifacts/native-phase-37167463547-1/'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True, help='contains all four immutable commits')
    args = parser.parse_args()
    data = verified_members()
    read = lambda name: json.loads(data[name])
    sha = lambda name: hashlib.sha256(data[name]).hexdigest()
    checks = []

    def check(condition, label):
        checks.append({'name': label, 'pass': bool(condition)})
        if not condition:
            raise ValueError(label)

    report = read(SDK + 'report.json'); pins = read(SDK + 'provenance.json')
    start = read(SDK + 'build-start.json'); summary = read('sdk-audit/summary.json')
    check(read('sdk-raw/run.json')['conclusion'] == 'success'
          and read('sdk-raw/run.json')['head_sha'] == SDK_CONTROLLER, 'actual SDK SUCCESS/controller')
    check(pins['revisions'] == start['revisions'] == {'base': BASE, 'candidate': CANDIDATE}
          and pins['harnessHead'] == SDK_CONTROLLER, 'literal subjects/controller')
    check(report['status'] == 'complete-56-sample-hosted-SDK-cohort'
          and len(report['samples']) == 56 and len(report['pairs']) == 28, 'complete56/28')
    planned = []; pairs = []
    for family in ['house', 'csg', 'heavy-csg', 'architecture']:
        for pair in range(7):
            kind = 'AA' if pair < 2 else 'AB'
            order = ['base', 'base'] if pair < 2 else (['candidate', 'base'] if pair % 2 else ['base', 'candidate'])
            pairs.append({'family': family, 'index': pair, 'kind': kind})
            for slot, arm in enumerate(order):
                planned.append({'id': f'{family}-{pair}-{slot}-{arm}', 'family': family,
                                'pair': pair, 'kind': kind, 'arm': arm})
    check([{k: s[k] for k in planned[0]} for s in report['samples']] == planned, 'exact ordered sample schedule')
    check([{k: p[k] for k in pairs[0]} for p in report['pairs']] == pairs, 'exact ordered pair schedule')
    for key in ['sources', 'automation', 'compiler', 'bindgen', 'transform', 'pnpmSelection', 'closures']:
        check(pins[key] == start[key], 'producer pre/post ' + key)
    check(all(pins['frozenFiles'].get(k) == v for k, v in start['frozenFiles'].items()), 'prebuild pins preserved')
    for arm in ['base', 'candidate']:
        build = read(SDK + arm + '-source-build.json')
        check(build['status'] == 'complete-source-build' and build['exit'] == 0
              and build == pins['builds'][arm]['sourceBuild']
              and sha(SDK + arm + '-source-build.log') == build['logSha256'], 'actual producing receipt ' + arm)
        for asset in pins['builds'][arm]['assets']:
            name = SDK + arm + '-endpoint/' + asset['path']
            check(len(data[name]) == asset['size'] and sha(name) == asset['sha256'], 'served asset ' + name)
        wasm = next(a for a in pins['builds'][arm]['assets'] if a['path'].endswith('.wasm'))
        check(wasm['sha256'] == build['wasmSha256'] == pins['builds'][arm]['wasmSha256'], 'produced WASM ' + arm)
    check(pins['builds']['base']['sourceBuild']['endedUTC']
          < pins['builds']['candidate']['sourceBuild']['startedUTC']
          < report['samples'][0]['preparedUTC'], 'serial builds precede all model prepares')
    intervals = 0; statistics_by_family = {}
    for family in ['house', 'csg', 'heavy-csg', 'architecture']:
        samples = [s for s in report['samples'] if s['family'] == family]
        witness = samples[0]; deltas = []
        for s in samples:
            receipt = s['receipt']
            check(read(SDK + s['id'] + '.json') == s, 'raw sample equals report ' + s['id'])
            check(s['status'] == 'complete' and receipt['status'] == 'supported-output'
                  and receipt['generatorDone'] and receipt['processorDisposed'], 'full drain ' + s['id'])
            check(receipt['identity'] == witness['receipt']['identity']
                  and receipt['complete'] == witness['receipt']['complete'], 'untouched output/complete/diagnostics ' + s['id'])
            check(s['runtime'] == RUNTIME and s['workerCount'] == 2
                  and s['workerIds'] == [0, 1], 'exact observed default pool/runtime ' + s['id'])
            check(not s['errors'] and s['teardown'] == 'complete' and s['exit']['code'] == 0
                  and s['cleanup']['status'] == 'complete' and not s['cleanup']['remaining']
                  and s['cleanup']['zombies'] == 0 and s['logFlush']['status'] == 'complete', 'sample cleanup ' + s['id'])
            check(sha(SDK + s['id'] + '.json.pre-teardown.json') == s['preTeardown']['sha256'], 'before-close witness ' + s['id'])
        for pair in [p for p in report['pairs'] if p['family'] == family]:
            rows = [s for s in samples if s['pair'] == pair['index']]
            check(pair['status'] == 'complete' and pair['comparison']['milliseconds']
                  == [s['receipt']['elapsedMs'] for s in rows], 'pair receipts')
            if pair['kind'] == 'AA':
                check(abs(rows[1]['receipt']['elapsedMs'] / rows[0]['receipt']['elapsedMs'] - 1) <= .1, 'AA10percent')
            else:
                elapsed = {s['arm']: s['receipt']['elapsedMs'] for s in rows}
                delta = 100 * (elapsed['candidate'] / elapsed['base'] - 1)
                check(math.isclose(delta, 100 * pair['comparison']['relativeDelta'], abs_tol=1e-10), 'raw paired delta')
                deltas.append(delta)
            for stage in ['beforeCPU', 'afterCPU']:
                cpu = pair[stage]
                check(len(cpu['rows']) == 4 and len(cpu['intervals']) == 3
                      and not cpu['before']['active'] and not cpu['after']['active'], 'quiet graph/CPU census')
                for i, (lo, hi) in enumerate(zip(cpu['rows'], cpu['rows'][1:])):
                    values = []
                    for row in [lo, hi]:
                        ticks = list(map(int, row['raw'].split()[1:])); total = sum(ticks); idle = ticks[3] + ticks[4]
                        check(len(ticks) == 8 and total == int(row['total']) and idle == int(row['idle']), 'raw CPU counters')
                        values.append((total, idle))
                    total = values[1][0] - values[0][0]; idle = values[1][1] - values[0][1]
                    ns = int(hi['monotonicNs']) - int(lo['monotonicNs']); record = cpu['intervals'][i]
                    check(ns >= 10**9 and total > 0 and 0 <= idle <= total and idle * 10 >= total * 9
                          and int(record['elapsedNs']) == ns and int(record['totalTicks']) == total
                          and int(record['idleTicks']) == idle and record['eligible']
                          and math.isclose(record['cpuPercent'], 100 * (1 - idle / total), abs_tol=1e-10), 'fresh <=10percent CPU')
                    intervals += 1
        check(deltas == summary['families'][family]['pairedABPercentDeltas'], 'all five deltas retained ' + family)
        statistics_by_family[family] = {'deltasPercent': deltas, 'median': statistics.median(deltas), 'range': [min(deltas), max(deltas)]}
    check(intervals == 168, '168 independent intervals')
    check(report['initialResource']['availableBytes'] >= 8 * 1024**3
          and all(s['bytes'] <= 5 * 1024**3 and s['availableBytes'] >= 4 * 1024**3 for s in report['resourceSamples']), 'memory gates')
    check(report['finalInputVerification'] == 'complete' and report['ownedCleanup']['status'] == 'complete'
          and not report['ownedCleanup']['remaining'] and report['ownedCleanup']['zombies'] == 0
          and all(s['status'] == 'complete' and s['remainingSockets'] == 0 and not s['serverFault'] for s in report['serverCleanup']), 'terminal cleanup/freeze')
    native = read(NATIVE + 'report.json'); run = read('native-raw/run.json')
    check(run['conclusion'] == 'failure' and run['head_sha'] == NATIVE_CONTROLLER
          and native['status'] == 'refused' and len(native['pairs']) == 1, 'native terminal first refusal')
    sample = native['pairs'][0]['runs'][0]
    check(native['pairs'][0]['kind'] == 'AA' and sample['arm'] == 'base' and sample['status'] == 'refused'
          and not data[NATIVE + '0-0-base.stdout'] and not data[NATIVE + '0-0-base.stderr']
          and native['finalFrozenVerification'] == 'complete' and sample['cleanup']['status'] == 'complete'
          and not sample['cleanup']['remaining'] and sample['cleanup']['zombies'] == 0, 'zero-output native refusal/cleanup')
    observed = json.loads(native['reason'].split('non-exempt compiler/test graph: ', 1)[1])['actual']
    check(observed['argv'][1:] == ['-vV'] and Path(observed['executable']).name == 'rustc'
          and observed['executableObserved'], 'exact observed version-query refusal')
    # Immutable Git bytes, never checkout or execute archived code.
    source_counts = []
    for snapshot in pins['sources'] + read(NATIVE + 'provenance.json')['sources']:
        tree = subprocess.check_output(['git', '-C', str(args.repo), 'ls-tree', '-r', '-z', snapshot['head']], timeout=30)
        entries = [r.split(b'\t', 1) for r in tree.split(b'\0') if r]
        check(len(entries) == len(snapshot['files']), 'complete Git inventory ' + snapshot['head'])
        check(subprocess.check_output(['git', '-C', str(args.repo), 'rev-parse', snapshot['head'] + '^{tree}'], timeout=30).decode().strip() == snapshot['tree'], 'Git tree')
        ids = [metadata.decode().split()[2] for metadata, name in entries]
        output = subprocess.run(['git', '-C', str(args.repo), 'cat-file', '--batch'], input=('\n'.join(ids) + '\n').encode(), stdout=subprocess.PIPE, check=True, timeout=30).stdout
        cursor = 0
        for (metadata, name), blob in zip(entries, ids):
            check(metadata.decode().split()[:2] == ['100644', 'blob'] or metadata.decode().split()[:2] == ['100755', 'blob'], 'regular tracked Git source')
            end = output.index(b'\n', cursor); header = output[cursor:end].decode().split(); size = int(header[2]); cursor = end + 1
            content = output[cursor:cursor + size]; cursor += size + 1
            check(header[:2] == [blob, 'blob'] and hashlib.sha1(b'blob ' + str(size).encode() + b'\0' + content).hexdigest() == blob, 'Git object identity')
            check(hashlib.sha256(content).hexdigest() == snapshot['files'][snapshot['directory'] + '/' + name.decode()], 'full Git source hash')
        source_counts.append({'head': snapshot['head'], 'files': len(entries)})
    print(json.dumps({'status': 'PASS_DATA_AND_GIT_REPLAY', 'checks': len(checks), 'families': statistics_by_family,
                      'sourceCounts': source_counts, 'native': 'REFUSED_NO_OUTPUT_NO_TIMING_VERDICT',
                      'limits': 'Observed CPU digests, not regenerated meshes; remote tool/binary final pins remain producing receipts; no full-viewer or universal claim.'}, indent=2))


if __name__ == '__main__':
    main()
