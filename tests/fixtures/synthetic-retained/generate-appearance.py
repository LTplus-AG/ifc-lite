# SPDX-License-Identifier: MPL-2.0
"""SYNTHETIC qualification M11-A (IfcAppearance), #7955. No authoring-tool provenance.

Every expected RGBA below is authored here, from the same constants that write the
styles into the STEP file. Nothing is read back from either geometry engine.

a-styled     box with IfcStyledItem rgb(.2,.4,.6), transparency .3 -> alpha .7.
b-material   wall styled only through IfcMaterialDefinitionRepresentation rgb(.9,.8,.1).
c1..c9       nine occurrences of ONE styled IfcRepresentationMap (rgb(.7,.2,.2)); c2/c3 are
             rotated 30/90 degrees, c9 sits at a (2600000, 1200000, 400) survey offset. The
             style is on the map's solid, so every occurrence resolves through the mapped chase.
d-default    unstyled slab: the class default display colour rgb(.7,.7,.7).
e-host       wall styled rgb(.5,.5,.9) with a through opening; reveals keep the host colour.
e-opening    the opening element is styled green but always renders the fixed display
             colour (1.0,.42,.29,.4) (#5409).
f-window     window of two unstyled boxes with materials [glass(alpha .35), frame]: the
             material cursor gives part 0 the glass and part 1 the frame, named
             Window_Glass and Window_Frame_<item id>.
pixel        a second, tiny fixture (f-m11a-pixel.ifc) for the viewer pixel probe: an opaque red box
             rgb(.9,.1,.1) and an opaque yellow material wall rgb(.9,.8,.1), side by side near the
             origin so the default camera fit keeps both large on screen.
g-type       orphan IfcRepresentationMap of a type, its solid styled rgb(.3,.6,.9)/alpha .5:
             published type geometry takes the map's style and its planned class.
"""
import argparse
import json
import math
from pathlib import Path
from step import Model, real, seq


def expectations(m):
    return json.dumps(m, indent=2, sort_keys=True) + '\n'


def generate():
    m = Model('m11a-appearance')
    expected = []

    def rendering(rgb, transparency=0):
        colour = m.add('IFCCOLOURRGB', '$', *(real(v) for v in rgb))
        rendering = m.add('IFCSURFACESTYLERENDERING', colour, real(transparency), '$', '$', '$', '$', '$', '$', '.NOTDEFINED.')
        return m.add('IFCSURFACESTYLE', '$', '.BOTH.', seq([rendering]))

    def styled(item, rgb, transparency=0):
        m.add('IFCSTYLEDITEM', item, seq([rendering(rgb, transparency)]), '$')

    def material(name, rgb, transparency=0):
        material = m.add('IFCMATERIAL', repr(name))
        shape = m.add('IFCSTYLEDREPRESENTATION', m.context, "'Style'", "'Material'",
                      seq([m.add('IFCSTYLEDITEM', '$', seq([rendering(rgb, transparency)]), '$')]))
        m.add('IFCMATERIALDEFINITIONREPRESENTATION', '$', '$', seq([shape]), material)
        return material

    def associate(product, select, role):
        m.add('IFCRELASSOCIATESMATERIAL', m.gid(role + ':material'), '$', '$', '$', seq([product]), select)

    def expect(role, product, parts):
        expected.append({'role': role, 'id': int(product[1:]), 'parts': parts})

    def part(rgba, item=None, name=None, geometry_class=0):
        row = {'rgba': rgba, 'materialName': name, 'geometryClass': geometry_class}
        if item is not None:  # a mapped occurrence's item id is an engine detail (map solid or IfcMappedItem), not asserted
            row['geometryItemId'] = int(item[1:])
        return row

    def axes(xyz):
        return m.add('IFCAXIS2PLACEMENT3D', m.point(xyz), '$', '$')

    box = m.box
    a_item = box()
    styled(a_item, (.2, .4, .6), .3)
    expect('a-styled', m.product('a-styled', a_item, placement=m.place((0, 0, 0))), [part([.2, .4, .6, .7], a_item)])

    b_item = box()
    wall = m.product('b-material', b_item, entity='IFCWALL', placement=m.place((5, 0, 0)))
    associate(wall, material('Concrete', (.9, .8, .1)), 'b-material')
    expect('b-material', wall, [part([.9, .8, .1, 1], b_item)])

    solid = box((1, 1, 1), (.5, .5))
    styled(solid, (.7, .2, .2))
    source = m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([solid], 'SweptSolid'))

    def occurrence(angle=0):
        c, s = math.cos(angle), math.sin(angle)
        target = m.add('IFCCARTESIANTRANSFORMATIONOPERATOR3D', m.direction((c, s, 0)), m.direction((-s, c, 0)),
                       m.point((0, 0, 0)), real(1), m.z)
        return m.add('IFCMAPPEDITEM', source, target)

    for i in range(9):
        angle = {1: math.pi / 6, 2: math.pi / 2}.get(i, 0)
        placement = m.place((2600000, 1200000, 400) if i == 8 else (10 + 2 * i, 0, 0))
        product = m.product(f'c{i + 1}', occurrence(angle), kind='MappedRepresentation', placement=placement)
        expect(f'c{i + 1}', product, [part([.7, .2, .2, 1])])

    d_item = box()
    expect('d-default', m.product('d-default', d_item, entity='IFCSLAB', placement=m.place((0, 5, 0))), [part([.7, .7, .7, 1], d_item)])

    e_item = box()
    styled(e_item, (.5, .5, .9))
    host = m.product('e-host', e_item, entity='IFCWALL', placement=m.place((5, 5, 0)))
    cutter = box((.5, 2, 2), (1, .5))
    styled(cutter, (.1, .9, .1))
    opening = m.product('e-opening', cutter, entity='IFCOPENINGELEMENT', placement=m.place((5, 5, 0)))
    m.add('IFCRELVOIDSELEMENT', m.gid('e-opening:void'), '$', '$', '$', host, opening)
    expect('e-host', host, [part([.5, .5, .9, 1], e_item)])
    expect('e-opening', opening, [part([1.0, .42, .29, .4], cutter)])

    pane_item, sash_item = box((.8, .05, 1.0), (.5, .05)), box((1, .1, 1.2), (.5, .05))
    shape = m.add('IFCPRODUCTDEFINITIONSHAPE', '$', '$', seq([m.shape([pane_item, sash_item])]))
    window = m.add('IFCWINDOW', m.gid('f-window'), '$', "'f-window'", '$', '$', m.place((10, 5, 0)), shape,
                   '$', real(1.2), real(1), '$', '$', '$')
    m.products.append(window)
    glass, frame = material('Glass', (.6, .8, 1.0), .65), material('Frame', (.3, .2, .1))
    associate(window, m.add('IFCMATERIALLIST', seq([glass, frame])), 'f-window')
    expect('f-window', window, [part([.6, .8, 1.0, .35], pane_item, 'Window_Glass'),
                                part([.3, .2, .1, 1], sash_item, f'Window_Frame_{sash_item[1:]}')])

    g_item = box((1, 1, 1), (.5, .5))
    styled(g_item, (.3, .6, .9), .5)
    g_map = m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([g_item], 'SweptSolid'))
    g_type = m.add('IFCBUILDINGELEMENTPROXYTYPE', m.gid('g-type'), '$', "'g-type'", '$', '$', '$', seq([g_map]), '$', '$', '.NOTDEFINED.')

    text = m.finish().replace('SYNTHETIC; issue 7955; not authoring-tool evidence', 'SYNTHETIC qualification M11-A')
    return text, expectations({'fixture': 'f-m11a-appearance.ifc', 'products': expected,
                               'typeMap': {'type': int(g_type[1:]), 'map': int(g_map[1:]), 'rgba': [.3, .6, .9, .5], 'geometryClass': 1, 'item': int(g_item[1:])}})


def generate_pixel():
    m = Model('m11a-pixel')
    expected = []
    red = m.box((2, 2, 2), (1, 1))
    colour = m.add('IFCCOLOURRGB', '$', real(.9), real(.1), real(.1))
    rendering = m.add('IFCSURFACESTYLERENDERING', colour, real(0), '$', '$', '$', '$', '$', '$', '.NOTDEFINED.')
    m.add('IFCSTYLEDITEM', red, seq([m.add('IFCSURFACESTYLE', '$', '.BOTH.', seq([rendering]))]), '$')
    red_box = m.product('pixel-red', red, placement=m.place((0, 0, 0)))
    expected.append({'role': 'pixel-red', 'id': int(red_box[1:]), 'rgba': [.9, .1, .1, 1]})
    yellow = m.box((2, 2, 2), (1, 1))
    wall = m.product('pixel-yellow', yellow, entity='IFCWALL', placement=m.place((4, 0, 0)))
    material = m.add('IFCMATERIAL', "'Yellow'")
    colour = m.add('IFCCOLOURRGB', '$', real(.9), real(.8), real(.1))
    rendering = m.add('IFCSURFACESTYLERENDERING', colour, real(0), '$', '$', '$', '$', '$', '$', '.NOTDEFINED.')
    shape = m.add('IFCSTYLEDREPRESENTATION', m.context, "'Style'", "'Material'", seq([m.add('IFCSTYLEDITEM', '$', seq([m.add('IFCSURFACESTYLE', '$', '.BOTH.', seq([rendering]))]), '$')]))
    m.add('IFCMATERIALDEFINITIONREPRESENTATION', '$', '$', seq([shape]), material)
    m.add('IFCRELASSOCIATESMATERIAL', m.gid('pixel-yellow:material'), '$', '$', '$', seq([wall]), material)
    expected.append({'role': 'pixel-yellow', 'id': int(wall[1:]), 'rgba': [.9, .8, .1, 1]})
    text = m.finish().replace('SYNTHETIC; issue 7955; not authoring-tool evidence', 'SYNTHETIC qualification M11-A pixel probe')
    return text, expectations({'fixture': 'f-m11a-pixel.ifc', 'products': expected})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    text, oracle = generate()
    pixel, pixel_oracle = generate_pixel()
    for name, body in [('f-m11a-appearance.ifc', text), ('f-m11a-appearance.oracle.json', oracle),
                       ('f-m11a-pixel.ifc', pixel), ('f-m11a-pixel.oracle.json', pixel_oracle)]:
        path = Path(__file__).with_name(name)
        if args.check:
            if path.read_text() != body:
                raise SystemExit(f'M11-A fixture differs from generator: {name}')
        else:
            path.write_text(body)
