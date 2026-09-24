#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Reproduce the #5557 native bounded-GLB screen on Linux (GNU time + taskset)."""
import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

FIXTURES = (
    ('holter', 'ara3d/ISSUE_053_20181220Holter_Tower_10.ifc'),
    ('csg129', 'ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc'),
    ('haus', 'ara3d/AC20-FZK-Haus.ifc'),
)


def digest(path):
    hash_ = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            hash_.update(block)
    return hash_.hexdigest()


def gnu_time_metric(text, label):
    match = re.search(r'^\s*' + re.escape(label) + r':\s*([0-9.]+)\s*$', text, re.M)
    if not match:
        raise RuntimeError(f'GNU time did not report {label}')
    return float(match.group(1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--fixture-root', type=Path, required=True, help='directory containing ara3d/*.ifc')
    parser.add_argument('--out', type=Path, required=True, help='new output directory; existing paths are refused')
    parser.add_argument('--cpus', required=True, help='allowed taskset CPU list, e.g. 4-23')
    parser.add_argument('--rayon-threads', type=int, required=True)
    parser.add_argument('--pairs', type=int, default=2)
    args = parser.parse_args()
    if args.pairs < 1 or args.rayon_threads < 1:
        parser.error('pairs and rayon-threads must be positive')
    for path in (args.base, args.candidate):
        if not path.is_file():
            parser.error(f'binary not found: {path}')
    for _, relative in FIXTURES:
        if not (args.fixture_root / relative).is_file():
            parser.error(f'fixture not found: {args.fixture_root / relative}')
    args.out.mkdir(parents=True, exist_ok=False)
    protocol = {
        'baseSha256': digest(args.base),
        'candidateSha256': digest(args.candidate),
        'sourceBase': 'd05f5423a7caf761f0a2e12d064d85e84355d031',
        'fixtures': [{'name': name, 'relativePath': relative, 'sha256': digest(args.fixture_root / relative)} for name, relative in FIXTURES],
        'environment': {'cpus': args.cpus, 'rayonThreads': args.rayon_threads, 'pairs': args.pairs},
        'boundary': 'probe output_ms covers file read, bounded export, and output write; hashing outside timer',
    }
    (args.out / 'protocol.json').write_text(json.dumps(protocol, indent=2) + '\n')
    rows = []
    for name, relative in FIXTURES:
        for pair in range(1, args.pairs + 1):
            for arm in (('base', 'candidate') if pair % 2 else ('candidate', 'base')):
                stem = f'{name}-p{pair}-{arm}'
                output = args.out / f'{stem}.glb'
                scratch = args.out / f'{stem}.scratch'
                time_file = args.out / f'{stem}.time'
                environment = os.environ.copy()
                environment.pop('IFC_SPIKE_SPOOL', None)
                environment.pop('IFC_SPIKE_GEOREF', None)
                environment['RAYON_NUM_THREADS'] = str(args.rayon_threads)
                if arm == 'candidate':
                    environment['IFC_SPIKE_SPOOL'] = str(scratch)
                binary = args.base if arm == 'base' else args.candidate
                command = ['taskset', '-c', args.cpus, '/usr/bin/time', '-v', '-o', str(time_file), str(binary), str(args.fixture_root / relative), str(output), 'float']
                started = datetime.now(timezone.utc).isoformat()
                started_monotonic = time.monotonic()
                with open(args.out / f'{stem}.stdout', 'w') as stdout, open(args.out / f'{stem}.stderr', 'w') as stderr:
                    child = subprocess.Popen(command, env=environment, stdout=stdout, stderr=stderr, start_new_session=True)
                    try:
                        exit_code = child.wait(timeout=120)
                        timed_out = False
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        exit_code = child.wait()
                        timed_out = True
                ended = datetime.now(timezone.utc).isoformat()
                result = next((json.loads(line) for line in (args.out / f'{stem}.stdout').read_text().splitlines() if line.startswith('{')), None)
                time_text = time_file.read_text()
                row = {
                    'sample': stem, 'fixture': name, 'pair': pair, 'arm': arm,
                    'startedUtc': started, 'endedUtc': ended, 'exit': exit_code, 'timeout': timed_out,
                    'processWallMs': (time.monotonic() - started_monotonic) * 1000,
                    'outputMs': result.get('output_ms') if result else None,
                    'artifactMs': result.get('artifact_ms') if result else None,
                    'peakRssKiB': int(gnu_time_metric(time_text, 'Maximum resident set size (kbytes)')),
                    'artifactSha256': digest(output) if output.is_file() else None,
                    'result': result, 'scratchLeaked': scratch.exists(),
                }
                rows.append(row)
                with open(args.out / 'runs.jsonl', 'a') as stream:
                    stream.write(json.dumps(row, separators=(',', ':')) + '\n')
                if exit_code or timed_out or row['scratchLeaked']:
                    raise RuntimeError(f'{stem} failed; all artifacts retained in {args.out}')
                hashes = {prior['artifactSha256'] for prior in rows if prior['fixture'] == name}
                if len(hashes) != 1:
                    raise RuntimeError(f'{name} GLB hashes differ; artifacts retained in {args.out}')
                output.unlink()
    print(f'{len(rows)} successful runs; per-fixture GLB hashes match. Evidence: {args.out}')


if __name__ == '__main__':
    main()
