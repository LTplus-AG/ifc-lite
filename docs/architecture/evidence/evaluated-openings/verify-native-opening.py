# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Verify the actual #4404 native plan with pinned independent geometry.

Usage: python verify-native-opening.py original.ifc exported.ifc native-plan.json output.json
The Reference interoperability defect is reported, never hidden by a default-reader equivalence claim.
"""
from pathlib import Path
import collections
import json
import sys
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.validate
import ifcopenshell.util.placement
import ifcopenshell.util.unit
import numpy as np

original_path, exported_path, plan_path, output_path = map(Path, sys.argv[1:])
assert ifcopenshell.version == '0.8.2', ifcopenshell.version
original, exported = ifcopenshell.open(original_path), ifcopenshell.open(exported_path)
plan = json.loads(plan_path.read_text())
conversion, = plan['conversions']
product = conversion['productId']
# JSON emits the shortest f32 roundtrip strings; reconstruct those f32 values
# before promoting to double, exactly as the viewer's Float32Array does.
source_points = np.asarray(conversion['sourcePositions'],dtype=np.float32).astype(np.float64).reshape(-1,3) + conversion['sourceOrigin'] + np.asarray(conversion['rtcOffset'])
source_faces = np.asarray(conversion['sourceIndices'], dtype=np.int64).reshape(-1,3)

def read_mesh(file, disable_openings=False):
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.DISABLE_OPENING_SUBTRACTIONS, disable_openings)
    owner = ifcopenshell.geom.create_shape(settings, file.by_id(product))
    return np.asarray(owner.geometry.verts).reshape(-1,3).copy(), np.asarray(owner.geometry.faces, dtype=np.int64).reshape(-1,3).copy()

def volume(mesh):
    vertices, faces = mesh
    # Translate to a small frame before the scalar triple product.
    triangles = vertices[faces] - vertices.mean(axis=0)
    return float(abs(np.einsum('ij,ij->i', triangles[:,0],np.cross(triangles[:,1],triangles[:,2])).sum()/6))

def samples(mesh):
    vertices, faces = mesh
    triangles = vertices[faces]
    return np.concatenate([vertices, triangles.mean(axis=1), (triangles[:,0]+triangles[:,1])/2,
                           (triangles[:,1]+triangles[:,2])/2, (triangles[:,2]+triangles[:,0])/2])

def distance(points, mesh):
    vertices, faces = mesh
    if len(points)>10000 or len(faces)>10000: raise ValueError('bounded acceptance probe exceeded sample/face limit')
    triangle = vertices[faces]
    a,b,c = triangle[:,0], triangle[:,1], triangle[:,2]
    u,v = b-a,c-a
    normal = np.cross(u,v)
    normal2 = np.einsum('ij,ij->i',normal,normal)
    assert np.all(normal2>0), 'independent mesh has degenerate triangles'
    result=[]
    for point in points:
        w=point-a
        plane=np.einsum('ij,ij->i',w,normal)/normal2
        projected=w-plane[:,None]*normal
        uu=np.einsum('ij,ij->i',u,u);vv=np.einsum('ij,ij->i',v,v);uv=np.einsum('ij,ij->i',u,v)
        wu=np.einsum('ij,ij->i',projected,u);wv=np.einsum('ij,ij->i',projected,v)
        denominator=uu*vv-uv*uv
        x=(vv*wu-uv*wv)/denominator;y=(uu*wv-uv*wu)/denominator
        inside=(x>=0)&(y>=0)&(x+y<=1)
        squared=np.where(inside,plane*plane*normal2,np.inf)
        for start,end in [(a,b),(b,c),(c,a)]:
            edge=end-start
            t=np.clip(np.einsum('ij,ij->i',point-start,edge)/np.einsum('ij,ij->i',edge,edge),0,1)
            residual=point-(start+t[:,None]*edge)
            squared=np.minimum(squared,np.einsum('ij,ij->i',residual,residual))
        result.append(float(np.sqrt(squared.min())))
    return max(result,default=0.)

def compare(a,b):
    return {'aToBSampledSurfaceDistanceMetres':distance(samples(a),b),
            'bToASampledSurfaceDistanceMetres':distance(samples(b),a),
            'aVolumeCubicMetres':volume(a),'bVolumeCubicMetres':volume(b),
            'volumeDifferenceCubicMetres':abs(volume(a)-volume(b))}

def findings(file):
    logger=ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(file,logger,express_rules=True)
    return collections.Counter((entry['instance'].id(),entry.get('attribute'),entry['message'].split('\n\nViolated by:')[0])
                               for entry in logger.statements)

canonical=(source_points,source_faces)
reader_original=read_mesh(original)
reader_default=read_mesh(exported)
# This setting matches the proven Reference semantics for this one host only.
# It is an oracle workaround, not an instruction to disable ordinary openings.
reader_reference=read_mesh(exported,True)
actual=compare(canonical,reader_reference)
item=exported.by_id(conversion['geometryItemId'])
local=np.asarray(item.Coordinates.CoordList)
placement=ifcopenshell.util.placement.get_local_placement(exported.by_id(product).ObjectPlacement)
raw_points=(np.column_stack([local,np.ones(len(local))])@placement.T)[:,:3]*ifcopenshell.util.unit.calculate_unit_scale(exported)
raw=(raw_points,np.asarray(item.CoordIndex,dtype=np.int64)-1)
old_findings,new_findings=findings(original),findings(exported)
assert not new_findings-old_findings,list((new_findings-old_findings).elements())
changed=sorted(entity.id() for entity in original if str(entity)!=str(exported.by_id(entity.id())))
assert changed==sorted(set(edit['expressId'] for edit in plan['edits'])),changed
assert original.by_id(product).GlobalId==exported.by_id(product).GlobalId
report={'reader':'IfcOpenShell','version':ifcopenshell.version,'product':product,
        'canonicalNativeVsExportedReference':actual,
        'canonicalNativeVsAuthoredRawTfs':compare(canonical,raw),
        'originalReaderVsCanonicalNative':compare(reader_original,canonical),
        'exportedDefaultReader':{'triangles':len(reader_default[1]),'volumeCubicMetres':volume(reader_default)},
        'exportedReferenceSemanticsReader':{'triangles':len(reader_reference[1]),'volumeCubicMetres':volume(reader_reference)},
        'changedExistingEntities':changed,'sourceSchemaFindings':sum(old_findings.values()),
        'exportSchemaFindings':sum(new_findings.values()),'newSchemaFindings':[],
        'surfaceSampling':'Bidirectional exact point-to-triangle distances for all vertices, triangle centroids and edge midpoints; this is a sampled surface comparison, not a full Hausdorff proof.',
        'referenceCaveat':'Default IfcOpenShell 0.8.2 incorrectly subtracts Reference openings; default-reader roundtrip equivalence is not claimed.'}
# The serialized double coordinates should preserve the native physical surface;
# this bound is standard double-operation roundoff at this bounded model scale.
magnitude=max(1.,float(np.abs(source_points).max()))
roundoff=128*np.finfo(float).eps*magnitude
assert actual['aToBSampledSurfaceDistanceMetres']<=roundoff,actual
assert actual['bToASampledSurfaceDistanceMetres']<=roundoff,actual
Path(output_path).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
