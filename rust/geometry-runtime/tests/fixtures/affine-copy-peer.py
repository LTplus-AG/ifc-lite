#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Affine-copy fault peer: serves one rectangle sweep, then answers opcode 18
as configured by the adjacent `mode` file. Never numerical SDK evidence."""
from pathlib import Path
import struct
import sys

mode = Path(__file__).with_name('mode').read_text().strip()
inp, out = sys.stdin.buffer, sys.stdout.buffer
slot = 0


def handle():
    global slot
    slot += 1
    return struct.pack('<QII', 1, slot, 1)


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
        data = struct.pack('<II', 1, 1 | 2 | 8 | (0 if mode == 'unavailable' else 16) | 32)
    elif opcode in (3, 9, 15):
        data = handle()
    elif opcode == 10:
        data = struct.pack('<IIIIII', 3, 1, 1, 0, 0, 0)
    elif opcode == 11:
        stream, offset, count = struct.unpack('<III', body[36:48])
        data = bytes(count * (8 if stream in (1, 4) else 4))
    elif opcode == 13:
        data = struct.pack('<Q', 7)
    elif opcode in (8, 14):
        pass
    elif opcode == 18 and mode == 'taint':
        status, data = 8, b'affine copy conversion/transform: injected'
    elif opcode == 18 and mode == 'refuse':
        status, data = 7, b'affine surface class has no exact rational conversion certificate'
    elif opcode == 18 and mode == 'short':
        data = handle()
    else:
        raise AssertionError(opcode)
    response = struct.pack('<IIi', version, request, status) + data
    out.write(struct.pack('<I', len(response)) + response)
    out.flush()
