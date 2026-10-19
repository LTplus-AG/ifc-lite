import hashlib
import json
import os
import subprocess
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = (HERE / 'benchmark-inputs.json').read_bytes()
CFG = json.loads(RAW)
OUT = HERE / 'benchmark-run1'
OUT.mkdir()
REPORT = {'inputSha256': hashlib.sha256(RAW).hexdigest(), 'commands': [],
          'primaryError': None, 'finallyErrors': []}


def identity():
    result = {}
    for arm, entry in CFG['binaries'].items():
        binary = Path(entry['binary'])
        assert hashlib.sha256(binary.read_bytes()).hexdigest() == entry['sha256'], arm + ' binary drift'
        head = subprocess.check_output(['git', '-C', entry['source'], 'rev-parse', 'HEAD'], text=True).strip()
        assert head == entry['head'] and not subprocess.check_output(
            ['git', '-C', entry['source'], 'status', '--porcelain']), arm + ' source drift'
        result[arm] = {'head': head, 'binarySha256': entry['sha256']}
    for fixture in CFG['fixtures']:
        path = Path(fixture['absolutePath'])
        assert path.stat().st_size == fixture['size'], 'fixture size drift'
        assert hashlib.sha256(path.read_bytes()).hexdigest() == fixture['sha256'], 'fixture hash drift'
    return result


def save():
    (OUT / 'collection.json').write_text(json.dumps(REPORT, indent=2) + '\n')


try:
    REPORT['before'] = identity()
    save()
    for index, spec in enumerate(CFG['commands']):
        arm = spec['arm']
        fixture = CFG['fixtures'][spec['fixture']]
        label = str(index) + '-' + arm
        argv = [CFG['binaries'][arm]['binary'], fixture['absolutePath'],
                '--iters', '5', '--json', '--fingerprint']
        row = {'index': index, 'arm': arm, 'fixture': fixture['path'], 'argv': argv,
               'stdout': label + '.json', 'stderr': label + '.stderr', 'startedAt': time.time()}
        REPORT['commands'].append(row)
        save()
        start = time.perf_counter()
        with (OUT / row['stdout']).open('wb') as stdout, (OUT / row['stderr']).open('wb') as stderr:
            child = subprocess.run(argv, stdout=stdout, stderr=stderr, timeout=600,
                                   env=os.environ | {'RAYON_NUM_THREADS': '8'})
        row.update(exitCode=child.returncode, finishedAt=time.time(),
                   completeCommandWallSeconds=time.perf_counter() - start)
        save()
        assert child.returncode == 0, 'probe failed ' + label
        json.loads((OUT / row['stdout']).read_text())
        REPORT['lastIdentity'] = identity()
        save()
except BaseException as error:
    REPORT['primaryError'] = repr(error)
    REPORT['traceback'] = traceback.format_exc()
finally:
    try:
        REPORT['after'] = identity()
    except BaseException as error:
        REPORT['finallyErrors'].append(repr(error))
    REPORT['complete'] = (len(REPORT['commands']) == 6
                          and all(row.get('exitCode') == 0 for row in REPORT['commands'])
                          and REPORT['primaryError'] is None and not REPORT['finallyErrors'])
    save()
raise SystemExit(0 if REPORT['complete'] else 1)
