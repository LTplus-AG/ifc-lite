#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 R1/R2 independent actual-executor reverse mutations; parent/CI only."""
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
NATIVE_TEST = 'j5_source_binding_two_mapped_sources_keep_distinct_physical_ancestry'
BROWSER_PREFIX = 'retained_browser_j5_'


def main():
    mode = sys.argv[1]
    if mode == 'native':
        worker = pathlib.Path(os.environ['IFCLITE_SMLIB_WORKER'])
        if not worker.is_file():
            raise RuntimeError('actual native Worker required; skip is not a control')
        cases = [
            ('rust/geometry-runtime/src/worker_affine.rs',
             'if copy.source_correspondence.is_some() {', 'if false {', NATIVE_TEST,
             'J5_R1 execute receipt must consume final triangle coverage'),
            ('rust/geometry-runtime/src/worker_mesh.rs',
             'let roots=self.read_u32(mesh,MeshStream::ConstructionRoots,triangles)?;',
             'let roots=self.read_u32(mesh,MeshStream::ConstructionRoots,triangles)?;\n'
             '            let roots=roots.into_iter().map(|r| (r+1)%expected.roles().len() as u32).collect();',
             NATIVE_TEST, 'J5_R1 production triangle matches original role'),
        ]
        cargo = ['cargo', 'test', '--locked', '-p', 'ifc-lite-processing', '--lib', '--features', 'retained-native']
    elif mode == 'browser':
        mesh = 'rust/wasm-bindings/src/retained_browser/mesh_admission.rs'
        shared = 'rust/geometry/src/document/retained_source.rs'
        cases = [
            (mesh, 'live_bytes: bytes as u64, copy_bytes: bytes as u64,',
             'live_bytes: 0, copy_bytes: bytes as u64,',
             BROWSER_PREFIX+'source_low_live_account_refuses_backing', 'J5_R2 source backing must refuse before Rust copy'),
            (mesh, 'live_bytes: bytes as u64, copy_bytes: bytes as u64,',
             'live_bytes: bytes as u64, copy_bytes: 0,',
             BROWSER_PREFIX+'source_low_copy_account_refuses_backing', 'J5_R2 source backing must refuse before Rust copy'),
            (mesh, 'mesh.storage = Some(storage);', 'drop(storage);',
             BROWSER_PREFIX+'multiple_affine_backing_follows_shared_proof_lifetime', 'J5_R2 dropped mesh refunds backing'),
            (shared, 'self._triangle_storage = Some(admission);', 'drop(admission);',
             BROWSER_PREFIX+'multiple_affine_backing_follows_shared_proof_lifetime', 'J5_R2 final proof drop refunds root backing'),
        ]
        cargo = ['cargo', 'test', '--locked', '-p', 'ifc-lite-wasm', '--lib', '--features', 'retained-browser', '--target', 'wasm32-unknown-unknown']
    else:
        raise RuntimeError('select native or browser explicitly')
    originals = {name: (ROOT/name).read_bytes() for name, *_ in cases}
    for name, before, *_ in cases:
        subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', name], cwd=ROOT, check=True)
        if originals[name].decode().count(before) != 1:
            raise RuntimeError(f'mutation anchor drift: {name}')

    def witness(test, marker=None):
        # No compilation failure can qualify as a semantic RED.
        subprocess.run(cargo+['--no-run'], cwd=ROOT, check=True, timeout=3600)
        if mode == 'native':
            command = cargo+[test, '--', '--nocapture']
        else:
            command = ['wasm-pack', 'test', '--headless', '--chrome', '--chromedriver',
                       str(ROOT/'scripts/wasm-test-mime-driver.mjs'), 'rust/wasm-bindings', '--lib',
                       '--features', 'retained-browser', '--', test]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=900)
        output = result.stdout+result.stderr
        print(output, end='', flush=True)
        if 'running 1 test' not in output or 'SKIP' in output or 'could not compile' in output:
            raise RuntimeError('actual single compiled witness required')
        if marker is None:
            if result.returncode != 0 or '1 passed; 0 failed' not in output:
                raise RuntimeError('green control required; preserve strict execution HOLD')
        elif result.returncode == 0 or marker not in output or '0 passed; 1 failed' not in output:
            raise RuntimeError('intended semantic RED required')

    for name, before, after, test, marker in cases:
        witness(test)
        try:
            (ROOT/name).write_bytes(originals[name].replace(before.encode(), after.encode()))
            witness(test, marker)
        finally:
            (ROOT/name).write_bytes(originals[name])
            witness(test)
        print(f'OBSERVED {mode} source-review mutation: {marker}', flush=True)


if __name__ == '__main__':
    main()
