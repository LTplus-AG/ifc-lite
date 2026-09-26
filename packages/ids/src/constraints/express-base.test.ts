/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adversarial review of #6153 found that classifying a measure by "does
 * it map to exactly one XSD type named xs:string" (the previous
 * `isStringOnlyMeasure`) wrongly let numeric coercion stay on for
 * `IfcDate`/`IfcDateTime`/`IfcDuration`: they are EXPRESS STRING but back
 * onto `xs:date`/`xs:dateTime`/`xs:duration`, not `xs:string`. This pins
 * the EXPRESS-base classifier that replaced it, including the chained
 * defined-type case and the "unrecognised type" fallback the review also
 * flagged.
 */

import { isExpressStringOnlyMeasure } from './express-base.js';

describe('isExpressStringOnlyMeasure (#6153 review)', () => {
  it('IfcDuration is EXPRESS STRING (xs:duration backing type, not xs:string)', () => {
    expect(isExpressStringOnlyMeasure('IFCDURATION')).toBe(true);
  });

  it('IfcDate and IfcDateTime are also EXPRESS STRING', () => {
    expect(isExpressStringOnlyMeasure('IFCDATE')).toBe(true);
    expect(isExpressStringOnlyMeasure('IFCDATETIME')).toBe(true);
  });

  it('IfcLabel/IfcText/IfcIdentifier are still string-only (control)', () => {
    expect(isExpressStringOnlyMeasure('IFCLABEL')).toBe(true);
    expect(isExpressStringOnlyMeasure('IFCTEXT')).toBe(true);
    expect(isExpressStringOnlyMeasure('IFCIDENTIFIER')).toBe(true);
  });

  it('IfcReal/IfcInteger are numeric, IfcBoolean/IfcLogical are boolean — none string-only', () => {
    expect(isExpressStringOnlyMeasure('IFCREAL')).toBe(false);
    expect(isExpressStringOnlyMeasure('IFCINTEGER')).toBe(false);
    expect(isExpressStringOnlyMeasure('IFCBOOLEAN')).toBe(false);
    expect(isExpressStringOnlyMeasure('IFCLOGICAL')).toBe(false);
  });

  it('follows a chained defined type to its numeric base (IfcPositiveInteger -> IfcInteger -> INTEGER)', () => {
    expect(isExpressStringOnlyMeasure('IFCPOSITIVEINTEGER')).toBe(false);
  });

  it('follows a chained defined type to its string base (IfcBoxAlignment -> IfcLabel -> STRING)', () => {
    expect(isExpressStringOnlyMeasure('IFCBOXALIGNMENT')).toBe(true);
  });

  it('an unrecognised dataType name falls to string-only (conservative), not to coercion', () => {
    expect(isExpressStringOnlyMeasure('IFCNOTAREALTYPE')).toBe(true);
  });
});
