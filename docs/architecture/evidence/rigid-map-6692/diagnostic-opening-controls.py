# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Independent source opening controls; requires ifcopenshell==0.8.2."""
import json
import math
import sys
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom

HOST_IDS = [135923, 200207, 147941, 201198, 148007, 201979, 202696]


def subtract(a, b):
    return [x - y for x, y in zip(a, b)]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]


def metrics(product, disable_openings):
    settings = ifcopenshell.geom.settings()
    settings.set(settings.DISABLE_OPENING_SUBTRACTIONS, disable_openings)
    # Retain the owner: taking .geometry from a temporary frees its buffers.
    owner = ifcopenshell.geom.create_shape(settings, product)
    geometry = owner.geometry
    points = list(zip(*[iter(geometry.verts)] * 3))
    triangles = list(zip(*[iter(geometry.faces)] * 3))
    assert points and triangles, (product.id(), disable_openings)
    anchor = points[0]
    area = volume = 0
    for ia, ib, ic in triangles:
        a, b, c = points[ia], points[ib], points[ic]
        normal = cross(subtract(b, a), subtract(c, a))
        area += math.sqrt(sum(value * value for value in normal)) / 2
        normal = cross(subtract(b, anchor), subtract(c, anchor))
        volume += sum(x * y for x, y in zip(subtract(a, anchor), normal)) / 6
    return {"openingSubtractionDisabled": disable_openings,
            "triangles": len(triangles), "areaSquareMetres": area,
            "signedTriangleVolumeCubicMetres": volume}


fixture = (Path(sys.argv[1]) if len(sys.argv) > 1 else
           Path(__file__).resolve().parents[4] /
           "tests/models/georeferencer/MiniBIM-3.1-DO_01_VORM.ifc")
if ifcopenshell.version != "0.8.2":
    raise SystemExit("This recorded oracle requires ifcopenshell==0.8.2.")
model = ifcopenshell.open(str(fixture))
reports = []
for express_id in HOST_IDS:
    product = model.by_id(express_id)
    items = [item for representation in product.Representation.Representations
             if representation.RepresentationIdentifier == "Body"
             for item in representation.Items]
    reports.append({
        "ExpressId": express_id,
        "bodyItems": [item.is_a() for item in items],
        "polygonalFacesWithVoids": sum(
            sum(face.is_a("IfcIndexedPolygonalFaceWithVoids") for face in item.Faces)
            for item in items if item.is_a("IfcPolygonalFaceSet")),
        "profileInnerLoops": sum(
            len(item.SweptArea.InnerCurves) for item in items
            if item.is_a("IfcExtrudedAreaSolid") and
            item.SweptArea.is_a("IfcArbitraryProfileDefWithVoids")),
        "variants": [metrics(product, False), metrics(product, True)],
    })
print(json.dumps({"version": ifcopenshell.version, "hosts": reports}, indent=2))
