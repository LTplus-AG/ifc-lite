/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `mergeInheritedPropertySets` composes an occurrence's own property sets with
 * the ones it inherits from its IfcTypeProduct. IFC inherits per PROPERTY, not
 * per property set — treating a name collision as "occurrence replaces type"
 * hides every type-only property in that set (#1913).
 */

import { describe, it, expect } from 'vitest';
import { mergeInheritedPropertySets } from '../src/columnar-parser.js';

type Set_ = { name: string; properties: Array<{ name: string; value?: unknown }> };

const set = (name: string, props: Array<[string, unknown]>): Set_ => ({
  name,
  properties: props.map(([n, v]) => ({ name: n, value: v })),
});

const propsOf = (sets: Set_[], name: string) =>
  sets.find((s) => s.name === name)?.properties.map((p) => p.name) ?? [];

describe('mergeInheritedPropertySets', () => {
  it('unions the properties of same-named occurrence and type sets', () => {
    // The #1913 shape.
    const own = [set('Pset_CoveringCommon', [['IsExternal', true], ['Reference', 'R1']])];
    const inherited = [
      set('Pset_CoveringCommon', [
        ['Combustible', false],
        ['SurfaceSpreadOfFlame', 'B'],
        ['ThermalTransmittance', 0],
      ]),
    ];

    const merged = mergeInheritedPropertySets(own, inherited);

    expect(merged).toHaveLength(1);
    expect(propsOf(merged, 'Pset_CoveringCommon')).toEqual([
      'IsExternal',
      'Reference',
      'Combustible',
      'SurfaceSpreadOfFlame',
      'ThermalTransmittance',
    ]);
  });

  it('lets the occurrence value win where both define the same property', () => {
    const own = [set('Pset_WallCommon', [['FireRating', 'REI 90']])];
    const inherited = [set('Pset_WallCommon', [['FireRating', 'REI 30'], ['IsExternal', true]])];

    const merged = mergeInheritedPropertySets(own, inherited);

    const fireRating = merged[0].properties.find((p) => p.name === 'FireRating');
    expect(fireRating?.value).toBe('REI 90');
    expect(propsOf(merged, 'Pset_WallCommon')).toEqual(['FireRating', 'IsExternal']);
  });

  it('appends an inherited set whose name the occurrence does not use', () => {
    const own = [set('Pset_WallCommon', [['IsExternal', true]])];
    const inherited = [set('Pset_ManufacturerTypeInformation', [['Manufacturer', 'Acme']])];

    const merged = mergeInheritedPropertySets(own, inherited);

    expect(merged.map((s) => s.name)).toEqual([
      'Pset_WallCommon',
      'Pset_ManufacturerTypeInformation',
    ]);
  });

  it('mutates neither input — extractor results are cached and reused', () => {
    const own = [set('Pset_WallCommon', [['IsExternal', true]])];
    const inherited = [set('Pset_WallCommon', [['FireRating', 'REI 90']])];

    mergeInheritedPropertySets(own, inherited);

    expect(propsOf(own, 'Pset_WallCommon')).toEqual(['IsExternal']);
    expect(propsOf(inherited, 'Pset_WallCommon')).toEqual(['FireRating']);
  });

  it('returns the occurrence sets unchanged when nothing is inherited', () => {
    const own = [set('Pset_WallCommon', [['IsExternal', true]])];
    expect(mergeInheritedPropertySets(own, [])).toEqual(own);
  });
});
