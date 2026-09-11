# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Read-only oracle for the original three controlled curved PDF pages."""
from pathlib import Path
import hashlib, json, sys
import fitz, ifcopenshell, ifcopenshell.geom
import numpy as np
from PIL import Image
root, source = Path(sys.argv[1]), Path(sys.argv[2])
pdf = fitz.open(source)
reports = []

def distances(points, edges):
    best = np.full(len(points), np.inf)
    for a, b in edges:
        v = b-a
        n = np.dot(v,v)
        t = np.zeros(len(points)) if n == 0 else np.clip((points-a)@v/n,0,1)
        best = np.minimum(best, np.linalg.norm(points-a-t[:,None]*v,axis=1))
    return best

def inside(points, ring):
    mask = np.zeros(len(points),bool)
    for a,b in zip(ring,np.roll(ring,-1,axis=0)):
        if a[1] == b[1]: continue
        mask ^= ((a[1]>points[:,1]) != (b[1]>points[:,1])) & (points[:,0] < (b[0]-a[0])*(points[:,1]-a[1])/(b[1]-a[1])+a[0])
    return mask

for number in (1,2,3):
    payload=json.loads((root/f'page-{number}.json').read_text())
    request,plan=payload['request'],payload['result']
    page=pdf[number-1]
    drawings=page.get_drawings()
    assert len(drawings)==1 and drawings[0]['type']=='f'
    drawing=drawings[0]
    rings=[]; ring=[]; previous=None; reference_error=0.
    for item in drawing['items']:
        assert item[0]=='c', 'Control oracle intentionally requires cubic PDF paths'
        c=np.array([[p.x,p.y] for p in item[1:]])
        if previous is not None and not np.array_equal(previous,c[0]):
            rings.append(np.array(ring));ring=[]
        t=np.linspace(0,1,257)[:,None];s=1-t
        curve=s**3*c[0]+3*s*s*t*c[1]+3*s*t*t*c[2]+t**3*c[3]
        ring.extend(curve[:-1]);previous=c[3]
        second=max(np.linalg.norm(6*(c[2]-2*c[1]+c[0])),np.linalg.norm(6*(c[3]-2*c[2]+c[1])))
        reference_error=max(reference_error,second/(8*256**2))
    rings.append(np.array(ring))
    assert len(rings)==(2 if number==2 else 1)
    native_edges=[];native_vertices=[]
    model=ifcopenshell.open(str(root/f'page-{number}.ifc'))
    annotations=model.by_type('IfcAnnotation');assert len(annotations)==1
    annotation=annotations[0];assert annotation.Name==request['Name']
    assert annotation.ContainedInStructure[0].RelatingStructure.id()==40
    for region in plan['regions']:
        area=model.by_id(region['geometryItemId'])
        assert area.is_a('IfcAnnotationFillArea')
        style=area.StyledByItem[0].Styles[0].FillStyles[0]
        assert [style.Red,style.Green,style.Blue]==region['rgb']
        for boundary in [area.OuterBoundary,*(area.InnerBoundaries or ())]:
            # Local authored coordinates are metres / unitScale. This fixture is metres.
            pts=np.array([p.Coordinates[:2] for p in boundary.Points])*30
            pts[:,1]=240-pts[:,1]
            native_vertices.extend(pts)
            native_edges.extend(zip(pts[:-1],pts[1:]))
    reference=np.concatenate(rings)
    reference_edges=[(a,b) for r in rings for a,b in zip(r,np.roll(r,-1,axis=0))]
    forward=distances(reference,native_edges).max()/30
    reverse=distances(np.array(native_vertices),reference_edges).max()/30
    assert forward<=request['page']['toleranceMetres']
    assert reverse<=request['page']['toleranceMetres']+reference_error/30
    yy,xx=np.mgrid[0:240,0:240];pixels=np.stack((xx.ravel()+.5,yy.ravel()+.5),axis=1)
    expected=np.zeros(len(pixels),bool)
    for r in rings:
        if drawing['even_odd']: expected ^= inside(pixels,r)
        else: expected |= inside(pixels,r)
    observed=np.zeros(len(pixels),bool)
    for mesh in plan['meshes']:
        vertices=np.array(mesh['positions']).reshape(-1,3)+np.array(mesh['origin'])+np.array(plan['rtcOffset'])
        pts=(vertices[:,[0,2]]-[2,4])*30;pts[:,1]=240-pts[:,1]
        for triangle in np.array(mesh['indices']).reshape(-1,3): observed |= inside(pixels,pts[triangle])
    mismatch=expected!=observed
    boundary_error=0. if not mismatch.any() else distances(pixels[mismatch],reference_edges).max()/30
    assert boundary_error<=request['page']['toleranceMetres']+reference_error/30
    color=np.array(plan['regions'][0]['rgb']);source_color=np.array(drawing['fill'])
    assert np.max(np.abs(color-source_color))<=1/255+1e-6
    picture=np.full((240*240,3),255,dtype=np.uint8);picture[observed]=np.rint(color*255).astype(np.uint8)
    Image.fromarray(picture.reshape(240,240,3)).save(root/f'native-support-{number}.png')
    page.get_pixmap(matrix=fitz.Matrix(1,1),alpha=False).save(root/f'mupdf-source-{number}.png')
    settings=ifcopenshell.geom.settings();settings.set('use-world-coords',True)
    shape=ifcopenshell.geom.create_shape(settings,annotation)
    vertices=np.array(shape.geometry.verts).reshape(-1,3);triangles=np.array(shape.geometry.faces).reshape(-1,3)
    area=np.linalg.norm(np.cross(vertices[triangles[:,1]]-vertices[triangles[:,0]],vertices[triangles[:,2]]-vertices[triangles[:,0]]),axis=1).sum()/2
    reports.append(dict(pageNumber=number,sourceCurveSamples=len(reference),sourceToNativeMaxMetres=forward,nativeVertexToSourceMaxMetres=reverse,referenceLinearizationBoundMetres=reference_error/30,pixelsCompared=len(pixels),supportMismatchPixels=int(mismatch.sum()),mismatchDistanceToSourceBoundaryMetres=boundary_error,sourceRgb=source_color.tolist(),nativeRgb=color.tolist(),holeCount=len(rings)-1,independentAreaSquareMetres=area,independentTriangleCount=len(triangles),nativeTriangleCount=sum(len(m['indices'])//3 for m in plan['meshes']),declaredToleranceMetres=request['page']['toleranceMetres'],geometryWork=plan['geometryWork'],exportSha256=hashlib.sha256((root/f'page-{number}.ifc').read_bytes()).hexdigest()))
(root/'oracle.json').write_text(json.dumps(dict(sourcePdfSha256=hashlib.sha256(source.read_bytes()).hexdigest(),mupdfVersion=fitz.VersionBind,ifcopenshellVersion=ifcopenshell.version,calibration='declared synthetic control: 30 PDF units per model metre',reports=reports),indent=2)+'\n')
print(json.dumps(reports,indent=2))
