#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Immutable cleanup fault peer. Its data is never geometry evidence."""
from pathlib import Path
import struct
import sys
import os

marker = Path(__file__).with_name('started')
if marker.exists() and os.environ.get('IFCLITE_SMLIB_WORKER'):
    real = os.environ['IFCLITE_SMLIB_WORKER']
    os.execv(real, [real])
marker.write_text(str(os.getpid()))
inp, out = sys.stdin.buffer, sys.stdout.buffer
while True:
    header = inp.read(4)
    if not header:
        break
    body = inp.read(struct.unpack('<I', header)[0])
    version, request, opcode = struct.unpack('<III', body[:12])
    status, data = 0, b''
    if opcode == 0:
        data = struct.pack('<I', 1)
    elif opcode == 12:
        data = struct.pack('<II', 1, 32)
    elif opcode == 19:
        data = struct.pack('<I', 0)
    elif opcode == 1:
        data = struct.pack('<Q', 1)
    elif opcode in (3, 9):
        data = struct.pack('<QQ', 1, 1 if opcode == 3 else 2)
    elif opcode == 10:
        vertices = 1000000 if Path(__file__).with_name('oversize').exists() else 1
        data = struct.pack('<IIIIII', vertices, 1, 1, 0, 0, 0)
    elif opcode == 11:
        stream, offset, count = struct.unpack('<III', body[36:48])
        data = bytes(count * (8 if stream in (1, 4) else 4))
    elif opcode == 8:
        status, data = 4, b'injected release failure'
    else:
        raise AssertionError(opcode)
    response = struct.pack('<IIi', version, request, status) + data
    out.write(struct.pack('<I', len(response)) + response)
    out.flush()
