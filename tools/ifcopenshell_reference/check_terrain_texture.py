#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Resolve a LandXML terrain's draped imagery from an exported .ifcZIP (#5942).

WHY. The LandXML -> IFC4X3 export carries draped imagery as an
IfcIndexedTriangleTextureMap on the terrain's IfcTriangulatedIrregularNetwork,
with the image as a sibling entry of the .ifcZIP (mapping spec §15.5).
ifc-lite reading its own output back proves only that writer and reader
agree. This script asks IfcOpenShell instead, and follows the texture the way
a consumer must:

  1. open the .ifcZIP with ifcopenshell (which unpacks it itself);
  2. find the IfcGeographicElement .TERRAIN. and its TIN;
  3. find the ONE IfcIndexedTriangleTextureMap whose MappedTo is that TIN, and
     the IfcSurfaceStyleWithTextures styling the TIN through an IfcStyledItem;
  4. resolve the IfcImageTexture's URLReference to an entry of the archive;
  5. take the TIN vertex at the given plan position, read its UV through
     TexCoordIndex (parallel to CoordIndex), and look up that pixel in the
     shipped image — it must be the expected pixel and colour.

Step 5 is the acceptance: the draped pixel and the TIN vertex coincide.

Exit 0 on success (prints a JSON summary), 1 on any failed check, 2 on bad
arguments, 3 when ifcopenshell cannot be imported.

Usage:
    python3 check_terrain_texture.py FILE.ifczip --feature E N \
        --expect-pixel COL ROW --expect-rgb R,G,B
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import zipfile
import zlib


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def decode_png(data: bytes) -> tuple[int, int, int, bytes]:
    """8-bit RGB/RGBA PNG -> (width, height, channels, unfiltered pixels)."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        fail("the shipped image is not a PNG")
    offset, idat, width = 8, b"", 0
    height = depth = colour = 0
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset:offset + 4])
        kind = data[offset + 4:offset + 8]
        body = data[offset + 8:offset + 8 + length]
        if kind == b"IHDR":
            width, height, depth, colour = struct.unpack(">IIBB", body[:10])
        elif kind == b"IDAT":
            idat += body
        offset += 12 + length
    if depth != 8 or colour not in (2, 6):
        fail(f"unsupported PNG (bit depth {depth}, colour type {colour})")
    channels = 4 if colour == 6 else 3
    stride = width * channels
    raw = zlib.decompress(idat)
    out = bytearray(height * stride)
    prev = bytearray(stride)
    for row in range(height):
        start = row * (stride + 1)
        kind = raw[start]
        line = bytearray(raw[start + 1:start + 1 + stride])
        for i in range(stride):
            left = line[i - channels] if i >= channels else 0
            up = prev[i]
            up_left = prev[i - channels] if i >= channels else 0
            if kind == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif kind == 4:
                p = left + up - up_left
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - up_left)
                pred = left if pa <= pb and pa <= pc else (up if pb <= pc else up_left)
                line[i] = (line[i] + pred) & 0xFF
        out[row * stride:(row + 1) * stride] = line
        prev = line
    return width, height, channels, bytes(out)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("--feature", nargs=2, type=float, required=True, metavar=("E", "N"))
    parser.add_argument("--expect-pixel", nargs=2, type=int, required=True, metavar=("COL", "ROW"))
    parser.add_argument("--expect-rgb", required=True)
    args = parser.parse_args(argv)
    try:
        import ifcopenshell
    except ImportError:
        print("ifcopenshell is not importable", file=sys.stderr)
        return 3

    model = ifcopenshell.open(args.archive)
    terrains = [e for e in model.by_type("IfcGeographicElement") if e.PredefinedType == "TERRAIN"]
    if len(terrains) != 1:
        fail(f"expected one TERRAIN element, found {len(terrains)}")
    body = [r for r in terrains[0].Representation.Representations if r.RepresentationIdentifier == "Body"]
    tins = [i for r in body for i in r.Items if i.is_a("IfcTriangulatedIrregularNetwork")]
    if len(tins) != 1:
        fail(f"expected one IfcTriangulatedIrregularNetwork in the terrain's Body, found {len(tins)}")
    tin = tins[0]

    maps = [m for m in model.by_type("IfcIndexedTriangleTextureMap") if m.MappedTo == tin]
    if len(maps) != 1:
        fail(f"expected one IfcIndexedTriangleTextureMap mapped to the TIN, found {len(maps)}")
    texture_map = maps[0]
    texture = texture_map.Maps[0]
    if not texture.is_a("IfcImageTexture"):
        fail(f"the map's texture is {texture.is_a()}, not IfcImageTexture")
    styled = [
        s for s in model.by_type("IfcStyledItem") if s.Item == tin
        and any(
            style.is_a("IfcSurfaceStyle") and any(
                element.is_a("IfcSurfaceStyleWithTextures") and texture in element.Textures
                for element in style.Styles
            )
            for style in s.Styles
        )
    ]
    if not styled:
        fail("no IfcStyledItem binds an IfcSurfaceStyleWithTextures carrying the texture to the TIN")

    with zipfile.ZipFile(args.archive) as archive:
        names = archive.namelist()
        if texture.URLReference not in names:
            fail(f"URLReference {texture.URLReference!r} is not an entry of the archive {names}")
        image = archive.read(texture.URLReference)
    width, height, channels, pixels = decode_png(image)

    coords = tin.Coordinates.CoordList
    east, north = args.feature
    distances = [math.hypot(x - east, y - north) for x, y, _ in coords]
    vertex = min(range(len(coords)), key=distances.__getitem__)
    if distances[vertex] > 1e-6:
        fail(f"no TIN vertex at the feature ({east}, {north}); nearest is {distances[vertex]} away")
    uv_rows = texture_map.TexCoords.TexCoordsList
    index = texture_map.TexCoordIndex or tin.CoordIndex
    if len(index) != len(tin.CoordIndex):
        fail("TexCoordIndex is not parallel to CoordIndex")
    corners = {
        tuple(uv_rows[index[t][k] - 1])
        for t, triangle in enumerate(tin.CoordIndex)
        for k in range(3)
        if triangle[k] - 1 == vertex
    }
    if len(corners) != 1:
        fail(f"the feature vertex has {len(corners)} different UVs: {sorted(corners)}")
    u, v = corners.pop()
    col, row = math.floor(u * width), math.floor((1 - v) * height)
    at = (row * width + col) * channels
    rgb = list(pixels[at:at + 3])
    expected_rgb = [int(c) for c in args.expect_rgb.split(",")]
    summary = {
        "archiveEntries": names, "urlReference": texture.URLReference, "repeatS": texture.RepeatS,
        "repeatT": texture.RepeatT, "image": [width, height], "featureVertex": vertex + 1, "uv": [u, v],
        "pixel": [col, row], "rgb": rgb,
    }
    print(json.dumps(summary))
    if [col, row] != args.expect_pixel:
        fail(f"the feature vertex drapes pixel {[col, row]}, expected {args.expect_pixel}")
    if rgb != expected_rgb:
        fail(f"the draped pixel is {rgb}, expected {expected_rgb}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
