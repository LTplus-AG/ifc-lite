# SPDX-License-Identifier: MPL-2.0
"""#5357 portable replay; original observer preserved in functional-original.py.txt."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-bin', type=Path, required=True)
parser.add_argument('--candidate-bin', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True, help='New output directory; never overwritten')
parser.add_argument('--fixture-root', type=Path, default=Path(__file__).resolve().parents[4] / 'tests/models')
parser.add_argument('--fixture', action='append', help='Relative fixture path; repeat to override the default corpus')
args = parser.parse_args()
for binary in (args.base_bin, args.candidate_bin):
    if not binary.is_file():
        parser.error(f'Missing binary: {binary}')
fixtures = args.fixture or [
    'ara3d/AC20-FZK-Haus.ifc',
    'ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc',
    'ara3d/ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC',
    'ara3d/ISSUE_053_20181220Holter_Tower_10.ifc',
    'issues/472_2222.ifc',
]
for fixture in fixtures:
    if not (args.fixture_root / fixture).is_file():
        parser.error(f'Missing fixture: {fixture}; run pnpm fixtures')
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
rows = []
for index, fixture in enumerate(fixtures):
    for mode in ('float', 'quantize'):
        for arm in ('base', 'spool', 'skip-georef'):
            stem = f'{index:02d}-{Path(fixture).stem}-{mode}-{arm}'
            dst = out / (stem + '.glb')
            env = os.environ.copy()
            env.pop('IFC_SPIKE_SPOOL', None)
            env.pop('IFC_SPIKE_GEOREF', None)
            binary = args.base_bin if arm == 'base' else args.candidate_bin
            if arm == 'spool':
                env['IFC_SPIKE_SPOOL'] = str(out / 'scratch')
            if arm != 'base':
                env['IFC_SPIKE_GEOREF'] = 'skip' if arm == 'skip-georef' else 'timed'
            (out / (stem + '.host')).write_text(subprocess.check_output(
                ['ps', '-eo', 'pid,comm,pcpu,rss', '--sort=-pcpu'], text=True))
            cmd = ['/usr/bin/time', '-v', '-o', str(out / (stem + '.time')),
                   str(binary.resolve()), str((args.fixture_root / fixture).resolve()), str(dst), mode]
            with (out / (stem + '.stdout')).open('w') as stdout, (out / (stem + '.stderr')).open('w') as stderr:
                result = subprocess.run(cmd, env=env, stdout=stdout, stderr=stderr, timeout=300)
            digest = hashlib.sha256(dst.read_bytes()).hexdigest() if dst.exists() else None
            row = {'fixture': fixture, 'mode': mode, 'arm': arm, 'exit': result.returncode,
                   'qualification': 'functional only; no timing qualification', 'sha256': digest}
            rows.append(row)
            (out / 'results.json').write_text(json.dumps(rows, indent=2) + '\n')
            print(stem, result.returncode, digest, flush=True)
        group = rows[-3:]
        if any(r['exit'] != 0 for r in group) or len({r['sha256'] for r in group}) != 1:
            raise RuntimeError(f'Export failed or artifact mismatch: {group}')
print(f'All {len(fixtures) * 2} fixture/mode groups byte identical across three arms', flush=True)
