#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Lifetime-only fault peer. Never numerical SDK evidence.

Boxes and meshes release normally; releasing a committed sweep solid fails,
so a managed receipt's deferred cleanup failure is observable."""
import struct
import sys

inp, out = sys.stdin.buffer, sys.stdout.buffer
slot = 0
sweeps = set()


def handle():
    global slot
    slot += 1
    return slot, struct.pack('<QII', 1, slot, 1)


while True:
    header = inp.read(4)
    if not header:
        break
    body = inp.read(struct.unpack('<I', header)[0])
    version, request, opcode = struct.unpack('<III', body[:12])
    status, data = 0, b''
    if opcode == 0:
        data = struct.pack('<I', 1)
    elif opcode == 1:
        data = struct.pack('<Q', 1)
    elif opcode == 12:
        data = struct.pack('<II', 1, 1 | 2 | 8)
    elif opcode in (3, 9):
        _, data = handle()
    elif opcode == 6:
        data = struct.pack('<d', 1.0)
    elif opcode == 10:
        data = struct.pack('<IIIIII', 3, 1, 1, 0, 0, 0)
    elif opcode == 11:
        stream, offset, count = struct.unpack('<III', body[36:48])
        data = bytes(count * (8 if stream in (1, 4) else 4))
    elif opcode == 13:
        data = struct.pack('<Q', 7)
    elif opcode == 14:
        pass
    elif opcode == 15:
        committed, data = handle()
        sweeps.add(committed)
    elif opcode == 8:
        released = struct.unpack('<I', body[28:32])[0]
        if released in sweeps:
            status, data = 4, b'injected object release failure'
    else:
        raise AssertionError(opcode)
    response = struct.pack('<IIi', version, request, status) + data
    out.write(struct.pack('<I', len(response)) + response)
    out.flush()
