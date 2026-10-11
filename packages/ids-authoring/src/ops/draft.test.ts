/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { matchConstraint, type IDSConstraint } from '@ifc-lite/ids';
import { describe, expect, it } from 'vitest';
import { DraftError, facetFromDraft, normaliseValue } from './draft.js';
import type { ConstraintDraft } from './types.js';
import { toSI } from './units.js';

describe('ConstraintDraft → IDSConstraint (table per kind)', () => {
  const cases: [string, ConstraintDraft, IDSConstraint | undefined][] = [
    ['any removes the constraint', { kind: 'any' }, undefined],
    ['equals string', { kind: 'equals', value: 'EI60' }, { type: 'simpleValue', value: 'EI60' }],
    ['equals number', { kind: 'equals', value: 2.5 }, { type: 'simpleValue', value: '2.5' }],
    ['equals boolean', { kind: 'equals', value: true }, { type: 'simpleValue', value: 'true' }],
    ['oneOf strings dedupes', { kind: 'oneOf', values: ['A', 'B', 'A'] }, { type: 'enumeration', values: ['A', 'B'] }],
    ['oneOf numbers infers xs:double', { kind: 'oneOf', values: [1, 2] }, { type: 'enumeration', values: ['1', '2'], base: 'xs:double' }],
    ['oneOf booleans infers xs:boolean', { kind: 'oneOf', values: [true, false] }, { type: 'enumeration', values: ['true', 'false'], base: 'xs:boolean' }],
    ['oneOf explicit base wins', { kind: 'oneOf', values: [1, 2], base: 'xs:integer' }, { type: 'enumeration', values: ['1', '2'], base: 'xs:integer' }],
    ['pattern', { kind: 'pattern', pattern: 'EI[0-9]+' }, { type: 'pattern', pattern: 'EI[0-9]+' }],
    ['range inclusive default', { kind: 'range', min: 1, max: 2 }, { type: 'bounds', minInclusive: 1, maxInclusive: 2 }],
    [
      'range exclusive flags',
      { kind: 'range', min: 1, minInclusive: false, max: 2, maxInclusive: false },
      { type: 'bounds', minExclusive: 1, maxExclusive: 2 },
    ],
    ['range unit mm → m', { kind: 'range', min: 2400, unit: 'mm' }, { type: 'bounds', minInclusive: 2.4 }],
    ['range unit degC → K', { kind: 'range', max: 20, unit: '°C' }, { type: 'bounds', maxInclusive: 293.15 }],
    ['range unit kN → N', { kind: 'range', max: 3, unit: 'kN' }, { type: 'bounds', maxInclusive: 3000 }],
    ['length exact', { kind: 'length', exact: 3 }, { type: 'bounds', length: 3 }],
    ['length min/max', { kind: 'length', min: 1, max: 5 }, { type: 'bounds', minLength: 1, maxLength: 5 }],
    ['digits', { kind: 'digits', total: 5, fraction: 2 }, { type: 'bounds', totalDigits: 5, fractionDigits: 2 }],
    [
      'all: bounds merge, first family primary, rest in and',
      { kind: 'all', of: [{ kind: 'pattern', pattern: '[A-Z]+' }, { kind: 'length', max: 4 }, { kind: 'length', min: 2 }] },
      { type: 'pattern', pattern: '[A-Z]+', and: [{ type: 'bounds', maxLength: 4, minLength: 2 }] },
    ],
    [
      'all: a literal becomes a one-value enumeration',
      { kind: 'all', of: [{ kind: 'equals', value: 'AB' }, { kind: 'length', exact: 2 }] },
      { type: 'enumeration', values: ['AB'], and: [{ type: 'bounds', length: 2 }] },
    ],
  ];
  it.each(cases)('%s', (_label, draft, expected) => {
    expect(normaliseValue(draft)).toEqual(expected);
  });

  it('round-trips raw constraints untouched', () => {
    const raw: IDSConstraint = { type: 'bounds', minInclusive: 0, base: 'xs:integer', unparseableFacets: [{ facet: 'x', rawValue: 'y' }] };
    expect(normaliseValue({ kind: 'raw', constraint: raw })).toBe(raw);
  });

  it('stores literal entity names and dataTypes upper-case, as IDS XML does', () => {
    expect(normaliseValue({ kind: 'equals', value: 'IfcWall' }, 'entity.name')).toEqual({ type: 'simpleValue', value: 'IFCWALL' });
    expect(normaliseValue({ kind: 'oneOf', values: ['IfcLabel'] }, 'property.dataType')).toEqual({ type: 'enumeration', values: ['IFCLABEL'] });
    expect(normaliseValue({ kind: 'equals', value: 'Pset_WallCommon' }, 'property.propertySet')).toEqual({
      type: 'simpleValue',
      value: 'Pset_WallCommon',
    });
    // Patterns are never rewritten.
    expect(normaliseValue({ kind: 'pattern', pattern: 'IfcW.*' }, 'entity.name')).toEqual({ type: 'pattern', pattern: 'IfcW.*' });
  });

  it.each<[string, ConstraintDraft]>([
    ['unknown unit', { kind: 'range', min: 1, unit: 'furlong' }],
    ['empty range', { kind: 'range' }],
    ['exact plus min length', { kind: 'length', exact: 2, min: 1 }],
    ['empty digits', { kind: 'digits' }],
    ['all with any', { kind: 'all', of: [{ kind: 'any' }] }],
    ['all setting a bound twice', { kind: 'all', of: [{ kind: 'range', min: 1 }, { kind: 'range', min: 2 }] }],
    ['conflicting bases', { kind: 'all', of: [{ kind: 'oneOf', values: [1] }, { kind: 'pattern', pattern: 'a', base: 'xs:string' }] }],
    ['non-finite', { kind: 'equals', value: Number.NaN }],
  ])('rejects %s with GATE-VAL-001', (_label, draft) => {
    expect(() => normaliseValue(draft)).toThrow(DraftError);
  });

  it('produces constraints the IDS matcher evaluates as the draft says', () => {
    const range = normaliseValue({ kind: 'range', min: 2400, max: 3000, unit: 'mm' })!;
    expect(matchConstraint(range, 2.5)).toBe(true);
    expect(matchConstraint(range, 3.1)).toBe(false);
    const all = normaliseValue({ kind: 'all', of: [{ kind: 'pattern', pattern: '[A-Z]+' }, { kind: 'length', max: 3 }] })!;
    expect(matchConstraint(all, 'ABC')).toBe(true);
    expect(matchConstraint(all, 'ABCD')).toBe(false);
    expect(matchConstraint(all, 'abc')).toBe(false);
  });
});

describe('FacetDraft → IDSFacet', () => {
  it('builds each facet type and drops any-valued optional fields', () => {
    expect(
      facetFromDraft({
        type: 'property',
        propertySet: { kind: 'equals', value: 'Pset_WallCommon' },
        baseName: { kind: 'equals', value: 'FireRating' },
        dataType: { kind: 'equals', value: 'IfcLabel' },
        value: { kind: 'any' },
      }),
    ).toEqual({
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_WallCommon' },
      baseName: { type: 'simpleValue', value: 'FireRating' },
      dataType: { type: 'simpleValue', value: 'IFCLABEL' },
    });
    expect(
      facetFromDraft({ type: 'partOf', relation: 'IfcRelAggregates', entity: { name: { kind: 'equals', value: 'IfcBuildingStorey' } } }),
    ).toEqual({ type: 'partOf', relation: 'IfcRelAggregates', entity: { type: 'entity', name: { type: 'simpleValue', value: 'IFCBUILDINGSTOREY' } } });
    expect(facetFromDraft({ type: 'material' })).toEqual({ type: 'material' });
    expect(() => facetFromDraft({ type: 'entity', name: { kind: 'any' } })).toThrow(DraftError);
  });
});

describe('toSI', () => {
  it('strips binary noise from decimal scales', () => {
    expect(toSI(2400, 'mm')).toBe(2.4);
    expect(toSI(1, 'ft2')).toBe(0.09290304);
    expect(toSI(32, 'degF')).toBeCloseTo(273.15, 10);
  });
});
