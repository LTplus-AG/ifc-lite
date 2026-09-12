# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Reopen a face-masked #4404 export with independent IfcOpenShell.

Usage: python verify-mask-export.py original.ifc exported.(ifc|ifczip) product-id output.json [expected-edited-ids]

Works from the exported file alone (no native plan needed), so it covers the
browser export as well as a node-produced one: the product's Body must be one
Tessellation wrapper holding a textured and a retained IfcTriangulatedFaceSet
over one shared point list; the textured set carries the image and the UV map,
the retained set keeps a style entity of the source; the union of their corners
reproduces IfcOpenShell's own tessellation of the original product; siblings
sharing the product's type tessellate identically; no schema finding is new;
only the listed existing entities changed; an IFCZIP carries the referenced image.
"""
from pathlib import Path
import collections
import hashlib
import json
import sys
import tempfile
import zipfile
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.validate
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np

original_path, exported_path, product_arg, output_path = map(Path, sys.argv[1:5])
product = int(str(product_arg))
expected_edits = sorted(int(v) for v in sys.argv[5].split(',')) if len(sys.argv) > 5 and sys.argv[5] else None

resources = []
if exported_path.suffix.lower() == '.ifczip':
    archive = zipfile.ZipFile(exported_path)
    names = archive.namelist()
    model_name, = [name for name in names if name.lower().endswith(('.ifc', '.ifcxml'))]
    resources = [name for name in names if name != model_name]
    temp = Path(tempfile.mkdtemp()) / 'model.ifc'
    temp.write_bytes(archive.read(model_name))
    exported_model_path = temp
else:
    exported_model_path = exported_path
original, exported = ifcopenshell.open(original_path), ifcopenshell.open(exported_model_path)

def findings(file):
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(file, logger, express_rules=True)
    return collections.Counter((entry['instance'].id(), entry.get('attribute'), entry['message'].split('\n\nViolated by:')[0])
                               for entry in logger.statements)

def canonical(entity):
    raw = bytearray()
    for char in str(entity):
        code = ord(char)
        if 0xFF80 <= code <= 0xFFFF: raw.append(code - 0xFF00)
        else: raw.extend(char.encode('utf-8'))
    return raw.decode('utf-8', errors='replace')

old_findings, new_findings = findings(original), findings(exported)
assert not new_findings - old_findings, list((new_findings - old_findings).elements())
changed = sorted(entity.id() for entity in original if canonical(entity) != canonical(exported.by_id(entity.id())))
if expected_edits is not None:
    assert changed == expected_edits, changed
owner = exported.by_id(product)
assert original.by_id(product).GlobalId == owner.GlobalId

bodies = [rep for rep in owner.Representation.Representations if rep.RepresentationIdentifier == 'Body']
assert len(bodies) == 1 and bodies[0].RepresentationType == 'Tessellation', [(b.RepresentationType, len(b.Items)) for b in bodies]
assert len(bodies[0].Items) == 2, len(bodies[0].Items)
textured, retained = bodies[0].Items
assert textured.is_a('IfcTriangulatedFaceSet') and retained.is_a('IfcTriangulatedFaceSet')
assert textured.Coordinates == retained.Coordinates, 'both face sets share one point list'

def style_of(item, file):
    styled = [inverse for inverse in file.get_inverse(item) if inverse.is_a('IfcStyledItem')]
    assert len(styled) == 1, (item.id(), styled)
    surface = [style for style in styled[0].Styles if style.is_a('IfcSurfaceStyle')]
    assert len(surface) == 1
    return surface[0]

textured_style, retained_style = style_of(textured, exported), style_of(retained, exported)
textures = [element for element in textured_style.Styles if element.is_a('IfcSurfaceStyleWithTextures')]
assert len(textures) == 1, 'masked face set carries the image'
assert not any(element.is_a('IfcSurfaceStyleWithTextures') for element in retained_style.Styles)
assert original.by_id(retained_style.id()).is_a('IfcSurfaceStyle'), 'retained face set keeps a source style entity'
image_urls = [texture.URLReference for texture in textures[0].Textures if texture.is_a('IfcImageTexture')]
assert image_urls, 'the textured style references an image texture'
if resources:
    for url in image_urls:
        assert any(name.endswith(url) for name in resources), (url, resources)
uv_maps = [inverse for inverse in exported.get_inverse(textured) if inverse.is_a('IfcIndexedTriangleTextureMap')]
assert len(uv_maps) == 1 and len(uv_maps[0].TexCoordIndex) == len(textured.CoordIndex)
assert not [inverse for inverse in exported.get_inverse(retained) if inverse.is_a('IfcIndexedTriangleTextureMap')]

settings = ifcopenshell.geom.settings()
settings.set(settings.USE_WORLD_COORDS, True)

def tessellation(file, entity_id):
    shape = ifcopenshell.geom.create_shape(settings, file.by_id(entity_id))
    return np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3), np.asarray(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)

def point_triangle_distance(point, a, b, c):
    # Ericson, Real-Time Collision Detection 5.1.5: closest point on a triangle.
    ab, ac, ap = b - a, c - a, point - a
    d1, d2 = ab @ ap, ac @ ap
    if d1 <= 0 and d2 <= 0: return np.linalg.norm(ap)
    bp = point - b
    d3, d4 = ab @ bp, ac @ bp
    if d3 >= 0 and d4 <= d3: return np.linalg.norm(bp)
    vc = d1 * d4 - d3 * d2
    if vc <= 0 and d1 >= 0 and d3 <= 0: return np.linalg.norm(ap - ab * (d1 / (d1 - d3)))
    cp = point - c
    d5, d6 = ab @ cp, ac @ cp
    if d6 >= 0 and d5 <= d6: return np.linalg.norm(cp)
    vb = d5 * d2 - d1 * d6
    if vb <= 0 and d2 >= 0 and d6 <= 0: return np.linalg.norm(ap - ac * (d2 / (d2 - d6)))
    va = d3 * d6 - d5 * d4
    if va <= 0 and (d4 - d3) >= 0 and (d5 - d6) >= 0:
        w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        return np.linalg.norm(point - (b + (c - b) * w))
    denominator = 1.0 / (va + vb + vc)
    return np.linalg.norm(point - (a + ab * (vb * denominator) + ac * (vc * denominator)))

def surface_distance(points, vertices, faces):
    triangles = vertices[faces]
    return float(max(min(point_triangle_distance(point, *triangle) for triangle in triangles) for point in points))

def area(vertices, faces):
    triangles = vertices[faces]
    return float(np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1).sum() / 2)

# The authored face sets, read straight from the file through the product's
# placement, must describe the same surface as IfcOpenShell's own tessellation
# of the original product: every vertex of either lies on the other surface
# (the kernels may triangulate a cut face differently, so vertex sets are not
# compared) and the areas agree. One millimetre is the documented precision of
# the planner's cut corners.
placement = ifcopenshell.util.placement.get_local_placement(owner.ObjectPlacement)
scale = ifcopenshell.util.unit.calculate_unit_scale(exported)
local = np.asarray(textured.Coordinates.CoordList, dtype=np.float64)
authored_vertices = (np.column_stack([local, np.ones(len(local))]) @ placement.T)[:, :3] * scale
authored_faces = np.concatenate([np.asarray(textured.CoordIndex, dtype=np.int64), np.asarray(retained.CoordIndex, dtype=np.int64)]) - 1
before_vertices, before_faces = tessellation(original, product)
distance_authored = surface_distance(authored_vertices[np.unique(authored_faces)], before_vertices, before_faces)
distance_before = surface_distance(before_vertices, authored_vertices, authored_faces)
assert distance_authored < 1e-3 and distance_before < 1e-3, (distance_authored, distance_before)
area_before, area_authored = area(before_vertices, before_faces), area(authored_vertices, authored_faces)
assert abs(area_authored - area_before) <= 1e-5 * max(1.0, area_before), (area_before, area_authored)
# IfcOpenShell's own reopening of the exported face sets is reported, not
# asserted equal: OpenCASCADE sews and may re-triangulate a face set whose
# faces carry holes (observed on the cut slab), while planar quads reopen 1:1.
after_vertices, after_faces = tessellation(exported, product)
distance_reader = surface_distance(after_vertices, before_vertices, before_faces)
assert distance_reader < 1e-3, distance_reader

def geometry_digest(file, entity_id):
    vertices, faces = tessellation(file, entity_id)
    return hashlib.sha256(vertices.tobytes() + faces.tobytes()).hexdigest()

kind = original.by_id(product).is_a()
siblings = [entity.id() for entity in original.by_type(kind) if entity.id() != product and entity.Representation]
unchanged = [sibling for sibling in siblings if geometry_digest(original, sibling) == geometry_digest(exported, sibling)]
assert unchanged == siblings, sorted(set(siblings) - set(unchanged))
report = {'reader': 'IfcOpenShell', 'version': ifcopenshell.version, 'export': exported_path.name, 'product': product, 'ifcClass': kind,
          'GlobalId': owner.GlobalId, 'changedExistingEntities': changed,
          'texturedFaceSet': {'id': textured.id(), 'triangles': len(textured.CoordIndex), 'style': textured_style.id(), 'images': image_urls},
          'retainedFaceSet': {'id': retained.id(), 'triangles': len(retained.CoordIndex), 'style': retained_style.id(), 'sourceStyle': True},
          'archiveResources': resources,
          'authoredTriangles': int(len(authored_faces)), 'readerTrianglesOriginal': int(len(before_faces)), 'readerTrianglesExported': int(len(after_faces)),
          'maxSurfaceDistanceMetres': {'authoredVerticesToOriginalSurface': distance_authored, 'originalVerticesToAuthoredSurface': distance_before,
                                       'readerExportVerticesToOriginalSurface': distance_reader},
          'surfaceAreaSquareMetres': {'originalReader': area_before, 'authored': area_authored, 'exportedReader': area(after_vertices, after_faces)},
          'siblings': {'ifcClass': kind, 'count': len(siblings), 'unchanged': len(unchanged),
                       'comparison': 'IfcOpenShell world tessellation digest (vertices and faces) equal before and after'},
          'sourceSchemaFindings': sum(old_findings.values()), 'exportSchemaFindings': sum(new_findings.values()), 'newSchemaFindings': [],
          'note': "Authored face sets versus IfcOpenShell's tessellation of the original: vertex-to-surface distances and areas, sampled at the vertices, not a Hausdorff proof. The reader's own re-tessellation of the export is reported for reference."}
Path(output_path).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
