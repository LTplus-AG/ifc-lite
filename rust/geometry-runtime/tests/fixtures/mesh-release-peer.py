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
    elif opcode == 1:
        data = struct.pack('<Q', 1)
    elif opcode in (3, 9):
        data = struct.pack('<QQ', 1, 1 if opcode == 3 else 2)
    elif opcode == 10:
        counts = (1000000, 1, 1, 0, 0, 0) if Path(__file__).with_name('oversize').exists() else (3, 1, 1, 0, 0, 0)
        data = struct.pack('<IIIIII', *counts)
    elif opcode == 11:
        stream, offset, count = struct.unpack('<III', body[36:48])
        # #7955: valid oriented fixture corners keep the lifecycle fault reachable.
        # These synthetic streams certify no SDK geometry.
        streams = {1: [0., 0., 0., 1., 0., 0., 0., 1., 0.],
                   2: [0, 1, 2], 3: [0], 4: [0., 0., 1.] * 3}
        values = streams[stream][offset:offset + count]
        assert len(values) == count
        data = struct.pack("<" + ("d" if stream in (1, 4) else "I") * count, *values)
    elif opcode == 8:
        status, data = 4, b'injected release failure'
    else:
        raise AssertionError(opcode)
    response = struct.pack('<IIi', version, request, status) + data
    out.write(struct.pack('<I', len(response)) + response)
    out.flush()
