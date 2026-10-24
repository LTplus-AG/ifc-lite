#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 semantic normal mutations. Run only inside parent/CI admission.

Requires a green control. Compiler errors, crashes and timeouts never count as
kills. Mutate only this checkout's adapter, never the pinned SDK, and restore
source and binary in finally. Refuse a dirty adapter source before starting.
"""
import pathlib
import subprocess
import sys


def main():
    root = pathlib.Path(__file__).resolve().parents[3]
    build = pathlib.Path(sys.argv[1]).resolve()
    source = root / 'native/smlib-adapter/src/mesh.cpp'
    affine = root / 'native/smlib-adapter/src/affine.cpp'
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', str(source), str(affine)], cwd=root, check=True)
    original = source.read_text()
    affine_original = affine.read_text()
    transform = 'checked(result->Transform(f.last,&f.scale,FALSE));'
    if affine_original.count(transform) != 1:
        raise RuntimeError('affine mutation anchor drifted')
    anchor = 'const auto n=found->second;'
    guard = 'n.x*(nx/length)+n.y*(ny/length)+n.z*(nz/length)>0'
    if original.count(anchor) != 1 or original.count(guard) != 1:
        raise RuntimeError('mutation anchors drifted')

    def build_target():
        subprocess.run(['cmake', '--build', str(build), '--target', 'ifclite_smlib_tests',
                        '--parallel', '2'], cwd=root, check=True)

    def witness(marker=None):
        result = subprocess.run([str(build / 'ifclite_smlib_tests')], cwd=root,
                                capture_output=True, text=True, timeout=60)
        output = result.stdout + result.stderr
        print(output, end='', flush=True)
        if marker is None:
            if result.returncode != 0:
                raise RuntimeError('normal control must be green before mutation')
        elif result.returncode != 1 or marker not in output:
            raise RuntimeError('normal mutation not killed by intended independent oracle')

    witness()
    mutations = [
        ('flatten', source, original, original.replace(anchor, 'const SmVector3d n(nx/length,ny/length,nz/length);'),
         'mesh FAIL: independent analytic corner normal'),
        ('orientation', source, original, original.replace(anchor, 'const auto n=-found->second;').replace(guard, 'true'),
         'mesh FAIL: analytic normal follows outward winding'),
        # Transforming the rational surface is the actual affine consumer:
        # normals are evaluated afterward, not transformed as mesh vectors.
        ('affine-scale', affine, affine_original,
         affine_original.replace(transform, 'checked(result->Transform(f.last,nullptr,FALSE));'),
         'affine FAIL: positive analytic volume under signed determinant'),
    ]
    for name, path, clean, mutant, marker in mutations:
        try:
            path.write_text(mutant)
            build_target()
            witness(marker)
            print(f'OBSERVED: J5 {name}', flush=True)
        finally:
            path.write_text(clean)
            build_target()
        witness()


if __name__ == '__main__':
    main()
