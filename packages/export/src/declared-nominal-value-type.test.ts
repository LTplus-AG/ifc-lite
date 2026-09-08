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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import {
  CONSTRAINED_IFC_VALUE_MEMBERS,
  declaredNominalValueType,
  serializeNominalValue,
} from './declared-property-type.js';
import { getSelectDefinedLeaves } from './select-qualification.js';

/** The bundled buildingSMART EXPRESS schemas — the authority on WHERE rules. */
const SCHEMA_FILES = ['IFC4_ADD2_TC1.exp', 'IFC4X3.exp'] as const;

/**
 * Every `IfcValue` defined-type leaf whose EXPRESS declaration carries a WHERE
 * rule, read out of the bundled schemas.
 *
 * This is deliberately NOT a test that asserts on the text of its own subject:
 * the text read here is the buildingSMART schema, the external authority the
 * table is a transcription OF, and nothing about `declared-property-type.ts` is
 * read. Asking the question any other way is what let #3268 happen — the
 * previous version guessed constrained-ness from the member's NAME
 * (`/Positive|NonNegative|Normalised/`), which is silent about `IfcPHMeasure`
 * (`{0.0 <= SELF <= 14.0}`) and `IfcHeatingValueMeasure` (`SELF > 0.`).
 */
function constrainedIfcValueLeavesFromSchemas(): Set<string> {
  const leaves = getSelectDefinedLeaves('IfcValue');
  const constrained = new Set<string>();
  for (const file of SCHEMA_FILES) {
    const text = readFileSync(new URL(`../../codegen/schemas/${file}`, import.meta.url), 'utf8');
    for (const match of text.matchAll(/\bTYPE\s+(\w+)\s*=([\s\S]*?)END_TYPE\s*;/gi)) {
      const [, name, body] = match;
      // Only members the serializer can actually reach: an `IfcValue` leaf the
      // registry resolves to an EXPRESS primitive. `IfcCompoundPlaneAngleMeasure`
      // is constrained but is a LIST, so it is no leaf here and no token this
      // module can write.
      if (!leaves.has(name)) continue;
      if (/\bWHERE\b/i.test(body)) constrained.add(name);
    }
  }
  return constrained;
}

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

    // And the SCHEMA holds no constrained leaf the table has not heard of.
    // Derived from the WHERE rules, not from the member's name: a name test is
    // silent about `IfcPHMeasure` and `IfcHeatingValueMeasure` (#3268).
    const fromSchemas = constrainedIfcValueLeavesFromSchemas();
    // Anti-vacuity: a broken parse or a moved schema path would produce an
    // empty set, and an empty set agrees with an empty table.
    expect(fromSchemas.size).toBeGreaterThan(0);
    expect(fromSchemas.has('IfcPHMeasure')).toBe(true);
    expect(fromSchemas.has('IfcHeatingValueMeasure')).toBe(true);
    expect([...fromSchemas].sort()).toEqual([...covered].sort());
  });

  it('every constrained member takes its named relaxation, or a valid IFCREAL', () => {
    // The relaxation target of each member is NAMED, not merely asserted to be
    // "some unconstrained member": the two whose alias chain leaves `IfcValue`
    // in one step (`= REAL`) have no ancestor to relax to and must land on the
    // shape-derived `IFCREAL`, which is still schema-valid. Reading that
    // outcome as a defect — or the reverse, letting a member that DOES have an
    // ancestor silently lose its unit semantics — is what a named table
    // prevents and a generic "not null" check does not.
    const RELAXES_TO: ReadonlyMap<string, string | null> = new Map([
      ['IfcPositiveLengthMeasure', 'IfcLengthMeasure'],
      ['IfcNonNegativeLengthMeasure', 'IfcLengthMeasure'],
      ['IfcPositiveRatioMeasure', 'IfcRatioMeasure'],
      ['IfcNormalisedRatioMeasure', 'IfcRatioMeasure'],
      ['IfcPositivePlaneAngleMeasure', 'IfcPlaneAngleMeasure'],
      ['IfcPositiveInteger', 'IfcInteger'],
      ['IfcPHMeasure', null],
      ['IfcHeatingValueMeasure', null],
    ]);

    // The table above must name every member and no other — otherwise a member
    // added to `CONSTRAINED_MEMBERS` could go untested here.
    expect([...RELAXES_TO.keys()].sort()).toEqual([...CONSTRAINED_IFC_VALUE_MEMBERS].sort());

    const leaves = getSelectDefinedLeaves('IfcValue');
    for (const [member, expected] of RELAXES_TO) {
      const base = leaves.get(member);
      const outOfDomain =
        member === 'IfcPositiveInteger' ? PropertyValueType.Integer : PropertyValueType.Real;
      const relaxed = declaredNominalValueType(-1, outOfDomain, member.toUpperCase());
      expect(relaxed, `${member} relaxation target`).toBe(expected);
      if (expected !== null) {
        expect(CONSTRAINED_IFC_VALUE_MEMBERS).not.toContain(expected);
        expect(leaves.get(expected)).toBe(base);
      } else {
        // No ancestor: the emitted token is the shape-derived primitive, and it
        // must still be a valid `IfcValue` member rather than the member whose
        // domain the value just violated.
        const emitted = serializeNominalValue(-1, outOfDomain, member.toUpperCase());
        expect(emitted).toBe('IFCREAL(-1.)');
        expect(emitted).not.toContain(member.toUpperCase());
      }
    }
  });

  it('a value outside IfcPHMeasure or IfcHeatingValueMeasure is never re-declared as one', () => {
    // #3268, both directions of each rule, and both ends of the pH range.
    // `IfcPHMeasure` WHERE WR21 : {0.0 <= SELF <= 14.0}
    expect(serializeNominalValue(7, PropertyValueType.Real, 'IFCPHMEASURE')).toBe(
      'IFCPHMEASURE(7.)',
    );
    expect(serializeNominalValue(0, PropertyValueType.Real, 'IFCPHMEASURE')).toBe(
      'IFCPHMEASURE(0.)',
    );
    expect(serializeNominalValue(14, PropertyValueType.Real, 'IFCPHMEASURE')).toBe(
      'IFCPHMEASURE(14.)',
    );
    expect(serializeNominalValue(-0.0001, PropertyValueType.Real, 'IFCPHMEASURE')).toBe(
      'IFCREAL(-0.0001)',
    );
    expect(serializeNominalValue(14.0001, PropertyValueType.Real, 'IFCPHMEASURE')).toBe(
      'IFCREAL(14.0001)',
    );

    // `IfcHeatingValueMeasure` WHERE WR1 : SELF > 0. — zero is out.
    expect(serializeNominalValue(1, PropertyValueType.Real, 'IFCHEATINGVALUEMEASURE')).toBe(
      'IFCHEATINGVALUEMEASURE(1.)',
    );
    expect(serializeNominalValue(0, PropertyValueType.Real, 'IFCHEATINGVALUEMEASURE')).toBe(
      'IFCREAL(0.)',
    );
    expect(serializeNominalValue(-5, PropertyValueType.Real, 'IFCHEATINGVALUEMEASURE')).toBe(
      'IFCREAL(-5.)',
    );

    // Negative control: an UNCONSTRAINED neighbour over the same base keeps its
    // token at the same values, so the two assertions above are about the WHERE
    // rule and not about negative numbers in general.
    expect(serializeNominalValue(-5, PropertyValueType.Real, 'IFCPOWERMEASURE')).toBe(
      'IFCPOWERMEASURE(-5.)',
    );
    expect(serializeNominalValue(99, PropertyValueType.Real, 'IFCPOWERMEASURE')).toBe(
      'IFCPOWERMEASURE(99.)',
    );
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
    expect(declaredNominalValueType(1, PropertyValueType.Real, 'IFCTEXT')).toBeNull();
    expect(declaredNominalValueType(true, PropertyValueType.Boolean, 'IFCLOGICAL')).toBeNull();
    expect(declaredNominalValueType(true, PropertyValueType.Logical, 'IFCBOOLEAN')).toBeNull();
  });

  it('a caller-named member outranks a disagreeing source token, and emits the same text', () => {
    // `Label` over an `IFCLENGTHMEASURE` is the same "caller retyped it, caller
    // wins" case as the test above, but since #3715 the answer is reached by
    // NAMING `IfcLabel` rather than by falling through to the shape-derived
    // path. Both write the identical line, which is the assertion that matters
    // — the return value is an implementation detail, the emitted token is not.
    expect(declaredNominalValueType('x', PropertyValueType.Label, 'IFCLENGTHMEASURE')).toBe('IfcLabel');
    expect(serializeNominalValue('x', PropertyValueType.Label, 'IFCLENGTHMEASURE')).toBe(
      "IFCLABEL('x')",
    );
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
    // that does not carry the token. A caller-NAMED member answers with its own
    // member here since #3715 (there is no source token to outrank), and the
    // emitted text is the same one the shape-derived fallback wrote.
    expect(declaredNominalValueType('x', PropertyValueType.String, undefined)).toBeNull();
    expect(serializeNominalValue('x', PropertyValueType.Text, undefined)).toBe("IFCTEXT('x')");
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

describe('a caller-named member changes the declared type within one EXPRESS base (#3715)', () => {
  // `IfcLabel` -> `IfcText` (a value outgrowing 255 characters) and
  // `IfcLabel` -> `IfcIdentifier` are ordinary corrections. Both were
  // unexpressible: the two agree on STRING, so gate 2 handed it to the source
  // token and the request was discarded with nothing reported.
  it('honours Text and Identifier over a source IFCLABEL', () => {
    expect(serializeNominalValue('42', PropertyValueType.Text, 'IFCLABEL')).toBe("IFCTEXT('42')");
    expect(serializeNominalValue('42', PropertyValueType.Identifier, 'IFCLABEL')).toBe(
      "IFCIDENTIFIER('42')",
    );
    // …in both directions, and onto itself.
    expect(serializeNominalValue('42', PropertyValueType.Label, 'IFCTEXT')).toBe("IFCLABEL('42')");
    expect(serializeNominalValue('42', PropertyValueType.Label, 'IFCLABEL')).toBe("IFCLABEL('42')");
  });

  it('does NOT let a bare shape rewrite a neighbour’s token (#2482 stands)', () => {
    // The regression this fix had to avoid. Editing one property regenerates
    // the whole set, and a value-only edit passes `String` — the shape the
    // extractor collapses every string token into. If a shape outranked the
    // source token, every untouched `IFCTEXT` / `IFCIDENTIFIER` neighbour would
    // be rewritten `IFCLABEL`, which is #2482 verbatim.
    expect(serializeNominalValue('prose', PropertyValueType.String, 'IFCTEXT')).toBe(
      "IFCTEXT('prose')",
    );
    expect(serializeNominalValue('id-7', PropertyValueType.String, 'IFCIDENTIFIER')).toBe(
      "IFCIDENTIFIER('id-7')",
    );
    // Numerics have no named member at all — `Real` collapses `IfcLengthMeasure`
    // and `IfcReal` alike — so the source token keeps winning there.
    expect(serializeNominalValue(2500, PropertyValueType.Real, 'IFCLENGTHMEASURE')).toBe(
      'IFCLENGTHMEASURE(2500.)',
    );
  });

  it('a named member does not smuggle a non-string value into a string token', () => {
    // Gate 3's job, unchanged: the value still has to fit STRING. These take
    // the shape-derived path exactly as they did before.
    expect(declaredNominalValueType(42, PropertyValueType.Text, 'IFCLABEL')).toBeNull();
    expect(declaredNominalValueType(null, PropertyValueType.Text, 'IFCLABEL')).toBeNull();
  });
});
