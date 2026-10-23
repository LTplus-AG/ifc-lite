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

def replay(prefix, helper, arms, contrasts, counts, allow_active=False):
    # Each cohort keeps its own original seed, observations and source names.
    assert (ROOT / helper).read_bytes() == records[prefix + '/statistics.py']
    spec = importlib.util.spec_from_file_location(Path(helper).stem, ROOT / helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rows = [json.loads(line) for line in records[prefix + '/cohort/rows.jsonl'].splitlines()]
    assert len(rows) == counts[0] and {r['index'] for r in rows} == set(range(counts[0]))
    expected = json.loads(records[prefix + '/cohort/summary.json'])
    groups = collections.defaultdict(list)
    for row in rows:
        assert row['exitCode'] == 0
        groups['-'.join(row[k] for k in ['section', 'fixture', 'mode'])].append(row)
    assert set(groups) == set(expected) and len(groups) == counts[1]
    contrasted = 0
    for label, members in groups.items():
        section = members[0]['section']
        active = section == 'active'
        assert section in (['symbolic', 'native', 'active'] if allow_active else ['symbolic', 'native'])
        selected_arms = arms[1:] if active else arms
        comparisons = {'C/B': ('optimized', 'unoptimized')} if active else contrasts
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
        assert all(set(block) == set(selected_arms) for block in blocks)
        assert {arm: [b[arm] for b in blocks] for arm in selected_arms} == expected[label]['armSamplesMs']
        computed = module.compare_blocks(blocks, comparisons, label)
        if section == 'native':
            # Report links are metadata added after the statistical calculation.
            for contrast, result in computed.items():
                result['stockReport'] = f"{label}-{contrast.replace('/', '-')}-stock.json"
        assert computed == expected[label]['contrasts']
        fields = (['meshes', 'vertices', 'triangles', 'meshFingerprintsFnv1a64'] if section == 'native'
                  else ['symbolicJsonFnv1a64', 'symbolicJsonBytes', 'polylineCount', 'circleCount', 'fillCount', 'textCount', 'gridCount'])
        identities = {arm: {field: sorted({json.dumps(r['data'][field]) for r in members if r['arm'] == arm})
                            for field in fields} for arm in selected_arms}
        assert identities == expected[label]['outputIdentity']
        contrasted += len(comparisons)
    assert contrasted == counts[2]
    return {'cohort': prefix, 'observations': len(rows), 'groups': len(groups), 'contrasts': contrasted}

results = [
    replay('current-parent-perf-v1', 'paired_statistics.py', ['parent', 'unoptimized', 'optimized'],
           {'B/A': ('unoptimized', 'parent'), 'C/B': ('optimized', 'unoptimized'), 'C/A': ('optimized', 'parent')},
           (840, 20, 36), allow_active=True),
    replay('publication-layer-perf-v1', 'publication_statistics.py', ['A', 'T', 'C'],
           {'T/A': ('T', 'A'), 'C/T': ('C', 'T'), 'C/A': ('C', 'A')}, (360, 8, 24)),
]
print(json.dumps({'verifiedDocuments': len(records), 'separateCohorts': results,
                  'scope': 'Exact retained-data/statistics/row-identity replay only; no pooling, new measurement, raw-process custody, neutrality or merge acceptance.'}))
