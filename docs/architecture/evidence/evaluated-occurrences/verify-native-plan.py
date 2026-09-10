# SPDX-License-Identifier: MPL-2.0
"""Compare a real native appearance export with independent IfcOpenShell."""
import sys
import ifcopenshell,ifcopenshell.geom,ifcopenshell.validate,collections,json,numpy as np
from pathlib import Path
root=Path(sys.argv[3])
original=ifcopenshell.open(sys.argv[1]);target=ifcopenshell.open(sys.argv[2])
def problems(m):
 l=ifcopenshell.validate.json_logger();ifcopenshell.validate.validate(m,l,express_rules=True)
 return collections.Counter((s.get('attribute'),s['message']) for s in l.statements)
a,b=problems(original),problems(target);new=list((b-a).elements());assert not new,new
p=target.by_id(35169);shape=ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(),p)
mesh=next(m for m in json.load(open(root/'native-original.json')) if m['express_id']==35169)
mat=np.asarray(shape.transformation.matrix).reshape(4,4).T
v=np.asarray(shape.geometry.verts).reshape(-1,3);world=(mat@np.column_stack([v,np.ones(len(v))]).T).T[:,:3]
native=np.asarray(mesh['positions']).reshape(-1,3)+mesh.get('origin',[0,0,0]);distance=max(min(np.linalg.norm(world-p,axis=1)) for p in native);assert distance<1e-6,distance
assert len(shape.geometry.faces)==len(mesh['indices'])
changed=[e.id() for e in original if str(e)!=str(target.by_id(e.id()))];assert changed==[35155],changed
result=dict(reader='IfcOpenShell',version=ifcopenshell.version,sourceSchemaErrors=sum(a.values()),targetSchemaErrors=sum(b.values()),newSchemaViolations=new,changedExistingEntities=changed,triangles=len(shape.geometry.faces)//3,maxNativeCornerDistanceMetres=distance,GlobalId=p.GlobalId,materialPolicy='original style retained by internal normalization; final requested image replaces albedo',productIdentityPreserved=True)
(root/'native-reader-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
