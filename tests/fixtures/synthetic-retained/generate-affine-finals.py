#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""M10 source-derived affine finals. Deterministic, no geometry-engine import.

P = [0,1]x[0,.2] union [0,.2]x[.2,.6], area .28, centroid
(27/70, 13/70), height 2. Mapped Boolean B-H has volume 5.25.
h4 is deliberately outside IFC4 ScaleGreaterZero (negative Scale); kept in a
separate adversarial fixture and never counted as schema qualification.
h22 maps an oblique plane clip AFTER clipping (M5 -> M10 note).
"""
import argparse
import math
from pathlib import Path
from step import Model, BOX_POINTS, BOX_FACES, real, seq
ROOT = Path(__file__).resolve().parent


def generate(adversarial=False):
    m = Model('m10-affine-finals')
    cases = []
    def extrusion(profile, depth=2, position=None):
        return m.add('IFCEXTRUDEDAREASOLID', profile, position or m.axes, m.z, real(depth))
    points = [m.point(p) for p in [(0,0),(1,0),(1,.2),(.2,.2),(.2,.6),(0,.6)]]
    poly = m.add('IFCPOLYLINE', seq(points + points[:1]))
    p = extrusion(m.add('IFCARBITRARYCLOSEDPROFILEDEF','.AREA.','$',poly))
    def mapping(items, kind='SweptSolid'):
        return m.add('IFCREPRESENTATIONMAP',m.axes,m.shape(items,kind))
    def occurrence(source, scales=(1,1,1), x=(1,0,0), y=(0,1,0), translation=(0,0,0)):
        args=[m.direction(x),m.direction(y),m.point(translation),real(scales[0]),m.z]
        kind='IFCCARTESIANTRANSFORMATIONOPERATOR3D'
        if scales[1:] != scales[:1]*2:
            kind += 'NONUNIFORM'; args += [real(scales[1]),real(scales[2])]
        return m.add('IFCMAPPEDITEM',source,m.add(kind,*args))
    def product(case, items, volume, placement=None, kind='MappedRepresentation'):
        if (case == 'h4') != adversarial:
            return None
        rep=m.add('IFCPRODUCTDEFINITIONSHAPE','$','$',seq([m.shape(items,kind)]))
        result=m.add('IFCBUILDINGELEMENTPROXY',m.gid(case),'$',repr(case),'$','$',placement or m.placement,rep,'$','.NOTDEFINED.')
        m.products.append(result); cases.append(f'/* {case}: product {result}; hand volume {volume} */')
        return result
    src=mapping([p])
    product('h1',[occurrence(src)],.56)
    product('h2',[occurrence(src,x=(-1,0,0))],.56)
    product('h3',[occurrence(src,y=(0,-1,0))],.56)
    if adversarial: product('h4',[occurrence(src,scales=(-1,-1,-1))],.56)
    product('h5',[occurrence(src,scales=(2,2,2))],4.48)
    product('h6',[occurrence(src,scales=(.5,.5,.5))],.07)
    product('h7',[occurrence(src,scales=(2,3,4))],13.44)
    product('h8',[occurrence(src,scales=(1,1,3),x=(-1,0,0))],1.68)
    product('h9',[occurrence(src,x=(-1,0,0))],.56,
            m.place((2600000,1200000,400),z=(0,0,1),x=(math.cos(math.pi/6),math.sin(math.pi/6),0)))
    # Door: .9 x 1.5 rectangle plus a semicircle R=.45, extruded 2m.
    bottom=m.add('IFCPOLYLINE',seq([m.point((-.45,1.5)),m.point((-.45,0)),m.point((.45,0)),m.point((.45,1.5))]))
    axis=m.add('IFCAXIS2PLACEMENT2D',m.point((0,1.5)),'$')
    circle=m.add('IFCCIRCLE',axis,'0.45')
    arc=m.add('IFCTRIMMEDCURVE',circle,'(IFCPARAMETERVALUE(0.))',f'(IFCPARAMETERVALUE({real(math.pi)}))','.T.','.PARAMETER.')
    segments=[m.add('IFCCOMPOSITECURVESEGMENT','.CONTINUOUS.','.T.',c) for c in [bottom,arc]]
    door=extrusion(m.add('IFCARBITRARYCLOSEDPROFILEDEF','.AREA.','$',m.add('IFCCOMPOSITECURVE',seq(segments),'.F.')))
    product('h10',[occurrence(mapping([door]),x=(-1,0,0))],2*(1.35+math.pi*.45**2/2))
    def cylinder(radius):
        a=m.add('IFCAXIS2PLACEMENT2D',m.point((0,0)),'$')
        return extrusion(m.add('IFCCIRCLEPROFILEDEF','.AREA.','$',a,real(radius)))
    for name,r,s in [('h11',.3,(.5,.5,.5)),('h12',1,(2,2,2)),('h13',.00005,(1000,1000,1000)),('h14',.05,(1,1,3))]:
        product(name,[occurrence(mapping([cylinder(r)]),scales=s)],2*math.pi*r*r*math.prod(s))
    inner=occurrence(src,scales=(2,2,2),translation=(2,3,4))
    product('h15',[occurrence(mapping([inner],'MappedRepresentation'),x=(-1,0,0),translation=(5,6,7))],4.48)
    product('h16',[occurrence(src),occurrence(src,x=(-1,0,0),translation=(3,0,0))],1.12)
    b=m.box(); hprofile=m.add('IFCRECTANGLEPROFILEDEF','.AREA.','$',m.add('IFCAXIS2PLACEMENT2D',m.point((1,.5)),'$'),'0.5','0.5')
    h=extrusion(hprofile,4,m.add('IFCAXIS2PLACEMENT3D',m.point((0,0,-.5)),'$','$'))
    diff=m.add('IFCBOOLEANRESULT','.DIFFERENCE.',b,h)
    product('h17',[occurrence(mapping([diff],'CSG'),x=(-1,0,0))],5.25)
    product('h18',[occurrence(mapping([diff],'CSG'),scales=(2,2,2))],42)
    host=product('h19',[occurrence(src,x=(-1,0,0))],.56-.1*.1*2)
    if host:
        m.opening(host,'h19-opening',size=(.1,.1,2),center=(-.1,.1))
    vertices=[m.point(v) for v in BOX_POINTS]; faces=[]
    for _, ids in BOX_FACES:
        loop=m.add('IFCPOLYLOOP',seq(vertices[i] for i in ids))
        faces.append(m.add('IFCFACE',seq([m.add('IFCFACEOUTERBOUND',loop,'.T.')])) )
    brep=m.add('IFCFACETEDBREP',m.add('IFCCLOSEDSHELL',seq(faces)))
    product('h20',[occurrence(mapping([brep],'Brep'),x=(-1,0,0))],6)
    product('h21',[occurrence(src,scales=(1e-7,1e-7,1e-7))],.56e-21)
    # z <= 1+x/4 over B=[0,2]x[0,1]x[0,3]: integral = 2.5; det=6 -> 15.
    plane=m.add('IFCPLANE',m.add('IFCAXIS2PLACEMENT3D',m.point((0,0,1)),m.direction((-.25,0,1)),m.direction((1,0,.25))))
    half=m.add('IFCHALFSPACESOLID',plane,'.T.')
    clip=m.add('IFCBOOLEANCLIPPINGRESULT','.DIFFERENCE.',b,half)
    product('h22',[occurrence(mapping([clip],'Clipping'),scales=(2,3,1))],15)
    text=m.finish().replace("'SYNTHETIC; issue 7955; not authoring-tool evidence'","'SYNTHETIC qualification M10'")
    return text.replace('DATA;\n','DATA;\n'+'\n'.join(cases)+'\n')

if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--check',action='store_true'); args=parser.parse_args()
    for adversarial in [False,True]:
        path=ROOT/('f-h-affine-finals'+('-adversarial' if adversarial else '')+'.ifc')
        text=generate(adversarial)
        if args.check:
            assert path.read_text()==text, f'{path} differs from generator'
        else: path.write_text(text)
