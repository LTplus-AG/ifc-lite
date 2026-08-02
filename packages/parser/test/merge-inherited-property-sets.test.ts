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
import { mergeInheritedPropertySets } from '../src/property-set-merge.js';

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

  it('augments EVERY same-named occurrence set, not just the first', () => {
    // Nothing dedupes occurrence sets by name — `extractPsetsFromIds` emits one
    // per IfcRelDefinesByProperties — and IDS requires every set matching the
    // facet's propertySet constraint to satisfy it. Augmenting only the first
    // would leave its twin bare and reintroduce the false "not found".
    const own = [
      set('Pset_CoveringCommon', [['IsExternal', true]]),
      set('Pset_CoveringCommon', [['Reference', 'R1']]),
    ];
    const inherited = [set('Pset_CoveringCommon', [['SurfaceSpreadOfFlame', 'B']])];

    const merged = mergeInheritedPropertySets(own, inherited);

    expect(merged).toHaveLength(2);
    for (const s of merged) {
      expect(s.properties.map((p) => p.name)).toContain('SurfaceSpreadOfFlame');
    }
    // The occurrence-specific properties are still distinct per set.
    expect(merged[0].properties.map((p) => p.name)).toEqual(['IsExternal', 'SurfaceSpreadOfFlame']);
    expect(merged[1].properties.map((p) => p.name)).toEqual(['Reference', 'SurfaceSpreadOfFlame']);
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

  it('appends same-named inherited sets independently when the occurrence has none', () => {
    // `indicesByName` tracks occurrence sets only. Recording an appended
    // inherited set there would fold the second one into the first, collapsing
    // two type-side sets into one — a different operation from inheritance.
    const inherited = [
      set('Pset_WallCommon', [['FireRating', 'REI 90']]),
      set('Pset_WallCommon', [['IsExternal', true]]),
    ];

    const merged = mergeInheritedPropertySets([], inherited);

    expect(merged).toHaveLength(2);
    expect(propsOf([merged[0]], 'Pset_WallCommon')).toEqual(['FireRating']);
    expect(merged[1].properties.map((p) => p.name)).toEqual(['IsExternal']);
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
