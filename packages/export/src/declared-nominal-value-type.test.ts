/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `declaredNominalValueType` and `serializeNominalValue` on their own: which
 * source `dataType` tokens the #2482 fix writes back into an `IfcValue` slot,
 * and which it refuses.
 *
 * `dataType` is whatever token the source line carried, so writing it back
 * unconditionally would emit vendor tokens into a SELECT slot, wrap display
 * strings in measure types, and keep a constrained defined type over a value
 * its WHERE rule forbids. Each case below names a shape that must NOT be
 * written back, or a boundary the gate has to read exactly.
 *
 * Pure functions over the schema registry — no parse, no `MutablePropertyView`,
 * no `StepExporter`, and no IFC fixture. The regeneration behaviour these gate,
 * asserted through a real export, is the sibling file
 * `declared-property-type.test.ts`; the two share no imports, and a failure here
 * is a statement about the predicate rather than about the exporter.
 */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import {
  CONSTRAINED_IFC_VALUE_MEMBERS,
  declaredNominalValueType,
  serializeNominalValue,
} from './declared-property-type.js';
import { getSelectDefinedLeaves } from './select-qualification.js';

describe('the constrained-member table is closed, and its boundaries are the WHERE rules', () => {
  it('the domain boundary is the WHERE rule’s, not a truthiness test', () => {
    // `> 0` and `>= 0` differ only at zero, and zero is the value a falsy-guard
    // bug loses. Each pair below is one member either side of its own boundary.
    expect(declaredNominalValueType(0, PropertyValueType.Real, 'IFCPOSITIVELENGTHMEASURE')).toBe(
      'IfcLengthMeasure',
    );
    expect(declaredNominalValueType(0, PropertyValueType.Real, 'IFCNONNEGATIVELENGTHMEASURE')).toBe(
      'IfcNonNegativeLengthMeasure',
    );
    expect(declaredNominalValueType(0, PropertyValueType.Real, 'IFCNORMALISEDRATIOMEASURE')).toBe(
      'IfcNormalisedRatioMeasure',
    );
    expect(declaredNominalValueType(1, PropertyValueType.Real, 'IFCNORMALISEDRATIOMEASURE')).toBe(
      'IfcNormalisedRatioMeasure',
    );
    expect(
      declaredNominalValueType(1.0000001, PropertyValueType.Real, 'IFCNORMALISEDRATIOMEASURE'),
    ).toBe('IfcRatioMeasure');
    expect(declaredNominalValueType(0, PropertyValueType.Integer, 'IFCPOSITIVEINTEGER')).toBe(
      'IfcInteger',
    );
    expect(declaredNominalValueType(1, PropertyValueType.Integer, 'IFCPOSITIVEINTEGER')).toBe(
      'IfcPositiveInteger',
    );
  });

  it('the constrained-member table covers every constrained IfcValue leaf', () => {
    const leaves = getSelectDefinedLeaves('IfcValue');
    const covered = new Set(CONSTRAINED_IFC_VALUE_MEMBERS);

    // Every entry names a real leaf — a typo would silently gate nothing.
    for (const member of covered) expect(leaves.has(member)).toBe(true);

    // And the registry holds no constrained leaf the table has not heard of.
    // The name test is a coarse alarm, not the definition of a constraint: it is
    // used ONLY here, where over-firing costs a human a look at a schema bump
    // and under-firing is impossible for the naming IFC actually uses. It must
    // never be moved into the serializer, where the same looseness would decide
    // a file's contents.
    const looksConstrained = [...leaves.keys()].filter((name) =>
      /Positive|NonNegative|Normalised/.test(name),
    );
    expect(looksConstrained.length).toBeGreaterThan(0);
    expect([...looksConstrained].sort()).toEqual([...covered].sort());
  });

  it('every constrained member relaxes to an unconstrained IfcValue member', () => {
    // The fallback is only better than the shape-derived primitive if it exists.
    // A member whose chain leaves `IfcValue` would return null and quietly drop
    // to `IFCREAL`, so assert the relaxation lands for all six.
    const leaves = getSelectDefinedLeaves('IfcValue');
    for (const member of CONSTRAINED_IFC_VALUE_MEMBERS) {
      const base = leaves.get(member);
      const outOfDomain = member === 'IfcPositiveInteger' ? PropertyValueType.Integer : PropertyValueType.Real;
      const relaxed = declaredNominalValueType(-1, outOfDomain, member.toUpperCase());
      expect(relaxed, `${member} must relax to an unconstrained member`).not.toBeNull();
      expect(CONSTRAINED_IFC_VALUE_MEMBERS).not.toContain(relaxed);
      expect(leaves.get(relaxed as string)).toBe(base);
    }
  });
});

describe('declaredNominalValueType: which source tokens are written back', () => {
  it('accepts a member whose EXPRESS base agrees with the value type', () => {
    expect(declaredNominalValueType('x', PropertyValueType.String, 'IFCTEXT')).toBe('IfcText');
    expect(declaredNominalValueType('x', PropertyValueType.String, 'IFCIDENTIFIER')).toBe('IfcIdentifier');
    expect(declaredNominalValueType(1, PropertyValueType.Real, 'IFCLENGTHMEASURE')).toBe('IfcLengthMeasure');
    expect(declaredNominalValueType(1, PropertyValueType.Integer, 'IFCCOUNTMEASURE')).toBe('IfcCountMeasure');
    expect(declaredNominalValueType(true, PropertyValueType.Boolean, 'IFCBOOLEAN')).toBe('IfcBoolean');
    expect(declaredNominalValueType(true, PropertyValueType.Logical, 'IFCLOGICAL')).toBe('IfcLogical');
  });

  it('rejects a token the IfcValue SELECT does not contain', () => {
    // Vendor extensions and typos alike: the registry is the authority, not a
    // prefix test, so `IFC…` in the name buys nothing.
    expect(declaredNominalValueType('x', PropertyValueType.String, 'IFCACMEWIDGETCODE')).toBeNull();
    expect(declaredNominalValueType('x', PropertyValueType.String, 'IFCLABELL')).toBeNull();
    // An entity member of a select is not a qualifiable defined type either.
    expect(declaredNominalValueType('x', PropertyValueType.String, 'IFCWALL')).toBeNull();
  });

  it('rejects a member whose family disagrees with the value type', () => {
    // A session that retyped the property explicitly. The caller wins.
    expect(declaredNominalValueType('x', PropertyValueType.Label, 'IFCLENGTHMEASURE')).toBeNull();
    expect(declaredNominalValueType(1, PropertyValueType.Real, 'IFCTEXT')).toBeNull();
    expect(declaredNominalValueType(true, PropertyValueType.Boolean, 'IFCLOGICAL')).toBeNull();
    expect(declaredNominalValueType(true, PropertyValueType.Logical, 'IFCBOOLEAN')).toBeNull();
  });

  it('rejects a value that does not fit the member’s base', () => {
    // `serializeTypedMarker` coerces, so without this gate these become
    // `IFCLENGTHMEASURE(NaN)` and `IFCBOOLEAN(.F.)` — tokens carrying a value
    // the shape-derived path refused to write at all.
    expect(declaredNominalValueType('not a number', PropertyValueType.Real, 'IFCLENGTHMEASURE')).toBeNull();
    expect(declaredNominalValueType(NaN, PropertyValueType.Real, 'IFCLENGTHMEASURE')).toBeNull();
    expect(declaredNominalValueType('maybe', PropertyValueType.Boolean, 'IFCBOOLEAN')).toBeNull();
    expect(declaredNominalValueType(2.5, PropertyValueType.Integer, 'IFCINTEGER')).toBeNull();
  });

  it('rejects the property kinds that are not a single scalar IfcValue', () => {
    expect(declaredNominalValueType('external', PropertyValueType.Enum, 'IFCLABEL')).toBeNull();
    expect(declaredNominalValueType('#42', PropertyValueType.Reference, 'IFCIDENTIFIER')).toBeNull();
    expect(declaredNominalValueType(['a'], PropertyValueType.List, 'IFCLABEL')).toBeNull();
  });

  it('leaves a null value entirely to the shape-derived path', () => {
    // A null is the extractor's reading of `IFCLOGICAL(.U.)` as much as of an
    // absent value, and which one it is belongs to #2472's mapping table, not
    // here. Honouring `dataType` for it would fork that decision in two places.
    expect(declaredNominalValueType(null, PropertyValueType.Logical, 'IFCLOGICAL')).toBeNull();
    expect(declaredNominalValueType(undefined, PropertyValueType.String, 'IFCTEXT')).toBeNull();
  });

  it('a property with no dataType is unchanged', () => {
    // Every AUTHORED property, and every property read through a base table
    // that does not carry the token.
    expect(declaredNominalValueType('x', PropertyValueType.Text, undefined)).toBeNull();
    expect(serializeNominalValue('x', PropertyValueType.Text, undefined)).toBe(
      serializeNominalValue('x', PropertyValueType.Text, ''),
    );
  });

  it('serializeNominalValue emits the token, or falls back verbatim', () => {
    expect(serializeNominalValue('prose', PropertyValueType.String, 'IFCTEXT')).toBe("IFCTEXT('prose')");
    expect(serializeNominalValue(2500, PropertyValueType.Real, 'IFCLENGTHMEASURE')).toBe(
      'IFCLENGTHMEASURE(2500.)',
    );
    // Rejected token → exactly what the generator wrote before this module
    // existed. The escaping and REAL formatting are the fallback's, unchanged.
    expect(serializeNominalValue("it's", PropertyValueType.String, 'IFCACMEWIDGETCODE')).toBe(
      "IFCLABEL('it''s')",
    );
    expect(serializeNominalValue(1.5e-7, PropertyValueType.Real, 'IFCACMEWIDGETCODE')).toBe(
      'IFCREAL(1.5E-7)',
    );
  });
});
