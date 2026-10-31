#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""C2-8 (#8263) move-only split of router/voids/prism_cut.rs, reproducibly.

Reads the BASE prism_cut.rs (main 70c91e8e61) and writes, for one stage of the
stack, the new submodules plus the facade. Every moved line is copied from the
base file; the only rewrites are mechanical:

* visibility: a moved top-level item, struct field or inherent method gains
  `pub(super)` (the old file-private scope seen from the deeper file); an item
  that was already `pub(super)` (voids-wide) becomes `pub(in crate::router::voids)`
  so its effective scope is unchanged;
* paths: `super::geom::` becomes `super::super::geom::` (one level deeper);
* each new file gets the MPL header, `//!` module docs and explicit imports.

Usage (from the repository root):

    git show 70c91e8e61:rust/geometry/src/router/voids/prism_cut.rs > /tmp/base.rs
    python3 -I tests/evidence/c2-8a/slice.py --base-file /tmp/base.rs --stage a --write
    python3 -I tests/evidence/c2-8a/slice.py --base-file /tmp/base.rs --stage a --check REV

`--write` regenerates the stage's new files and the facade. A later stage never
rewrites an earlier stage's files (PR-1's math::v3 commit edits kit.rs after
the move). `--check` verifies the move against the files at git revision REV:
every base line of every range must reappear, in order, in its target file
after normalising the rewrites above, and every other line of a target file
must be preamble (header, docs, imports). It prints the unmatched lines.
"""
import argparse
import re
import subprocess
import sys

BASE_COMMIT = '70c91e8e61'
VOIDS = 'rust/geometry/src/router/voids/'
FACADE = VOIDS + 'prism_cut.rs'
SUB = VOIDS + 'prism_cut/'
STAGES = 'abc'

HEADER = [
    '// This Source Code Form is subject to the terms of the Mozilla Public',
    '// License, v. 2.0. If a copy of the MPL was not distributed with this',
    '// file, You can obtain one at https://mozilla.org/MPL/2.0/.',
]

# (stage, module, [(first, last), ...]) -- 1-based inclusive lines of the base
# file, in base order. A module may take more than one range; the ranges of a
# stage tile its region of the base file exactly (checked below).
RANGES = [
    ('a', 'kit', [(234, 290)]),
    ('a', 'plane2', [(291, 332)]),
    ('a', 'ptri', [(333, 354), (503, 576)]),
    ('a', 'checks', [(355, 502)]),
    ('a', 'frame', [(577, 746)]),
    ('a', 'profile', [(747, 944)]),
    ('a', 'detect', [(945, 1242)]),
    ('b', 'extension', [(1243, 1608)]),
    ('b', 'face', [(1609, 1701)]),
    ('b', 'cut', [(1702, 1938)]),
    ('b', 'pool', [(1939, 1984)]),
    ('b', 'decompose', [(1985, 2118)]),
    ('c', 'caps', [(2119, 2318)]),
    ('c', 'cap_cdt', [(2319, 2386), (2481, 2611)]),
    ('c', 'crossings', [(2387, 2480)]),
    ('c', 'driver', [(2612, 2921)]),
]
# Region of the base file each stage moves (the union of its ranges).
REGION = {'a': (234, 1242), 'b': (1243, 2118), 'c': (2119, 2921)}

DOCS = {
    'kit': [
        'The prism cut\'s small f64 vector kit: explicit component arithmetic, no',
        'nalgebra matrix products, so no FMA can break native == wasm identity.',
        '',
        'F2a prism-kit exception (#7781 §3 row 10). `normalize`, `lerp` and `bits`',
        'stay local. `normalize` refuses a length strictly below `1e-12` and',
        'multiplies by the reciprocal; `math::v3::normalize` refuses `<= min_len`',
        'and divides each component, so swapping it would move the last bit of',
        'every unit vector the cut derives. `lerp` and `bits` have no `math::v3`',
        'twin. `V2` is a ROUTER-7 site, moved as-is (no `math::v2` swap).',
    ],
    'plane2': [
        'Plane predicates of the prism cut: even-odd point-in-polygon and the',
        'segment crossing parameter, over the kit\'s `V2`.',
        '',
        'ROUTER-7 sites, moved as-is: they keep their own arithmetic and',
        'tolerances (`1e-18` parallel cutoff, `1e-12` endpoint slack) rather than',
        '`math::v2` / `geom2d`. Unifying them is not part of this move.',
    ],
    'ptri': [
        'One host triangle in f64 (`PTri`), and the promotion from and demotion',
        'back to a `Mesh`.',
    ],
    'checks': [
        'Self-checks on a candidate cut: the host partition identity, a',
        'measurable removed region, and the consolidated result\'s change and',
        'volume bounds.',
    ],
    'frame': [
        'The stepped-extrusion cutter (`PrismFrame`), its faces, and the OBB',
        'overlap veto.',
    ],
    'profile': [
        'Cross-section ring helpers for prism detection: the depth basis,',
        'collinear simplification, CCW area, an interior point and the',
        'cross-section stitcher.',
    ],
    'detect': [
        'Prism detection: decide that a welded cutter mesh is a stepped',
        'extrusion, merge two prisms across a coincident interface, and give an',
        'opening that did not yield a prism its identity-frame blocker OBB.',
    ],
    'extension': [
        'Cap and profile-edge extension: push a flush cap or profile edge past',
        'the host surface when the swept region is provably empty of host',
        'material, with the ray-parity point-in-solid test it relies on.',
    ],
    'face': [
        'Per-face geometry of the stepped solid: the canonical-order crossing',
        'cache, seam segments, face planes and face-local coordinates.',
    ],
    'cut': [
        'The prism cut: subtract a stepped solid from the host triangle list, or',
        'return the defer reason that sends the opening to the exact kernel.',
    ],
    'pool': [
        'Tolerance-merging 2D point pool shared by the triangle and cap CDTs.',
    ],
    'decompose': [
        'Decompose one host triangle along the cutter seams with a conforming',
        'CDT and classify its pieces inside or outside the prism.',
    ],
    'caps': [
        'Reveal caps: the canonical breakpoints of a cap plane and the cap built',
        'for each cutter face from its seams, kept where it lies in the exposed',
        'region and inside the pre-cut host.',
    ],
    'cap_cdt': [
        'The cap CDT: pool the face ring, auxiliary rings and seams, run the',
        'conforming CDT, and emit each kept sub-triangle with the result',
        'orientation.',
    ],
    'crossings': [
        'Make a cap constraint soup CDT-admissible by splitting crossing',
        'constraints and constraints through pooled points.',
    ],
    'driver': [
        'The driver: `Execution::try_prism_cut` admits, detects, extends and cuts',
        'each merged opening in order, self-checks the result and returns the',
        'residual context for the exact kernel.',
    ],
}
# Explicit imports per module, keyed by the first stage they apply from (a
# later stage may repoint an import at a module that stage creates).
IMPORTS = {
    'kit': {'a': []},
    'plane2': {'a': ['use super::kit::V2;']},
    'ptri': {'a': [
        'use super::kit::{cross, normalize, sub, V3};',
        'use crate::math::aabb::Aabb3;',
        'use crate::mesh::Mesh;',
    ]},
    'checks': {'a': [
        'use super::kit::{cross, dot, norm, normalize, sub, V3};',
        'use super::ptri::{mesh_from_ptris, PTri};',
        'use crate::math::aabb::Aabb3;',
        'use crate::mesh::Mesh;',
    ]},
    'frame': {'a': [
        'use super::kit::{add, cross, dot, norm, normalize, scale, sub, V2, V3};',
        'use super::plane2::pip;',
    ]},
    'profile': {'a': [
        'use super::kit::{bits, cross, dot, lerp, normalize, V2, V3};',
        'use nalgebra::Point2;',
        'use rustc_hash::FxHashMap;',
    ]},
    'detect': {'a': [
        'use super::super::geom::opening_frame::cluster_prism_directions;',
        'use super::super::CutterKind;',
        'use super::frame::{PrismFrame, MAX_PROFILE_VERTS};',
        'use super::kit::{cross, dot, normalize, sub, V2, V3};',
        'use super::profile::{',
        '    basis_from_depth, ccw_area, cross_section_ring, ring_interior, simplify_collinear, MAX_SLABS,',
        '};',
    ]},
    'extension': {'b': [
        'use super::super::geom::parity::PARITY_RAY_DIR as RAY_DIR;',
        'use super::frame::PrismFrame;',
        'use super::kit::{dot, lerp, V2, V3};',
        'use super::plane2::{pip, seg_cross_param};',
        'use super::profile::ccw_area;',
        'use super::ptri::PTri;',
    ]},
    'face': {'b': [
        'use super::frame::{Face, PrismFrame};',
        'use super::kit::{add, bits, dot, lerp, scale, V2, V3};',
        'use rustc_hash::FxHashMap;',
    ]},
    'cut': {
        'b': [
            'use super::checks::{has_measurable_region, partition_consistent};',
            'use super::decompose::decompose_tri;',
            'use super::face::{cached_crossing, face_plane, CrossCache, Seam};',
            'use super::frame::{cap_xor, stack_faces, Face, PrismFrame};',
            'use super::kit::{add, dot, lerp, scale, V2, V3};',
            'use super::plane2::seg_cross_param;',
            'use super::ptri::PTri;',
            'use super::{build_face_cap, cap_plane_breakpoints};',
        ],
        'c': [
            'use super::caps::{build_face_cap, cap_plane_breakpoints};',
            'use super::checks::{has_measurable_region, partition_consistent};',
            'use super::decompose::decompose_tri;',
            'use super::face::{cached_crossing, face_plane, CrossCache, Seam};',
            'use super::frame::{cap_xor, stack_faces, Face, PrismFrame};',
            'use super::kit::{add, dot, lerp, scale, V2, V3};',
            'use super::plane2::seg_cross_param;',
            'use super::ptri::PTri;',
        ],
    },
    'pool': {'b': [
        'use super::kit::{V2, V3};',
        'use nalgebra::Point2;',
        'use rustc_hash::FxHashMap;',
    ]},
    'decompose': {
        'b': [
            'use super::face::{face_coords, Seam};',
            'use super::frame::{Face, PrismFrame};',
            'use super::kit::{add, cross, dot, lerp, normalize, scale, sub, V2, V3};',
            'use super::pool::PointPool;',
            'use super::ptri::PTri;',
            'use super::resolve_crossings;',
            'use crate::cdt::triangulate_pslg;',
        ],
        'c': [
            'use super::crossings::resolve_crossings;',
            'use super::face::{face_coords, Seam};',
            'use super::frame::{Face, PrismFrame};',
            'use super::kit::{add, cross, dot, lerp, normalize, scale, sub, V2, V3};',
            'use super::pool::PointPool;',
            'use super::ptri::PTri;',
            'use crate::cdt::triangulate_pslg;',
        ],
    },
    'caps': {'c': [
        'use super::cap_cdt::{cap_cdt, cap_cdt_xor, emit_cap};',
        'use super::extension::point_inside;',
        'use super::face::Seam;',
        'use super::frame::{Face, PrismFrame};',
        'use super::kit::{add, scale, V2, V3};',
        'use super::plane2::{pip, seg_cross_param};',
        'use super::ptri::PTri;',
    ]},
    'cap_cdt': {'c': [
        'use super::crossings::resolve_crossings;',
        'use super::extension::point_inside;',
        'use super::face::Seam;',
        'use super::frame::PrismFrame;',
        'use super::kit::{add, dot, scale, V2, V3};',
        'use super::pool::PointPool;',
        'use super::ptri::PTri;',
        'use crate::cdt::triangulate_pslg;',
    ]},
    'crossings': {'c': [
        'use super::kit::{V2, V3};',
        'use super::pool::PointPool;',
    ]},
    'driver': {'c': [
        'use super::super::admission::{aabb_engulfs, min_opening_volume, ENGULF_TOLERANCE};',
        'use super::super::{CutterKind, VoidContext};',
        'use super::checks::{consolidated_change_is_measurable, result_volume_within_bounds};',
        'use super::cut::cut_prism;',
        'use super::detect::{opening_aabb_obb, try_merge_prisms};',
        'use super::extension::{extend_prism_caps, extend_profile_edges};',
        'use super::frame::{obb_overlaps, PrismFrame};',
        'use super::kit::{dot, V3};',
        'use super::opening_prism::prepare_prism;',
        'use super::ptri::{mesh_from_ptris, ptris_from_mesh, PTri};',
        'use super::{defer, finish, finish_cut_verdict, record_cut, tjunction_close};',
        'use crate::math::aabb::Aabb3;',
        'use crate::mesh::Mesh;',
        'use crate::mesh_check::{closed_enough_to_emit, ClosureVerdict};',
        'use crate::program::openings::execute::Execution;',
    ]},
}


def imports_of(module, stage):
    table = IMPORTS[module]
    keys = [k for k in table if STAGES.index(k) <= STAGES.index(stage)]
    return table[max(keys, key=STAGES.index)]
# Modules whose existing `pub(super)` items stay voids-wide.
VOIDS_WIDE = {'kit', 'driver'}
# How the facade imports each module (the facade's private globs are what
# opening_prism.rs, planar_correction.rs, prism_cut_tests.rs and
# aabb_fold_tests.rs reach through `use super::*` / `use super::{..}`).
# `driver` holds only an `impl Execution` block, so there is nothing to import.
# `decompose_tri` has no caller outside cut.rs, which imports it itself.
FACADE_USE = {'kit': 'pub(super) use kit::*;', 'decompose': None, 'driver': None}
# The final facade's docs gain a module map after base line 60 (stage c).
LAYOUT = [
    '//!',
    '//! Layout: `detect` (with `frame`, `profile`) finds the prism, `extension`',
    '//! pushes flush caps and edges, `cut` subtracts it (`face`, `decompose`,',
    '//! `pool`, `crossings`), `caps` and `cap_cdt` build the reveal, `checks`',
    '//! holds the self-checks and `driver` runs `try_prism_cut`. `kit`, `plane2`',
    '//! and `ptri` are the shared f64 vocabulary.',
]


def lines_of(path):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    assert text.endswith('\n')
    return text[:-1].split('\n')


def numbered_body(base, module):
    """(base line number, line) for every line of a module's ranges."""
    out = []
    for stage, name, ranges in RANGES:
        if name == module:
            for first, last in ranges:
                out.extend((n, base[n - 1]) for n in range(first, last + 1))
    return out


def body_of(base, module):
    return [line for _, line in numbered_body(base, module)]


# A rewritten line that the visibility prefix pushed past rustfmt's 100-column
# width is emitted in rustfmt's form (whitespace and a trailing comma only).
WRAP = {
    365: [
        'pub(super) fn partition_consistent(',
        '    host: &[PTri],',
        '    out: &[PTri],',
        '    inside: &[PTri],',
        '    bounds: &[(V3, V3)],',
        ') -> bool {',
    ],
}


def squash(text):
    return re.sub(r'\s+', '', text).replace(',)', ')')


ITEM = re.compile(r'^(fn|struct|enum|type|const) ')
FIELD = re.compile(r'^    (\w+): ')


def rewrite(module, body):
    """Apply the mechanical visibility and path rewrites to one module body."""
    out = []
    block = None  # 'struct' / 'impl' while inside a top-level block
    wide = 'pub(in crate::router::voids) '
    for line in body:
        if block is None:
            if line.startswith('pub(super) '):
                assert module in VOIDS_WIDE, (module, line)
                line = wide + line[len('pub(super) '):]
            elif ITEM.match(line):
                line = 'pub(super) ' + line
            if re.match(r'^(pub\(super\) )?struct \w+ \{$', line):
                block = 'struct'
            elif line.startswith('impl ') and line.endswith('{'):
                block = 'impl'
        elif line == '}':
            block = None
        elif block == 'struct' and FIELD.match(line):
            line = '    pub(super) ' + line[4:]
        elif block == 'impl':
            if line.startswith('    fn '):
                line = '    pub(super) ' + line[4:]
            elif line.startswith('    pub(super) fn '):
                assert module in VOIDS_WIDE, (module, line)
                line = '    ' + wide + line[len('    pub(super) '):]
        line = line.replace('super::geom::', 'super::super::geom::')
        out.append(line)
    return out


def preamble(module, stage):
    pre = list(HEADER) + ['']
    pre += ['//! ' + d if d else '//!' for d in DOCS[module]]
    imports = imports_of(module, stage)
    if imports:
        pre += [''] + imports
    return pre + ['']


def moved_pieces(base, module):
    """Per base range, the lines as emitted: rewritten, WRAP applied, and the
    module's final trailing blank line(s) dropped (a file ends at its `}`)."""
    nb = numbered_body(base, module)
    rewritten = dict(zip((n for n, _ in nb), rewrite(module, [l for _, l in nb])))
    pieces = []
    for st, name, ranges in RANGES:
        if name != module:
            continue
        for first, last in ranges:
            piece = []
            for n in range(first, last + 1):
                line = rewritten[n]
                if n in WRAP:
                    assert squash(''.join(WRAP[n])) == squash(line), n
                    piece.extend(WRAP[n])
                else:
                    piece.append(line)
            pieces.append((first, piece))
    last_piece = pieces[-1][1]
    while last_piece and last_piece[-1] == '':
        last_piece.pop()
    return pieces


def module_file(base, module, stage):
    out = preamble(module, stage)
    for _, piece in moved_pieces(base, module):
        out.extend(piece)
    return out


def modules_through(stage):
    return [name for st, name, _ in RANGES if STAGES.index(st) <= STAGES.index(stage)]


# Facade edits, all on base lines 1..233:
# * `/// IFC_LITE_PRISM_CUT=0 ...` (80-81) documents `enabled()` (98), not
#   `mod vertex_dedup;`; it moves onto `enabled()` unchanged;
# * FACADE_DROP[stage] lists base import lines the facade stops using at that
#   stage (cumulative: a later stage drops its own and every earlier entry).
FACADE_DROP = {
    'a': {70},  # cluster_prism_directions: detect.rs imports it itself
    'b': {72, 77},  # RAY_DIR (extension.rs), Point2 (profile.rs, pool.rs)
    'c': set(),
}


def dropped(stage):
    return set().union(*(FACADE_DROP[s] for s in STAGES[:STAGES.index(stage) + 1]))


def facade(base, stage):
    head = base[:233]
    doc = head[79:81]
    assert doc[0].startswith('/// `IFC_LITE_PRISM_CUT=0`'), doc
    assert head[97].startswith('pub(super) fn enabled()'), head[97]
    out = []
    for n, line in enumerate(head, start=1):
        if n in (80, 81) or n in dropped(stage):
            continue
        if n == 98:
            out.extend(doc)
        out.append(line)
        if n == 60 and stage == 'c':
            out.extend(LAYOUT)
    for name in modules_through(stage):
        out.append(f'mod {name};')
        use = FACADE_USE.get(name, f'use {name}::*;')
        if use:
            out.append(use)
    last = REGION[stage][1]
    if last < len(base):
        out.append('')
        out.extend(base[last:])
    return out


def check_tiling():
    for stage in STAGES:
        lo, hi = REGION[stage]
        covered = sorted(r for st, _, rs in RANGES if st == stage for r in rs)
        nxt = lo
        for first, last in covered:
            assert first == nxt, (stage, first, nxt)
            nxt = last + 1
        assert nxt == hi + 1, (stage, nxt, hi)


def git_show(rev, path):
    return subprocess.run(['git', 'show', f'{rev}:{path}'], check=True,
                          capture_output=True, text=True).stdout[:-1].split('\n')


VIS = re.compile(r'\bpub(\((crate|super|in [\w:]+)\))? ')


def norm(line):
    return VIS.sub('', line).replace('super::super::', 'super::')


def check(base, stage, rev):
    """Committed files equal the generated ones, and the generated moved lines
    equal the base lines after normalising visibility, paths and WRAP."""
    import difflib
    bad = 0
    # This stage's modules; an earlier stage's files were checked in their own
    # PR (and PR-1's math::v3 commit edits kit.rs after its move).
    for name in [n for st, n, _ in RANGES if st == stage]:
        have = git_show(rev, SUB + name + '.rs')
        want = module_file(base, name, stage)
        pre = preamble(name, stage)
        nb = numbered_body(base, name)
        rewritten = rewrite(name, [l for _, l in nb])
        changed = [(n, b, r) for (n, b), r in zip(nb, rewritten) if b != r]
        unmatched = [(n, b, r) for n, b, r in changed if norm(b) != norm(r)]
        wrapped = [n for n, _ in nb if n in WRAP]
        emitted = len(want) - len(pre)
        blank = len(nb) + sum(len(WRAP[n]) - 1 for n in wrapped) - emitted
        state = 'identical to generated' if have == want else 'DIFFERS from generated'
        print(f'{name}.rs: {len(have)} lines = {len(pre)} preamble + {emitted} moved; '
              f'{len(changed)} visibility/path rewrites, {len(unmatched)} unmatched after '
              f'normalising, wrapped {wrapped}, {blank} trailing blank dropped; {state}')
        for n, b, r in unmatched:
            bad += 1
            print(f'  base {n}: {b}\n  head: {r}')
        if have != want:
            bad += 1
            for d in difflib.unified_diff(want, have, 'generated', 'committed', lineterm='', n=1):
                print('  ' + d)
    print('facade:')
    want = facade(base, stage)
    have = git_show(rev, FACADE)
    if want != have:
        bad += 1
        for d in difflib.unified_diff(want, have, 'generated', 'committed', lineterm='', n=1):
            print('  ' + d)
    else:
        print(f'  {len(have)} lines, identical to the generated facade')
    return bad


def concat(base, stage, rev):
    """The concatenation check: the committed facade with every moved piece put
    back at its base position (each module's preamble before its first piece),
    normalised, diffed against the base file. Pieces come from the generator,
    which `--check` proves equal to the committed files. Expected: only added
    preamble and `mod` lines, the doc-comment move, FACADE_DROP lines, WRAP
    reflows and each file's dropped trailing blank line."""
    import difflib
    facade_lines = git_show(rev, FACADE)
    assert facade_lines == facade(base, stage), 'run --check first'
    last = REGION[stage][1]
    tail_len = len(base) - last
    head = facade_lines[:len(facade_lines) - tail_len - (1 if tail_len else 0)]
    tail = facade_lines[len(facade_lines) - tail_len:] if tail_len else []
    pieces = []
    for st, name, ranges in RANGES:
        if STAGES.index(st) > STAGES.index(stage):
            continue
        for i, (first, piece) in enumerate(moved_pieces(base, name)):
            pieces.append((first, (preamble(name, stage) if i == 0 else []) + piece))
    out = list(head)
    for _, lines in sorted(pieces, key=lambda x: x[0]):
        out.extend(lines)
    out.extend(tail)
    out = [norm(l) for l in out]
    ref = [norm(l) for l in base]
    diff = list(difflib.unified_diff(ref, out, 'base prism_cut.rs', 'facade+modules',
                                     lineterm='', n=0))
    for d in diff:
        print(d)
    added = sum(1 for d in diff if d.startswith('+') and not d.startswith('+++'))
    removed = sum(1 for d in diff if d.startswith('-') and not d.startswith('---'))
    print(f'concat: {len(out)} lines vs base {len(ref)}; +{added} -{removed}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base-file', required=True)
    ap.add_argument('--stage', choices=list(STAGES), required=True)
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--check', metavar='REV')
    ap.add_argument('--concat', metavar='REV')
    ap.add_argument('--root', default='.')
    args = ap.parse_args()
    check_tiling()
    base = lines_of(args.base_file)
    assert len(base) == 2921, len(base)
    if args.write:
        for st, name, _ in RANGES:
            path = f'{args.root}/{SUB}{name}.rs'
            if st == args.stage:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write('\n'.join(module_file(base, name, args.stage)) + '\n')
            elif STAGES.index(st) < STAGES.index(args.stage):
                # An earlier stage's file: repoint its imports only.
                prev = STAGES[STAGES.index(args.stage) - 1]
                old, new = imports_of(name, prev), imports_of(name, args.stage)
                if old != new:
                    text = open(path, encoding='utf-8').read()
                    old_block = '\n' + '\n'.join(old) + '\n'
                    assert text.count(old_block) == 1, (name, 'import block not found')
                    text = text.replace(old_block, '\n' + '\n'.join(new) + '\n')
                    with open(path, 'w', encoding='utf-8') as f:
                        f.write(text)
        with open(f'{args.root}/{FACADE}', 'w', encoding='utf-8') as f:
            f.write('\n'.join(facade(base, args.stage)) + '\n')
    if args.concat:
        concat(base, args.stage, args.concat)
    if args.check:
        sys.exit(1 if check(base, args.stage, args.check) else 0)


if __name__ == '__main__':
    main()
