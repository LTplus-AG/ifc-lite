#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
# Independent hand derivation (#7955): dental_clinic #1673/#1757 are rectangular walls
# clipped by a tilted plane with a triangular opening; both cuts are prismatic in the wall
# thickness, so the solid is a 2D polygon (wall length x height) extruded by the thickness.
# Reads raw STEP, uses no ifc-lite code and no mesh.
import re,sys,math
path=sys.argv[1]; ids=[int(x) for x in sys.argv[2:]]
E={}
buf=''
for line in open(path,errors='replace'):
    line=line.strip()
    if not line: continue
    buf+=line
    if buf.endswith(';'):
        m=re.match(r'#(\d+)\s*=\s*([A-Z0-9]+)\s*\((.*)\);$',buf,re.S)
        if m:E[int(m.group(1))]=(m.group(2),m.group(3))
        buf=''
def split(s):
    o=[];d=0;c='';q=False
    for ch in s:
        if ch=="'":q=not q
        if not q:
            if ch=='(':d+=1
            if ch==')':d-=1
        if ch==',' and d==0 and not q:o.append(c.strip());c=''
        else:c+=ch
    o.append(c.strip());return o
A=lambda i:split(E[i][1])
R=lambda s:int(s[1:])
def nums(s):return [float(x) for x in re.findall(r'[-+]?\d+\.?\d*(?:E[-+]?\d+)?',s)]
pt=lambda i:(nums(A(i)[0])+[0,0,0])[:3]
def norm(v):
    n=math.sqrt(sum(x*x for x in v));return [x/n for x in v]
def cross(a,b):return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def dot(a,b):return sum(x*y for x,y in zip(a,b))
def ap3(i):
    a=A(i);o=pt(R(a[0]))
    z=norm(nums(A(R(a[1]))[0])) if a[1]!='$' else [0,0,1]
    x=nums(A(R(a[2]))[0]) if a[2]!='$' else [1,0,0]
    if a[2]=='$' and abs(z[2])>0.99: x=[1,0,0]
    x=norm([x[k]-dot(x,z)*z[k] for k in range(3)]);y=cross(z,x)
    return [[x[0],y[0],z[0],o[0]],[x[1],y[1],z[1],o[1]],[x[2],y[2],z[2],o[2]],[0,0,0,1]]
def mul(a,b):return [[sum(a[i][k]*b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]
def app(m,p):return [sum(m[i][k]*p[k] for k in range(3))+m[i][3] for i in range(3)]
def vec(m,p):return [sum(m[i][k]*p[k] for k in range(3)) for i in range(3)]
def lp(i):
    a=A(i);m=ap3(R(a[1]))
    return mul(lp(R(a[0])),m) if a[0]!='$' else m
def inv(m):
    r=[[m[j][i] for j in range(3)] for i in range(3)];t=[-sum(r[i][k]*m[k][3] for k in range(3)) for i in range(3)]
    return [r[0]+[t[0]],r[1]+[t[1]],r[2]+[t[2]],[0,0,0,1]]
def clip(poly,n,c):  # keep n.p<=c in 2D
    o=[]
    for i,p in enumerate(poly):
        q=poly[(i+1)%len(poly)];a=dot(n,p)-c;b=dot(n,q)-c
        if a<=0:o.append(p)
        if (a<0 and b>0) or (a>0 and b<0):t=a/(a-b);o.append([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])])
    return o
def area(p):return sum(p[i][0]*p[(i+1)%len(p)][1]-p[(i+1)%len(p)][0]*p[i][1] for i in range(len(p)))/2
def perim(p):return sum(math.dist(p[i],p[(i+1)%len(p)]) for i in range(len(p)))
for pid in ids:
    a=A(pid);world=lp(R(a[5]));shape=A(R(a[6]));body=[R(x) for x in re.findall(r'#\d+',shape[2]) if A(int(x[1:]))[1].strip("'")=='Body'][0]
    item=R(re.findall(r'#\d+',A(body)[3])[0]);assert E[item][0]=='IFCBOOLEANCLIPPINGRESULT'
    b=A(item);ex=A(R(b[1]));hs=A(R(b[2]));prof=A(R(ex[0]))
    assert E[R(ex[0])][0]=='IFCRECTANGLEPROFILEDEF'
    p2=A(R(prof[2]));c2=pt(R(p2[0]))[:2];L,t=float(prof[3]),float(prof[4]);H=float(ex[3])
    # rectangle in (x,y) centred at c2, extruded +z; all authored axes identity
    assert p2[1]=='$' or [abs(v) for v in nums(A(R(p2[1]))[0])[:2]]==[1.0,0.0],(p2,A(R(p2[1])))
    poly=[[c2[0]-L/2,0.],[c2[0]+L/2,0.],[c2[0]+L/2,H],[c2[0]-L/2,H]]
    # clip plane (#HalfSpace base, in product frame); AgreementFlag .F. keeps the +normal side
    pl=A(R(hs[0]));pm=ap3(R(pl[0]));n=vec(pm,[0,0,1]);o=app(pm,[0,0,0]);agree=hs[1]=='.T.'
    assert abs(n[1])<1e-12,n
    # AgreementFlag TRUE: the plane normal points away from the half space material. So .F.
    # means the removed material is on the normal side and the kept side is n.p<=c.
    kn=[-n[0],-n[2]] if agree else [n[0],n[2]]
    kc=dot(kn,[o[0],o[2]])
    poly=clip(poly,kn,kc)
    # opening: find void, triangular profile extruded across the thickness
    op=None
    for k,(ty,args) in E.items():
        if ty=='IFCRELVOIDSELEMENT':
            q=split(args)
            if R(q[4])==pid: op=R(q[5])
    oa=A(op);ow=lp(R(oa[5]));orep=A(R(oa[6]));oitem=R(re.findall(r'#\d+',A(R(re.findall(r'#\d+',orep[2])[0]))[3])[0]);oex=A(oitem)
    oprof=A(R(oex[0]));ring=[pt(R(x))[:2] for x in re.findall(r'#\d+',A(R(oprof[2]))[0])][:-1]
    om=mul(mul(inv(world),ow),ap3(R(oex[1])))
    tri=[app(om,[x,y,0]) for x,y in ring]
    print('#%d opening triangle in wall frame:'%pid,[[round(v,6) for v in q] for q in tri],'normal y span',max(q[1] for q in tri)-min(q[1] for q in tri))
    tri2=[[q[0],q[2]] for q in tri]
    if area(tri2)<0:tri2.reverse()
    # polygon \ triangle: subtract polygon ∩ triangle; result polygon stays connected? report both numbers
    inter=poly[:]
    for i in range(3):
        p,q=tri2[i],tri2[(i+1)%3];e=[q[0]-p[0],q[1]-p[1]];nn=[e[1],-e[0]]
        inter=clip(inter,nn,dot(nn,p))
    if area(poly)<0:poly.reverse()
    A2=area(poly)-abs(area(inter))
    print('#%d L=%.12g t=%.12g H=%.12g outer=%s'%(pid,L,t,H,[[round(v,6) for v in q] for q in poly]))
    print('#%d inter=%s'%(pid,[[round(v,9) for v in q] for q in inter]))
    print('#%d plane n=%s o=%s agree=%s'%(pid,n,o,agree))
    print('#%d A2D=%.12f V=%.12f'%(pid,A2,A2*t))
    # Surface: two end faces (A2D each) plus perimeter x thickness of the prismatic result.
    print('#%d area if the opening touches nothing: %.12f'%(pid,2*A2+perim(poly)*t))
    # outer minus the opening: the trapezoid under the clip line goes, leaving this L.
    xs=[q[0] for q in tri2];zs=[q[1] for q in tri2]
    x0=min(q[0] for q in poly);x1=max(q[0] for q in poly);xc=max(xs);z0=min(zs)
    L6=[[x0,0.],[x1,0.],[x1,H],[xc,H],[xc,z0],[x0,z0]]
    assert abs(area(L6)-A2)<1e-9,(area(L6),A2)
    print('#%d L-shape=%s A=%.15f P=%.15f SURFACE=%.15f VOLUME=%.15f'%(pid,L6,area(L6),perim(L6),2*area(L6)+perim(L6)*t,area(L6)*t))
    print('#%d sections: outer area %.12f perimeter %.12f; inter area %.12f perimeter %.12f'%(pid,area(poly),perim(poly),abs(area(inter)),perim(inter)))
