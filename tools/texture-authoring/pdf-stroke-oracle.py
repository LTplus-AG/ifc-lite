# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Read-only original PDF raster / independent IFC geometry controls."""
from pathlib import Path
import hashlib,json,sys
import fitz,ifcopenshell,ifcopenshell.geom
import numpy as np
from PIL import Image
root,source=Path(sys.argv[1]),Path(sys.argv[2]);pdf=fitz.open(source)
fitz.TOOLS.set_aa_level(0)
reports=[]
for number,expected_area in enumerate([2.4,2.54,2.38,19.36,1.5768],1):
 data=json.loads((root/f'page-{number}.json').read_text());plan=data['result']
 pix=pdf[number-1].get_pixmap(alpha=False)
 expected=np.frombuffer(pix.samples,dtype=np.uint8).reshape(240,240,pix.n)[:,:,:3]
 predicted=np.full_like(expected,255);yy,xx=np.mgrid[:240,:240]
 points=np.stack(((xx+.5)/30,(240-yy-.5)/30),axis=-1)
 for mesh in plan['meshes']:
  vertices=np.array(mesh['positions']).reshape(-1,3)+np.array(mesh.get('origin',[0,0,0]))+np.array(plan['rtcOffset'])
  plane=vertices[:,[0,2]]-[2,4];inside=np.zeros((240,240),bool)
  for tri in np.array(mesh['indices']).reshape(-1,3):
   a,b,c=plane[tri];u=b-a;v=c-a;q=points-a;den=np.linalg.det(np.stack((u,v)))
   assert den!=0
   s=(q[:,:,0]*v[1]-q[:,:,1]*v[0])/den;t=(u[0]*q[:,:,1]-u[1]*q[:,:,0])/den
   inside|=(s>=0)&(t>=0)&(s+t<=1)
  predicted[inside]=np.rint(np.array(mesh['color'][:3])*255).astype(np.uint8)
 mismatch=np.any(np.abs(predicted.astype(np.int16)-expected.astype(np.int16))>1,axis=2)
 model=ifcopenshell.open(str(root/f'page-{number}.ifc'));annotations=model.by_type('IfcAnnotation');assert len(annotations)==1
 annotation=annotations[0];assert annotation.Name==data['request']['Name'];assert annotation.ContainedInStructure[0].RelatingStructure.id()==40
 edges=[]
 for region in plan['regions']:
  item=model.by_id(region['geometryItemId']);assert item.is_a('IfcAnnotationFillArea')
  color=item.StyledByItem[0].Styles[0].FillStyles[0];assert [color.Red,color.Green,color.Blue]==region['rgb']
  for boundary in [item.OuterBoundary,*(item.InnerBoundaries or [])]:
   p=np.array([p.Coordinates[:2] for p in boundary.Points]);edges.extend(zip(p[:-1],p[1:]))
 boundary_distance=0.
 if mismatch.any():
  p=points[mismatch];best=np.full(len(p),np.inf)
  for a,b in edges:
   v=b-a;t=np.clip(np.sum((p-a)*v,axis=1)/np.dot(v,v),0,1);best=np.minimum(best,np.linalg.norm(p-a-t[:,None]*v,axis=1))
  boundary_distance=float(best.max()*30)
 # First four controls use integer, axis-aligned edges/45-degree bevels.
 # Sheared page rasterizer edge inclusion can differ within one pixel. This
 # is a raster support check, not a claim of metre-tolerance proof from pixels.
 assert boundary_distance<=1.,(number,int(mismatch.sum()),boundary_distance)
 settings=ifcopenshell.geom.settings();settings.set('use-world-coords',True)
 shape=ifcopenshell.geom.create_shape(settings,annotation);v=np.array(shape.geometry.verts).reshape(-1,3);t=np.array(shape.geometry.faces).reshape(-1,3)
 area=float(np.linalg.norm(np.cross(v[t[:,1]]-v[t[:,0]],v[t[:,2]]-v[t[:,0]]),axis=1).sum()/2)
 assert abs(area-expected_area)<0.0001,(number,area,expected_area)
 Image.fromarray(expected).save(root/f'mupdf-source-{number}.png');Image.fromarray(predicted).save(root/f'native-support-{number}.png')
 reports.append(dict(pageNumber=number,pixelsCompared=57600,rasterMismatchPixels=int(mismatch.sum()),maxMismatchDistanceToNativeBoundaryPixels=boundary_distance,independentAreaSquareMetres=area,analyticAreaSquareMetres=expected_area,independentTriangleCount=len(t),nativeTriangleCount=sum(len(m['indices'])//3 for m in plan['meshes']),geometryWork=plan['geometryWork'],exportSha256=hashlib.sha256((root/f'page-{number}.ifc').read_bytes()).hexdigest()))
(root/'oracle.json').write_text(json.dumps(dict(sourcePdfSha256=hashlib.sha256(source.read_bytes()).hexdigest(),mupdfVersion=fitz.VersionBind,ifcopenshellVersion=ifcopenshell.version,calibration='declared synthetic control:30 PDF units per model metre',rasterMode='MuPDF antialiasing disabled; all pixel centres, no exclusions; one 8-bit RGB quantization step allowed; remaining differences must be within one pixel of native boundary',reports=reports),indent=2)+'\n')
print(json.dumps(reports,indent=2))
