#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""C2-8a (#8263): the kit functions replaced by `math::v3` are token-identical.

For each of V3, dot, sub, add, scale, cross and norm, compare the deleted
definition in base prism_cut.rs with the `math::v3` definition at REV, with
whitespace removed and the visibility keyword stripped. Both must carry
`#[inline]` (functions) and neither may use `mul_add`.

    python3 -I tests/evidence/c2-8a/v3_parity.py /tmp/base.rs HEAD
"""
import re
import subprocess
import sys

NAMES = ['dot', 'sub', 'add', 'scale', 'cross', 'norm']


def items(text):
    """name -> (attribute lines, signature+body) for top-level fns and V3."""
    out = {}
    lines = text.split('\n')
    for i, line in enumerate(lines):
        m = re.match(r'^(?:pub(?:\([^)]*\))? )?fn (\w+)\(', line)
        if m:
            j = i
            while lines[j] != '}':
                j += 1
            attrs = []
            k = i - 1
            while k >= 0 and lines[k].startswith('#['):
                attrs.append(lines[k])
                k -= 1
            out[m.group(1)] = (attrs, '\n'.join(lines[i:j + 1]))
        m = re.match(r'^(?:pub(?:\([^)]*\))? )?type V3 = (.*);$', line)
        if m:
            out['V3'] = ([], m.group(1))
    return out


def squash(code):
    code = re.sub(r'\bpub(\([^)]*\))? ', '', code)
    return re.sub(r'\s+', '', code)


def main():
    base_text = open(sys.argv[1], encoding='utf-8').read()
    v3_text = subprocess.run(['git', 'show', f'{sys.argv[2]}:rust/geometry/src/math/v3.rs'],
                             check=True, capture_output=True, text=True).stdout
    base, v3 = items(base_text), items(v3_text)
    bad = 0
    for name in ['V3'] + NAMES:
        (ba, bb), (va, vb) = base[name], v3[name]
        same = squash(bb) == squash(vb)
        inline = name == 'V3' or ('#[inline]' in ba and '#[inline]' in va)
        fma = 'mul_add' in bb or 'mul_add' in vb
        ok = same and inline and not fma
        bad += not ok
        print(f'{name:6} token-identical={same} inline-both={inline} mul_add={fma} -> '
              f'{"OK" if ok else "MISMATCH"}')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
