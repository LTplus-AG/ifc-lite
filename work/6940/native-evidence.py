#!/usr/bin/env python3
"""Finite #6940 native evidence controller. No retry or survivor-only verdict.

Run only on the dedicated Ubuntu CI job after sequential own-source builds.
This supplies native evidence, not browser worker-pool or full-result identity.
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import pathlib
import platform
import re
import subprocess
import sys
import time

FIXTURES = [
    'ara3d/AC20-FZK-Haus.ifc',
    'ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc',
    'ara3d/ISSUE_053_20181220Holter_Tower_10.ifc',
    'georeferencer/MiniBIM-3.1-DO_01_VORM.ifc',
]
PHASES = ['parseMs', 'entityScanMs', 'lookupMs', 'preprocessMs', 'geometryMs', 'totalMs']


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_identity(path):
    path = pathlib.Path(path)
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': h.hexdigest()}


def save(path, value):
    # Exclusive evidence files prevent silent replacement of earlier attempts.
    with pathlib.Path(path).open('x') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def source_identity(root, expected):
    head = git(root, 'rev-parse', 'HEAD').decode().strip()
    assert head == expected, (root, head, expected)
    diff = git(root, 'diff', 'HEAD', '--binary')
    assert not diff, f'Tracked source changed in {root}'
    return {'root': str(root), 'head': head, 'tree': git(root, 'rev-parse', 'HEAD^{tree}').decode().strip(),
            'trackedDiffSha256': digest(diff), 'status': git(root, 'status', '--short').decode(),
            'cargoLock': file_identity(root / 'Cargo.lock'),
            'toolchain': file_identity(root / 'rust-toolchain.toml')}


def cpu_ticks():
    line = pathlib.Path('/proc/stat').read_text().splitlines()[0].split()
    assert line[0] == 'cpu'
    values = [int(value) for value in line[1:]]
    # Guest/guest_nice already contribute to user/nice; do not double-count.
    return values[:8]


def optional_text(path):
    file = pathlib.Path(path)
    return file.read_text().strip() if file.exists() else None


def builds():
    found = []
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            comm = (path / 'comm').read_text().strip()
            stat = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if stat[0] == 'Z':
                continue
            args = (path / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
            compiler = comm in {'cargo', 'rustc', 'rust-lld', 'cc1', 'cc1plus', 'ninja', 'cmake', 'make', 'cc', 'c++', 'clang', 'clang++', 'gcc', 'g++'}
            node_build = comm.startswith('node') and re.search(r'(?:^|[ /])(turbo|vite|webpack|tsc|esbuild)(?:[ /]|$)', args)
            if compiler or node_build:
                found.append({'pid': int(path.name), 'uid': path.stat().st_uid, 'comm': comm,
                              'cwd': os.readlink(path / 'cwd')})
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return found


def host_observation():
    mem = {}
    for line in pathlib.Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in {'MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'}:
            mem[key + 'KiB'] = int(value.split()[0])
    frequencies = []
    for cpu in sorted(pathlib.Path('/sys/devices/system/cpu').glob('cpu[0-9]*')):
        frequencies.append({'cpu': cpu.name, 'scalingCurFreqKHz': optional_text(cpu / 'cpufreq/scaling_cur_freq'),
                            'governor': optional_text(cpu / 'cpufreq/scaling_governor')})
    return {'at': utc(), 'monotonic': time.monotonic(), 'cpuTicks': cpu_ticks(), 'memory': mem,
            'loadavg': pathlib.Path('/proc/loadavg').read_text().strip(), 'logicalCores': os.cpu_count(),
            'affinity': sorted(os.sched_getaffinity(0)), 'frequencies': frequencies,
            'pressureCpu': optional_text('/proc/pressure/cpu'), 'pressureMemory': optional_text('/proc/pressure/memory'),
            'cgroup': optional_text('/proc/self/cgroup'), 'productName': optional_text('/sys/class/dmi/id/product_name'),
            'cpuInfo': pathlib.Path('/proc/cpuinfo').read_text(), 'buildProcesses': builds()}


def admission():
    before = host_observation()
    start = time.monotonic()
    time.sleep(2)
    after = host_observation()
    delta = [b - a for a, b in zip(before['cpuTicks'], after['cpuTicks'])]
    total = sum(delta)
    assert total > 0 and all(value >= 0 for value in delta), 'Invalid /proc/stat interval'
    busy = 100 * (total - delta[3]) / total  # iowait counts as unavailable capacity.
    return {'policy': 'Linux hosted-VM aggregate /proc/stat busy <=10% over >=2s; no live build processes; no retry',
            'scope': 'This fresh Ubuntu hosted job only; no Windows/WSL policy assumed',
            'durationSeconds': time.monotonic() - start, 'busyPercent': busy,
            'stealPercent': 100 * delta[7] / total, 'tickDelta': delta,
            'before': before, 'after': after,
            'accepted': busy <= 10 and not before['buildProcesses'] and not after['buildProcesses']}


def main():
    parser = argparse.ArgumentParser()
    for field in ['controller', 'base', 'branch', 'base-binary', 'branch-binary', 'base-sha', 'branch-sha', 'out']:
        parser.add_argument('--' + field, required=True)
    args = parser.parse_args()
    out = pathlib.Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    controller = pathlib.Path(args.controller).resolve()
    roots = {side: pathlib.Path(getattr(args, side)).resolve() for side in ['base', 'branch']}
    shas = {side: getattr(args, side + '_sha') for side in roots}
    binaries = {side: pathlib.Path(getattr(args, side + '_binary')).resolve() for side in roots}
    summary = {'started': utc(), 'qualified': False, 'protocol': '5 fresh-process samples per arm per control, seeded balanced interleaving; MiniBIM untimed functional capture',
               'scope': 'Native profiling perf_probe only; not browser worker-pool performance',
               'fingerprintScope': 'Ordered geometry payload FNV excludes text metadata, material definitions, UVs, textures and instancing; not full-result byte identity',
               'hostScope': 'Dedicated GitHub-hosted Ubuntu24.04 VM job; hypervisor co-tenancy and OS caches uncontrolled',
               'platform': platform.platform(), 'ci': {key: os.environ.get(key) for key in ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'RUNNER_NAME', 'RUNNER_OS', 'RUNNER_ARCH']}, 'samples': [], 'errors': []}
    schedule = []
    try:
        assert sys.platform == 'linux', 'This controller implements Linux-only admission'
        assert all(re.fullmatch('[0-9a-f]{40}', sha) for sha in shas.values())
        sources = {side: source_identity(roots[side], shas[side]) for side in roots}
        binary_ids = {side: file_identity(binaries[side]) for side in roots}
        summary.update(sources=sources, binaries=binary_ids,
                       controller={'source': git(controller, 'rev-parse', 'HEAD').decode().strip(),
                                   'harness': file_identity(pathlib.Path(__file__).resolve()),
                                   'order': file_identity(controller / 'scripts/perf/ab-order.mjs'),
                                   'reporter': file_identity(controller / 'scripts/perf/ab-report.mjs')})
        manifests = {key: json.loads((root / 'tests/models/manifest.json').read_text()) for key, root in {**roots, 'controller': controller}.items()}
        fixtures = {}
        for relative in FIXTURES:
            entries = {key: next(row for row in manifest['files'] if row['path'] == relative) for key, manifest in manifests.items()}
            assert len({(entry['sha256'], entry['size']) for entry in entries.values()}) == 1, f'Fixture source catalogues differ: {relative}'
            identity = file_identity(controller / 'tests/models' / relative)
            assert identity['sha256'] == entries['controller']['sha256'] and identity['bytes'] == entries['controller']['size']
            fixtures[relative] = identity
        summary['fixtures'] = fixtures
        save(out / 'identity-before.json', summary)
        for fixture_index, fixture in enumerate(FIXTURES[:3]):
            seed = 694000 + fixture_index
            text = subprocess.check_output(['node', str(controller / 'scripts/perf/ab-order.mjs'), '5', str(seed)], text=True)
            order = [line.split() for line in text.splitlines()]
            assert len(order) == 5 and all(sorted(pair) == ['base', 'branch'] for pair in order)
            assert sum(pair[0] == 'base' for pair in order) == 3
            for round_index, pair in enumerate(order, 1):
                for side in pair:
                    schedule.append({'fixture': fixture, 'round': round_index, 'side': side, 'seed': seed, 'timed': True, 'status': 'planned'})
        for side in ['base', 'branch']:
            schedule.append({'fixture': FIXTURES[3], 'round': 1, 'side': side, 'timed': False, 'status': 'planned',
                             'expectation': 'MiniBIM output change intended; capture actual counts/fingerprint separately, exclude latency report'})
        save(out / 'schedule.json', schedule)
        rows = []
        for index, planned in enumerate(schedule):
            label = f"sample-{index:02d}-{planned['side']}"
            receipt = dict(planned, index=index, started=utc(), ok=False)
            summary['samples'].append(receipt)
            try:
                fixture = fixtures[planned['fixture']]
                assert source_identity(roots[planned['side']], shas[planned['side']]) == sources[planned['side']], 'Source fence changed'
                assert file_identity(binaries[planned['side']]) == binary_ids[planned['side']], 'Binary fence changed'
                assert file_identity(fixture['path']) == fixture, 'Fixture fence changed'
                receipt['admission'] = admission()
                assert receipt['admission']['accepted'], 'Linux CPU/build admission refused; sample not launched, no retry'
                command = [str(binaries[planned['side']]), fixture['path'], '--iters', '1', '--json', '--fingerprint']
                receipt['command'] = command
                with (out / (label + '.stdout')).open('xb') as stdout, (out / (label + '.stderr')).open('xb') as stderr:
                    process = subprocess.run(command, cwd=roots[planned['side']], stdout=stdout, stderr=stderr, timeout=1800)
                receipt['exitCode'] = process.returncode
                receipt['hostAfter'] = host_observation()
                assert process.returncode == 0, f'perf_probe exited {process.returncode}'
                assert not receipt['hostAfter']['buildProcesses'], 'Live foreign build at sample completion'
                parsed = json.loads((out / (label + '.stdout')).read_text())
                assert isinstance(parsed, list) and len(parsed) == 1, 'Expected exactly one JSON fixture row'
                row = parsed[0]
                assert row['path'] == fixture['path'], 'Probe reported another fixture'
                for phase in PHASES:
                    assert isinstance(row[phase], (int, float)) and math.isfinite(row[phase]) and row[phase] >= 0, f'Invalid {phase}'
                for key in ['meshes', 'vertices', 'triangles']:
                    assert isinstance(row[key], int) and row[key] > 0, f'Invalid {key}'
                assert len(row['allTotalsMs']) == len(row['allWallMs']) == 1
                fingerprints = row['meshFingerprintsFnv1a64']
                assert len(fingerprints) == 1 and re.fullmatch('[0-9a-f]{16}', fingerprints[0]), 'Missing one-run geometry FNV'
                receipt['probe'] = row
                assert source_identity(roots[planned['side']], shas[planned['side']]) == sources[planned['side']]
                assert file_identity(binaries[planned['side']]) == binary_ids[planned['side']]
                assert file_identity(fixture['path']) == fixture
                receipt['ok'] = True
                if planned['timed']:
                    rows.append(dict(row, side=planned['side']))
            except Exception as error:
                receipt['error'] = {'type': type(error).__name__, 'message': str(error)}
                raise
            finally:
                receipt['finished'] = utc()
                save(out / (label + '.json'), receipt)
        assert len(rows) == 30 and len(summary['samples']) == 32 and all(row['ok'] for row in summary['samples'])
        # Only a complete cohort reaches the reporter; failures cannot disappear
        # through reporting only its successful prefix.
        with (out / 'runs.jsonl').open('x') as stream:
            for row in rows:
                stream.write(json.dumps(row, allow_nan=False) + '\n')
        identity = {}
        for fixture in FIXTURES[:3]:
            cohort = [row['probe'] for row in summary['samples'] if row['fixture'] == fixture]
            values = {tuple(row[key] for key in ['meshes', 'vertices', 'triangles']) + (row['meshFingerprintsFnv1a64'][0],) for row in cohort}
            identity[fixture] = {'stableAcrossBothArmsAndAllRounds': len(values) == 1, 'values': sorted(values)}
        summary['controlGeometryIdentity'] = identity
        report_path = out / 'ab-report.json'
        with (out / 'ab-report.stdout').open('xb') as stdout, (out / 'ab-report.stderr').open('xb') as stderr:
            process = subprocess.run(['node', str(controller / 'scripts/perf/ab-report.mjs'), str(out / 'runs.jsonl'),
                                      '--base', shas['base'], '--branch', shas['branch'], '--json', str(report_path)], stdout=stdout, stderr=stderr)
        assert process.returncode == 0, 'Canonical ab-report failed'
        report = json.loads(report_path.read_text())
        summary['reportVerdict'] = report['verdict']
        summary['positiveRealMoves'] = [{'fixture': fixture['fixture'], **phase} for fixture in report['fixtures'] for phase in fixture['phases'] if phase['real'] and phase['deltaPct'] > 0]
        summary['miniBimFunctional'] = [{'side': row['side'], 'probe': row['probe']} for row in summary['samples'] if not row['timed']]
        assert all(value['stableAcrossBothArmsAndAllRounds'] for value in identity.values()), 'Control geometry fingerprint/count drift'
        assert not report['verdict']['fingerprintDrift'], 'Canonical count fingerprint drift'
        assert not report['verdict']['tooNoisy'], 'Base total spread exceeds canonical15% noise guard; no retry'
        assert not summary['positiveRealMoves'], 'Positive phase delta clears canonical noise/3%/1ms gates; regression flagged'
        summary['qualified'] = True
    except Exception as error:
        summary['errors'].append({'type': type(error).__name__, 'message': str(error)})
    finally:
        summary['finished'] = utc()
        completed = len(summary['samples'])
        summary['notRunPlannedSamples'] = schedule[completed:]
        save(out / 'summary.json', summary)
        print(json.dumps({'qualified': summary['qualified'], 'completedAttempts': completed,
                          'planned': len(schedule), 'errors': summary['errors']}, indent=2))
    return 0 if summary['qualified'] else 1


if __name__ == '__main__':
    sys.exit(main())
