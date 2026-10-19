#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Malformed protocol/lifetime fixtures only. No actual SDK geometry evidence."""
from pathlib import Path
import struct
import sys

root = Path(__file__).parent
case = (root / 'case').read_text().strip()
source, sink = sys.stdin.buffer, sys.stdout.buffer
slot = 0
clip_seen = False

def handle():
    global slot
    slot += 1
    return struct.pack('<QII', 42, slot, 1)


def corrupt_clip(body):
    # A structural template is immediately corrupted before crossing the seam.
    # Even the mesh-failure case only tests cleanup, not numerical success.
    output = handle()
    data = bytearray(312)
    data[:16] = output
    data[32:48] = body[20:36]
    data[48:64] = output
    for offset, value in [(16, 1), (20, 1), (24, 1), (64, 1), (68, 2), (72, 6), (76, 12), (80, 64)]:
        struct.pack_into('<I', data, offset, value)
    data[84:132] = body[36:84]
    for offset, values in [(132, [1, 0, 0, 0, 1, 0, 0, 0, 1]),
                           (204, [-1, -1, 0, 1, 1, 1]), (252, [-2, -2, 0, 2, 2, 2])]:
        struct.pack_into('<' + 'd' * len(values), data, offset, *values)
    struct.pack_into('<d', data, 300, 1e-6)
    if case == 'short':
        data.pop()
    elif case == 'trailing':
        data.append(0)
    elif case == 'input-generation':
        struct.pack_into('<I', data, 44, 99)
    elif case == 'output-generation':
        struct.pack_into('<I', data, 12, 0)
        struct.pack_into('<I', data, 60, 0)
    elif case == 'alias':
        data[:16] = body[20:36]
        data[48:64] = body[20:36]
    elif case == 'plane':
        struct.pack_into('<d', data, 84, -0.)
    elif case == 'frame':
        struct.pack_into('<I', data, 24, 2)
    elif case == 'normal':
        struct.pack_into('<d', data, 196, -1.)
    elif case == 'cylinders':
        struct.pack_into('<I', data, 308, 17)
    elif case == 'empty':
        struct.pack_into('<I', data, 28, 1)
    else:
        assert case == 'mesh-refusal' or case.startswith('postclip-'), case
    return data


while True:
    header = source.read(4)
    if not header:
        break
    body = source.read(struct.unpack('<I', header)[0])
    version, request, opcode = struct.unpack('<III', body[:12])
    data, status = b'', 0
    with (root / 'commands').open('a') as log:
        log.write(str(opcode) + '\n')
    if clip_seen and case.startswith('postclip-') and opcode == int(case.split('-')[1]):
        status, data = 9, f'fixture unknown status9 after clip opcode{opcode}'.encode()
    elif opcode == 0:
        data = struct.pack('<I', 1)
    elif opcode in (1, 13):
        data = struct.pack('<Q', 42)
    elif opcode == 12:
        data = struct.pack('<II', 1, 113)
    elif opcode == 14:
        pass
    elif opcode in (9, 15):
        if opcode == 9 and clip_seen and case == 'mesh-refusal':
            status, data = 7, b'fixture mesh refusal after clip publication'
        else:
            data = handle()
    elif opcode == 19:
        data = struct.pack('<I', 0)
    elif opcode == 10:
        data = struct.pack('<6I', 4, 4, 4, 0, 0, 0)
    elif opcode == 11:
        stream, _, count = struct.unpack('<III', body[36:48])
        data = bytes(count * (8 if stream in (1, 4) else 4))
    elif opcode == 8:
        with (root / 'released').open('a') as log:
            log.write(str(struct.unpack('<I', body[28:32])[0]) + '\n')
    elif opcode == 20:
        assert len(body) == 92
        clip_seen = True
        if case.startswith('status'):
            status, data = int(case[6:]), b'fixture clip refusal'
        else:
            data = corrupt_clip(body)
    else:
        raise AssertionError(opcode)
    response = struct.pack('<IIi', version, request, status) + data
    sink.write(struct.pack('<I', len(response)) + response)
    sink.flush()
