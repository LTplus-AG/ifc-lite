#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Lifetime-only fault peer. Never numerical SDK evidence."""
import struct
import sys

inp, out = sys.stdin.buffer, sys.stdout.buffer
slot = 0
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
    elif opcode == 3:
        slot += 1
        data = struct.pack('<QQ', 1, slot)
    elif opcode == 8:
        status, data = 4, b'injected object release failure'
    else:
        raise AssertionError(opcode)
    response = struct.pack('<IIi', version, request, status) + data
    out.write(struct.pack('<I', len(response)) + response)
    out.flush()
