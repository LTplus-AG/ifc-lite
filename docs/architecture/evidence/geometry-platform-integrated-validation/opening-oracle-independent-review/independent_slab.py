# SPDX-License-Identifier: MPL-2.0
# Independent union integration over exact rational segment arrangement; fixture-only.
import runpy,io,contextlib,json
from fractions import Fraction as F
with contextlib.redirect_stdout(io.StringIO()): d=runpy.run_path('/tmp/ifclite-opening-binary-volume.py')
host=d['host']; A=d['A']; B=d['B']; C=d['C']; A2=d['A2']
def edges(p): return list(zip(p,p[1:]+p[:1]))
def cross(a,b): return a[0]*b[1]-a[1]*b[0]
def sub(a,b): return a[0]-b[0],a[1]-b[1]
def strip(p,x):
    ys=[]
    for a,b in edges(p):
        if min(a[0],b[0])<x<max(a[0],b[0]):ys.append(a[1]+(x-a[0])*(b[1]-a[1])/(b[0]-a[0]))
    assert len(ys)==2,(p,x,ys)
    return min(ys),max(ys)
def union_in_host(ps):
    es=[e for p in [host[0]]+ps for e in edges(p)]
    xs={x for p in [host[0]]+ps for x,y in p}
    for i,(a,b) in enumerate(es):
        r=sub(b,a)
        for c,e in es[i+1:]:
            s=sub(e,c); den=cross(r,s)
            if not den:continue
            t=cross(sub(c,a),s)/den;u=cross(sub(c,a),r)/den
            if 0<=t<=1 and 0<=u<=1:xs.add(a[0]+t*r[0])
    total=F(0);xs=sorted(xs)
    for l,r in zip(xs,xs[1:]):
        x=(l+r)/2
        if not min(v[0] for v in host[0])<x<max(v[0] for v in host[0]):continue
        hlo,hhi=strip(host[0],x);intervals=[]
        for p in ps:
            if min(v[0] for v in p)<x<max(v[0] for v in p):
                lo,hi=strip(p,x);lo=max(lo,hlo);hi=min(hi,hhi)
                if lo<hi:intervals.append((lo,hi))
        intervals.sort();merged=[]
        for lo,hi in intervals:
            if merged and lo<=merged[-1][1]:merged[-1]=(merged[-1][0],max(hi,merged[-1][1]))
            else:merged.append((lo,hi))
        total+=(r-l)*sum((hi-lo for lo,hi in merged),F(0))
    return total
def remaining(items):
    zs=sorted({host[1],host[2]}|{z for _,lo,hi in items for z in (max(lo,host[1]),min(hi,host[2])) if host[1]<=z<=host[2]})
    removed=F(0)
    for lo,hi in zip(zs,zs[1:]):
        z=(lo+hi)/2; ps=[p for p,a,b in items if a<z<b]
        removed+=(hi-lo)*union_in_host(ps)
    return d['area'](host[0])*(host[2]-host[1])-removed
out={}
for name,items,count in [('original',[A,B,C],1),('reference',[B,C],1),('repeated',[A,A2,B,C],2)]:
    stages=[]
    for n in range(1,len(items)+1):
        actual=remaining(items[:n]); expected=d['remaining'](items[:n]);assert actual==expected
        stages.append(str(actual))
    out[name]={'exact_rational_total':str(count*actual),'nearest_f64':float(count*actual),'all_stages_equal_independent_inclusion_exclusion':True}
print(json.dumps(out,indent=2))
