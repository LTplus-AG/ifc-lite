# SPDX-License-Identifier: MPL-2.0
"""#7955 equivalent PBHS boundary encodings; independent deterministic IFC writer.

Square: area 4. Quarter-disc: area pi. Both remove the upper 2 m of a 4 m cube.
Uses step.Model, as the other synthetic-retained generators do.
"""
import argparse
import math
from pathlib import Path
from step import Model, real, rows, seq


def generate():
    m = Model('M6-equivalent-boundaries')
    host = m.box((4, 4, 4), (2, 2))
    plane_axes = m.add('IFCAXIS2PLACEMENT3D', m.point((0, 0, 2)), '$', '$')
    plane = m.add('IFCPLANE', plane_axes)

    def indexed(points, segments):
        coords = m.add('IFCCARTESIANPOINTLIST2D', rows(points))
        return m.add('IFCINDEXEDPOLYCURVE', coords, segments, '.F.')

    def trimmed_line(a, b, cartesian=False):
        # Descending parameters and SenseAgreement false: do not reverse twice.
        direction = tuple(a[i]-b[i] for i in range(2))
        length = math.hypot(*direction)
        vector = m.add('IFCVECTOR', m.direction(direction), real(length))
        basis = m.add('IFCLINE', m.point(b), vector)
        trims = [seq([m.point(p)]) for p in (a, b)] if cartesian else ['(IFCPARAMETERVALUE(1.))', '(IFCPARAMETERVALUE(0.))']
        return m.add('IFCTRIMMEDCURVE', basis, *trims, '.F.', '.CARTESIAN.' if cartesian else '.PARAMETER.')

    def composite(curves):
        return m.add('IFCCOMPOSITECURVE', seq(m.add('IFCCOMPOSITECURVESEGMENT', '.CONTINUOUS.', '.T.', c) for c in curves), '.F.')

    square = [(0.5, 0.5), (2.5, 0.5), (2.5, 2.5), (0.5, 2.5), (0.5, 0.5)]
    boundaries = [indexed(square, '(IFCLINEINDEX((1,2,3,4,5)))'), indexed(square, '$'),
                  composite([trimmed_line(a, b) for a, b in zip(square, square[1:])])]
    quarter = [(2, 0), (math.sqrt(2), math.sqrt(2)), (0, 2), (0, 0)]
    boundaries.append(indexed(quarter, '(IFCARCINDEX((1,2,3)),IFCLINEINDEX((3,4,1)))'))
    for cartesian in (False, True):
        # Rotated circle placement makes the local trim angle differ from world.
        axes = m.add('IFCAXIS2PLACEMENT2D', m.point((0, 0)), m.direction((0, 1)))
        circle = m.add('IFCCIRCLE', axes, '2.')
        trims = [seq([m.point(p)]) for p in ((2, 0), (0, 2))] if cartesian else [f'(IFCPARAMETERVALUE({real(-math.pi/2)}))', '(IFCPARAMETERVALUE(0.))']
        arc = m.add('IFCTRIMMEDCURVE', circle, *trims, '.T.', '.CARTESIAN.' if cartesian else '.PARAMETER.')
        boundaries.append(composite([arc, trimmed_line((0, 2), (0, 0), cartesian), trimmed_line((0, 0), (2, 0), cartesian)]))
    names = ['square-explicit', 'square-omitted', 'square-trimmed', 'quarter-explicit', 'quarter-parameter', 'quarter-cartesian']
    # IFC4 PBHS BoundaryType requires a composite wrapper for indexed curves.
    boundaries = [composite([b]) if i in (0, 1, 3) else b for i, b in enumerate(boundaries)]
    circle_axes = m.add('IFCAXIS2PLACEMENT2D', m.point((1, 1)), '$')
    circle = m.add('IFCCIRCLE', circle_axes, '0.5')
    halves = [m.add('IFCTRIMMEDCURVE', circle,
                    f'(IFCPARAMETERVALUE({real(a)}))', f'(IFCPARAMETERVALUE({real(b)}))', '.T.', '.PARAMETER.')
              for a, b in [(0, math.pi), (math.pi, 2*math.pi)]]
    boundaries.append(composite(halves))
    names.append('circle-with-opening')
    for i, (name, boundary) in enumerate(zip(names, boundaries)):
        half = m.add('IFCPOLYGONALBOUNDEDHALFSPACE', plane, '.F.', m.axes, boundary)
        difference = m.add('IFCBOOLEANCLIPPINGRESULT', '.DIFFERENCE.', host, half)
        # Stable product ids separate from the writer's internal record ids.
        saved = m.next
        m.next = 1000+i*10
        product = m.product(name, difference, 'Clipping')
        m.next = saved
        if name == 'circle-with-opening':
            m.opening(product, 'disjoint-opening', size=(0.5, 0.5, 1), center=(3, 3))
    return m.finish()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    path = Path(__file__).with_name('m6-equivalent-boundaries.ifc')
    source = generate()
    if args.check:
        if path.read_text() != source:
            raise SystemExit('stale generated fixture: '+str(path))
    else:
        path.write_text(source)
    print(path.name)
