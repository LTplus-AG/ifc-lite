# SPDX-License-Identifier: MPL-2.0
"""Minimal deterministic IFC4 writer, independent of both geometry engines."""
import math
import uuid

ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'


def guid(name):
    value = uuid.uuid5(uuid.NAMESPACE_URL, 'ifc-lite:synthetic-7955:' + name).int
    chars = []
    for _ in range(22):
        chars.append(ALPHABET[value % 64])
        value //= 64
    return ''.join(reversed(chars))


def real(value):
    s = format(float(value), '.15g')
    return s if '.' in s or 'e' in s else s + '.'


def seq(values):
    return '(' + ','.join(str(v) for v in values) + ')'


def rows(values):
    return seq(seq(real(v) for v in row) for row in values)


class Model:
    def __init__(self, name, start=1):
        self.name, self.next, self.lines, self.products = name, start, [], []
        self.origin = self.point((0, 0, 0))
        self.axes = self.add('IFCAXIS2PLACEMENT3D', self.origin, '$', '$')
        self.z = self.direction((0, 0, 1))
        self.context = self.add('IFCGEOMETRICREPRESENTATIONCONTEXT', '$', "'Model'", 3, '1.E-7', self.axes, '$')
        unit = self.add('IFCSIUNIT', '*', '.LENGTHUNIT.', '$', '.METRE.')
        angle = self.add('IFCSIUNIT', '*', '.PLANEANGLEUNIT.', '$', '.RADIAN.')
        units = self.add('IFCUNITASSIGNMENT', seq([unit, angle]))
        self.project = self.add('IFCPROJECT', self.gid('project'), '$', "'SYNTHETIC qualification'", '$', '$', '$', '$', seq([self.context]), units)
        self.placement = self.add('IFCLOCALPLACEMENT', '$', self.axes)
        self.site = self.add('IFCSITE', self.gid('site'), '$', "'Site'", '$', '$', self.placement, '$', '$', '.ELEMENT.', '$', '$', '$', '$', '$')
        self.building = self.add('IFCBUILDING', self.gid('building'), '$', "'Building'", '$', '$', self.placement, '$', '$', '.ELEMENT.', '$', '$', '$')
        self.storey = self.add('IFCBUILDINGSTOREY', self.gid('storey'), '$', "'Storey'", '$', '$', self.placement, '$', '$', '.ELEMENT.', '0.')
        for i, (parent, child) in enumerate([(self.project, self.site), (self.site, self.building), (self.building, self.storey)]):
            self.add('IFCRELAGGREGATES', self.gid('aggregate' + str(i)), '$', '$', '$', parent, seq([child]))

    def gid(self, role):
        return "'" + guid(self.name + ':' + role) + "'"

    def add(self, kind, *args):
        ref = '#' + str(self.next)
        self.next += 1
        self.lines.append(f'{ref}={kind}(' + ','.join(str(a) for a in args) + ');')
        return ref

    def point(self, xyz):
        return self.add('IFCCARTESIANPOINT', seq(real(v) for v in xyz))

    def direction(self, xyz):
        return self.add('IFCDIRECTION', seq(real(v) for v in xyz))

    def place(self, xyz=(0, 0, 0), z=None, x=None, parent='$'):
        axes = self.add('IFCAXIS2PLACEMENT3D', self.point(xyz), self.direction(z) if z else '$', self.direction(x) if x else '$')
        return self.add('IFCLOCALPLACEMENT', parent, axes)

    def shape(self, items, kind='SweptSolid', label='Body'):
        return self.add('IFCSHAPEREPRESENTATION', self.context, repr(label), repr(kind), seq(items))

    def product(self, role, item, kind='SweptSolid', placement=None, entity='IFCBUILDINGELEMENTPROXY', extra_reps=()):
        shape = self.add('IFCPRODUCTDEFINITIONSHAPE', '$', '$', seq([self.shape([item], kind), *extra_reps]))
        predefined = '.OPENING.' if entity == 'IFCOPENINGELEMENT' else '.NOTDEFINED.'
        product = self.add(entity, self.gid(role), '$', repr(role), '$', '$', placement or self.placement, shape, '$', predefined)
        if entity != 'IFCOPENINGELEMENT':
            self.products.append(product)
        return product

    def box(self, size=(2, 1, 3), center=(1, 0.5)):
        pos = self.add('IFCAXIS2PLACEMENT2D', self.point(center), '$')
        profile = self.add('IFCRECTANGLEPROFILEDEF', '.AREA.', '$', pos, real(size[0]), real(size[1]))
        return self.add('IFCEXTRUDEDAREASOLID', profile, self.axes, self.z, real(size[2]))

    def opening(self, host, role, placement=None, size=(0.5, 2, 2), center=(1, 0.5)):
        opening = self.product(role, self.box(size, center), placement=placement, entity='IFCOPENINGELEMENT')
        relation = self.add('IFCRELVOIDSELEMENT', self.gid(role + ':void'), '$', '$', '$', host, opening)
        return int(opening[1:]), int(relation[1:])

    def style(self, item, rgb, texture=None):
        colour = self.add('IFCCOLOURRGB', '$', *(real(v) for v in rgb))
        shading = self.add('IFCSURFACESTYLESHADING', colour, '0.')
        parts = [shading]
        if texture:
            parts.append(self.add('IFCSURFACESTYLEWITHTEXTURES', seq([texture])))
        style = self.add('IFCSURFACESTYLE', "'SYNTHETIC'", '.BOTH.', seq(parts))
        return self.add('IFCSTYLEDITEM', item, seq([style]), '$')

    def finish(self, reverse=False):
        self.add('IFCRELCONTAINEDINSPATIALSTRUCTURE', self.gid('containment'), '$', '$', '$', seq(self.products), self.storey)
        lines = list(reversed(self.lines)) if reverse else self.lines
        return ("ISO-10303-21;\n/* SPDX-License-Identifier: MPL-2.0 */\nHEADER;\n"
                "FILE_DESCRIPTION(('SYNTHETIC; issue 7955; not authoring-tool evidence'),'2;1');\n"
                "FILE_NAME('synthetic.ifc','2026-10-24T00:00:00',('ifc-lite'),(''),"
                "'deterministic synthetic generator','ifc-lite','MPL-2.0');\n"
                "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n" + '\n'.join(lines) + '\nENDSEC;\nEND-ISO-10303-21;\n')


BOX_POINTS = [(0, 0, 0), (2, 0, 0), (2, 1, 0), (0, 1, 0), (0, 0, 3), (2, 0, 3), (2, 1, 3), (0, 1, 3)]
# Outward loops, semantic roles explicitly independent of triangulation.
BOX_FACES = [('bottom', [0, 3, 2, 1]), ('top', [4, 5, 6, 7]), ('y_min', [0, 1, 5, 4]), ('x_max', [1, 2, 6, 5]), ('y_max', [2, 3, 7, 6]), ('x_min', [3, 0, 4, 7])]


def triangles():
    return [[v[0]+1, v[1]+1, v[2]+1] for _, v in BOX_FACES] + [[v[0]+1, v[2]+1, v[3]+1] for _, v in BOX_FACES]


def face_set(m, points=BOX_POINTS, indices=None):
    coords = m.add('IFCCARTESIANPOINTLIST3D', rows(points))
    indices = indices or triangles()
    return m.add('IFCTRIANGULATEDFACESET', coords, '$', '.T.', seq(seq(t) for t in indices), '$')


def texture(m, face, uv, indices):
    image = m.add('IFCIMAGETEXTURE', '.T.', '.F.', '$', '$', '$', "'checker.png'")
    coords = m.add('IFCTEXTUREVERTEXLIST', rows(uv))
    mapping = m.add('IFCINDEXEDTRIANGLETEXTUREMAP', seq([image]), face, coords, seq(seq(t) for t in indices))
    m.style(face, (1, 1, 1), image)
    return int(image[1:]), int(mapping[1:])
