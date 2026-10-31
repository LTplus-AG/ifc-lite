# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""#8341 browser cohort on Pop: two ordinary source builds, one exclusive measurement.

setup DRIVER_SHA   run on Pop outside any reservation; submits the original requests
prepare SIDE       ordinary job in the SIDE commit's worker checkout: fresh WASM + viewer
smoke              ordinary job in the driver checkout: headless functional run, not timing
measure [ATTEMPT]  benchmark job in the driver commit's checkout: browser-cohort.mts
remeasure DRIVER_SHA ATTEMPT  outside any reservation: a corrected driver commit reuses
                   the settled builds; dependencies install inside the measure job

Same submit/probe/receipt helpers as ifc-benchmark. Requests are never resubmitted:
an existing request id resolves to its original receipt.
"""
import hashlib, json, os, shutil, subprocess, sys, threading, time
from pathlib import Path
sys.path.insert(0, '/home/louistrue/build-workers/storage-current')
from benchmark_workflow import submit, write, probe

BASE = Path('/home/louistrue/build-workers')
TASK = 'c4-browser-8341-v1'
ROOT = BASE / 'worker-state/storage-tasks' / TASK
SHA = {'base': 'a7164756b7d031a799e0075e141555185d7b8ef3', 'branch': '2f028bb080e8e5a1a0fb89539480de404e425400'}
FIXTURES = {  # tests/models/manifest.json
    'AC20-FZK-Haus.ifc': 'd42ab0dee01173106c16cd823b4614efe188fa15dd65195d95b9879bec59acc5',
    'duplex.ifc': 'b347a2c8aa8fff6db896a4417a9c50c22ac0ccd7c5cfc22b99b8d29336c606ed',
    'ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc': 'ffdfa9a91ac6a6c301d7da0d7861dfbc3958ceb55098c143a560468702642131',
}
CHROME = Path('/home/louistrue/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome')
LAUNCH_FLAGS = ['--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan']
SEED = '8341'
EVIDENCE = 'tests/evidence/c4-browser-8341'


def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def tree(root): return {str(p.relative_to(root)): digest(p) for p in sorted(Path(root).rglob('*')) if p.is_file()}
def git(*args, cwd=None): return subprocess.check_output(['git', *args], text=True, cwd=cwd).strip()


def prepare(side):
    assert os.environ.get('IFC_WORKER_KIND') == 'ordinary'
    assert git('rev-parse', 'HEAD') == SHA[side] and not git('status', '--porcelain'), 'clean exact source required'
    env = os.environ.copy(); env['CARGO_BUILD_JOBS'] = '8'
    subprocess.run(['pnpm', 'install', '--frozen-lockfile'], check=True)
    subprocess.run(['bash', 'scripts/build-wasm.sh'], check=True, env=env)
    built = digest('packages/wasm/pkg/ifc-lite_bg.wasm')
    subprocess.run(['pnpm', 'turbo', 'build', '--filter=@ifc-lite/viewer', '--force', '--env-mode=loose'], check=True, env=env)
    assert digest('packages/wasm/pkg/ifc-lite_bg.wasm') == built, 'WASM changed during viewer build'
    served = list(Path('apps/viewer/dist/assets').glob('ifc-lite_bg-*.wasm'))
    assert len(served) == 1 and digest(served[0]) == built, 'served WASM differs from the source build'
    assert git('status', '--porcelain', '--untracked-files=no') == '', 'build changed tracked source'
    shutil.copytree('apps/viewer/dist', ROOT / f'{side}-dist')
    tools = {t: subprocess.check_output([t, *f], text=True).strip() for t, f in
             [('rustc', ['-V']), ('wasm-pack', ['-V']), ('node', ['--version']), ('pnpm', ['--version'])]}
    write(ROOT / f'{side}-build.json', {'source': SHA[side], 'tree': git('rev-parse', 'HEAD^{tree}'),
          'wasmSha256': built, 'toolchain': tools, 'assets': tree(ROOT / f'{side}-dist')})


def manifest_assets(driver):
    assets = {}
    for side in SHA:
        build = json.loads((ROOT / f'{side}-build.json').read_text())
        assert build['source'] == SHA[side]
        assets.update({str(ROOT / f'{side}-dist' / n): h for n, h in build['assets'].items()})
    assets.update({str(ROOT / 'fixtures' / n): h for n, h in FIXTURES.items()})
    for rel in ['scripts/perf', 'scripts/lib', 'tests/benchmark', EVIDENCE]:
        for p in (driver / rel).rglob('*'):
            if p.is_file() and p.suffix in ('.mts', '.ts', '.mjs', '.py', '.json'):
                assets[str(p)] = digest(p)
    for p in [ROOT / 'cohort.py', ROOT / 'hardware-chrome', CHROME]:
        assets[str(p)] = digest(p)
    return assets


def setup(driver_sha):
    assert not os.environ.get('IFC_WORKER_ACTIVE_STATE'), 'start outside a reservation'
    driver = BASE / 'worker-state/checkouts' / driver_sha
    assert (driver / 'node_modules').is_dir(), 'run the fleet driver install for this commit first'
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    me = Path(__file__).resolve()
    committed = subprocess.check_output(['git', '-C', str(BASE / 'ifc-lite'), 'show', f'{driver_sha}:{EVIDENCE}/cohort.py'])
    assert hashlib.sha256(committed).hexdigest() == digest(me), 'orchestrator differs from the driver commit'
    if me != ROOT / 'cohort.py':
        shutil.copyfile(me, ROOT / 'cohort.py')
    (ROOT / 'fixtures').mkdir(exist_ok=True)
    for name, expected in FIXTURES.items():
        target = ROOT / 'fixtures' / name
        if not target.exists():
            shutil.copyfile(BASE / 'ifc-lite/tests/models/ara3d' / name, target)
        assert digest(target) == expected, f'fixture hash mismatch: {name}'
    receipts = {}
    def build(side):
        receipts[side] = submit(BASE, ROOT, f'{side}-prepare', {
            'id': f'{TASK}-{side}-prepare', 'commit': SHA[side], 'kind': 'ordinary', 'cpu': 8, 'memoryGiB': 24,
            'storageTask': TASK, 'storageScratch': [str(ROOT)],
            'command': [sys.executable, str(ROOT / 'cohort.py'), 'prepare', side],
            'artifacts': [str(ROOT / f'{side}-build.json')]})
    threads = [threading.Thread(target=build, args=(s,)) for s in SHA]
    for t in threads: t.start()
    for t in threads: t.join()
    assert set(receipts) == set(SHA), 'a preparation did not settle; inspect its original request'
    for side, receipt in receipts.items():
        r = json.loads(Path(receipt).read_text())
        assert r['exitCode'] == 0 and r['sourceUnchanged'], f'{side} preparation not clean: {receipt}'
    launcher = ROOT / 'hardware-chrome'
    launcher.write_text('#!/usr/bin/python3\nimport os,sys\n'
                        'args=[a for a in sys.argv[1:] if not a.startswith(("--use-angle=","--enable-features="))]\n'
                        f'os.execv({str(CHROME)!r},[{str(CHROME)!r}]+args+{LAUNCH_FLAGS!r})\n')
    launcher.chmod(0o700)
    subprocess.run(['xdpyinfo', '-display', ':1'], stdout=subprocess.DEVNULL, check=True)
    write(ROOT / 'measurement-manifest.json', {'base': SHA['base'], 'branch': SHA['branch'], 'driver': driver_sha,
          'preparationReceipts': {s: str(r) for s, r in receipts.items()}, 'seed': SEED,
          'hardwareLaunch': {'display': ':1', 'headed': True, 'chrome': str(CHROME), 'flags': LAUNCH_FLAGS},
          'assets': manifest_assets(driver)})
    smoke = submit(BASE, ROOT, 'smoke', {
        'id': f'{TASK}-smoke', 'commit': driver_sha, 'kind': 'ordinary', 'cpu': 4, 'memoryGiB': 16,
        'storageTask': TASK, 'storageScratch': [str(ROOT)],
        'command': [sys.executable, str(ROOT / 'cohort.py'), 'smoke'],
        'artifacts': [str(ROOT / 'smoke' / n) for n in ['runs.jsonl', 'summary.txt']]})
    assert json.loads(Path(smoke).read_text())['exitCode'] == 0, f'smoke failed: {smoke}'
    out = ROOT / 'measurement'
    receipt = submit(BASE, ROOT, 'measure', {
        'id': f'{TASK}-measure', 'commit': driver_sha, 'kind': 'benchmark', 'cpu': 4, 'memoryGiB': 24,
        'storageTask': TASK, 'storageScratch': [str(ROOT)],
        'command': [sys.executable, str(ROOT / 'cohort.py'), 'measure'],
        'artifacts': [str(ROOT / n) for n in ['measurement-manifest.json', 'base-build.json', 'branch-build.json', 'cohort.py']]
                     + [str(out / n) for n in ['qualification.json', 'report.json', 'report.txt', 'summary.json', 'summary.txt',
                                               'readiness-before.json', 'readiness-samples.json', 'cohort/runs.jsonl', 'cohort/plan.json']]})
    print('c4-browser-8341 cohort settled:', receipt, flush=True)


def smoke():
    assert os.environ.get('IFC_WORKER_KIND') == 'ordinary'
    out = ROOT / 'smoke'
    code = subprocess.run(['node', '--import', 'tsx', f'{EVIDENCE}/browser-cohort.mts', str(ROOT / 'fixtures/AC20-FZK-Haus.ifc'),
                           '--dist-base', str(ROOT / 'base-dist'), '--dist-branch', str(ROOT / 'branch-dist'),
                           '--base-revision', SHA['base'], '--branch-revision', SHA['branch'], '--out', str(out),
                           '--iters', '5', '--seed', '1', '--port', '38342']).returncode
    with open(out / 'summary.txt', 'w') as f:
        subprocess.run(['node', f'{EVIDENCE}/summarize.mjs', str(out / 'runs.jsonl')], stdout=f, stderr=subprocess.STDOUT, check=True)
    rows = [json.loads(l) for l in (out / 'runs.jsonl').read_text().splitlines()]
    assert all(r['ok'] and r['payload'].get('root') and r['memory']['rendererPeakRssKiB'] for r in rows), 'smoke rows incomplete'
    sys.exit(code)


def remeasure(driver_sha, attempt):
    assert not os.environ.get('IFC_WORKER_ACTIVE_STATE'), 'start outside a reservation'
    repo = BASE / 'ifc-lite'
    me = Path(__file__).resolve()
    committed = subprocess.check_output(['git', '-C', str(repo), 'show', f'{driver_sha}:{EVIDENCE}/cohort.py'])
    assert hashlib.sha256(committed).hexdigest() == digest(me), 'orchestrator differs from the driver commit'
    script = ROOT / f'cohort-{attempt}.py'
    if me != script: shutil.copyfile(me, script)
    checkout = BASE / 'worker-state/checkouts' / driver_sha
    assets = {p: h for p, h in json.loads((ROOT / 'measurement-manifest.json').read_text())['assets'].items()
              if p.startswith(str(ROOT / 'base-dist')) or p.startswith(str(ROOT / 'branch-dist')) or p.startswith(str(ROOT / 'fixtures'))}
    files = subprocess.check_output(['git', '-C', str(repo), 'ls-tree', '-r', '--name-only', driver_sha, '--',
                                     'scripts/perf', 'scripts/lib', 'tests/benchmark', EVIDENCE], text=True).split()
    for rel in files:
        if Path(rel).suffix in ('.mts', '.ts', '.mjs', '.py', '.json'):
            blob = subprocess.check_output(['git', '-C', str(repo), 'show', f'{driver_sha}:{rel}'])
            assets[str(checkout / rel)] = hashlib.sha256(blob).hexdigest()
    for p in [script, ROOT / 'hardware-chrome', CHROME]:
        assets[str(p)] = digest(p)
    for side in SHA:
        assert json.loads((ROOT / f'{side}-build.json').read_text())['source'] == SHA[side]
    manifest = ROOT / f'measurement-manifest-{attempt}.json'
    write(manifest, {'base': SHA['base'], 'branch': SHA['branch'], 'driver': driver_sha, 'attempt': attempt, 'seed': SEED,
          'hardwareLaunch': {'display': ':1', 'headed': True, 'chrome': str(CHROME), 'flags': LAUNCH_FLAGS}, 'assets': assets})
    out = ROOT / f'measurement-{attempt}'
    receipt = submit(BASE, ROOT, f'measure-{attempt}', {
        'id': f'{TASK}-measure-{attempt}', 'commit': driver_sha, 'kind': 'benchmark', 'cpu': 4, 'memoryGiB': 24,
        'storageTask': TASK, 'storageScratch': [str(ROOT)],
        'command': [sys.executable, str(script), 'measure', attempt],
        'artifacts': [str(manifest), str(script), str(ROOT / 'base-build.json'), str(ROOT / 'branch-build.json')]
                     + [str(out / n) for n in ['qualification.json', 'report.json', 'report.txt', 'summary.json', 'summary.txt',
                                               'readiness-before.json', 'readiness-samples.json', 'cohort/runs.jsonl', 'cohort/plan.json']]})
    print('c4-browser-8341 cohort settled:', receipt, flush=True)


def measure(attempt=None):
    assert os.environ.get('IFC_WORKER_KIND') == 'benchmark'
    suffix = f'-{attempt}' if attempt else ''
    if attempt:  # fresh driver checkout: offline install from the host store, before readiness and timing
        subprocess.run(['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], check=True)
    manifest = json.loads((ROOT / f'measurement-manifest{suffix}.json').read_text())
    def drift(): return [p for p, h in manifest['assets'].items() if digest(p) != h]
    assert not drift(), 'input drift before measurement'
    out = ROOT / f'measurement{suffix}'; out.mkdir(exist_ok=False)
    readiness = []
    for _ in range(120):  # unmanaged activity: wait, never kill
        readiness.append(probe())
        if len(readiness) >= 2 and all(s['ready'] for s in readiness[-2:]): break
        time.sleep(5)
    write(out / 'readiness-before.json', readiness)
    assert readiness[-1]['ready'], 'whole-host readiness refused'
    initial = readiness[-1]; samples = [initial]; stop = threading.Event()
    def observe():
        while not stop.wait(5): samples.append(probe())
    observer = threading.Thread(target=observe, daemon=True); observer.start()
    env = os.environ.copy(); env['DISPLAY'] = ':1'
    runs = out / 'cohort/runs.jsonl'
    command = ['node', '--import', 'tsx', f'{EVIDENCE}/browser-cohort.mts',
               *[str(ROOT / 'fixtures' / n) for n in FIXTURES],
               '--dist-base', str(ROOT / 'base-dist'), '--dist-branch', str(ROOT / 'branch-dist'),
               '--base-revision', SHA['base'], '--branch-revision', SHA['branch'], '--out', str(out / 'cohort'),
               '--iters', '5', '--seed', SEED, '--headed', '--browser-executable', str(ROOT / 'hardware-chrome'), '--port', '38341']
    try:
        code = subprocess.run(command, env=env).returncode
    finally:
        stop.set(); observer.join(timeout=10); samples.append(probe())
        write(out / 'readiness-samples.json', samples)
    changed = bool(drift())
    with open(out / 'report.txt', 'w') as f:
        subprocess.run(['node', 'scripts/perf/browser-ab-report.mjs', str(runs), '--base', SHA['base'], '--branch', SHA['branch'],
                        '--json', str(out / 'report.json')], stdout=f, stderr=subprocess.STDOUT)
    with open(out / 'summary.txt', 'w') as f:
        subprocess.run(['node', f'{EVIDENCE}/summarize.mjs', str(runs), '--json', str(out / 'summary.json')], stdout=f, stderr=subprocess.STDOUT)
    rows = [json.loads(l) for l in runs.read_text().splitlines()] if runs.exists() else []
    complete = len(rows) == 30 and all(r.get('ok') for r in rows) and all(
        {r['round'] for r in rows if r['arm'] == a and r['fixture'] == n} == set(range(1, 6)) for a in SHA for n in FIXTURES)
    hardware = complete and all(isinstance(r.get('gpuAdapter'), dict) and r['gpuAdapter'].get('fallback') is False
                                and r['gpuAdapter'].get('architecture', '').lower() not in ('', 'swiftshader') for r in rows)
    verdict = json.loads((out / 'report.json').read_text()).get('verdict', {}) if (out / 'report.json').exists() else {}
    write(out / 'qualification.json', {
        'commandExitCode': code, 'artifactDrift': changed, 'completeFivePairsPerFixture': complete, 'confirmedHardwareGpu': hardware,
        'observedExternalBuildActivity': any(s['builders'] or s['unreadableProcesses'] for s in samples),
        'cpuPolicyChanged': any(s['cpuPolicy'] != initial['cpuPolicy'] for s in samples),
        'thermalInvalid': any(s['maxTemperatureC'] is None or s['maxTemperatureC'] >= 80 for s in samples),
        'throttled': initial['throttleTotal'] is None or any(s['throttleTotal'] is None or s['throttleTotal'] > initial['throttleTotal'] for s in samples),
        'protocolVerdict': verdict,
        'order': 'balanced randomized within-pair order per fixture, scripts/perf/ab-order.mjs, seed ' + SEED,
        'scope': 'Fresh-process default browser worker-pool cold load (4 pinned geometry workers), hardware GPU; '
                 'kernel peak RSS per Chrome process; CPU payload root, not GPU buffer identity.'})
    sys.exit(code)


if __name__ == '__main__':
    {'setup': lambda: setup(sys.argv[2]), 'prepare': lambda: prepare(sys.argv[2]), 'smoke': smoke,
     'measure': lambda: measure(sys.argv[2] if len(sys.argv) > 2 else None), 'remeasure': lambda: remeasure(sys.argv[2], sys.argv[3])}[sys.argv[1]]()
