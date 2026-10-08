# SPDX-License-Identifier: MPL-2.0
"""Offline evidence replay; never executes a model, browser, build or test graph."""
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / 'manifest.json').read_text())
archive = (ROOT / manifest['archive']['path']).read_bytes()
assert hashlib.sha256(archive).hexdigest() == manifest['archive']['sha256']
expected = {row['path']: row for row in manifest['members']}
with tempfile.TemporaryDirectory(prefix='symbolic-outcomes-replay-') as output:
    target = Path(output)
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        members = tar.getmembers()
        assert len(members) == len(expected)
        seen = set()
        for member in members:
            path = Path(member.name)
            assert member.isfile() and not member.issym() and not member.islnk()
            assert not path.is_absolute() and '..' not in path.parts
            assert member.name in expected and member.name not in seen
            data = tar.extractfile(member).read()
            row = expected[member.name]
            assert len(data) == row['bytes']
            assert hashlib.sha256(data).hexdigest() == row['sha256']
            dest = target / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            seen.add(member.name)
    assert seen == set(expected)
    def read(name):
        return (target / name).read_text()
    def counts(name):
        raw = read(name)
        return {key: int(re.search(r'ℹ ' + key + r' (\d+)', raw).group(1))
                for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped']}
    inv = '6537-symbolic-parse-false-success-inverse-v1/'
    v3 = '6537-symbolic-parse-outcome-validation-v3/'
    assert counts(inv + 'inverse.log') == dict(tests=18, **{'pass': 11}, fail=7, cancelled=0, skipped=0)
    assert counts(inv + 'restored.log') == dict(tests=18, **{'pass': 18}, fail=0, cancelled=0, skipped=0)
    assert counts(v3 + 'selected-tests-corrected.log') == dict(tests=52, **{'pass': 52}, fail=0, cancelled=0, skipped=0)
    summary = json.loads(read(inv + 'summary.json'))
    assert summary['inverseExit'] == 1 and summary['restorationExit'] == 0
    assert summary['byteExactRestored'] and summary['allNineSourceFinallyEqual']
    classification = json.loads(read(inv + 'classification.json'))
    assert len(classification['inverse']['failures']) == 7
    assert all(row['actual'] == 'success' and row['expected'] == 'failure'
               for row in classification['inverse']['failures'])
    raw = read(inv + 'inverse.log')
    assert raw.count("code: 'ERR_ASSERTION'") == 7
    for marker in ['ERR_MODULE_NOT_FOUND', 'Cannot find module', 'SyntaxError:', 'TypeError:', 'ReferenceError:']:
        assert marker not in raw and marker not in read(inv + 'restored.log')
    assert '@ifc-lite/viewer:test: cache bypass, force executing ' in read(inv + 'restored.log')
    sources = json.loads(read('6537-symbolic-parse-outcome-source-v3/source-manifest.json'))
    for row in sources['members']:
        data = (target / '6537-symbolic-parse-outcome-source-v3/source' / row['path']).read_bytes()
        assert len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == row['sha256']
    # Original historical packet's inherited byte total is intentionally retained.
    old = json.loads(read('6537-symbolic-parse-outcome-source-v2/source-manifest.json'))
    assert sum(row['bytes'] for row in old['members']) == 77365
    assert 'all 3365 test file(s) across 57 package(s)' in read(v3 + 'root-typecheck.log')
    assert json.loads(read(v3 + 'root-typecheck.json'))['exit'] == 0
    gates = json.loads(read(v3 + 'source-gate-results.json'))
    rows = gates if isinstance(gates, list) else gates['results']
    assert all(row['exit'] == 0 for row in rows)
print(json.dumps({'scope': 'offline receipt/source identity and finite correctness replay',
                  'members': len(expected), 'roundTrip': True,
                  'inverse': '11PASS/7 genuine ASSERT/0SKIP', 'restored': '18PASS/0FAIL/0SKIP',
                  'normal': '52PASS/0FAIL/0SKIP', 'rootTypecheckAudit': '3365/3365',
                  'realIfcWasmGpuOrPerformanceQualified': False}))
