#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Admission-only peer: advertises staged sweeps but exits on any upload.
Its replies are never geometry evidence."""
import struct
import sys

inp, out = sys.stdin.buffer, sys.stdout.buffer
while True:
    header = inp.read(4)
    if not header:
        break
    body = inp.read(struct.unpack('<I', header)[0])
    version, request, opcode = struct.unpack('<III', body[:12])
    if opcode == 0:
        data = struct.pack('<I', 1)
    elif opcode == 1:
        data = struct.pack('<Q', 1)
    elif opcode == 12:
        data = struct.pack('<II', 1, 1 | 2 | 8)
    else:
        # Any upload (opcode 13+) means a gate let the request through.
        raise AssertionError(opcode)
    response = struct.pack('<IIi', version, request, 0) + data
    out.write(struct.pack('<I', len(response)) + response)
    out.flush()
