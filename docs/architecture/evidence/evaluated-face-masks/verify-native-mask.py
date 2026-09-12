# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Reopen the real face-masked #4404 native plan with independent IfcOpenShell.

Usage: python verify-native-mask.py original.ifc exported.ifc native-mask-plan.json output.json
The masked face set must carry the image, the retained face set must keep the
source style, and their union must reproduce the canonical source corners.
"""
from pathlib import Path
import collections
import hashlib
import json
import sys
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.validate
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np

original_path, exported_path, plan_path, output_path = map(Path, sys.argv[1:])
original, exported = ifcopenshell.open(original_path), ifcopenshell.open(exported_path)
plan = json.loads(plan_path.read_text())
conversion, = plan['conversions']
product = conversion['productId']
masked = conversion['maskedTriangles']
# JSON emits the shortest f32 roundtrip strings; reconstruct those f32 values
# before promoting to double, exactly as the viewer's Float32Array does.
source_points = np.asarray(conversion['sourcePositions'], dtype=np.float32).astype(np.float64).reshape(-1, 3) \
    + conversion['sourceOrigin'] + np.asarray(conversion['rtcOffset'])
source_faces = np.asarray(conversion['sourceIndices'], dtype=np.int64).reshape(-1, 3)
source_corners = source_points[source_faces]

def findings(file):
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(file, logger, express_rules=True)
    return collections.Counter((entry['instance'].id(), entry.get('attribute'), entry['message'].split('\n\nViolated by:')[0])
                               for entry in logger.statements)

def canonical(entity):
    # The native test writer emits raw UTF-8 where the source used \X2\ escapes.
    # IfcOpenShell surfaces each un-escaped byte as U+FF00 + byte; recover the
    # text before comparing. Numeric and reference content is compared verbatim.
    raw = bytearray()
    for char in str(entity):
        code = ord(char)
        if 0xFF80 <= code <= 0xFFFF: raw.append(code - 0xFF00)
        else: raw.extend(char.encode('utf-8'))
    return raw.decode('utf-8', errors='replace')

old_findings, new_findings = findings(original), findings(exported)
assert not new_findings - old_findings, list((new_findings - old_findings).elements())
changed = sorted(entity.id() for entity in original if canonical(entity) != canonical(exported.by_id(entity.id())))
assert changed == sorted(set(edit['expressId'] for edit in plan['edits'])), changed
assert original.by_id(product).GlobalId == exported.by_id(product).GlobalId

owner = exported.by_id(product)
bodies = [rep for rep in owner.Representation.Representations if rep.RepresentationIdentifier == 'Body']
assert len(bodies) == 1 and bodies[0].RepresentationType == 'Tessellation'
textured, retained = bodies[0].Items
assert textured.id() == conversion['geometryItemId'] and retained.id() == conversion['retainedGeometryItemId']
assert textured.is_a('IfcTriangulatedFaceSet') and retained.is_a('IfcTriangulatedFaceSet')
assert textured.Coordinates == retained.Coordinates, 'both face sets share one point list'
placement = ifcopenshell.util.placement.get_local_placement(owner.ObjectPlacement)
scale = ifcopenshell.util.unit.calculate_unit_scale(exported)
local = np.asarray(textured.Coordinates.CoordList)
world = (np.column_stack([local, np.ones(len(local))]) @ placement.T)[:, :3] * scale

def authored_corners(item):
    return world[np.asarray(item.CoordIndex, dtype=np.int64) - 1]

def style_of(item):
    styled = [inverse for inverse in exported.get_inverse(item) if inverse.is_a('IfcStyledItem')]
    assert len(styled) == 1, (item.id(), styled)
    surface = [style for style in styled[0].Styles if style.is_a('IfcSurfaceStyle')]
    assert len(surface) == 1
    return surface[0]

textured_style, retained_style = style_of(textured), style_of(retained)
assert any(element.is_a('IfcSurfaceStyleWithTextures') for element in textured_style.Styles), 'masked face set carries the image'
assert not any(element.is_a('IfcSurfaceStyleWithTextures') for element in retained_style.Styles)
# The source style may sit behind the schema's single IfcPresentationStyleAssignment
# wrapper, which the planner flattens while keeping the surface style definition.
source_styles = {leaf.id() for item in original.by_id(conversion['sourceGeometryItemId']).StyledByItem for style in item.Styles
                 for leaf in (style.Styles if style.is_a('IfcPresentationStyleAssignment') else [style])}
assert retained_style.id() in source_styles, 'retained face set keeps the original source style entity'
uv_maps = [inverse for inverse in exported.get_inverse(textured) if inverse.is_a('IfcIndexedTriangleTextureMap')]
assert len(uv_maps) == 1 and len(uv_maps[0].TexCoordIndex) == len(textured.CoordIndex)
assert not [inverse for inverse in exported.get_inverse(retained) if inverse.is_a('IfcIndexedTriangleTextureMap')]

mask = np.zeros(len(source_faces), dtype=bool)
mask[masked] = True
magnitude = max(1., float(np.abs(source_points).max()))
roundoff = 128 * np.finfo(float).eps * magnitude
textured_error = float(np.abs(authored_corners(textured) - source_corners[mask]).max())
retained_error = float(np.abs(authored_corners(retained) - source_corners[~mask]).max())
assert textured_error <= roundoff and retained_error <= roundoff, (textured_error, retained_error)

settings = ifcopenshell.geom.settings()
settings.set(settings.USE_WORLD_COORDS, True)
shape = ifcopenshell.geom.create_shape(settings, owner)
reader_vertices = np.asarray(shape.geometry.verts).reshape(-1, 3)
reader_faces = np.asarray(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)
assert len(reader_faces) == len(source_faces)
reader_corner_distance = float(max(np.linalg.norm(reader_vertices - corner, axis=1).min() for corner in source_corners.reshape(-1, 3)))
assert reader_corner_distance < 1e-6, reader_corner_distance
def geometry_digest(file, entity_id):
    # Independent world tessellation of one product; equal digests mean equal
    # vertex and face arrays, not merely an unchanged entity id.
    shape = ifcopenshell.geom.create_shape(settings, file.by_id(entity_id))
    vertices = np.asarray(shape.geometry.verts, dtype=np.float64)
    faces = np.asarray(shape.geometry.faces, dtype=np.int64)
    return hashlib.sha256(vertices.tobytes() + faces.tobytes()).hexdigest()

siblings = [member.id() for member in original.by_type('IfcMember') if member.id() != product]
unchanged_siblings = [sibling for sibling in siblings if geometry_digest(original, sibling) == geometry_digest(exported, sibling)]
assert unchanged_siblings == siblings, sorted(set(siblings) - set(unchanged_siblings))
report = {'reader': 'IfcOpenShell', 'version': ifcopenshell.version, 'product': product, 'GlobalId': owner.GlobalId,
          'maskedTriangles': masked, 'surfaceFingerprint': conversion['surfaceFingerprint'],
          'texturedFaceSet': {'id': textured.id(), 'triangles': len(textured.CoordIndex), 'style': textured_style.id(),
                              'maxAuthoredCornerErrorMetres': textured_error},
          'retainedFaceSet': {'id': retained.id(), 'triangles': len(retained.CoordIndex), 'style': retained_style.id(),
                              'sourceStyle': True, 'maxAuthoredCornerErrorMetres': retained_error},
          'readerTriangles': int(len(reader_faces)), 'maxReaderCornerDistanceMetres': reader_corner_distance,
          'changedExistingEntities': changed, 'siblingMembers': len(siblings), 'unchangedSiblingMembers': len(unchanged_siblings),
          'siblingComparison': 'IfcOpenShell world tessellation digest (vertices and faces) equal before and after',
          'sourceSchemaFindings': sum(old_findings.values()), 'exportSchemaFindings': sum(new_findings.values()),
          'newSchemaFindings': [],
          'note': 'Sampled corner comparison against the canonical native source snapshot; not a Hausdorff proof and not a browser claim.'}
Path(output_path).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
