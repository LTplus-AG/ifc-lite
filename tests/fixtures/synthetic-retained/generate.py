#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Generate tiny IFC4 qualification witnesses without importing an IFC engine."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import zlib
from step import Model, BOX_POINTS, BOX_FACES, face_set, guid, real, rows, seq, texture, triangles

ROOT = Path(__file__).resolve().parent
LICENSE = 'SPDX-License-Identifier: MPL-2.0'


def arc(m, radius, start, end):
    # Rotate the basis so trims stay in [0, 2*pi). Avoid a seam-crossing
    # negative parameter: independent geometry validation caught that ambiguity.
    position = m.add('IFCAXIS2PLACEMENT2D', m.point((0, 0)), m.direction((math.cos(start), math.sin(start))))
    circle = m.add('IFCCIRCLE', position, real(radius))
    return m.add('IFCTRIMMEDCURVE', circle, '(IFCPARAMETERVALUE(0.))', f'(IFCPARAMETERVALUE({real(end-start)}))', '.T.', '.PARAMETER.')


def band(m, a, b):
    lo, hi = -math.pi/4, math.pi/4
    def point(r, t):
        return m.point((r*math.cos(t), r*math.sin(t)))
    # Traversal: outer -45 -> +45, inner +45 -> -45.
    pieces = [arc(m, b, lo, hi), m.add('IFCPOLYLINE', seq([point(b, hi), point(a, hi)])), arc(m, a, lo, hi), m.add('IFCPOLYLINE', seq([point(a, lo), point(b, lo)]))]
    segments = [m.add('IFCCOMPOSITECURVESEGMENT', '.CONTINUOUS.', '.F.' if i == 2 else '.T.', p) for i, p in enumerate(pieces)]
    curve = m.add('IFCCOMPOSITECURVE', seq(segments), '.F.')
    profile = m.add('IFCARBITRARYCLOSEDPROFILEDEF', '.AREA.', '$', curve)
    return m.add('IFCEXTRUDEDAREASOLID', profile, m.axes, m.z, '3.')


def curved():
    m = Model('F-A')
    radii = [10., 10.1, 10.3, 10.6]
    layers = []
    for i, thickness in enumerate([0.1, 0.2, 0.3]):
        material = m.add('IFCMATERIAL', repr('Layer ' + str(i)), '$', '$')
        layers.append(m.add('IFCMATERIALLAYER', material, real(thickness), '.F.', repr('Band ' + str(i)), '$', '$', '$'))
    layer_set = m.add('IFCMATERIALLAYERSET', seq(layers), "'Three unequal bands'", '$')
    usage = m.add('IFCMATERIALLAYERSETUSAGE', layer_set, '.AXIS2.', '.NEGATIVE.', '0.', '$')
    # Axis runs CCW at the INNER radius: its left normal points inward;
    # DirectionSense NEGATIVE therefore grows layers radially outward.
    axis = m.shape([arc(m, radii[0], -math.pi/4, math.pi/4)], 'Curve2D', 'Axis')
    wall = m.product('curved-layered-wall', band(m, 10., 10.6), entity='IFCWALL', extra_reps=[axis])
    m.add('IFCRELASSOCIATESMATERIAL', m.gid('material'), '$', '$', '$', seq([wall]), usage)
    opening_id, relation = m.opening(wall, 'door-all-layers', size=(3, 1, 2), center=(10.5, 0))
    products = []
    volumes = []
    # Circular-strip antiderivative, independent of the tessellator and CSG.
    def strip(r):
        return 0.5*math.sqrt(r*r-0.25) + r*r*math.asin(0.5/r)
    for i, (a, b) in enumerate(zip(radii, radii[1:])):
        before = 3*math.pi/4*(b*b-a*a)
        removed = 2*(strip(b)-strip(a))
        volumes.append({'inner_radius':a, 'outer_radius':b, 'before':before, 'removed':removed, 'after':before-removed})
        for cut in [False, True]:
            # Controls sit away from the actual layered wall; translation cannot affect volume.
            place = m.place((0, 30+10*i, 10 if cut else 0))
            role = f'band-{i}-' + ('cut' if cut else 'uncut')
            product = m.product(role, band(m, a, b), placement=place)
            row = {'id':int(product[1:]), 'role':role, 'volume':before-removed if cut else before, 'band':i, 'cut':cut}
            if cut:
                row['opening_volume'] = 6
                row['opening_id'], row['void_relation'] = m.opening(product, role+'-door', placement=place, size=(3, 1, 2), center=(10.5, 0))
            products.append(row)
    products.insert(0, {'id':int(wall[1:]), 'role':'curved-layered-wall', 'volume':sum(v['after'] for v in volumes), 'opening_id':opening_id, 'opening_volume':6, 'void_relation':relation})
    return m.finish(), {'products':products, 'bands':volumes, 'before_total':sum(v['before'] for v in volumes), 'after_total':sum(v['after'] for v in volumes), 'material_usage':int(usage[1:]), 'axis_radius':10, 'angular_span_radians':math.pi/2, 'height':3, 'opening_bounds':[[9,-0.5,0],[12,0.5,2]], 'note':'Controls qualify individual band meshes; they do not prove automatic layer decomposition, internal-cap suppression or smooth-normal provenance.'}


def mapped():
    m = Model('F-B')
    base = face_set(m)
    base_map = m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([base], 'Tessellation'))
    palette = face_set(m)
    colours = [[1,0,0],[0,0,1]]
    indices = [1,2]*6
    rgb = m.add('IFCCOLOURRGBLIST', rows(colours))
    colour_map = m.add('IFCINDEXEDCOLOURMAP', palette, '1.', rgb, seq(indices))
    palette_map = m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([palette], 'Tessellation'))
    tex_face = face_set(m)
    uv = [[0,0],[1,0],[1,1],[0,1],[0,0],[1,0],[1,1],[0,1]]
    uv_permutation = [3,4,1,2,3,4,1,2]
    texture_id, texture_map = texture(m, tex_face, uv, [[uv_permutation[i-1] for i in tri] for tri in triangles()])
    tex_map = m.add('IFCREPRESENTATIONMAP', m.axes, m.shape([tex_face], 'Tessellation'))
    type_id = m.add('IFCBUILDINGELEMENTPROXYTYPE', m.gid('type'), '$', "'Repeated box'", '$', '$', '$', seq([base_map]), '$', '$', '.NOTDEFINED.')
    products = []
    roles = ['plain','rotated','mirrored','nonuniform','red','door-left','door-right','palette','textured']
    typed = []
    for i, role in enumerate(roles):
        source = palette_map if role == 'palette' else tex_map if role == 'textured' else base_map
        x, y, z = (1,0,0), (0,1,0), (0,0,1)
        if role == 'rotated':
            x, y = (0,1,0), (-1,0,0)
        if role == 'mirrored':
            x = (-1,0,0)
        args = [m.direction(x), m.direction(y), m.origin, '2.' if role == 'nonuniform' else '1.', m.direction(z)]
        operator = m.add('IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM', *args, '1.', '0.5') if role == 'nonuniform' else m.add('IFCCARTESIANTRANSFORMATIONOPERATOR3D', *args)
        item = m.add('IFCMAPPEDITEM', source, operator)
        style_item = m.style(item, (1,0,0) if role == 'red' else (0.5,0.5,0.5)) if source == base_map else None
        # The right-hand opening lives in a rotated occurrence placement,
        # exercising cutter-frame composition in addition to unequal cut positions.
        place = m.place((i*5, 0, 0), x=(0,1,0)) if role == 'door-right' else m.place((i*5, 0, 0))
        product = m.product(role, item, 'MappedRepresentation', place)
        row = {'id':int(product[1:]), 'role':role, 'volume':5 if role.startswith('door') else 6, 'map':int(source[1:]), 'mapped_item':int(item[1:]), 'translation':[i*5,0,0], 'basis_columns':[x,y,z], 'scale':[2,1,0.5] if role == 'nonuniform' else [1,1,1], 'mirrored':role == 'mirrored', 'nonuniform':role == 'nonuniform'}
        if style_item:
            row['styled_item'] = int(style_item[1:])
        row['local_centroid'] = [1,0.5,1.5]
        if role == 'door-right':
            row['basis_columns'] = [[0,1,0],[-1,0,0],[0,0,1]]
        if role.startswith('door'):
            row['local_centroid'] = [1.1 if role == 'door-left' else 0.9,0.5,1.6]
            row['opening_volume'] = 2
            row['opening_id'], row['void_relation'] = m.opening(product, role+'-opening', place, center=(0.5 if role == 'door-left' else 1.5, 0.5))
        if i < 7:
            typed.append(product)
        products.append(row)
    m.add('IFCRELDEFINESBYTYPE', m.gid('typed'), '$', '$', '$', seq(typed), type_id)
    return m.finish(), {'products':products, 'palette':{'face_set':int(palette[1:]),'map':int(colour_map[1:]),'colours':colours,'indices':indices}, 'texture_id':texture_id, 'texture_map':texture_map, 'texture':{'id':products[-1]['id'],'texture_id':texture_id,'url':'checker.png','vertices':[[x+40,y,z] for x,y,z in BOX_POINTS],'exact_uv':[[uv[i-1][0],1-uv[i-1][1]] for i in uv_permutation]}, 'definition_groups':[['plain','rotated'],['mirrored'],['nonuniform'],['red'],['door-left'],['door-right'],['palette'],['textured']], 'group_policy':'Conservative retained GPU eligibility: positive rigid, same appearance and same cuts share. Mirror needs parity handling; nonuniform realized; red changes appearance; unequal local opening positions change geometry. Palette and UV maps bind to IfcTessellatedFaceSet, not IfcMappedItem: valid IFC4 requires distinct representation maps for these variants. Seven occurrences share the original map/type. This expected policy is NOT a claim about current exact template grouping.', 'mapped_boolean_limit':'Host opening subtraction over mapped geometry; not an IfcMappedItem used as an IfcBooleanOperand (not in the IFC4 select).'}


def reexport(brep=False):
    # Same GlobalIds; different integer ids and reverse serialization order.
    m = Model('F-C', 1001 if brep else 1)
    face_ids = {}
    if brep:
        points = [m.point(p) for p in BOX_POINTS]
        faces = []
        for role, vertices in reversed(BOX_FACES):
            loop = m.add('IFCPOLYLOOP', seq(points[v] for v in vertices))
            bound = m.add('IFCFACEOUTERBOUND', loop, '.T.')
            face = m.add('IFCFACE', seq([bound]))
            face_ids[role] = int(face[1:])
            faces.append(face)
        item = m.add('IFCFACETEDBREP', m.add('IFCCLOSEDSHELL', seq(faces)))
    else:
        item = m.box()
    x, y, z = [0.36,0.48,-0.8], [0.48,0.64,0.6], [0.8,-0.6,0]
    position = [4,-3,2]
    product = m.product('stable-box', item, 'Brep' if brep else 'SweptSolid', m.place(position, z, x))
    return m.finish(reverse=brep), {'id':int(product[1:]), 'GlobalId':guid('F-C:stable-box'), 'volume':6, 'basis_columns':[x,y,z], 'translation':position, 'source_face_ids':face_ids, 'face_roles':{role:{'key':guid('F-C:stable-box')+'/'+role, 'local_vertices':[BOX_POINTS[v] for v in vertices]} for role, vertices in BOX_FACES}, 'identity_limit':'Semantic-role keys are an external oracle, not an IFC face identifier or a claim of current persistent engine identity. Match by local oriented plane/extent, never mesh triangle index or STEP entity id.'}


def sidecar():
    m = Model('F-D')
    points = [[0,0,0],[1,0,0],[0,1,0],[0,0,1]]
    indices = [[1,3,2],[1,2,4],[1,4,3],[2,3,4]]
    uv = [[0,0],[1,0],[0,1],[1,1]]
    item = face_set(m, points, indices)
    permutation = [2,4,1,3]
    uv_indices = [[permutation[i-1] for i in tri] for tri in indices]
    image, mapping = texture(m, item, uv, uv_indices)
    product = m.product('image-tetrahedron', item, 'Tessellation')
    return m.finish(), {'id':int(product[1:]),'volume':1/6,'texture_id':image,'texture_map':mapping,'url':'checker.png','vertices':points,'source_uv':uv,'exact_uv':[[uv[i-1][0],1-uv[i-1][1]] for i in permutation],'texture_indices':uv_indices,'triangles':indices,'note':'Exact mesher flips V for GPU/glTF; IFC source UV is unflipped. Sidecar pixels are red/green then blue/white, RGBA8, top-down.'}


def png():
    def chunk(kind, data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    pixels = bytes([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255])
    # Stored DEFLATE block, independent of compressor version/settings.
    raw = b'\0'+pixels[:8]+b'\0'+pixels[8:]
    compressed = b'\x78\x01\x01'+struct.pack('<HH',len(raw),65535-len(raw))+raw+struct.pack('>I',zlib.adler32(raw)&0xffffffff)
    data = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,6,0,0,0))+chunk(b'tEXt',b'License\0'+LICENSE.encode())+chunk(b'IDAT',compressed)+chunk(b'IEND',b'')
    return data


def outputs():
    result = {'checker.png':png()}
    oracle = {'license':LICENSE,'issue':7955,'provenance':'SYNTHETIC; no external authoring tool','tolerances':'tolerances.json','cases':{}}
    for filename, builder in [('f-a-curved.ifc',curved),('f-b-mapped.ifc',mapped),('f-c-extrusion.ifc',lambda:reexport(False)),('f-c-brep.ifc',lambda:reexport(True)),('f-d-texture.ifc',sidecar)]:
        source, info = builder()
        result[filename] = source.encode()
        oracle['cases'][filename] = info
    oracle['files'] = {name:{'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)} for name,data in result.items()}
    result['oracles.json'] = (json.dumps(oracle,indent=2)+'\n').encode()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    for name, data in outputs().items():
        path = ROOT/name
        if args.check:
            if not path.exists() or path.read_bytes() != data:
                raise SystemExit('stale generated fixture: '+name)
        else:
            path.write_bytes(data)
        print(name, len(data), hashlib.sha256(data).hexdigest())


if __name__ == '__main__':
    main()
