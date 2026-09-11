# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Read-only oracle for the original registered CropBox/UserUnit/rotation control."""
from pathlib import Path
import hashlib,json,sys
import fitz,ifcopenshell,ifcopenshell.geom
import numpy as np
from PIL import Image
root,source=Path(sys.argv[1]),Path(sys.argv[2]);data=json.loads((root/'registered.json').read_text());request,plan=data['request'],data['result']
pdf=fitz.open(source);page=pdf[0];pix=page.get_pixmap(alpha=False)
assert (pix.width,pix.height)==(144,200) and page.rotation==90
expected=np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3]
frame=request['frame'];size=np.array(frame['sizeMetres']);origin=np.array(frame['origin']);axes=np.array([frame['axisU'],frame['axisV']])
y,x=np.mgrid[:pix.height,:pix.width]
# Registration's complete displayed page occupies the retained plane rectangle.
# MuPDF independently applies CropBox, intrinsic rotation and UserUnit to pixels.
points=np.stack(((x+.5)/pix.width*size[0],(1-(y+.5)/pix.height)*size[1]),axis=-1)
predicted=np.full_like(expected,255)
for mesh in plan['meshes']:
 world=np.array(mesh['positions']).reshape(-1,3)+np.array(mesh.get('origin',[0,0,0]))+np.array(plan['rtcOffset'])
 plane=np.stack([np.sum((world-origin)*axis,axis=1) for axis in axes],axis=1);inside=np.zeros((pix.height,pix.width),bool)
 for tri in np.array(mesh['indices']).reshape(-1,3):
  a,b,c=plane[tri];u=b-a;v=c-a;q=points-a;den=u[0]*v[1]-u[1]*v[0];assert den!=0
  s=(q[:,:,0]*v[1]-q[:,:,1]*v[0])/den;t=(u[0]*q[:,:,1]-u[1]*q[:,:,0])/den;inside|=(s>=0)&(t>=0)&(s+t<=1)
 predicted[inside]=np.rint(np.array(mesh['color'][:3])*255).astype(np.uint8)
mismatch=int(np.count_nonzero(np.any(predicted!=expected,axis=2)));assert mismatch==0,mismatch
model=ifcopenshell.open(str(root/'registered.ifc'));annotations=model.by_type('IfcAnnotation');assert len(annotations)==1
annotation=annotations[0];assert annotation.Name==request['Name'];assert annotation.ContainedInStructure[0].RelatingStructure.id()==request['containerId']
for region in plan['regions']:
 item=model.by_id(region['geometryItemId']);assert item.is_a('IfcAnnotationFillArea')
 color=item.StyledByItem[0].Styles[0].FillStyles[0];assert [color.Red,color.Green,color.Blue]==region['rgb']
settings=ifcopenshell.geom.settings();settings.set('use-world-coords',True);shape=ifcopenshell.geom.create_shape(settings,annotation)
v=np.array(shape.geometry.verts).reshape(-1,3);t=np.array(shape.geometry.faces).reshape(-1,3)
area=float(np.linalg.norm(np.cross(v[t[:,1]]-v[t[:,0]],v[t[:,2]]-v[t[:,0]]),axis=1).sum()/2);assert abs(area-2.4)<0.00001
Image.fromarray(expected).save(root/'mupdf-source.png');Image.fromarray(predicted).save(root/'native-support.png')
report=dict(sourcePdfSha256=hashlib.sha256(source.read_bytes()).hexdigest(),sourceIfcSha256=plan['sourceIfcSha256'],exportSha256=hashlib.sha256((root/'registered.ifc').read_bytes()).hexdigest(),mupdfVersion=fitz.VersionBind,ifcopenshellVersion=ifcopenshell.version,pixelsCompared=pix.width*pix.height,rasterMismatchPixels=mismatch,independentAreaSquareMetres=area,independentTriangleCount=len(t),geometryWork=plan['geometryWork'],gridSizeMetres=plan['gridSizeMetres'],registration='Frozen actual host calibration; CropBox [10,20,110,92], UserUnit 2, intrinsic rotation 90; displayed page plane 2.88 by 4 metres')
(root/'oracle.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
