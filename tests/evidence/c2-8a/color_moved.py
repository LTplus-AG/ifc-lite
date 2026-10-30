#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""C2-8 (#8263): summarise `git diff --color-moved` for a move-only commit.

Runs `git diff -M --color-moved=plain --color-moved-ws=allow-indentation-change`
between two revisions over rust/geometry/src and prints every added or removed
line git did NOT colour as moved (plain mode colours a moved line with the
`color.diff.newMoved` / `oldMoved` slots, distinct from plain +/- colours).

    python3 -I tests/evidence/c2-8a/color_moved.py BASE HEAD
"""
import re
import subprocess
import sys

ANSI = re.compile(r'\x1b\[[0-9;]*m')


def main():
    a, b = sys.argv[1], sys.argv[2]
    cmd = ['git', '-c', 'color.diff.new=green', '-c', 'color.diff.old=red',
           '-c', 'color.diff.newMoved=cyan', '-c', 'color.diff.oldMoved=magenta',
           'diff', '-M', '--color=always', '--color-moved=plain',
           '--color-moved-ws=allow-indentation-change', a, b, '--', 'rust/geometry/src']
    out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    moved = {'+': 0, '-': 0}
    plain = {'+': [], '-': []}
    path = None
    for raw in out.split('\n'):
        text = ANSI.sub('', raw)
        if text.startswith('+++ ') or text.startswith('--- '):
            if text.startswith('+++ '):
                path = text[6:]
            continue
        if not text or text[0] not in '+-':
            continue
        sign = text[0]
        # cyan (36) / magenta (35) = moved; green (32) / red (31) = not moved.
        if '\x1b[36m' in raw or '\x1b[35m' in raw:
            moved[sign] += 1
        else:
            plain[sign].append(f'{path.split("/voids/")[-1]} | {text}')
    print(f'moved lines: +{moved["+"]} -{moved["-"]}; '
          f'not moved: +{len(plain["+"])} -{len(plain["-"])}')
    for sign in '-+':
        print(f'== not moved ({sign})')
        for line in plain[sign]:
            print(line)


if __name__ == '__main__':
    main()
