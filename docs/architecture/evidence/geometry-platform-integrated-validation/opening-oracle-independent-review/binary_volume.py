# SPDX-License-Identifier: MPL-2.0
# Exact rational evaluation of polygons obtained from decoded binary64 source
# coefficients and canonical decoded profile basis. No geometry engine or mesh.
from fractions import Fraction as F
from itertools import combinations
from decimal import Decimal, localcontext
from pathlib import Path
import re, math, hashlib, json, struct
source=Path('/home/louistrue/.t3/worktrees/ifc-lite/t3-f778e361/rust/processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc')
data=source.read_text(); records={int(i):(t,a) for i,t,a in re.findall(r'#(\d+)\s*=\s*(\w+)\s*\((.*?)\);',data,re.S)}
def attrs(raw):
    out=[];start=depth=0;quoted=False
    for i,c in enumerate(raw):
        if c=="'": quoted=not quoted
        if not quoted:
            if c=='(':depth+=1
            elif c==')':depth-=1
            elif c==',' and depth==0:out.append(raw[start:i].strip());start=i+1
    return out+[raw[start:].strip()]
def record(i,ty):
    t,a=records[i];assert t==ty,(i,t,ty)
    return attrs(a)
def ref(v):assert v.startswith('#');return int(v[1:])
def coord(i,ty):return tuple(float(x) for x in record(i,ty)[0].strip('()').split(','))
def cross(a,b):return a[0]*b[1]-a[1]*b[0]
def sub(a,b):return a[0]-b[0],a[1]-b[1]
def clip(p,q):
    for a,b in zip(q,q[1:]+q[:1]):
        out=[]
        for x,y in zip(p,p[1:]+p[:1]):
            dx,dy=cross(sub(b,a),sub(x,a)),cross(sub(b,a),sub(y,a))
            if dx>=0:out.append(x)
            if (dx<0)!=(dy<0):
                t=dx/(dx-dy);out.append((x[0]+t*(y[0]-x[0]),x[1]+t*(y[1]-x[1])))
        p=out
        if not p:break
    return p

def area(p):return abs(sum((cross(a,b) for a,b in zip(p,p[1:]+p[:1])),F(0)))/2
coefficient_bits={}
def solid(i):
    a=record(i,'IFCEXTRUDEDAREASOLID');p=record(ref(a[0]),'IFCRECTANGLEPROFILEDEF')
    p2=record(ref(p[2]),'IFCAXIS2PLACEMENT2D');centre=coord(ref(p2[0]),'IFCCARTESIANPOINT')
    c,s=coord(ref(p2[1]),'IFCDIRECTION')
    # build_axis2_matrix normalizes X, projects against Z, normalizes X
    # again, then normalizes Z cross X. All three norms round to 1 here.
    for _ in range(2):
        norm=math.sqrt(c*c+s*s);assert norm==1.;c,s=c/norm,s/norm
    ynorm=math.sqrt(s*s+c*c);assert ynorm==1.
    w,h=float(p[3]),float(p[4]);hw,hh=w/2.,h/2.
    pl=record(ref(a[1]),'IFCAXIS2PLACEMENT3D');origin=coord(ref(pl[0]),'IFCCARTESIANPOINT')
    assert coord(ref(pl[1]),'IFCDIRECTION')==(0.,0.,1.)
    assert coord(ref(pl[2]),'IFCDIRECTION')==(1.,0.,0.)
    assert coord(ref(a[2]),'IFCDIRECTION')==(0.,0.,1.)
    depth=float(a[3]);cx,cy=map(F,centre);ox,oy,oz=map(F,origin)
    polygon=[(ox+cx+F(c)*F(hw)*u-F(s)*F(hh)*v,
              oy+cy+F(s)*F(hw)*u+F(c)*F(hh)*v)
             for u,v in [(-1,-1),(1,-1),(1,1),(-1,1)]]
    raw={'centre':centre,'origin':origin,'basis':(c,s,-s,c),'dims':(w,h),'depth':depth}
    coefficient_bits[str(i)]={k:[struct.pack('>d',x).hex() for x in (v if isinstance(v,tuple) else (v,))] for k,v in raw.items()}
    return polygon,oz,oz+F(depth)
# Explicitly verify the fixture's common parent and all local placements.
for i in [5]:
    a=record(i,'IFCAXIS2PLACEMENT3D');assert coord(ref(a[0]),'IFCCARTESIANPOINT')==(0.,0.,0.)
    assert coord(ref(a[1]),'IFCDIRECTION')==(0.,0.,1.) and coord(ref(a[2]),'IFCDIRECTION')==(1.,0.,0.)
assert record(8,'IFCLOCALPLACEMENT')==['$','#5']
for i in [29,49,69,99]:assert record(i,'IFCLOCALPLACEMENT')==['#8','#5']
host=solid(26);A=solid(46);B=solid(66);C=solid(96)
# Repeated mapped source injects #204=(0.2,0,0), same binary64 .2 token;
# do not parse a pre-rounded 1.7 centre or pre-summed Z upper endpoints.
A2=([(x+F(float('0.2')),y) for x,y in A[0]],A[1],A[2])
def remaining(items):
    removed=F(0)
    for n in range(1,len(items)+1):
        for subset in combinations(items,n):
            p=host[0]
            for poly,lo,hi in subset:p=clip(p,poly)
            z=max(F(0),min([host[2]]+[x[2] for x in subset])-max([host[1]]+[x[1] for x in subset]))
            removed+=(-1)**(n+1)*area(p)*z
    return area(host[0])*(host[2]-host[1])-removed
with localcontext() as ctx:
    ctx.prec=65
    def show(x):return {'rational':str(x),'decimal':str(Decimal(x.numerator)/Decimal(x.denominator)),'nearest_f64':float(x)}
    result={'fixture_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'coefficient_bits':coefficient_bits,
        'host_volume':show(area(host[0])*(host[2]-host[1])),
        'derived_endpoints':{'A_zmax':show(A[2]),'C_zmax':show(C[2]),'mapped_A_center_x':show(F(float('1.5'))+F(float('0.2')))},'variants':{}}
    for name,seq,count in [('original',[A,B,C],1),('reference',[B,C],1),('repeated',[A,A2,B,C],2)]:
        result['variants'][name]={'per_host_stages':[show(remaining(seq[:n])) for n in range(1,len(seq)+1)],'total':show(count*remaining(seq))}
    print(json.dumps(result,indent=2))
