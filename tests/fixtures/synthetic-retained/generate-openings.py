# SPDX-License-Identifier: MPL-2.0
"""M3 candidate fixture. UNREVIEWED: deliberately excluded from evidence/universe.

Schema, independent oracle and third-party round-trip review are pending.
This generator records intent only; it does not certify geometry or outcomes.
"""
import argparse
import math
from pathlib import Path
from step import Model, seq


def generate():
    m = Model('f-d-openings-unreviewed')
    cases = []

    def product(name, items, placement, entity='IFCWALL', label='Body', kind='SweptSolid'):
        shape = m.add('IFCPRODUCTDEFINITIONSHAPE', '$', '$', seq([m.shape(items, kind=kind, label=label)]))
        result = m.add(entity, m.gid(name), '$', repr(name), '$', '$', placement, shape, '$',
                       '.OPENING.' if entity == 'IFCOPENINGELEMENT' else '.NOTDEFINED.')
        if entity != 'IFCOPENINGELEMENT':
            m.products.append(result)
        return result

    def mapped(items, scale='1.'):
        representation = m.shape(items)
        mapping = m.add('IFCREPRESENTATIONMAP', m.axes, representation)
        transform = m.add('IFCCARTESIANTRANSFORMATIONOPERATOR3D', '$', '$', m.origin, scale, '$')
        return m.add('IFCMAPPEDITEM', mapping, transform)

    for index, case in enumerate('abcdefghijk'):
        placement = m.place((20 * index, 0, 0))
        if case == 'a':
            placement = m.place((2.6e6, 1e5, 0), x=(math.sqrt(3)/2, 0.5, 0))
        host_items = [m.box((4, 0.2, 3), (2, 0.1))]
        if case == 'b':
            host_items = [mapped(host_items)]
        if case == 'd':
            host_items = [m.box((1, 0.2, 3), (0.5, 0.1)), m.box((1, 0.2, 3), (3.5, 0.1))]
        host = product(case + '-host', host_items, placement, 'IFCSLAB' if case == 'e' else 'IFCWALL',
                       kind='MappedRepresentation' if case == 'b' else 'SweptSolid')
        # Nonidentity PlacementRelTo for (a) exercises both relative rotation and translation.
        opening_place = m.place((0.5, -1.2, 0.3), x=(0.8, 0.6, 0), parent=placement) if case == 'a' else placement
        size, center = (1, 0.4, 2), (2, 0.1)
        if case == 'd':
            size, center = (2, 1, 4), (0.5, 0.1)
        elif case == 'e':
            size, center = (6, 2, 5), (2, 0.1)
        elif case == 'f':
            center = (100, 0.1)
        if case in 'de':
            opening_place = m.place((0, 0, -1), parent=placement)
        cutter_items = [m.box(size, center)]
        if case == 'c':
            # Two distinct mapped cutter values; future sequencer must use both.
            cutter_items.append(m.box((0.5, 0.4, 1), (3, 0.1)))
        if case in 'ci':
            cutter_items = [mapped(cutter_items, '2.' if case == 'i' else '1.')]
        opening = product(case + '-opening', cutter_items, opening_place, 'IFCOPENINGELEMENT',
                          'Reference' if case == 'g' else ('Axis' if case == 'h' else 'Body'),
                          kind='MappedRepresentation' if case in 'ci' else 'SweptSolid')
        m.add('IFCRELVOIDSELEMENT', m.gid(case + '-void'), '$', '$', '$', host, opening)
        if case in 'jk':
            material = m.add('IFCMATERIAL', "'synthetic'", '$', '$')
            layers_list = [m.add('IFCMATERIALLAYER', material, '0.2' if case == 'j' else '0.1', '$', '$', '$', '$', '$')]
            if case == 'k':
                layers_list.append(m.add('IFCMATERIALLAYER', material, '0.1', '$', '$', '$', '$', '$'))
            layers = m.add('IFCMATERIALLAYERSET', seq(layers_list), "'synthetic'", '$')
            usage = m.add('IFCMATERIALLAYERSETUSAGE', layers, '.AXIS2.', '.POSITIVE.', '0.', '$')
            m.add('IFCRELASSOCIATESMATERIAL', m.gid('layers' if case == 'j' else 'two-layers'), '$', '$', '$', seq([host]), usage)
        cases.append(f'/* UNREVIEWED M3 case ({case}): host {host}, opening {opening}. */')
    text = m.finish().replace('DATA;\n', 'DATA;\n' + '\n'.join(cases) + '\n', 1)
    return text.replace('SYNTHETIC; issue 7955; not authoring-tool evidence',
                        'SYNTHETIC UNREVIEWED NON-EVIDENCE; M3-0 issue 7955')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    output = Path(__file__).with_name('f-d-openings.ifc')
    text = generate()
    if args.check:
        if output.read_text() != text:
            raise SystemExit('unreviewed fixture differs from generator')
    else:
        output.write_text(text)
