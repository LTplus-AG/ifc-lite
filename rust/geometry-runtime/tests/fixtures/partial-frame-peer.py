#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Immutable transport fault peer; no geometry behavior is fabricated."""
import os
from pathlib import Path
import struct
import sys
import time

# Preserve the invoked symlink path: each test's markers belong beside its
# symlink, rather than beside this shared immutable executable fixture.
marker = Path(__file__).with_name("started")
if marker.exists():
    real = os.environ.get("IFCLITE_SMLIB_WORKER")
    if real is not None:
        os.execv(real, [real])
    sys.exit(0)
marker.write_text(str(os.getpid()))
inp, out = sys.stdin.buffer, sys.stdout.buffer
for operation in (0, 1):
    size = struct.unpack("<I", inp.read(4))[0]
    body = inp.read(size)
    version, request, opcode = struct.unpack("<III", body[:12])
    assert opcode == operation
    data = struct.pack("<I", 1) if operation == 0 else struct.pack("<Q", 1)
    response = struct.pack("<IIi", version, request, 0) + data
    out.write(struct.pack("<I", len(response)) + response)
    out.flush()

# A synthetic opaque token establishes transport affinity only. Tests never
# assert a geometry result from this peer or admit its geometry into a document.
size = struct.unpack("<I", inp.read(4))[0]
body = inp.read(size)
version, request, opcode = struct.unpack("<III", body[:12])
assert opcode == 3
response = struct.pack("<IIiQQ", version, request, 0, 1, 1)
out.write(struct.pack("<I", len(response)) + response)
out.flush()

size = struct.unpack("<I", inp.read(4))[0]
inp.read(size)
out.write(struct.pack("<I", 28) + b"partial")
out.flush()
marker.with_name("blocked").write_text("partial frame sent")
while True:
    time.sleep(60)
