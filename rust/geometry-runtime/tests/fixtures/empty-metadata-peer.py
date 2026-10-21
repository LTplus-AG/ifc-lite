#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Fault peer only: tests refusal, never qualifies SDK semantic emptiness."""
from pathlib import Path
import json
import struct
import sys

config = json.loads(Path(__file__).with_name('metadata.json').read_text())
source, sink = sys.stdin.buffer, sys.stdout.buffer
while True:
    header = source.read(4)
    if not header:
        break
    body = source.read(struct.unpack('<I', header)[0])
    version, request, opcode = struct.unpack('<III', body[:12])
    if opcode == 0:
        data = struct.pack('<I', 1)
    elif opcode == 1:
        data = struct.pack('<Q', 1)
    elif opcode == 12:
        data = struct.pack('<II', 1, config['capabilities'])
    elif opcode == 19:
        data = struct.pack('<I', config['query'])
    elif opcode in (3, 9):
        data = struct.pack('<QII', 1, opcode, 1)
    elif opcode == 10:
        data = struct.pack('<IIIIII', *config['info'])
    elif opcode == 8:
        data = b''
    else:
        raise AssertionError(opcode)
    response = struct.pack('<III', version, request, 0) + data
    sink.write(struct.pack('<I', len(response)) + response)
    sink.flush()
