# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Offline CC BY 4.0 CRAS transfer target (#4381). The published model is IFC2X3
# with swept-solid walls and 1.33 M entities of manufacturer window/door
# geometry; the F4 transfer target policy takes direct IfcTriangulatedFaceSet
# bodies (evaluated occurrences are F6, #4404) and the planner bounds its target
# at 200,000 entities. This writes what an IFC4 Reference View export would:
# every wall and slab as a world-coordinate tessellated body (openings applied
# by the independent IfcOpenShell tessellation), GlobalIds and names unchanged,
# one neutral surface style per element so unknown regions keep a visible
# prior appearance. Requires IfcOpenShell.
# Usage: python cras-tessellated-target.py SOURCE_IFC2X3.ifc OUTPUT_IFC4.ifc REPORT.json
import sys, json, hashlib, pathlib, time
import numpy as np
import ifcopenshell, ifcopenshell.geom

src_path, out_path, report_path = map(pathlib.Path, sys.argv[1:4])
t0 = time.time()
src = ifcopenshell.open(src_path)
settings = ifcopenshell.geom.settings(); settings.set(settings.USE_WORLD_COORDS, True)
shapes = []
out = ifcopenshell.file(schema='IFC4')
project = out.createIfcProject(src.by_type('IfcProject')[0].GlobalId, None, src.by_type('IfcProject')[0].Name)
units = out.createIfcUnitAssignment([out.createIfcSIUnit(None, 'LENGTHUNIT', None, 'METRE')])
project.UnitsInContext = units
origin = out.createIfcAxis2Placement3D(out.createIfcCartesianPoint((0., 0., 0.)), None, None)
context = out.createIfcGeometricRepresentationContext(None, 'Model', 3, 1.0e-5, origin, None)
project.RepresentationContexts = [context]
site = out.createIfcSite(src.by_type('IfcSite')[0].GlobalId, None, src.by_type('IfcSite')[0].Name, None, None, out.createIfcLocalPlacement(None, origin))
building = out.createIfcBuilding(src.by_type('IfcBuilding')[0].GlobalId, None, src.by_type('IfcBuilding')[0].Name, None, None, out.createIfcLocalPlacement(site.ObjectPlacement, origin))
out.createIfcRelAggregates(ifcopenshell.guid.new(), None, None, None, project, [site])
out.createIfcRelAggregates(ifcopenshell.guid.new(), None, None, None, site, [building])
storeys = {}
for s in src.by_type('IfcBuildingStorey'):
    storeys[s.id()] = out.createIfcBuildingStorey(s.GlobalId, None, s.Name, None, None, out.createIfcLocalPlacement(building.ObjectPlacement, origin), None, None, 'ELEMENT', s.Elevation)
out.createIfcRelAggregates(ifcopenshell.guid.new(), None, None, None, building, list(storeys.values()))
style = out.createIfcSurfaceStyle('CRAS derivative default', 'BOTH', [out.createIfcSurfaceStyleRendering(out.createIfcColourRgb(None, 0.85, 0.84, 0.80), 0., None, None, None, None, None, None, 'NOTDEFINED')])
contained = {sid: [] for sid in storeys}
elements = []
for element in list(src.by_type('IfcWall')) + list(src.by_type('IfcSlab')):
    try:
        shape = ifcopenshell.geom.create_shape(settings, element)
    except RuntimeError as error:
        elements.append({'globalId': element.GlobalId, 'type': element.is_a(), 'name': element.Name, 'status': f'no geometry: {error}'}); continue
    shapes.append(shape)
    verts = np.array(shape.geometry.verts).reshape(-1, 3); faces = np.array(shape.geometry.faces).reshape(-1, 3)
    if not len(faces):
        elements.append({'globalId': element.GlobalId, 'type': element.is_a(), 'name': element.Name, 'status': 'empty tessellation'}); continue
    unique, inverse = np.unique(verts.round(9), axis=0, return_inverse=True)
    points = out.createIfcCartesianPointList3D([tuple(float(v) for v in p) for p in unique])
    coord_index = [tuple(int(inverse[i]) + 1 for i in tri) for tri in faces]
    tfs = out.createIfcTriangulatedFaceSet(points, None, False, coord_index, None)
    out.createIfcStyledItem(tfs, [style], None)
    body = out.createIfcShapeRepresentation(context, 'Body', 'Tessellation', [tfs])
    placement = out.createIfcLocalPlacement(building.ObjectPlacement, origin)
    kind = 'IfcWall' if element.is_a('IfcWall') else 'IfcSlab'
    created = out.create_entity(kind, GlobalId=element.GlobalId, Name=element.Name, ObjectPlacement=placement, Representation=out.createIfcProductDefinitionShape(None, None, [body]))
    storey = next((r.RelatingStructure for r in element.ContainedInStructure), None)
    if storey is not None and storey.id() in storeys: contained[storey.id()].append(created)
    elements.append({'globalId': element.GlobalId, 'type': element.is_a(), 'name': element.Name, 'status': 'ok', 'vertices': int(len(unique)), 'triangles': int(len(faces)),
                     'openings': len(element.HasOpenings), 'bbox': [unique.min(0).round(4).tolist(), unique.max(0).round(4).tolist()], 'expressId': created.id()})
for sid, items in contained.items():
    if items: out.createIfcRelContainedInSpatialStructure(ifcopenshell.guid.new(), None, None, None, items, storeys[sid])
out.write(str(out_path))
check = ifcopenshell.open(out_path)
report = {
    'source': {'file': src_path.name, 'schema': src.schema, 'sha256': hashlib.sha256(src_path.read_bytes()).hexdigest(), 'entities': len(list(src))},
    'derived': {'file': out_path.name, 'schema': check.schema, 'sha256': hashlib.sha256(out_path.read_bytes()).hexdigest(), 'entities': len(list(check)), 'bytes': out_path.stat().st_size,
                'walls': len(check.by_type('IfcWall')), 'slabs': len(check.by_type('IfcSlab'))},
    'method': 'IfcOpenShell world-coordinate tessellation with openings applied; one IfcTriangulatedFaceSet body per element under an identity placement; GlobalIds and names preserved; no property sets, materials or fillings',
    'ifcopenshell': ifcopenshell.version, 'seconds': round(time.time() - t0, 1), 'elements': elements,
}
report_path.write_text(json.dumps(report, indent=1) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'elements'}, indent=1), 'ok elements', sum(1 for e in elements if e['status'] == 'ok'), 'of', len(elements))
