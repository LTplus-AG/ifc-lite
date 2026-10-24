#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 actual-SDK lineage mutations, parent/CI admission only.

Each case needs its own green control and the intended semantic assertion.
Compilation errors, isolation taint, signals and timeouts are not kills.
Sources and the control executable are restored even after a failed mutant.
"""
import pathlib
import subprocess
import sys


def main():
    root = pathlib.Path(__file__).resolve().parents[3]
    build = pathlib.Path(sys.argv[1]).resolve()
    source = root / 'native/smlib-adapter/src'
    cases = [
        ('split', 'planar_transition.hpp',
         'return i<2?children[i]:Identity{};', 'return i<2?parent:Identity{};',
         'both real fragments have distinct generations and frozen source parent'),
        ('split', 'planar_transition.hpp',
         'Identity after() const { return merged; }', 'Identity after() const { return parent; }',
         'new physical revision derives from both fragments, never relabelled as original'),
        ('mixed', 'face_lineage_events.cpp',
         'append(Change::Copy,from->current,prior)', 'append(Change::Copy,from->current)',
         'copy onto existing face preserves both input ancestors'),
        ('owned', 'mesh.cpp',
         'mesh->provenance.triangles.push_back(triangle_lineage.at(triangle));',
         'mesh->provenance.triangles.push_back(lineage->identity(source_faces[0]));',
         'retessellation preserves all native face identities'),
        ('unknown', 'face_lineage_geometry.cpp',
         'if(complete(entry->current)) { fail(Failure::UnsupportedGeometryChange); return; }',
         'if(complete(entry->current)) { return; }',
         'direct SDK property query still refuses an unissued transient numerical edit'),
        ('budget', 'face_lineage.cpp',
         'nodes.resize(limits.nodes); bindings.resize(2*size_t(limits.nodes)+1);',
         'limits.events=32768; nodes.resize(limits.nodes); bindings.resize(2*size_t(limits.nodes)+1);',
         'ignored observer refusal cannot publish a partial copy'),
    ]
    # J5-STATIC-01: independent removal at each SDK-reading / history entry.
    for case, signature in [
        ('terminal-faces', 'std::vector<Identity> OwnedBoundary::faces() const {'),
        ('terminal-tessellate', 'std::unique_ptr<AdapterMesh> OwnedBoundary::tessellate(double chord,double angle) const {'),
        ('terminal-ancestors', 'std::vector<Root> OwnedBoundary::ancestors(Identity id) const {'),
    ]:
        cases.append((case, 'owned_lineage.cpp', signature + '\n    require_live();', signature,
                      'terminal owner refuses before SDK events or mesh publication'))
    # J5-STATIC-03: preserves all six labels/coverage and all normal data.
    cases.append(('owned', 'mesh.cpp',
                  'mesh->provenance.triangles.push_back(triangle_lineage.at(triangle));',
                  'mesh->provenance.triangles.push_back(lineage->identity(source_faces[(source->second+1)%source_faces.GetSize()]));',
                  'triangle geometry agrees with claimed source face root'))
    cases.append(('affine-positive', 'mesh.cpp',
                  'mesh->provenance.triangles.push_back(triangle_lineage.at(triangle));',
                  'mesh->provenance.triangles.push_back(lineage->identity(source_faces[(source->second+1)%source_faces.GetSize()]));',
                  'affine triangle geometry matches its original physical ancestor'))
    cases.append(('affine-mixed', 'face_lineage_events.cpp',
                  'append(Change::Copy,from->current,prior)', 'append(Change::Copy,from->current)',
                  'affine preserves complete mixed-kind ancestor union through retessellation'))
    # Each reverse mutation independently attacks authority or a semantic check.
    cases.extend([
        ('affine-positive', 'owned_lineage.cpp',
         'auto transformed=copy_affine_rational(solid.get(),matrix,certificate,&state->ledger);',
         'auto transformed=checked_brep_copy(solid.get(),&state->ledger);',
         'affine triangle geometry matches its original physical ancestor'),
        ('affine-negative-source', 'affine_transition.cpp',
         'for(auto& seal:protected_seals) seal->verify();',
         '// mutation: do not verify protected source and sibling state',
         'affine transition rejects unreported edits and incomplete receipts'),
        ('affine-negative-sibling', 'affine_transition.cpp',
         'for(auto& seal:protected_seals) seal->verify();',
         '// mutation: do not verify protected source and sibling state',
         'affine transition rejects unreported edits and incomplete receipts'),
        ('affine-negative-target', 'affine_transition.cpp',
         'verify_target(); // affine-terminal-target',
         '// mutation: omit terminal target proof',
         'affine transition rejects unreported edits and incomplete receipts'),
        ('affine-negative-receipt', 'affine_transition.cpp',
         'require(position==expected_events.size(),"affine missing prescribed SDK notification");',
         '// mutation: accept real numerical work with missing notification receipts',
         'affine transition rejects unreported edits and incomplete receipts'),
        ('affine-negative-late', 'affine_transition.cpp',
         'require(receipts==3,"affine missing semantic transition receipt");',
         '// mutation: accept an incomplete late transition',
         'affine transition rejects unreported edits and incomplete receipts'),
    ])
    paths = sorted({source / row[1] for row in cases})
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', *map(str, paths)], cwd=root, check=True)
    originals = {path: path.read_text() for path in paths}
    for _, name, before, _, _ in cases:
        if originals[source / name].count(before) != 1:
            raise RuntimeError(f'lineage mutation anchor drifted: {name}')

    def compile_control():
        subprocess.run(['cmake', '--build', str(build), '--target', 'ifclite_smlib_lineage_tests',
                        '--parallel', '2'], cwd=root, check=True)

    def witness(case, marker=None):
        result = subprocess.run([str(build / 'ifclite_smlib_lineage_tests'), case], cwd=root,
                                capture_output=True, text=True, timeout=120)
        output = result.stdout + result.stderr
        print(output, end='', flush=True)
        if marker is None:
            if result.returncode != 0 or f'lineage selected witness PASS: {case}' not in output:
                raise RuntimeError(f'lineage control must be green: {case}')
        elif result.returncode != 1 or f'lineage FAIL: {marker}' not in output or 'lineage TAINT:' in output:
            raise RuntimeError(f'lineage mutation not killed by intended oracle: {case}')

    compile_control()
    for number, (case, name, before, after, marker) in enumerate(cases, 1):
        witness(case)
        path = source / name
        try:
            path.write_text(originals[path].replace(before, after))
            compile_control()
            witness(case, marker)
            print(f'OBSERVED: J5 lineage mutation {number}: {case}', flush=True)
        finally:
            path.write_text(originals[path])
            compile_control()
        witness(case)


if __name__ == '__main__':
    main()
