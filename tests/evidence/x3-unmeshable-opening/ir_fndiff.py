#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""X3 (#8385): per-function self-Ir diff of one callgrind dump, base vs head.

Usage: ir_fndiff.py <base callgrind.out.N> <head callgrind.out.N>

Feed it the geometry-phase dump (`callgrind.out.9` from `instructions.sh
--keep`, as ir_interleaved.sh keeps for round 1). It runs callgrind_annotate
--inclusive=no on both, drops call-tree lines, strips tree/binary path
prefixes so base and head functions share keys, and prints the largest
deltas plus any function present on only one side with >= 0.01% of the phase.
"""
import glob, os, re, subprocess, sys

annotate = 'callgrind_annotate'
for d in glob.glob(os.path.expanduser('~/build-workers/toolchains/valgrind-*/bin')):
    if os.path.exists(os.path.join(d, 'callgrind_annotate')):
        annotate = os.path.join(d, 'callgrind_annotate')


def load(path):
    text = subprocess.run([annotate, '--inclusive=no', '--threshold=100', path],
                          capture_output=True, text=True, check=True).stdout
    total, fns = 0, {}
    for line in text.splitlines():
        m = re.match(r'\s*([\d,]+) \([^)]*\)\s+(.*)$', line)
        if not m:
            continue
        ir, key = int(m.group(1).replace(',', '')), m.group(2)
        if key.startswith('=>') or key.startswith('<') or key.startswith('*'):
            continue  # call-tree lines; only self-cost function lines count
        if key == 'PROGRAM TOTALS':
            total = ir
            continue
        key = re.sub(r' \[[^\]]*\]$', '', key)
        key = re.sub(r' \(\d[\d,]*x\)$', '', key)
        key = re.sub(r'^.*?/base-src/', '', key)
        key = re.sub(r'^/.*?/((?:rust|library)/)', r'\1', key)
        key = re.sub(r'^/.*?/(index\.crates\.io-[0-9a-f]+/)', r'\1', key)
        fns[key] = fns.get(key, 0) + ir
    return total, fns


bt, b = load(sys.argv[1])
ht, h = load(sys.argv[2])
print(f'X3_FNDIFF totals base={bt} head={ht} delta={ht - bt} ratio={ht / bt:.6f}')
deltas = sorted(((h.get(k, 0) - b.get(k, 0), k) for k in set(b) | set(h)), key=lambda x: -abs(x[0]))
for d, k in deltas[:25]:
    print(f'X3_FNDIFF {d:+15,d} base={b.get(k, 0):>15,d} head={h.get(k, 0):>15,d} {k[:140]}')
floor = bt * 0.0001
only_head = [(h[k], k) for k in h if k not in b and h[k] >= floor]
only_base = [(b[k], k) for k in b if k not in h and b[k] >= floor]
print(f'X3_FNDIFF_ONLY_HEAD count={len(only_head)} (>=0.01% of phase)')
for ir, k in sorted(only_head, reverse=True)[:15]:
    print(f'X3_FNDIFF_ONLY_HEAD {ir:,d} {k[:140]}')
print(f'X3_FNDIFF_ONLY_BASE count={len(only_base)}')
for ir, k in sorted(only_base, reverse=True)[:15]:
    print(f'X3_FNDIFF_ONLY_BASE {ir:,d} {k[:140]}')
