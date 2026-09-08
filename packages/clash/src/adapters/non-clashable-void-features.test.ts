/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A void is a void whatever the schema calls it.
 *
 * `NON_CLASHABLE_TAGS` listed `IfcOpeningElement` and `IfcOpeningStandardCase`
 * by hand — one branch of the subtraction family, in its IFC4 spelling. IFC4
 * also has `IfcVoidingFeature` and IFC4.3 adds `IfcEarthworksCut`; both are
 * `IfcFeatureElementSubtraction` subtypes, both are meshed like any other
 * product, and both were clash candidates. A void that clashes with the
 * element it cuts is the exact phantom-clash symptom #1464 was filed for,
 * surviving under a class name the list had not heard of.
 *
 * The assertions below are DERIVED from the schema registry rather than from a
 * second hand-typed list of the same names: a test that restates the table it
 * guards can only ever confirm the copy. The enumeration walks the parser's
 * IFC4 registry; the IFC4.3-only leaves are named, and their membership of the
 * family is itself derived through `getInheritanceChainAcrossSchemas` — the
 * same walk the production predicate uses — so neither half is asserted from a
 * copy.
 */

import { describe, expect, it } from 'vitest';
import { getInheritanceChainAcrossSchemas, SCHEMA_REGISTRY } from '@ifc-lite/parser';
import { isNonClashableTag } from './shared.js';

/** Classes whose inheritance chain reaches `ancestor` in any bundled schema. */
function descendantsOf(ancestor: string, extra: readonly string[] = []): string[] {
  const candidates = new Set([...Object.keys(SCHEMA_REGISTRY.entities), ...extra]);
  return [...candidates]
    .filter((name) => getInheritanceChainAcrossSchemas(name).includes(ancestor))
    .sort();
}

/**
 * IFC4.3 subtraction leaves, named rather than counted. They are outside the
 * parser's IFC4 codegen pin, so the registry walk cannot enumerate them — but
 * `descendantsOf` still has to CONFIRM each one descends from the family
 * before it is asserted on, which is what keeps this from being a hand-copy.
 */
const IFC4X3_SUBTRACTION_LEAVES = ['IfcEarthworksCut'] as const;

const VOIDS = descendantsOf('IfcFeatureElementSubtraction', IFC4X3_SUBTRACTION_LEAVES);
const ADDITIONS = descendantsOf('IfcFeatureElementAddition');

describe('every subtraction feature is dropped before it can become a clash candidate', () => {
  it('finds the subtraction family in the bundled schemas (anti-vacuity)', () => {
    // An empty derivation would let the per-name loop below report success over
    // a set it never examined. Named, not counted: a count floor reds on benign
    // schema growth and stays silent in the case that matters.
    expect(VOIDS).toEqual(
      expect.arrayContaining([
        'IfcFeatureElementSubtraction',
        'IfcOpeningElement',
        'IfcOpeningStandardCase',
        'IfcVoidingFeature',
        'IfcEarthworksCut',
      ]),
    );
  });

  it.each(VOIDS)('%s is not a clash candidate', (tag) => {
    expect(isNonClashableTag(tag)).toBe(true);
  });

  it('keeps real building elements clashable (control fixture)', () => {
    // Without this, a predicate that answered `true` unconditionally would
    // satisfy every assertion above.
    for (const tag of ['IfcWall', 'IfcSlab', 'IfcColumn', 'IfcBeam', 'IfcPipeSegment']) {
      expect(isNonClashableTag(tag), `${tag} must stay clashable`).toBe(false);
    }
  });

  it('keeps ADDITION features clashable — they are physical material', () => {
    // `IfcProjectionElement` (a corbel) and `IfcSurfaceFeature` descend from
    // `IfcFeatureElementAddition`, not Subtraction. They occupy space, so a
    // clash against them is a real coordination problem; widening the filter
    // to the whole `IfcFeatureElement` tree would hide it.
    expect(ADDITIONS).toEqual(expect.arrayContaining(['IfcProjectionElement']));
    for (const tag of ADDITIONS) {
      expect(isNonClashableTag(tag), `${tag} must stay clashable`).toBe(false);
    }
    // `IfcSurfaceFeature` hangs off `IfcFeatureElement` directly rather than
    // off either branch — a surface treatment, still physical. It is named
    // here because no derivation puts it in a family; the point of the case is
    // that the filter must not swallow it along with the voids.
    expect(getInheritanceChainAcrossSchemas('IfcSurfaceFeature')).toContain('IfcFeatureElement');
    expect(isNonClashableTag('IfcSurfaceFeature')).toBe(false);
  });
});
