# SPDX-License-Identifier: MPL-2.0
"""Replay retained data, not model execution or a performance acceptance gate."""
import collections
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import statistics
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).parent
manifest = json.loads((ROOT / 'manifest.json').read_text())
records = {}
for row in manifest['files']:
    compressed = (ROOT / row['path']).read_bytes()
    assert hashlib.sha256(compressed).hexdigest() == row['compressedSha256']
    raw = gzip.decompress(compressed)
    assert len(raw) == row['originalBytes']
    assert hashlib.sha256(raw).hexdigest() == row['originalSha256']
    assert row['originalPath'] not in records
    records[row['originalPath']] = raw

statistics_bytes = records['current-parent-perf-v1/statistics.py']
assert (ROOT / 'statistics.py').read_bytes() == statistics_bytes
spec = importlib.util.spec_from_file_location('frozen_statistics', ROOT / 'statistics.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
rows = [json.loads(line) for line in records['current-parent-perf-v1/cohort/rows.jsonl'].splitlines()]
assert len(rows) == 840 and {r['index'] for r in rows} == set(range(840))
expected = json.loads(records['current-parent-perf-v1/cohort/summary.json'])
groups = collections.defaultdict(list)
for row in rows:
    assert row['exitCode'] == 0
    groups['-'.join(row[k] for k in ['section', 'fixture', 'mode'])].append(row)
assert set(groups) == set(expected) and len(groups) == 20
contrasts_replayed = 0
for label, members in groups.items():
    section = members[0]['section']
    active = section == 'active'
    arms = ['unoptimized', 'optimized'] if active else ['parent', 'unoptimized', 'optimized']
    contrasts = {'C/B': ('optimized', 'unoptimized')} if active else {
        'B/A': ('unoptimized', 'parent'), 'C/B': ('optimized', 'unoptimized'),
        'C/A': ('optimized', 'parent'),
    }
    by_block = collections.defaultdict(dict)
    for row in members:
        block = by_block[row['block']]
        assert row['arm'] not in block
        data = row['data']
        if section == 'native':
            assert len(data['allWallMs']) == 5
            value = statistics.median(data['allWallMs'])
        else:
            assert data['authority'] == row['mode']
            value = data['elapsedNs'] / 1e6
        block[row['arm']] = value
    blocks = [by_block[k] for k in sorted(by_block)]
    assert len(blocks) == (20 if active else 6 if section == 'native' else 24)
    assert all(set(block) == set(arms) for block in blocks)
    assert {arm: [b[arm] for b in blocks] for arm in arms} == expected[label]['armSamplesMs']
    assert module.compare_blocks(blocks, contrasts, label) == expected[label]['contrasts']
    contrasts_replayed += len(contrasts)
assert contrasts_replayed == 36
print(json.dumps({'verifiedDocuments': len(records), 'observations': len(rows),
                  'groups': len(groups), 'contrasts': contrasts_replayed,
                  'scope': 'Exact retained-data/statistics replay only; no new measurement, raw-process custody or merge acceptance.'}))
