# SPDX-License-Identifier: MPL-2.0
"""exercise real subprocess framing and geometry; no mock kernel."""
import struct
import subprocess
import sys

worker = sys.argv[1]

def request(op, payload=b"", request_id=1):
    body = struct.pack("<III", 1, request_id, op) + payload
    return struct.pack("<I", len(body)) + body


def read_exact(pipe, count):
    result = b""
    while len(result) < count:
        part = pipe.read(count - len(result))
        if not part:
            raise AssertionError("worker response truncated")
        result += part
    return result


with subprocess.Popen([worker], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                      stderr=subprocess.PIPE) as process:
    def call(op, payload=b"", request_id=1):
        process.stdin.write(request(op, payload, request_id))
        process.stdin.flush()
        size, = struct.unpack("<I", read_exact(process.stdout, 4))
        assert 12 <= size <= 4096
        body = read_exact(process.stdout, size)
        version, echoed_id, status = struct.unpack("<IIi", body[:12])
        assert version == 1 and echoed_id == request_id
        return status, body[12:]

    assert call(0) == (0, struct.pack("<I", 1))
    status, session = call(1)
    assert status == 0 and len(session) == 8
    status, solid = call(3, session + struct.pack("<6d", 0, 0, 0, 2, 3, 4))
    assert status == 0 and len(solid) == 16
    status, value = call(6, session + solid + struct.pack("<d", 1e-8), 1234)
    assert status == 0 and abs(struct.unpack("<d", value)[0] - 24) < 1e-6
    matrix = (0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1)
    status, moved = call(17, session + solid + struct.pack("<16d", *matrix))
    assert status == 0 and len(moved) == 16 and moved != solid
    for handle in (moved, solid):
        status, value = call(6, session + handle + struct.pack("<d", 1e-8))
        assert status == 0 and abs(struct.unpack("<d", value)[0] - 24) < 1e-6
    assert call(8, session + moved)[0] == 0
    reflected = (-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
    assert call(17, session + solid + struct.pack("<16d", *reflected))[0] == 1
    # Opcode 18 is independent of unchanged rigid opcode 17 and returns the
    # conversion certificate of the real adapter after the new handle.
    affine = (-2, 0, 0, 0, 0.4, 3, 0, 0, 0.2, 0.3, 4, 0, 7, -4, 2, 1)
    status, copied = call(18, session + solid + struct.pack("<16d", *affine))
    assert status == 0 and len(copied) == 72
    handle, certificate = copied[:16], copied[16:]
    version, representation, *classes = struct.unpack("<14I", certificate)
    assert version == representation == 1 and classes[1] == 12 and classes[7] == 6
    status, value = call(6, session + handle + struct.pack("<d", 1e-8))
    assert status == 0 and abs(struct.unpack("<d", value)[0] - 24*24) < 24*24*1e-5
    assert call(8, session + handle)[0] == 0
    singular = (1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)
    status, refused = call(18, session + solid + struct.pack("<16d", *singular))
    assert status == 1 and refused
    status, value = call(6, session + solid + struct.pack("<d", 1e-8))
    assert status == 0 and abs(struct.unpack("<d", value)[0] - 24) < 1e-6
    status, error = call(6, session + solid + struct.pack("<d", 1e-12))
    assert status == 1 and b"tolerance" in error
    status, mesh = call(9, session + solid + struct.pack("<dd", 0.001, 5))
    assert status == 0 and len(mesh) == 16
    status, info = call(10, session + mesh)
    vertices, triangles, faces, boundary, spine, failed = struct.unpack("<6I", info)
    assert status == 0 and vertices and triangles and faces == 6
    assert boundary == spine == failed == 0
    # Opcode 19 classifies the actual solid; a mesh handle is no solid.
    status, caps = call(12)
    assert status == 0 and struct.unpack("<II", caps)[0] == 1 and struct.unpack("<II", caps)[1] & 32
    assert call(19, session + solid) == (0, struct.pack("<I", 0))
    assert call(19, session + mesh)[0] == 3
    status, empty = call(5, session + solid + solid + struct.pack("<I", 3))
    assert status == 0 and call(19, session + empty) == (0, struct.pack("<I", 1))
    status, empty_mesh = call(9, session + empty + struct.pack("<dd", 0.001, 5))
    assert status == 0 and call(10, session + empty_mesh) == (0, bytes(24))
    assert call(8, session + empty_mesh) == (0, b"") and call(8, session + empty) == (0, b"")
    assert call(19, session + empty)[0] == 3
    status, positions = call(11, session + mesh + struct.pack("<3I", 1, 0, vertices*3))
    assert status == 0 and len(positions) == vertices*3*8
    status, error = call(11, session + mesh + struct.pack("<3I", 1, 0, 481))
    assert status == 1 and error
    assert call(8, session + solid) == (0, b"")
    status, error = call(8, session + solid)
    assert status == 3 and b"handle" in error
    assert call(10, session + mesh) == (0, info)
    assert call(8, session + mesh) == (0, b"")
    assert call(2, session) == (0, b"")
    process.stdin.close()
    assert process.wait(timeout=10) == 0
    assert process.stdout.read() == b""

malformed = [
    b"\x01",  # truncated prefix
    struct.pack("<I", 4097),  # oversized before allocation
    struct.pack("<I", 12) + b"short",  # truncated payload
    struct.pack("<IIII", 12, 2, 1, 0),  # unsupported version
    request(0, b"extra"),  # unexpected trailing fields
    request(99, struct.pack("<Q", 1)),  # unknown opcode
]
for frame in malformed:
    result = subprocess.run([worker], input=frame, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=10)
    assert result.returncode == 1 and result.stdout == b"" and result.stderr
print("SMLib worker framing and real geometry passed")
