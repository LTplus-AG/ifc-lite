# SPDX-License-Identifier: MPL-2.0
"""SYNTHETIC qualification M7, #7955. No authoring-tool provenance.

17 cases plus e13's opening = 18 products across two fixtures.
The schema-valid coverage fixture excludes e8/e17: 16 candidates, 10 published after M3-A.
The 2 adversarial products pin controller behaviour, not IFC qualification.
B=[0,2]x[0,1]x[0,3], H=[.75,1.25]x[.25,.75]x[-.5,3.5].
e1 identity difference: 6-.5*.5*3=5.25; e2 rotates 30 degrees;
e3 translates (7,-3,1); e4 product translates (2600000,1200000,400).
e5 two occurrences, total 10.5, ONE Boolean evaluation per product.
e6 union with B+(1,0,0): 6+6-1*1*3=9; e7 intersection=3.
e8 half-scale H about its centre: .25*.25*2=.125 removed, V=5.875.
e9 mirror and e10 scale2: incomplete final-affine boundary.
e11 plain and e12 bounded halfspace: unsupported at the halfspace.
e13 host: 5.25-.4^3=5.186 after M3-A; opening V=.4^3=.064.
The opening [.1,.5]x[.3,.7]x[0,.4] is inside B and disjoint from H.
e14 B-B: authenticated empty_result. e15 radius.2 through-hole: 6-.12*pi.
e16 chained halfspaces: unsupported. e17 multi-item mapped operand: refused.

Mapped Boolean operands (e8/e17) intentionally exercise the existing controller
extension: IfcMappedItem is not a member of IFC4 IfcBooleanOperand. Validate and
report these schema exceptions explicitly; never label them schema-valid IFC.
"""
import argparse
import math
import re
from pathlib import Path
from step import Model, real, seq


def generate(adversarial=False):
    m = Model('m7-mapped-booleans')
    cases = []
    products = {}

    def axes(xyz):
        return m.add('IFCAXIS2PLACEMENT3D', m.point(xyz), '$', '$')

    def box(size, center, z=0):
        pos = m.add('IFCAXIS2PLACEMENT2D', m.point(center), '$')
        profile = m.add('IFCRECTANGLEPROFILEDEF', '.AREA.', '$', pos, real(size[0]), real(size[1]))
        return m.add('IFCEXTRUDEDAREASOLID', profile, axes((0, 0, z)), m.z, real(size[2]))

    def boolean(a, b, operation='DIFFERENCE', clipping=False):
        return m.add('IFCBOOLEANCLIPPINGRESULT' if clipping else 'IFCBOOLEANRESULT',
                     '.' + operation + '.', a, b)

    def mapping(items, kind='CSG'):
        return m.add('IFCREPRESENTATIONMAP', m.axes, m.shape(items, kind=kind))

    def occurrence(source, translation=(0, 0, 0), scale=1, angle=0, mirror=False):
        c, s = math.cos(angle), math.sin(angle)
        x = (-1, 0, 0) if mirror else (c, s, 0)
        y = (0, 1, 0) if mirror else (-s, c, 0)
        target = m.add('IFCCARTESIANTRANSFORMATIONOPERATOR3D', m.direction(x),
                       m.direction(y), m.point(translation), real(scale), m.z)
        return m.add('IFCMAPPEDITEM', source, target)

    def product(case, items, placement=None, kind='MappedRepresentation', entity='IFCBUILDINGELEMENTPROXY'):
        shape = m.add('IFCPRODUCTDEFINITIONSHAPE', '$', '$', seq([m.shape(items, kind)]))
        result = m.add(entity, m.gid(case), '$', repr(case), '$', '$', placement or m.placement,
                       shape, '$', '.OPENING.' if entity == 'IFCOPENINGELEMENT' else '.NOTDEFINED.')
        if entity != 'IFCOPENINGELEMENT':
            m.products.append(result)
        products[case] = result
        cases.append((case, f'/* {case}: product {result} */'))
        return result

    b = box((2, 1, 3), (1, .5))
    h = box((.5, .5, 4), (1, .5), -.5)
    m1 = mapping([boolean(b, h)])
    product('e1', [occurrence(m1)])
    product('e2', [occurrence(m1, angle=math.pi / 6)])
    product('e3', [occurrence(m1, (7, -3, 1))])
    product('e4', [occurrence(m1)], m.place((2600000, 1200000, 400)))
    product('e5', [occurrence(m1), occurrence(m1, (4, 0, 0))])
    shifted = box((2, 1, 3), (2, .5))
    union = m.add('IFCCSGSOLID', boolean(b, shifted, 'UNION'))
    product('e6', [occurrence(mapping([union]))])
    product('e7', [occurrence(mapping([boolean(b, shifted, 'INTERSECTION')]))])
    # Scaling about (1,.5,1.5) gives translation (.5,.25,.75).
    half_h = occurrence(mapping([h], 'SweptSolid'), (.5, .25, .75), scale=.5)
    product('e8', [occurrence(mapping([boolean(b, half_h)]))])
    product('e9', [occurrence(m1, mirror=True)])
    product('e10', [occurrence(m1, scale=2)])
    plane = m.add('IFCPLANE', axes((0, 0, 1.5)))
    half = m.add('IFCHALFSPACESOLID', plane, '.T.')
    product('e11', [occurrence(mapping([boolean(b, half, clipping=True)], 'Clipping'))])
    corners = [m.point(p) for p in [(-1, -1), (3, -1), (3, 2), (-1, 2)]]
    boundary = m.add('IFCPOLYLINE', seq(corners + corners[:1]))
    bounded = m.add('IFCPOLYGONALBOUNDEDHALFSPACE', plane, '.T.', m.axes, boundary)
    product('e12', [occurrence(mapping([boolean(b, bounded, clipping=True)], 'Clipping'))])
    host = product('e13', [occurrence(m1)])
    opening = product('e13-opening', [box((.4, .4, .4), (.3, .5))],
                      kind='SweptSolid', entity='IFCOPENINGELEMENT')
    m.add('IFCRELVOIDSELEMENT', m.gid('e13-void'), '$', '$', '$', host, opening)
    product('e14', [occurrence(mapping([boolean(b, b)]))])
    pos = m.add('IFCAXIS2PLACEMENT2D', m.point((1, .5)), '$')
    circle = m.add('IFCCIRCLEPROFILEDEF', '.AREA.', '$', pos, '0.2')
    cylinder = m.add('IFCEXTRUDEDAREASOLID', circle, axes((0, 0, -.5)), m.z, '4.')
    product('e15', [occurrence(mapping([boolean(b, cylinder)]))])
    chain = boolean(boolean(b, half, clipping=True), bounded, clipping=True)
    product('e16', [occurrence(mapping([chain], 'Clipping'))])
    multi = occurrence(mapping([h, shifted], 'SweptSolid'))
    product('e17', [boolean(b, multi)], kind='CSG')
    # Keep original entity IDs stable across the split. Strip unreachable
    # definitions too: an unreferenced invalid Boolean still violates IFC4.
    selected = {name for name in products if (name in ('e8', 'e17')) == adversarial}
    m.products = [products[name] for name in products if name in selected and name != 'e13-opening']
    header = m.finish().split('DATA;\n')[0] + 'DATA;\n'  # also appends subset containment
    records = {line.split('=')[0]: line for line in m.lines}
    roots = [products[name] for name in selected]
    for ref, line in records.items():
        kind = line.split('=')[1].split('(')[0]
        if kind in ('IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY',
                    'IFCRELAGGREGATES', 'IFCRELCONTAINEDINSPATIALSTRUCTURE'):
            roots.append(ref)
        elif kind == 'IFCRELVOIDSELEMENT' and not adversarial:
            roots.append(ref)
    kept = set()
    while roots:
        ref = roots.pop()
        if ref in kept:
            continue
        kept.add(ref)
        roots.extend(re.findall(r'#\d+', records[ref].split('=', 1)[1]))
    lines = [line for ref, line in records.items() if ref in kept]
    comments = [comment for name, comment in cases if name in selected]
    if adversarial:
        comments.insert(0, '/* ADVERSARIAL NON-SCHEMA: e8/e17 SecondOperand is IfcMappedItem, '
                        'outside IFC4 IfcBooleanOperand. Controller extension only; NOT qualification. */')
    else:
        comments.append(f'/* halfspace origins: e11/e16 {half}, e12 {bounded}; M1 {m1} */')
    text = header + '\n'.join(comments + lines) + '\nENDSEC;\nEND-ISO-10303-21;\n'
    return text.replace('SYNTHETIC; issue 7955; not authoring-tool evidence',
                        'SYNTHETIC ADVERSARIAL NON-SCHEMA M7' if adversarial else 'SYNTHETIC qualification M7')



if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    for adversarial in [False, True]:
        suffix = '-adversarial' if adversarial else ''
        path = Path(__file__).with_name(f'f-e-mapped-booleans{suffix}.ifc')
        text = generate(adversarial)
        if args.check:
            if path.read_text() != text:
                raise SystemExit(f'M7 fixture differs from generator: {path.name}')
        else:
            path.write_text(text)
