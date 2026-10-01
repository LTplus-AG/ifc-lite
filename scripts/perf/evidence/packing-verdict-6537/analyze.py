# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Read preserved matched samples; never filter or substitute failed rows."""
import json
import hashlib
import math
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

root = Path(sys.argv[1])
schedule = json.loads((root / 'schedule.json').read_text())
rows = [json.loads(line) for line in (root / 'runs.jsonl').read_text().splitlines()]
expected = schedule['schedule']
issues = []
runtime_sha = '039415545e2448ce8b1e40b14306524ee60cff29dabd97448080ac0d9e170610'
expected_sources = {'base': '9400cb6c952ba200e165c1dadbd95f9d28fca927', 'branch': sys.argv[2] if len(sys.argv) > 2 else '982da209b3a07da924d4c0af566aebbe7fe749e9'}
if schedule['source'] != expected_sources:
    issues.append('Scheduled source differs from frozen matched affinity sources')
if len(expected) != 50:
    issues.append('Expected the complete 50-row affinity schedule')
if len(rows) != len(expected):
    issues.append(f'Expected {len(expected)} rows, observed {len(rows)}; incomplete run')
row_qualification = {}
for index, row in enumerate(rows):
    row_issue_start = len(issues)
    if index >= len(expected):
        issues.append(f'Unexpected extra row {index}')
        continue
    item = expected[index]
    if row.get('index') != index or any(row.get(k) != item[k] for k in item):
        issues.append(f'Row {index} does not match immutable schedule')
    if not row.get('workerStreamValid') or not row.get('renderReady') or row.get('failure') or row.get('teardownFailure') or row.get('contextTeardownFailure') or row.get('hostContamination'):
        issues.append(f'Row {index} is unqualified')
    for boundary in ['hostPreflightBefore', 'hostPreflightAfter']:
        preflight = row.get(boundary) or {}
        if preflight.get('exitCode') != 0:
            issues.append(f'Row {index} lacks clean actual {boundary}')
    if row.get('source') != schedule['source'].get(item['build']) or row.get('source') != expected_sources.get(item['build']):
        issues.append(f'Row {index} source differs from scheduled source')
    runtimes = row.get('servedRuntimes', [])
    observed = row.get('observedRuntimeResponses', [])
    # The root packing harness preserves every original status grouped under
    # its observed URL; the affinity harness also retains individual records.
    # Accept both explicit schemas, never invent a missing original status.
    if not observed and runtimes and all(isinstance(witness.get('originalStatuses'), list) and witness['originalStatuses'] for witness in runtimes):
        observed = [{'url': witness.get('url'), 'status': status} for witness in runtimes for status in witness['originalStatuses']]
    if not runtimes or not observed or row.get('expectedRuntimeSha256') != runtime_sha:
        issues.append(f'Row {index} lacks a qualified served-resource runtime witness')
    if any(witness.get('sha256') != runtime_sha or witness.get('status') != 200 or not all(status == 200 for status in witness.get('originalStatuses', [witness.get('originalObservedStatus')])) for witness in runtimes):
        issues.append(f'Row {index} served-resource runtime status/hash mismatch')
    if {witness.get('url') for witness in runtimes} != {response.get('url') for response in observed} or any(response.get('status') != 200 for response in observed):
        issues.append(f'Row {index} observed worker URLs/status differ from outside-timing witnesses')
    environment = row.get('environment') or {}
    cadence = row.get('afterCadence') or {}
    if not environment.get('crossOriginIsolated') or environment.get('visibility') != 'visible' or not environment.get('focused') or not environment.get('adapter') or environment['adapter'].get('fallback'):
        issues.append(f'Row {index} lacks native foreground environment qualification')
    if cadence.get('visibility') != 'visible' or not cadence.get('focused') or not isinstance(cadence.get('medianMs'), (int, float)) or not 0 < cadence['medianMs'] < 50:
        issues.append(f'Row {index} lacks qualified foreground frame cadence')
    observation = row.get('observation') or {}
    if observation.get('loading') is not False or observation.get('streaming') is not False or observation.get('visibilityChanges'):
        issues.append(f'Row {index} incomplete or backgrounded at readiness')
    if observation.get('errors'):
        issues.append(f'Row {index} captured errors require independent review')
    models = observation.get('models', [])
    # Canonical primary completion updates loadState, but the per-model
    # geometry/metadata phase fields still remain opening/idle on real loads.
    # Readiness therefore uses the actual milestones/global flags above.
    if len(models) != 1 or any(model.get('loadState') != 'complete' for model in models):
        issues.append(f'Row {index} lacks a registered completed one-model load')
    ready = observation.get('fullReadyAfterInputMs')
    for milestone in ['finalizeAfterInputMs', 'streamAfterInputMs', 'metadataAfterInputMs']:
        value = observation.get(milestone)
        if not isinstance(ready, (int, float)) or not isinstance(value, (int, float)) or not math.isfinite(ready) or not math.isfinite(value) or not 0 <= value <= ready:
            issues.append(f'Row {index} invalid readiness chronology for {milestone}')
    fixture = row.get('fixtureInfo', {})
    if not isinstance(fixture.get('bytes'), int) or fixture['bytes'] <= 0 or not re.fullmatch('[0-9a-f]{64}', fixture.get('sha256', '')):
        issues.append(f'Row {index} lacks actual fixture identity')
    geometry = observation.get('geometry', {})
    for field in ['meshes', 'retainedVertices', 'retainedTriangles', 'totalVertices', 'totalTriangles']:
        if not isinstance(geometry.get(field), (int, float)) or not math.isfinite(geometry[field]) or geometry[field] <= 0:
            issues.append(f'Row {index} invalid geometry count {field}')
    if not re.fullmatch('[0-9a-f]{1,8}', geometry.get('fullPositionsNormalsIndicesAppearanceFNV32', '')):
        issues.append(f'Row {index} lacks CPU geometry/appearance identity')
    frame = row.get('colorFrame', {})
    frame_path = root / frame.get('file', 'missing-color-frame')
    if not frame.get('bytes') or not frame_path.is_file():
        issues.append(f'Row {index} lacks actual GPU color-frame artifact')
    else:
        data = frame_path.read_bytes()
        if len(data) != frame['bytes'] or hashlib.sha256(data).hexdigest() != frame.get('sha256'):
            issues.append(f'Row {index} GPU color-frame artifact hash/length differs')
    row_qualification[index] = {'qualified': len(issues) == row_issue_start, 'issues': issues[row_issue_start:], 'reportedModelPhases': models}

groups = defaultdict(list)
for row in rows:
    groups[(row['control'], row['fixture'], row['pair'])].append(row)
expected_groups = {('AA', 'ac20', pair) for pair in range(5)} | {('AB', fixture, pair) for fixture in ['ac20', 'holter', 'os1', 'snowdon'] for pair in range(5)}
if set(groups) != expected_groups:
    issues.append('Observed pair groups differ from complete five AA and twenty AB pairs')

identity_fields = ['meshes', 'retainedVertices', 'retainedTriangles', 'totalVertices', 'totalTriangles', 'fullPositionsNormalsIndicesAppearanceFNV32']
metrics = ['fullReadyAfterInputMs', 'streamAfterInputMs', 'workerStreamWallMs', 'metadataAfterInputMs', 'heapPeak']
derived = defaultdict(list)
for (control, fixture, pair), samples in sorted(groups.items()):
    sides = ['A1', 'A2'] if control == 'AA' else ['base', 'branch']
    by_side = {row['side']: row for row in samples}
    if len(samples) != 2 or set(by_side) != set(sides):
        issues.append(f'{control}/{fixture}/{pair} has missing or repeated side')
        continue
    left, right = [by_side[side] for side in sides]
    observations = [row.get('observation') for row in (left, right)]
    if any(observation is None for observation in observations):
        issues.append(f'{control}/{fixture}/{pair} lacks observations')
        continue
    a, b = observations
    mismatches = [field for field in identity_fields if a['geometry'].get(field) != b['geometry'].get(field)]
    fixture_matches = left.get('fixtureInfo') == right.get('fixtureInfo')
    if mismatches or not fixture_matches:
        issues.append(f'{control}/{fixture}/{pair} output/fixture identity differs: {mismatches}')
    pair_result = {'pair': pair, 'sides': sides, 'rowIndices': [left['index'], right['index']], 'geometryIdentity': not mismatches, 'fixtureIdentity': fixture_matches, 'deltas': {}}
    for metric in metrics:
        av, bv = a.get(metric), b.get(metric)
        if not isinstance(av, (int, float)) or not isinstance(bv, (int, float)) or not math.isfinite(av) or not math.isfinite(bv) or av <= 0 or bv <= 0:
            issues.append(f'{control}/{fixture}/{pair} invalid {metric}')
            continue
        pair_result['deltas'][metric] = {'left': av, 'right': bv, 'absolute': bv - av, 'percent': 100 * (bv - av) / av}
    pair_result['qualified'] = not mismatches and fixture_matches and len(pair_result['deltas']) == len(metrics) and all(row_qualification.get(row['index'], {}).get('qualified', False) for row in samples)
    derived[(control, fixture)].append(pair_result)

summary = {}
for (control, fixture), pairs in sorted(derived.items()):
    summary[f'{control}/{fixture}'] = {
        'qualification': 'COMPLETE_QUALIFIED_FAMILY' if len(pairs) == 5 and all(pair['qualified'] for pair in pairs) else 'INCOMPLETE_OR_UNQUALIFIED_FAMILY',
        'observedPairGroups': sum(key[:2] == (control, fixture) for key in groups),
        'completedPairs': len(pairs),
        'qualifiedPairs': sum(pair['qualified'] for pair in pairs),
        'pairs': pairs,
        'metrics': {
            metric: {
                'medianLeft': statistics.median([pair['deltas'][metric]['left'] for pair in pairs if metric in pair['deltas']]),
                'medianRight': statistics.median([pair['deltas'][metric]['right'] for pair in pairs if metric in pair['deltas']]),
                'medianPairedDeltaPercent': statistics.median([pair['deltas'][metric]['percent'] for pair in pairs if metric in pair['deltas']]),
                'pairedDeltaPercentRange': [min(pair['deltas'][metric]['percent'] for pair in pairs if metric in pair['deltas']), max(pair['deltas'][metric]['percent'] for pair in pairs if metric in pair['deltas'])],
            }
            for metric in metrics if any(metric in pair['deltas'] for pair in pairs)
        },
    }

result = {
    'input': str(root), 'source': schedule['source'], 'expectedSource': expected_sources, 'observedRows': len(rows), 'expectedRows': len(expected),
    'qualification': 'COMPLETE_WITH_IDENTITY_CHECKS' if not issues else 'UNQUALIFIED',
    'issues': issues, 'rowQualification': row_qualification, 'groups': summary,
    'scope': 'Derived paired observations only; no automatic speed verdict. All completed pairs, including invalid pairs, remain in descriptive metrics; incomplete groups remain explicit issues and every observed row keeps its validity record. Use family qualification explicitly and never substitute missing samples. Heap is rAF-sampled Chrome-reported usedJSHeapSize, not exact held-array bytes or unsampled allocation peak. Served-resource witness hashes are outside timing and are not original worker-response body hashes. Actual primary loads retain geometryLoadState opening/metadataLoadState idle; these misleading phase fields are disclosed and are not treated as readiness signals.',
}
print(json.dumps(result, indent=2))
sys.exit(0 if not issues else 1)
