#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 independently invoked compiled semantic controls; parent/CI admission only."""
import pathlib
import subprocess
import sys


def main():
    root = pathlib.Path(__file__).resolve().parents[3]
    build = pathlib.Path(sys.argv[1]).resolve()
    source = root / 'native/smlib-adapter/src'
    cases = [
        ('construction', 'u32(uint32_t(source.roots.size()));', 'u32(uint32_t(source.roots.size()-1));',
         'complete initial construction role inventory'),
        ('construction', 'u32(root.role);u32(root.ordinal);', 'u32(1);u32(root.ordinal);',
         'direct construction role corresponds to authored feature'),
        ('construction', 'u32(source.source.entity);', 'u32(source.source.entity+1);',
         'source entity binding is exact'),
        (None, 'mesh->source_roots.push_back(matched);',
         'mesh->source_roots.push_back((matched+1)%state->inventory->roots.size());',
         'actual affine triangle matches original construction role'),
    ]
    # Preserve the four inherited source-binding mutations verbatim above.
    cases = [(case, 'source_boundary.cpp', before, after, marker)
             for case, before, after, marker in cases]
    cases.extend([
        ('cap-positive', 'source_construction_cap.cpp',
         'cap_phase.splits[cap_phase.count++]={parent->generation,child->generation};',
         '++cap_phase.count;',
         'cap construction requires actual complete split receipts'),
        ('cap-bound', 'source_construction_cap.cpp',
         'cap_phase.count>=cap_phase.limit', 'false',
         'cap split requires exact active construction body'),
        ('cap-output', 'source_construction_cap.cpp',
         'void SourceConstruction::finish_cap(const SmTArray<SmFace*>& output) {',
         'void SourceConstruction::finish_cap(const SmTArray<SmFace*>& output) {\n'
         '    if(output.GetSize()==0) { cap_phase.active=false; return; }',
         'cap publication requires actual returned live descendant'),
    ])
    paths = sorted({source / row[1] for row in cases})
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', *map(str, paths)], cwd=root, check=True)
    originals = {path: path.read_text() for path in paths}
    for _, name, before, _, _ in cases:
        if originals[source / name].count(before) != 1:
            raise RuntimeError('source binding mutation anchor drift')

    def build_control():
        subprocess.run(['cmake', '--build', str(build), '--target', 'ifclite_smlib_source_binding_tests', '--parallel', '2'], check=True, cwd=root)

    def witness(case, marker=None):
        command = [str(build / 'ifclite_smlib_source_binding_tests')]
        if case:
            command.append(case)
        result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=120)
        output = result.stdout + result.stderr
        print(output, end='', flush=True)
        if marker is None:
            if result.returncode != 0:
                raise RuntimeError('source binding control is not green; preserve execution hold')
        elif result.returncode != 42 or f'SOURCE_BINDING_ASSERT: {marker}' not in output:
            raise RuntimeError('source binding mutant did not reach intended semantic RED')

    build_control()
    for case, name, before, after, marker in cases:
        path = source / name
        original = originals[path]
        witness(case)
        try:
            path.write_text(original.replace(before, after))
            build_control()
            witness(case, marker)
            print(f'OBSERVED source binding mutation: {marker}', flush=True)
        finally:
            path.write_text(original)
            build_control()
        witness(case)


if __name__ == '__main__':
    main()
