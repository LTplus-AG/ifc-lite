# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Private cold native qualification. Run only in an exclusive measurement window.
Frozen probe binaries must be built from named source commits before this runs.
The OS file cache is uncontrolled. Mesh hash excludes UVs/textures/instancing.
"""
import argparse, hashlib, json, os, pathlib, subprocess, time, re
root = pathlib.Path(__file__).parent
p = argparse.ArgumentParser()
p.add_argument('--manifest', type=pathlib.Path, required=True)
p.add_argument('--artifacts', type=pathlib.Path, required=True)
p.add_argument('--out', type=pathlib.Path, required=True)
p.add_argument('--pairs', type=int, default=5)
p.add_argument('labels', nargs='+')
args = p.parse_args()
if args.pairs < 1: p.error('--pairs must be positive')
manifest = json.loads(args.manifest.read_text())
rows = {row['label']: row for row in manifest['expanded_corpus']}
if set(args.labels) - rows.keys(): p.error('unknown fixture labels')
artifacts = json.loads(args.artifacts.read_text())
for side in ['base', 'candidate']:
    artifact = artifacts[side]
    digest = hashlib.sha256(pathlib.Path(artifact['binary']).read_bytes()).hexdigest()
    if digest != artifact['sha256'] or not artifact['sourceCommit']:
        raise RuntimeError('Missing or mismatched binary provenance')
args.out.mkdir(parents=True, exist_ok=True)
# File hashing is a preflight outside all timed runs; do not claim a cold OS cache.
for label in args.labels:
    row = rows[label]
    digest = hashlib.sha256()
    with open(row['path'], 'rb') as source:
        for block in iter(lambda: source.read(8*1024*1024), b''): digest.update(block)
    if digest.hexdigest() != row['fixture_identity']['sha256']:
        raise RuntimeError('Fixture identity changed: '+label)
for repetition in range(args.pairs):
    for index, label in enumerate(args.labels):
        row = rows[label]
        for side in (['base', 'candidate'] if (repetition+index)%2 == 0 else ['candidate', 'base']):
            out = args.out/f'{label}-pair{repetition+1}-{side}'
            if out.exists():
                print(json.dumps({'preservedExistingAttempt': str(out)}), flush=True)
                continue
            out.mkdir()
            command = ['/usr/bin/time', '-l', artifacts[side]['binary'], row['path'], '--cold', '--iters', '1', '--fingerprint', '--json']
            status = {'label': label, 'pair': repetition+1, 'side': side, 'fixtureSha256': row['fixture_identity']['sha256'], 'artifact': artifacts[side], 'startedUnix': time.time(), 'command': command}
            (out/'attempt.json').write_text(json.dumps(status, indent=2))
            with (out/'stdout.json').open('w') as stdout, (out/'stderr.log').open('w') as stderr:
                try:
                    result = subprocess.run(command, stdout=stdout, stderr=stderr, timeout=600)
                    status['exitCode'] = result.returncode
                except subprocess.TimeoutExpired:
                    status['timeout'] = True
            status['finishedUnix'] = time.time()
            if status.get('exitCode') == 0:
                try:
                    values = json.loads((out/'stdout.json').read_text())
                    if len(values) != 1 or not values[0].get('cold') or len(values[0].get('meshFingerprintsFnv1a64', [])) != 1:
                        raise ValueError('Missing exact cold single-fixture witness')
                    status['measurement'] = values[0]
                    diagnostic = (out/'stderr.log').read_text()
                    for field, pattern in [('maximumResidentSetBytes', r'([0-9]+)\s+maximum resident set size'), ('peakMemoryFootprintBytes', r'([0-9]+)\s+peak memory footprint')]:
                        match = re.search(pattern, diagnostic)
                        if not match: raise ValueError('Missing native process memory witness: '+field)
                        status['measurement'][field] = int(match.group(1))
                except (ValueError, KeyError) as error:
                    status['invalidOutput'] = str(error)
            (out/'result.json').write_text(json.dumps(status, indent=2))
            print(json.dumps(status), flush=True)
