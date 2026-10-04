# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Lossless evidence packaging only; never builds or runs a model."""
import gzip, hashlib, io, json, pathlib, re, subprocess, tarfile
ROOT = pathlib.Path('/tmp/6232-takeover')
OUT = pathlib.Path(__file__).resolve().parent
WT = OUT.parents[3]
REMOTE = ROOT / '6537-native-hosted-remote-v4'
V2 = ROOT / '6537-checked-magnitude-evidence-source-v2'
SDK = ROOT / '6537-sdk-v5-independent-qualification-session6503'
CONTROLLER = 'c32830300ebbfe919a9d69df94197dc2ae8cceb0'
BASE = '0a16f532ceb8f177d02ee29f4645e6f048fbace5'
CAND = '07bdf45b5d470413d3796b3189d588a91a09a0d6'
sha = lambda b: hashlib.sha256(b).hexdigest()
entries = {}
secrets = [rb'gh[pousr]_[A-Za-z0-9]{30,}', rb'github_pat_[A-Za-z0-9_]{30,}',
           rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', rb'AKIA[A-Z0-9]{16}']

def safe(name):
    p = pathlib.PurePosixPath(name)
    assert not p.is_absolute() and '..' not in p.parts and name == str(p)
    assert not name.lower().endswith(('.ifc', '.wasm', '.exe', '.deb', '.dll', '.so'))
    assert 'node_modules' not in p.parts and '.capture.' not in name

def inspect(name, data):
    safe(name)
    assert not data.startswith(b'\x7fELF')
    assert not any(re.search(pattern, data) for pattern in secrets), name
    if name.endswith('.tar.gz'):
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
            members = tar.getmembers()
            assert len({m.name for m in members}) == len(members)
            manifest = json.loads(tar.extractfile('member-manifest.json').read())
            inventory = {r['path']: r for r in manifest['members']}
            assert set(inventory) | {'member-manifest.json'} == {m.name for m in members}
            for m in members:
                assert m.isfile()
                b = tar.extractfile(m).read()
                inspect(m.name, b)
                if m.name != 'member-manifest.json':
                    r = inventory[m.name]
                    assert sha(b) == r['sha256'] and len(b) == r['storedMemberBytes']
    elif name.endswith('.gz'):
        # Inner profile/source compression is also checked for excluded payloads.
        inspect(name[:-3], gzip.decompress(data))

def put(name, data, origin, kind):
    assert name not in entries
    inspect(name, data)
    entries[name] = {'data': data, 'origin': origin, 'kind': kind}

def add(path, name, kind):
    assert path.is_file() and not path.is_symlink()
    put(name, path.read_bytes(), str(path), kind)

# Preserve every original run, stdout/stderr and both original audit versions.
for path in sorted(REMOTE.rglob('*')):
    if path.is_file():
        add(path, 'native-hosted-remote-v4/' + str(path.relative_to(REMOTE)), 'original-native-run-or-audit')
audit = json.loads((REMOTE / 'independent-audit.json').read_text())
assert audit['status'] == 'QUALIFIED_SCOPED_NATIVE_ATTRIBUTION' and not audit['errors']
assert audit['run'] == 37149940166 and audit['revisions'] == {'base': BASE, 'candidate': CAND}
assert len(audit['checks']) == 687 and all(x['pass'] for x in audit['checks'])
# Existing instruction/correctness evidence stays an immutable nested dependency.
index = json.loads((V2 / 'artifact-index.json').read_text())
b = (V2 / 'retained-v2.tar.gz').read_bytes()
assert sha(b) == index['archiveSha256'] and len(b) == index['archiveBytes']
for name in ['retained-v2.tar.gz', 'artifact-index.json', 'member-manifest.json',
             'README.md', 'archive.py', 'outer-document-identities.json']:
    add(V2 / name, 'dependency-v2/' + name, 'immutable-v2-with-v1-instruction-dependency')
# Mixed worker-pool result is supporting context, never pooled with native phases.
for path in sorted(SDK.iterdir()):
    if path.is_file():
        add(path, 'supporting-sdk-audit/' + path.name, 'original-sdk-audit-context')
# Freeze the exact native harness and its local-import closure from Git objects.
paths = subprocess.check_output(['git', '-C', str(WT), 'ls-tree', '-r', '--name-only',
                                 CONTROLLER, 'scripts/perf'], text=True).splitlines()
selected = {p for p in paths if pathlib.PurePosixPath(p).parent == pathlib.PurePosixPath('scripts/perf')
            and pathlib.PurePosixPath(p).name.startswith('native-')}
selected |= {'.github/workflows/benchmark.yml', '.github/workflows/perf-native.yml',
             '.github/actions/setup-wasm-build/action.yml', 'scripts/perf/NATIVE_HOSTED.md',
             'scripts/perf/probe.sh', 'scripts/fixtures/download.ts', 'tests/models/manifest.json'}
source_inventory = json.loads((REMOTE / 'artifacts/native-phase-37149940166-1/provenance.json').read_text())['sources']
controller = next(s for s in source_inventory if s['head'] == CONTROLLER)
# Some historical fixture entrypoint names differ; only include actual Git files.
all_paths = set(subprocess.check_output(['git', '-C', str(WT), 'ls-tree', '-r', '--name-only', CONTROLLER], text=True).splitlines())
selected &= all_paths
queue = list(selected)
while queue:
    path = queue.pop()
    data = subprocess.check_output(['git', '-C', str(WT), 'show', CONTROLLER + ':' + path])
    if path.endswith('.mjs'):
        for relative in re.findall(r"(?:from\s*|import\s*)['\"](\.[^'\"]+\.mjs)['\"]", data.decode()):
            target = str(pathlib.PurePosixPath(path).parent / relative)
            target = str(pathlib.Path(target))
            if target in all_paths and target not in selected:
                selected.add(target); queue.append(target)
for path in sorted(selected):
    b = subprocess.check_output(['git', '-C', str(WT), 'show', CONTROLLER + ':' + path])
    assert sha(b) == controller['files'][controller['directory'] + '/' + path], path
    put('controller-source/' + path, b, 'git:' + CONTROLLER + ':' + path, 'exact-run-harness-source')
for head, role in [(BASE, 'base'), (CAND, 'candidate')]:
    source = next(s for s in source_inventory if s['head'] == head)
    rustpaths = subprocess.check_output(['git', '-C', str(WT), 'ls-tree', '-r', '--name-only', head,
                                       'rust/processing/examples/perf_probe'], text=True).splitlines()
    rustpaths += ['rust/processing/examples/perf_probe.rs', 'rust/geometry/src/kernel/fixed_int/mod.rs',
                  'rust/geometry/src/kernel/fixed_int/mul.rs', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']
    if role == 'candidate': rustpaths += ['rust/geometry/src/kernel/fixed_int/magnitude_mul_tests.rs']
    for path in rustpaths:
        b = subprocess.check_output(['git', '-C', str(WT), 'show', head + ':' + path])
        assert sha(b) == source['files'][source['directory'] + '/' + path]
        put(role + '-source/' + path, b, 'git:' + head + ':' + path, 'exact-probe-and-arithmetic-source')
rows = [{'path': n, 'originalPath': e['origin'], 'kind': e['kind'],
         'originalInputBytes': len(e['data']), 'storedMemberBytes': len(e['data']), 'sha256': sha(e['data'])}
        for n, e in sorted(entries.items())]
# One record per line keeps the outer review surface compact.
mb = ('{\n"scope":"Qualified native evidence and immutable diagnostic dependencies; no browser speed claim",\n"members":[\n'
      + ',\n'.join(json.dumps(r, separators=(',', ':')) for r in rows) + '\n]}\n').encode()
archive = OUT / 'retained-native.tar.gz'
with archive.open('xb') as raw:
    with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode='w|', format=tarfile.PAX_FORMAT) as tar:
            for name, data in [(n, e['data']) for n, e in sorted(entries.items())] + [('member-manifest.json', mb)]:
                item = tarfile.TarInfo(name); item.size = len(data); item.mode = 0o644
                item.mtime = item.uid = item.gid = 0; item.uname = item.gname = ''
                tar.addfile(item, io.BytesIO(data))
with tarfile.open(archive, 'r:gz') as tar:
    assert len(tar.getmembers()) == len(entries) + 1
    for member in tar.getmembers():
        assert member.isfile(); safe(member.name)
        b = tar.extractfile(member).read()
        expected = mb if member.name == 'member-manifest.json' else entries[member.name]['data']
        assert b == expected and sha(b) == sha(expected)
(OUT / 'member-manifest.json').write_bytes(mb)
index = {'archive': archive.name, 'archiveBytes': archive.stat().st_size, 'archiveSha256': sha(archive.read_bytes()),
         'originalArtifactCount': len(entries), 'archiveMemberCount': len(entries) + 1,
         'originalInputBytes': sum(len(e['data']) for e in entries.values()),
         'storedArtifactMemberBytes': sum(len(e['data']) for e in entries.values()),
         'memberManifestSha256': sha(mb), 'gzipMtime': 0, 'safeRegularPaths': True,
         'roundtripAllBytesAndHashes': True, 'nestedDependencyMembersVerified': True,
         'modelBinaryAndNodeModulesExcluded': True, 'highConfidenceSecretScanPassed': True,
         'run': 37149940166, 'controller': CONTROLLER, 'base': BASE, 'candidate': CAND,
         'independentAuditChecks': 687, 'scope': 'Evidence retention only; no execution of production, tests or measurements.'}
(OUT / 'artifact-index.json').write_text(json.dumps(index, indent=2) + '\n')
print(json.dumps(index, indent=2))
