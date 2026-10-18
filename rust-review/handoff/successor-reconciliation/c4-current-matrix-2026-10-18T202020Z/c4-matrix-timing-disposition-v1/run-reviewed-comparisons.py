from pathlib import Path
import datetime
import hashlib
import json
import shutil
import subprocess

D = Path(__file__).resolve().parent
A = D.parent
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
proposal = D / 'PROPOSED-TIMING-WITNESSES.json'
bindings = D / 'BINDINGS.json'
review = D / 'independent-review/REVIEW.md'
assert sha(proposal) == 'b4e643e486036a82f4bb2b0362612f0f74bfe261a692990e393ca1bd7513ba84'
assert sha(bindings) == '5480e8b806b87b3e12dd513d9c9b40fab2e605b58413e96c20dc557dacd6600e'
b = json.loads(bindings.read_text())
p = json.loads(proposal.read_text())
assert len(p['witnesses']) == 21
assert sum(len(w['policy']['entries']) for w in p['witnesses']) == 47
assert review.read_text().startswith('**APPROVE exactly the 21 saved witnesses')
compare = A / 'c4-5-combined-observed-runtime-v1/inputs/adapter/compare.mjs'
assert sha(compare) == '5e660df5173fc211ee3b9ed677a29299f9902fbacdd49e3562ebb3164ab81f65'
node = Path(shutil.which('node'))
extra = [proposal, bindings, review, Path(__file__), node, *sorted(compare.parent.glob('*.mjs'))]
source = A / 'c4-5-required-qualification-v1/source/rust/processing/src/processor'
supplemental = {
    str(source / 'pass.rs'): {'size': 9163, 'sha256': '334f389fc4dd51b9c0cbcfeeafe8b3b6ee1b57fce9761d985c58660c54b06688'},
    str(source / 'phase_marks.rs'): {'size': 3848, 'sha256': '0f1f58aa9c3ee8d1a455c583c3f9ac0eb0de0f0b9845217a6e479bf6bcec5d20'},
}
pins = b['files'] | supplemental

def guard():
    for name, row in pins.items():
        q = Path(name)
        assert q.stat().st_size == row['size'] and sha(q) == row['sha256'], name
    return {str(q): {'size': q.stat().st_size, 'sha256': sha(q)} for q in extra}

before = guard()
out = D / 'reviewed-saved-comparisons'
out.mkdir()
receipt = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'before': before, 'results': [], 'primaryError': None, 'finallyErrors': [],
           'scope': 'Exact 21 saved witnesses only. No producer/runtime rerun or performance acceptance; original worker FAILED1 and 72 route/native comparisons remain unresolved.'}
try:
    for w in p['witnesses']:
        left, right = Path(w['left']), Path(w['right'])
        assert sha(left) == w['leftSha256'] and sha(right) == w['rightSha256']
        assert sha(Path(w['originalReport'])) == w['originalReportSha256']
        assert before == guard()
        policy = w['policy'] | {'state': 'INDEPENDENTLY_REVIEWED_EXACT_SAVED_PAIR_ONLY',
                               'independentReviewSha256': sha(review),
                               'captureFilePins': {str(left): sha(left), str(right): sha(right)}}
        policy_path = out / (w['name'] + '.policy.json')
        with policy_path.open('x') as f:
            f.write(json.dumps(policy, indent=2) + '\n')
        argv = [str(node), str(compare), str(left), str(right), str(policy_path), 'pair:' + w['kind']]
        r = subprocess.run(argv, text=True, capture_output=True, timeout=30)
        report_path = out / (w['name'] + '.result.json')
        with report_path.open('x') as f:
            f.write(r.stdout)
        with (out / (w['name'] + '.stderr')).open('x') as f:
            f.write(r.stderr)
        result = json.loads(r.stdout)
        receipt['results'].append({'name': w['name'], 'argv': argv, 'exitCode': r.returncode,
                                   'policySha256': sha(policy_path), 'resultSha256': sha(report_path),
                                   'result': result})
        assert r.returncode == 0 and result['result'] == 'MATCH_OR_EXACT_EXPECTED_DIFF'
        assert len(result['expected']) == len(policy['entries']) and result['unknown'] == [] and result['stale'] == []
except BaseException as error:
    receipt['primaryError'] = repr(error)
finally:
    try:
        receipt['after'] = guard()
        assert receipt['after'] == before
    except BaseException as error:
        receipt['finallyErrors'].append(repr(error))
    receipt['complete'] = len(receipt['results']) == 21 and receipt['primaryError'] is None and not receipt['finallyErrors']
    receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with (D / 'EXECUTION-RECEIPT.json').open('x') as f:
        f.write(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'complete': receipt['complete'], 'pairs': len(receipt['results']), 'primaryError': receipt['primaryError'], 'finallyErrors': receipt['finallyErrors']}))
raise SystemExit(0 if receipt['complete'] else 1)
