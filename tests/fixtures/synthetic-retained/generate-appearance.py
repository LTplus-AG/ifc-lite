# SPDX-License-Identifier: MPL-2.0
"""SYNTHETIC qualification M11-A (IfcAppearance), #7955. No authoring-tool provenance.

Every expected RGBA below is authored here, from the same constants that write the
styles into the STEP file. Nothing is read back from either geometry engine.

a-styled     box with IfcStyledItem rgb(.2,.4,.6), transparency .3 -> alpha .7.
b-material   wall styled only through IfcMaterialDefinitionRepresentation rgb(.9,.8,.1). NOT an arm
             isolator: with one material the cursor and the element fallback
             (element_material_fallback_color) give the same colour. The material arm alone is
             isolated by f-window and i-window-map-materials, whose glass is listed FIRST while the
             element fallback is the opaque frame, so only the transparent/opaque cursor yields it.
c1..c9       nine occurrences of ONE styled IfcRepresentationMap (rgb(.7,.2,.2)); c2/c3 are
             rotated 30/90 degrees, c9 sits at a (2600000, 1200000, 400) survey offset. The
             style is on the map's solid, so every occurrence resolves to the solid's style; the
             sub-mesh key (and geometry_item_id) is the SOLID, never the IfcMappedItem.
d-default    unstyled slab: the class default display colour rgb(.7,.7,.7).
e-host       wall styled rgb(.5,.5,.9) with a through opening; reveals keep the host colour.
e-opening    the opening element is styled green but always renders the fixed display
             colour (1.0,.42,.29,.4) (#5409).
f-window     window of two unstyled boxes with materials [glass(alpha .35), frame]: the
             material cursor gives part 0 the glass and part 1 the frame, named
             Window_Glass and Window_Frame_<item id>.
pixel        a second, tiny fixture (f-m11a-pixel.ifc) for the viewer e2e: an opaque red box
             rgb(.9,.1,.1) and an opaque yellow material wall rgb(.9,.8,.1), side by side near the
             origin so the default camera fit keeps both large on screen. The e2e asserts these
             colours at the renderer's input; canvas pixels are recorded evidence only.
g-type       orphan IfcRepresentationMap of a type, its solid styled rgb(.3,.6,.9)/alpha .5:
             published type geometry takes the map's style and its planned class.

Exact keys a styled sub-mesh by the LEAF item the walk reached (mapping_accept.rs: Merging::Styled(
item.item().id, mesh) -> meshes.add(id, mesh)) and resolves each with presentation_source::color:
  1. a direct IfcStyledItem on the leaf; else the IfcMappedItem chase (only when the leaf is itself a
     mapped item); else the element's material list, ONE cursor per product: step 0, 2, ... prefer the
     transparent entry, step 1, 3, ... the opaque one (style::resolve_submesh_color); else
  2. the element colour: the first style the product's representation items reach, an IfcMappedItem's
     own style first (processor::job ColorLayerResolver, element_color::product_shape_style_source);
     else the first opaque material colour; else the class default.
A window/door part is named Window_Glass when alpha <= .65, else Window_Frame_<leaf id>
(element_color::infer_opening_subpart_material_name). The cases below differ between keying by the
leaf and keying by the enclosing IfcMappedItem:
h-window-map   window whose Body is ONE IfcMappedItem -> map of [glass leaf rgb(.5,.75,1) T .75,
               frame leaf rgb(.25,.125,.0625)]: two sub-meshes, two colours, two names, two ids.
i-window-map-materials
               the same window with UNSTYLED leaves and materials [glass T .5, frame]: the cursor
               runs across the leaves of the map (glass, then frame), not once for the map.
j-mapped-item-style
               map [red-styled leaf, bare leaf] whose IfcMappedItem is itself styled blue: the red
               leaf keeps its direct style; the bare leaf is NOT coloured by the map's style as a
               leaf style, it takes the element colour, which is the map's style (first style the
               product reaches), so both rules are exercised and the two parts differ.
k-nested-map   a map whose items are two IfcMappedItems, each -> a map of one styled leaf (green,
               yellow): each leaf sits inside TWO enclosing occurrences and keeps its own colour and id.
l-window-twice one single-leaf map used by TWO occurrences in one window with materials
               [glass, frame]: two sub-meshes of the same leaf, so two cursor steps (glass, then
               frame); frames of ONE occurrence would share one step.
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
        if item is not None:  # the leaf item the walk reached; for a mapped occurrence that is the map's own item
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

    def occurrence(angle=0, of=None, at=(0, 0, 0)):
        c, s = math.cos(angle), math.sin(angle)
        target = m.add('IFCCARTESIANTRANSFORMATIONOPERATOR3D', m.direction((c, s, 0)), m.direction((-s, c, 0)),
                       m.point(at), real(1), m.z)
        return m.add('IFCMAPPEDITEM', of or source, target)

    for i in range(9):
        angle = {1: math.pi / 6, 2: math.pi / 2}.get(i, 0)
        placement = m.place((2600000, 1200000, 400) if i == 8 else (10 + 2 * i, 0, 0))
        product = m.product(f'c{i + 1}', occurrence(angle), kind='MappedRepresentation', placement=placement)
        expect(f'c{i + 1}', product, [part([.7, .2, .2, 1], solid)])

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

    # The cases below follow g-type, so every id above stays put.
    def window(role, items, placement, materials=None):
        shape = m.add('IFCPRODUCTDEFINITIONSHAPE', '$', '$', seq([m.shape(items, 'MappedRepresentation')]))
        product = m.add('IFCWINDOW', m.gid(role), '$', repr(role), '$', '$', placement, shape, '$', real(1.2), real(1), '$', '$', '$')
        m.products.append(product)
        if materials:
            associate(product, m.add('IFCMATERIALLIST', seq([material(name, rgb, t) for name, rgb, t in materials])), role)
        return product

    glass, frame = (.5, .75, 1.0), (.25, .125, .0625)
    pane, sash = box((.8, .05, 1.0), (.5, .05)), box((1, .1, 1.2), (.5, .05))
    styled(pane, glass, .75)
    styled(sash, frame)
    h = window('h-window-map', [occurrence(of=m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([pane, sash])))], m.place((30, 10, 0)))
    expect('h-window-map', h, [part([*glass, .25], pane, 'Window_Glass'), part([*frame, 1], sash, f'Window_Frame_{sash[1:]}')])

    pane, sash = box((.8, .05, 1.0), (.5, .05)), box((1, .1, 1.2), (.5, .05))
    i = window('i-window-map-materials', [occurrence(of=m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([pane, sash])))],
               m.place((34, 10, 0)), [('Glass-i', glass, .5), ('Frame-i', frame, 0)])
    expect('i-window-map-materials', i, [part([*glass, .5], pane, 'Window_Glass'), part([*frame, 1], sash, f'Window_Frame_{sash[1:]}')])

    red, bare = box(), box((1, 1, 1), (.5, .5))
    styled(red, (.75, .25, .25))
    item = occurrence(of=m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([red, bare])))
    styled(item, (.25, .25, .75))
    j = m.product('j-mapped-item-style', item, kind='MappedRepresentation', placement=m.place((38, 10, 0)))
    expect('j-mapped-item-style', j, [part([.75, .25, .25, 1], red), part([.25, .25, .75, 1], bare)])

    green, yellow = box(), box((1, 1, 1), (.5, .5))
    styled(green, (.25, .75, .25))
    styled(yellow, (.75, .75, .25))
    inner_a = occurrence(of=m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([green])))
    inner_b = occurrence(of=m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([yellow])), at=(1.5, 0, 0))
    outer = occurrence(of=m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([inner_a, inner_b], 'MappedRepresentation')))
    k = m.product('k-nested-map', outer, kind='MappedRepresentation', placement=m.place((42, 10, 0)))
    expect('k-nested-map', k, [part([.25, .75, .25, 1], green), part([.75, .75, .25, 1], yellow)])

    leaf = box((.8, .05, 1.0), (.5, .05))
    twice = m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([leaf]))
    l_window = window('l-window-twice', [occurrence(of=twice), occurrence(of=twice, at=(1.5, 0, 0))], m.place((46, 10, 0)),
                      [('Glass-l', glass, .5), ('Frame-l', frame, 0)])
    expect('l-window-twice', l_window, [part([*glass, .5], leaf, 'Window_Glass'), part([*frame, 1], leaf, f'Window_Frame_{leaf[1:]}')])

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
