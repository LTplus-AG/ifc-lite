/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `select-qualification.ts` had no test file. Its behaviour was reachable only
 * through `step-exporter.test.ts`, which pins the AMBIGUOUS direction (the
 * `{ typed }` marker escape hatch) — so a mutation sweep found that making
 * `#`-references qualifiable and flipping the boolean preference from
 * `IfcBoolean` to `IfcLogical` both left the suite green.
 *
 * Both write a non-conformant or wrong-typed token into the exported STEP file:
 * `IFCDESCRIPTIVEMEASURE('#5')` where an entity reference belongs, and
 * `IFCLOGICAL(.T.)` where a strict reader expects `IFCBOOLEAN(.T.)`.
 */

import { describe, it, expect } from 'vitest';
import { serializeQualifiedSelectSlot } from './select-qualification.js';

describe('serializeQualifiedSelectSlot — unambiguous members', () => {
  it('qualifies a bare boolean as IfcBoolean, not IfcLogical', () => {
    // IfcPropertySingleValue.NominalValue is IfcValue, whose defined-type
    // leaves contain EXACTLY ONE BOOLEAN (IfcBoolean) and EXACTLY ONE LOGICAL
    // (IfcLogical). Both resolve unambiguously, so only the declared
    // preference order decides — which is precisely what must be pinned.
    expect(serializeQualifiedSelectSlot('IFCPROPERTYSINGLEVALUE', 2, true)).toBe('IFCBOOLEAN(.T.)');
    expect(serializeQualifiedSelectSlot('IFCPROPERTYSINGLEVALUE', 2, false)).toBe('IFCBOOLEAN(.F.)');
  });

  it('qualifies a string in a slot whose SELECT has exactly one STRING member', () => {
    // IfcCurveStyle.CurveWidth is IfcSizeSelect: one STRING leaf
    // (IfcDescriptiveMeasure), several REAL leaves.
    expect(serializeQualifiedSelectSlot('IFCCURVESTYLE', 2, 'thick')).toBe(
      "IFCDESCRIPTIVEMEASURE('thick')",
    );
  });

  it('leaves an ambiguous REAL family to the caller marker', () => {
    // Same slot, a number: IfcSizeSelect has FIVE REAL leaves, so there is no
    // single right answer and the auto-qualifier must decline.
    expect(serializeQualifiedSelectSlot('IFCCURVESTYLE', 2, 3)).toBeNull();
  });
});

describe('serializeQualifiedSelectSlot — values that are never qualifiable', () => {
  it('declines an entity reference even in a slot with one unambiguous STRING member', () => {
    // `#5` is an ENTITY member of the SELECT and must serialize as a bare
    // reference. Qualifying it would emit IFCDESCRIPTIVEMEASURE('#5') — a
    // quoted string where the file needs a live link, so the reference is lost.
    expect(serializeQualifiedSelectSlot('IFCCURVESTYLE', 2, '#5')).toBeNull();
    expect(serializeQualifiedSelectSlot('IFCCURVESTYLE', 2, '  #1234  ')).toBeNull();
  });

  it('declines the null and derived markers and an enum token', () => {
    expect(serializeQualifiedSelectSlot('IFCCURVESTYLE', 2, '$')).toBeNull();
    expect(serializeQualifiedSelectSlot('IFCCURVESTYLE', 2, '*')).toBeNull();
    expect(serializeQualifiedSelectSlot('IFCCURVESTYLE', 2, '.NOTDEFINED.')).toBeNull();
  });

  it('declines a non-finite number', () => {
    expect(serializeQualifiedSelectSlot('IFCCURVESTYLE', 2, NaN)).toBeNull();
    expect(serializeQualifiedSelectSlot('IFCCURVESTYLE', 2, Infinity)).toBeNull();
  });
});

describe('serializeQualifiedSelectSlot — slots that are not SELECTs', () => {
  it('declines a slot the schema does not type as a scalar SELECT', () => {
    // IfcWall.Name is IfcLabel, a plain defined type — not this pass's business.
    expect(serializeQualifiedSelectSlot('IFCWALL', 2, 'W-01')).toBeNull();
  });

  it('declines an entity the registry does not know', () => {
    expect(serializeQualifiedSelectSlot('IFCNOTAREALENTITY', 0, true)).toBeNull();
  });

  it('declines an out-of-range slot index', () => {
    expect(serializeQualifiedSelectSlot('IFCCURVESTYLE', 99, 'thick')).toBeNull();
  });
});
