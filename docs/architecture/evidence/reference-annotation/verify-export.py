# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Independent IFC reader oracle for a browser-exported reference annotation.

Requires ifcopenshell and numpy. Run with an IFCZIP, its browser reference
snapshot, an annotation Name, and output JSON. Never produces or repairs IFC.
"""
import argparse
import hashlib
import json
import zipfile
from pathlib import PurePosixPath

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import ifcopenshell.validate
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('archive')
parser.add_argument('snapshot')
parser.add_argument('name')
parser.add_argument('output')
parser.add_argument('--reference-index', type=int, default=0)
args = parser.parse_args()
reference = json.load(open(args.snapshot))['references'][args.reference_index]
with zipfile.ZipFile(args.archive) as archive:
    entries = [name for name in archive.namelist() if name.lower().endswith('.ifc')]
    assert len(entries) == 1, 'Expected one IFC entry'
    document = ifcopenshell.file.from_string(archive.read(entries[0]).decode())
    annotations = [a for a in document.by_type('IfcAnnotation') if a.Name == args.name]
    assert len(annotations) == 1, 'Expected one named annotation'
    annotation = annotations[0]
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(document, logger, express_rules=True)
    assert not logger.statements, logger.statements
    item = annotation.Representation.Representations[0].Items[0]
    maps = [mapping for mapping in document.by_type('IfcIndexedTriangleTextureMap') if mapping.MappedTo == item]
    assert len(maps) == 1 and len(maps[0].Maps) == 1
    mapping = maps[0]
    image = mapping.Maps[0]
    path = str(PurePosixPath(entries[0]).parent / image.URLReference)
    digest = hashlib.sha256(archive.read(path)).hexdigest()
    assert digest == reference['assetId'], 'Original encoded image changed'
    transform = ifcopenshell.util.placement.get_local_placement(annotation.ObjectPlacement)
    scale = ifcopenshell.util.unit.calculate_unit_scale(document)
    expected = dict(zip([(0., 1.), (1., 1.), (1., 0.), (0., 0.)], reference['cornersIfcWorld']))
    maximum = 0.
    corners = []
    for face, uv_face in zip(item.CoordIndex, mapping.TexCoordIndex):
        for position_id, uv_id in zip(face, uv_face):
            point = np.array([*item.Coordinates.CoordList[position_id - 1], 1.])
            world = (transform @ point)[:3] * scale
            uv = tuple(mapping.TexCoords.TexCoordsList[uv_id - 1])
            error = float(np.max(np.abs(world - expected[uv])))
            maximum = max(maximum, error)
            corners.append(world.tolist())
    assert maximum < 1e-6, maximum
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    shape = ifcopenshell.geom.create_shape(settings, annotation)
    vertices = np.array(shape.geometry.verts).reshape((-1, 3))
    for corner in corners:
        assert float(np.min(np.linalg.norm(vertices - corner, axis=1))) < 1e-6
    output = dict(reader='IfcOpenShell', readerVersion=ifcopenshell.version, schema=document.schema,
                  annotationName=annotation.Name, GlobalId=annotation.GlobalId, expressId=annotation.id(),
                  schemaValidationErrors=len(logger.statements), textureSHA256=digest,
                  maxCornerErrorMetres=maximum, toleranceMetres=1e-6,
                  referenceCornersIfcWorld=reference['cornersIfcWorld'],
                  shapeTriangles=len(shape.geometry.faces) // 3,
                  archiveSHA256=hashlib.sha256(open(args.archive, 'rb').read()).hexdigest())
    with open(args.output, 'w') as file:
        json.dump(output, file, indent=2)
        file.write('\n')
    print(json.dumps(output))
