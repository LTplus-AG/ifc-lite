# SPDX-License-Identifier: MPL-2.0
# Independent composition oracle, OpenUSD 26.8. Untimed functional check.
from pxr import Usd,UsdGeom,Gf
import sys,json,math,collections

def load(path):
 stage=Usd.Stage.Open(path); assert stage
 cache=UsdGeom.XformCache(); groups=collections.defaultdict(list); metadata={}
 for prim in stage.Traverse():
  if prim.IsA(UsdGeom.Xform):
   metadata[str(prim.GetPath())]={str(a.GetName()):str(a.Get()) for a in prim.GetAttributes() if str(a.GetName()).startswith('ifc:')}
  if not prim.IsA(UsdGeom.Mesh):continue
  mesh=UsdGeom.Mesh(prim); matrix=cache.GetLocalToWorldTransform(prim)
  pts=[tuple(matrix.Transform(Gf.Vec3d(p))) for p in mesh.GetPointsAttr().Get()]
  idx=list(mesh.GetFaceVertexIndicesAttr().Get()); counts=list(mesh.GetFaceVertexCountsAttr().Get())
  assert all(n==3 for n in counts) and sum(counts)==len(idx)
  assert all(0<=i<len(pts) for i in idx)
  assert all(math.isfinite(x) for p in pts for x in p)
  normalmat=matrix.GetInverse().GetTranspose()
  normals=[tuple(normalmat.TransformDir(Gf.Vec3d(n)).GetNormalized()) for n in mesh.GetNormalsAttr().Get()]
  # Keep winding and corner normals; only normalize the triangle's starting corner.
  tris=[]
  for off in range(0,len(idx),3):
   corners=[(pts[idx[off+j]],normals[idx[off+j]]) for j in range(3)]
   k=min(range(3),key=lambda j:corners[j][0]);corners=corners[k:]+corners[:k]
   tris.append(corners)
  tris.sort(key=lambda t:tuple(round(x,4) for p,n in t for x in p))
  color=mesh.GetDisplayColorAttr().Get(); opacity=mesh.GetDisplayOpacityAttr().Get()
  groups[str(prim.GetParent().GetPath())].append({'triangles':tris,'color':str(color),'opacity':str(opacity),'purpose':str(mesh.ComputePurpose()),'orientation':str(mesh.GetOrientationAttr().Get())})
 return groups,metadata

def err(a,b):
 if any(a[k]!=b[k] for k in ['color','opacity','purpose','orientation']):return float('inf'),float('inf')
 if len(a['triangles'])!=len(b['triangles']):return float('inf'),float('inf')
 pmax=nmax=0.
 for at,bt in zip(a['triangles'],b['triangles']):
  for (ap,an),(bp,bn) in zip(at,bt):
   pmax=max(pmax,math.dist(ap,bp));nmax=max(nmax,math.dist(an,bn))
 return pmax,nmax

a,am=load(sys.argv[1]);b,bm=load(sys.argv[2]);assert am==bm,'element metadata differs'
assert a.keys()==b.keys(),'geometry entity paths differ'
maxp=maxn=0.; meshcount=tris=0
for key,aa in a.items():
 bb=b[key][:];assert len(aa)==len(bb),(key,'part count',len(aa),len(bb))
 for x in aa:
  choices=[(err(x,y),i) for i,y in enumerate(bb)];(pe,ne),i=min(choices)
  assert pe<=1e-4 and ne<=1e-4,(key,'geometry/appearance mismatch',pe,ne)
  bb.pop(i);maxp=max(maxp,pe);maxn=max(maxn,ne);meshcount+=1;tris+=len(x['triangles'])
print(json.dumps({'ok':True,'usdVersion':Usd.GetVersion(),'meshes':meshcount,'triangles':tris,'maxPointErrorM':maxp,'maxNormalError':maxn,'metadata':'exact','materialPurposeOrientation':'exact'}))
