# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Generate `tiny.copc.laz`, the COPC unit-test fixture (#6869).

Written from the COPC 1.0 specification (https://copc.io), not from any
other implementation. Deterministic: a fixed-seed LCG drives every value,
so the same lazrs version writes the same bytes.

Usage (any venv with lazrs; laspy is only needed for --verify):

    uv venv /tmp/copc-venv && uv pip install --python /tmp/copc-venv/bin/python lazrs laspy
    /tmp/copc-venv/bin/python generate_tiny_copc.py tiny.copc.laz --verify

Layout the tests rely on (see tiny-copc.json, written alongside):
- LAS 1.4, PDRF 7 (XYZ + intensity + classification + gps time + RGB).
- Octree of depth 3 (levels 0..2) over a cube; each point lands in the
  shallowest level whose voxel grid cell (cell = spacing / 2^level) is
  still free, so coarse nodes are an even subsample of the whole cloud.
- The root hierarchy page holds level 0 plus one pointer entry
  (pointCount -1) per level-1 subtree; the CHILD PAGE it points at holds
  that level-1 node and its level-2 children, so the page walk is exercised.
- The large-coordinate offset (2.6e6, 1.2e6, 400) mirrors a projected CRS.
"""

import io
import json
import struct
import sys

import lazrs

SEED = 6869
POINT_COUNT = 1800
PDRF = 7
RECORD_LEN = 36
HEADER_SIZE = 375
SCALE = (0.001, 0.001, 0.001)
OFFSET = (2_600_000.0, 1_200_000.0, 400.0)
CENTER = (2_600_010.0, 1_200_010.0, 410.0)
HALFSIZE = 10.0
SPACING = HALFSIZE * 2 / 4  # 4 cells across the root
MAX_LEVEL = 2


class Lcg:
    """Numerical Recipes LCG: a stable seeded stream independent of numpy's RNG versions."""

    def __init__(self, seed):
        self.state = seed & 0xFFFFFFFF

    def next_u32(self):
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state

    def uniform(self):
        return self.next_u32() / 2**32


def make_points():
    rng = Lcg(SEED)
    pts = []
    for i in range(POINT_COUNT):
        # A floor slab plus two walls: planar structure, not a uniform blob.
        kind = i % 3
        u, v = rng.uniform() * 19.9, rng.uniform() * 19.9
        noise = (rng.uniform() - 0.5) * 0.02
        lo = CENTER[0] - HALFSIZE, CENTER[1] - HALFSIZE, CENTER[2] - HALFSIZE
        if kind == 0:
            x, y, z = lo[0] + u, lo[1] + v, lo[2] + 0.05 + noise
        elif kind == 1:
            x, y, z = lo[0] + 0.05 + noise, lo[1] + u, lo[2] + v
        else:
            x, y, z = lo[0] + u, lo[1] + 0.05 + noise, lo[2] + v
        cls = (2, 6, 6)[kind]
        rgb = (rng.next_u32() & 0xFF00, rng.next_u32() & 0xFF00, rng.next_u32() & 0xFF00)
        pts.append({
            "xyz": (x, y, z),
            "intensity": rng.next_u32() & 0xFFFF,
            "classification": cls,
            "gps": 1000.0 + i * 0.5,
            "rgb": rgb,
        })
    return pts


def encode_record(p):
    raw = [round((p["xyz"][a] - OFFSET[a]) / SCALE[a]) for a in range(3)]
    return struct.pack(
        "<iiiHBBBBhHdHHH",
        raw[0], raw[1], raw[2],
        p["intensity"],
        0x11,  # return number 1 of 1
        0x00,  # class flags / scanner channel / scan direction / edge
        p["classification"],
        0,     # user data
        0,     # scan angle
        1,     # point source id
        p["gps"],
        *p["rgb"],
    )


def quantized(p):
    return tuple(round((p["xyz"][a] - OFFSET[a]) / SCALE[a]) * SCALE[a] + OFFSET[a] for a in range(3))


def build_octree(points):
    """Assign each point to the shallowest free voxel cell. Returns {(d,x,y,z): [points]}."""
    nodes = {}
    occupied = set()
    lo = [CENTER[a] - HALFSIZE for a in range(3)]
    for p in points:
        q = quantized(p)
        for d in range(MAX_LEVEL + 1):
            node_side = 2 * HALFSIZE / 2**d
            key = tuple(min(2**d - 1, int((q[a] - lo[a]) // node_side)) for a in range(3))
            cell = SPACING / 2**d
            c = tuple(int((q[a] - lo[a]) // cell) for a in range(3))
            if d == MAX_LEVEL or (d, c) not in occupied:
                occupied.add((d, c))
                nodes.setdefault((d, *key), []).append(p)
                break
    return nodes


def vlr_header(user_id, record_id, length, description):
    return struct.pack("<H16sHH32s", 0, user_id.encode(), record_id, length, description.encode())


def evlr_header(user_id, record_id, length, description):
    return struct.pack("<H16sHQ32s", 0, user_id.encode(), record_id, length, description.encode())


def entry(key, offset, byte_size, point_count):
    return struct.pack("<iiiiQii", *key, offset, byte_size, point_count)


def generate(out_path):
    points = make_points()
    nodes = build_octree(points)
    # Parents before children in file order; a sorted key order is deterministic.
    order = sorted(nodes.keys())

    laz_vlr = lazrs.LazVlr.new_for_compression(PDRF, 0, True)
    laz_vlr_data = laz_vlr.record_data()
    copc_info_len = 160
    vlrs_len = 54 + copc_info_len + 54 + len(laz_vlr_data)
    point_offset = HEADER_SIZE + vlrs_len

    stream = io.BytesIO()
    stream.write(b"\0" * point_offset)
    compressor = lazrs.LasZipCompressor(stream, laz_vlr)
    chunk_records = []
    for key in order:
        recs = b"".join(encode_record(p) for p in nodes[key])
        chunk_records.append(recs)
    compressor.compress_chunks(chunk_records)
    compressor.done()
    stream.seek(point_offset)
    table_offset = struct.unpack("<q", stream.read(8))[0]
    stream.seek(point_offset)
    table = lazrs.read_chunk_table(stream, laz_vlr)

    node_spans = {}
    cursor = point_offset + 8
    for key, (count, nbytes) in zip(order, table):
        assert count == len(nodes[key]), (key, count)
        node_spans[key] = (cursor, nbytes, count)
        cursor += nbytes
    assert cursor == table_offset, (cursor, table_offset)

    # Hierarchy: the root page holds level 0 plus one pointer per level-1
    # subtree; each child page holds that level-1 node and its descendants.
    stream.seek(0, io.SEEK_END)
    evlr_start = stream.tell()
    page_entries = {}
    for key in order:
        d, x, y, z = key
        shift = d - 1
        page_owner = None if d == 0 else (1, x >> shift, y >> shift, z >> shift)
        page_entries.setdefault(page_owner, []).append(key)
    child_owners = sorted(k for k in page_entries if k is not None)
    root_size = 32 * (len(page_entries[None]) + len(child_owners))
    child_offsets = {}
    page_cursor = evlr_start + 60 + root_size
    for owner in child_owners:
        child_offsets[owner] = (page_cursor, 32 * len(page_entries[owner]))
        page_cursor += 32 * len(page_entries[owner])

    def page_bytes(owner):
        out = b""
        for key in page_entries[owner]:
            off, nbytes, count = node_spans[key]
            out += entry(key, off, nbytes, count)
        return out

    root = page_bytes(None)
    for owner in child_owners:
        off, size = child_offsets[owner]
        root += entry(owner, off, size, -1)
    hierarchy = root + b"".join(page_bytes(o) for o in child_owners)
    stream.write(evlr_header("copc", 1000, len(hierarchy), "EPT hierarchy"))
    stream.write(hierarchy)

    q = [quantized(p) for p in points]
    mins = [min(v[a] for v in q) for a in range(3)]
    maxs = [max(v[a] for v in q) for a in range(3)]
    gps = [p["gps"] for p in points]

    header = bytearray(HEADER_SIZE)
    struct.pack_into("<4sHH16sBB32s32sHHHIIBHI", header, 0,
                     b"LASF", 0, 0x10, b"\0" * 16, 1, 4,
                     b"ifc-lite tiny copc", b"generate_tiny_copc.py",
                     1, 2026, HEADER_SIZE, point_offset, 2,
                     PDRF | 0x80, RECORD_LEN, 0)
    struct.pack_into("<3d3d6d", header, 131, *SCALE, *OFFSET,
                     maxs[0], mins[0], maxs[1], mins[1], maxs[2], mins[2])
    struct.pack_into("<QQIQ", header, 227, 0, evlr_start, 1, len(points))
    struct.pack_into("<Q", header, 255, len(points))  # all first returns

    copc_info = struct.pack("<5dQQ2d11Q", *CENTER, HALFSIZE, SPACING,
                            evlr_start + 60, root_size, min(gps), max(gps), *([0] * 11))
    assert len(copc_info) == copc_info_len
    vlrs = (vlr_header("copc", 1, copc_info_len, "copc info") + copc_info
            + vlr_header("laszip encoded", 22204, len(laz_vlr_data), "lazrs variable chunks")
            + bytes(laz_vlr_data))
    stream.seek(0)
    stream.write(bytes(header))
    stream.write(vlrs)
    data = stream.getvalue()
    with open(out_path, "wb") as f:
        f.write(data)

    expected = {
        "pointCount": len(points),
        "pdrf": PDRF,
        "center": CENTER,
        "halfsize": HALFSIZE,
        "spacing": SPACING,
        "rootHierOffset": evlr_start + 60,
        "rootHierSize": root_size,
        "gpsTimeRange": [min(gps), max(gps)],
        "nodeCount": len(order),
        "childPageCount": len(child_owners),
        "nodes": {"-".join(map(str, k)): len(nodes[k]) for k in order},
        "classCounts": {str(c): sum(1 for p in points if p["classification"] == c) for c in (2, 6)},
        "bboxMin": mins,
        "bboxMax": maxs,
    }
    return data, expected


def verify(path, expected):
    import laspy

    with laspy.CopcReader.open(path) as reader:
        got = reader.query()
        assert len(got) == expected["pointCount"], (len(got), expected["pointCount"])
        root = reader.query(level=0)
        assert len(root) == expected["nodes"]["0-0-0-0"], (len(root), expected["nodes"]["0-0-0-0"])
    whole = laspy.read(path)
    assert len(whole.points) == expected["pointCount"]
    print(f"laspy CopcReader + LAZ reader agree: {len(got)} points")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "tiny.copc.laz"
    data, expected = generate(out)
    manifest = out.replace(".copc.laz", "-copc.json")
    with open(manifest, "w") as f:
        json.dump(expected, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"wrote {out}: {len(data)} bytes, {expected['nodeCount']} nodes, {expected['childPageCount']} child pages")
    if "--verify" in sys.argv:
        verify(out, expected)
