# SPDX-License-Identifier: MPL-2.0
# Nominal decimal coefficient geometry; not decoded-f64/SDK/exact-mesh proof.
from fractions import Fraction as F
from itertools import combinations

def rectangle(cx,cy,w,h,c,s):
    return [(F(cx)+F(c)*F(w)*i/2-F(s)*F(h)*j/2,
             F(cy)+F(s)*F(w)*i/2+F(c)*F(h)*j/2)
            for i,j in [(-1,-1),(1,-1),(1,1),(-1,1)]]
def cross(a,b): return a[0]*b[1]-a[1]*b[0]
def sub(a,b): return a[0]-b[0],a[1]-b[1]
def clip(p,q):
    for a,b in zip(q,q[1:]+q[:1]):
        output=[]
        for x,y in zip(p,p[1:]+p[:1]):
            dx,dy=cross(sub(b,a),sub(x,a)),cross(sub(b,a),sub(y,a))
            if dx>=0: output.append(x)
            if (dx<0)!=(dy<0):
                t=dx/(dx-dy)
                output.append((x[0]+t*(y[0]-x[0]),x[1]+t*(y[1]-x[1])))
        p=output
        if not p: break
    return p

def area(p):
    return abs(sum((cross(a,b) for a,b in zip(p,p[1:]+p[:1])),F(0)))/2
host=rectangle('2','.1','4','.2',1,0)
A=rectangle('1.5','.1','1','.4',1,0)
A2=rectangle('1.7','.1','1','.4',1,0)
B=rectangle('2','.1','1','.4','.8','.6')
C=rectangle('1.8','.1','.7','.5','.6','-.8')
def remaining_volume(items):
    removed=F(0)
    for n in range(1,len(items)+1):
        for subset in combinations(items,n):
            p=host
            for poly,lo,hi in subset: p=clip(p,poly)
            z=max(F(0),min(x[2] for x in subset)-max(x[1] for x in subset))
            removed+=(-1)**(n+1)*area(p)*z
    return F('2.4')-removed
items=[(A,F('.3'),F('1.5')),(B,F('.3'),F('1.5')),(C,F('.6'),F('1.5'))]
for name,x,count in [('original',items,1),('reference',items[1:],1),
                     ('repeated',[(A,F('.3'),F('1.5')),(A2,F('.3'),F('1.5'))]+items[1:],2)]:
    result=remaining_volume(x)*count
    print(name,str(result),format(float(result),'.17g'))
for name,p in [('A',A),('B',B),('C',C)]:
    print(name,'host intersection area',area(clip(host,p)))
