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
    # #7955 observed trim repair: independent constructor, original-edit and
    # helper-lifetime reversals. The preceding 18 cases stay intact.
    cases.extend([
        ('trim-positive', 'face_lineage_read.cpp',
         'if(!known) {', 'if(true) {',
         'copied trim gets an observed constructor generation'),
        ('trim-original', 'face_lineage_read.cpp',
         'if(!caller->IsKindOf(SmCurve_TYPE)) return false;',
         'if(!caller->IsKindOf(SmCurve_TYPE)) return false;\n'
         '    if(op==SM_NO_PRE_EDIT || op==SM_NO_POST_EDIT)\n'
         '        for(auto* trim:numerical.trims) if(trim==caller) return true;',
         'issued trim read still refuses original geometry edits'),
        ('trim-attached', 'face_lineage_read.cpp',
         '!original_attached || helper_attached', 'false',
         'observed copied helper loses authority when actually attached'),
        ('trim-replacement', 'face_lineage_read.cpp',
         'numerical.serial!=frames[frame_count-1]->serial || !caller', '!caller',
         'same-depth replacement frame cannot replay helper authority'),
        ('trim-leak', 'representation_seal_geometry.cpp',
         'if(binding.alive && binding.numerical_operation==ledger.numerical.operation) ledger.fail(Failure::UnknownHistory);',
         'if(false) ledger.fail(Failure::UnknownHistory);',
         'issued trim read refuses a surviving temporary generation'),
    ])
    # #7955: the observed tessellator's two constructor edges are separately
    # necessary; the internal copy never grants attached-geometry authority.
    cases.extend([
        ('trim-internal-positive', 'face_lineage_read.cpp',
         'const bool copied_original=!known && numerical_copy_trim(original);',
         'const bool copied_original=false;',
         'internal trim helper requires actual two-generation issuance'),
        ('trim-internal-positive', 'face_lineage_read_copy.cpp',
         'numerical.copy_issued=true; event.after[0]=id;',
         'numerical.copy_issued=true; numerical.copy=nullptr; event.after[0]=id;',
         'internal trim helper requires actual two-generation issuance'),
        ('trim-internal-original', 'face_lineage_read.cpp',
         'if(!caller->IsKindOf(SmCurve_TYPE)) return false;',
         'if(!caller->IsKindOf(SmCurve_TYPE)) return false;\n'
         '    if((op==SM_NO_PRE_EDIT || op==SM_NO_POST_EDIT) && numerical_copy_trim(caller)) return true;',
         'internal attached original still refuses edits'),
        ('trim-internal-positive', 'face_lineage_read_copy.cpp',
         'target->numerical_owner_copy_operation=numerical.operation;',
         'target->numerical_owner_copy_operation={};',
         'internal trim helper requires actual two-generation issuance'),
        ('trim-internal-backlink', 'face_lineage_read.cpp',
         'if(entry->numerical_internal_original) { fail(Failure::UnsupportedGeometryChange); return true; }',
         '// mutation: trust the mutable owner backlink over observed attachment',
         'internal attached original still refuses edits'),
    ])
    # #7955 round 3: polygon attribute propagation has no face-copy authority.
    cases.extend([
        ('trim-poly-positive', 'face_lineage_read_copy.cpp',
         'if(op==SM_NO_COPY && face(caller) && a && a->GetType()==SmPolyFace_TYPE) {',
         'if(false) {',
         'polygon attribute copy preserves actual face identity'),
        ('trim-poly-outside', 'face_lineage_read_copy.cpp',
         'if(!numerical.source || !numerical.tessellation || !frame_count || numerical.frame!=frame_count ||',
         'if(!numerical.source || !frame_count || numerical.frame!=frame_count ||',
         'polygon copy requires current owned tessellation phase'),
    ])
    # #7955 round 5: actual subdivision plus independently attacked completion,
    # final coefficients, final intervals, and original polygon correspondence.
    cases.extend([
        ('trim-poly-wrong-root', 'face_lineage_read_copy.cpp',
         'found->input!=source->current) { // polygon-original-receipt',
         'false) { // polygon-original-receipt',
         'polygon rebind refuses a different original root'),
        ('trim-split-frame', 'edge_subdivision_events.cpp',
         'ledger.frame_count==frame && ledger.numerical.serial==serial &&\n'
         '        ledger.frames[frame-1]->serial==serial',
         'true',
         'subdivision rejects changed geometry intervals or missing completion'),
        ('trim-split-missing', 'edge_subdivision.cpp',
         'require(stage==Idle,"subdivision missing matching completion receipt"); // subdivision-completion',
         '// mutation: accept missing subdivision completion',
         'subdivision rejects changed geometry intervals or missing completion'),
        ('trim-split-curve', 'edge_subdivision_verify.cpp',
         'exact(left.get(),curve); exact(right.get(),static_cast<SmCurve*>(child_curve.object)); // subdivision-exact-curves',
         '// mutation: omit completed subdivision coefficient verification',
         'subdivision rejects changed geometry intervals or missing completion'),
        ('trim-split-interval', 'edge_subdivision_verify.cpp',
         'one.GetMin()==first.GetMin() && one.GetMax()==first.GetMax() &&\n'
         '        two.GetMin()==second.GetMin() && two.GetMax()==second.GetMax()',
         'true',
         'subdivision rejects changed geometry intervals or missing completion'),
    ])
    # #7955 r7: both sides of the fixed rounding contract and analytic state.
    cases.extend([
        ('trim-planar-rounding', 'planar_transition_detail.hpp',
         'std::abs(actual-expected)<=coefficient_bound(expected); // planar-coefficient-bound',
         'actual==expected; // mutation: restore exact numerical correspondence',
         'planar correspondence accepts fixed rounding budget'),
        ('trim-planar-outside', 'planar_transition_detail.hpp',
         'std::abs(actual-expected)<=coefficient_bound(expected); // planar-coefficient-bound',
         'true; // mutation: omit coefficient deviation bound',
         'planar correspondence refuses the first value beyond fixed budget'),
        ('trim-split-surface', 'representation_seal_geometry.cpp',
         'real(radius); real(angle); word(swap); word(inside); // subdivision-cone-analytic',
         'real(0); real(angle); word(swap); word(inside); // mutation: omit analytic radius',
         'subdivision rejects changed geometry intervals or missing completion'),
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
