# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
from pathlib import Path
import hashlib,json,sys
import fitz,ifcopenshell,ifcopenshell.geom
import numpy as np
from PIL import Image
root=Path(sys.argv[1])
pdf=fitz.open(sys.argv[2])
reports=[]
for number in (1,2):
 data=json.loads((root/f'page-{number}.json').read_text());plan=data['result']
 page=pdf[number-1];pix=page.get_pixmap(matrix=fitz.Matrix(1,1),alpha=False)
 expected=np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width,pix.n)[:,:,:3]
 predicted=np.full_like(expected,255)
 # Pixel centres mapped independently from unrotated PDF coordinates into
 # the declared control calibration and native vertical IFC plane.
 yy,xx=np.mgrid[0:240,0:240];points=np.stack(((xx+.5)/30,(240-yy-.5)/30),axis=-1)
 for mesh in plan['meshes']:
  world=np.array(mesh['positions']).reshape(-1,3)+np.array(mesh.get('origin',[0,0,0]))+np.array(plan['rtcOffset'])
  plane=world[:,[0,2]]-np.array([2,4]);inside=np.zeros((240,240),bool)
  for tri in np.array(mesh['indices']).reshape(-1,3):
   a,b,c=plane[tri];u=b-a;v=c-a;q=points-a;den=u[0]*v[1]-u[1]*v[0]
   if abs(den)<1e-20:raise AssertionError('degenerate native triangle')
   s=(q[:,:,0]*v[1]-q[:,:,1]*v[0])/den;t=(u[0]*q[:,:,1]-u[1]*q[:,:,0])/den
   inside|=(s>=0)&(t>=0)&(s+t<=1)
  predicted[inside]=np.rint(np.array(mesh['color'][:3])*255).astype(np.uint8)
 mismatch=int(np.count_nonzero(np.any(predicted!=expected,axis=2)))
 assert mismatch==0,(number,mismatch)
 Image.fromarray(expected).save(root/f'mupdf-source-{number}.png');Image.fromarray(predicted).save(root/f'native-support-{number}.png')
 model=ifcopenshell.open(str(root/f'page-{number}.ifc'));annotations=model.by_type('IfcAnnotation');assert len(annotations)==1
 annotation=annotations[0];assert annotation.Name=='Actual PDF fill control'
 assert annotation.ContainedInStructure[0].RelatingStructure.id()==40
 settings=ifcopenshell.geom.settings();settings.set(settings.USE_WORLD_COORDS,True)
 shape=ifcopenshell.geom.create_shape(settings,annotation)
 vertices=np.array(shape.geometry.verts).reshape(-1,3);triangles=np.array(shape.geometry.faces).reshape(-1,3)
 area=float(np.linalg.norm(np.cross(vertices[triangles[:,1]]-vertices[triangles[:,0]],vertices[triangles[:,2]]-vertices[triangles[:,0]]),axis=1).sum()/2)
 assert abs(area-(63 if number==1 else 64))<1e-6
 paints=[]
 for region in plan['regions']:
  item=model.by_id(region['geometryItemId']);assert item.is_a('IfcAnnotationFillArea')
  style=item.StyledByItem[0].Styles[0];assert style.is_a('IfcFillAreaStyle')
  color=style.FillStyles[0];rgb=[color.Red,color.Green,color.Blue];assert rgb==region['rgb']
  paints.append({'itemId':item.id(),'rgb':rgb,'holeCount':len(item.InnerBoundaries or [])})
 reports.append({'pageNumber':number,'pixelsCompared':240*240,'rasterMismatchPixels':mismatch,'rasterBoundary':'all pixel centres at 72dpi, no edge exclusions; independent MuPDF source vs native triangle support/color','ifcopenshellVersion':ifcopenshell.version,'independentAreaSquareMetres':area,'independentTriangleCount':len(triangles),'nativeTriangleCount':sum(len(m['indices'])//3 for m in plan['meshes']),'independentBounds':[vertices.min(axis=0).tolist(),vertices.max(axis=0).tolist()],'fillStylesReadFromIfc':paints,'exportSha256':hashlib.sha256((root/f'page-{number}.ifc').read_bytes()).hexdigest()})
(root/'oracle.json').write_text(json.dumps({'sourcePdfSha256':hashlib.sha256(Path(sys.argv[2]).read_bytes()).hexdigest(),'mupdfVersion':fitz.VersionBind,'calibration':'declared synthetic control:30PDFunits per model metre; not a measured building scale','reports':reports},indent=2)+'\n')
print(json.dumps(reports,indent=2))
