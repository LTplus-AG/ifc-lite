/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as r from '../src/runtime/index.js';
import { UNKNOWN, type Logical, type Value } from '../src/runtime/values.js';

describe('three-valued logic (ISO 10303-11 12.4)', () => {
  it.each<[Logical, Logical, Logical]>([
    [true, UNKNOWN, UNKNOWN], [false, UNKNOWN, false], [UNKNOWN, UNKNOWN, UNKNOWN], [true, true, true],
  ])('%s AND %s = %s', (a, b, want) => expect(r.and(a, () => b)).toBe(want));

  it.each<[Value, Logical, Logical]>([
    [false, UNKNOWN, UNKNOWN], [true, UNKNOWN, true], [false, false, false], [undefined, true, true],
  ])('%s OR %s = %s', (a, b, want) => expect(r.or(a, () => b)).toBe(want));

  it('treats an indeterminate operand as UNKNOWN and only FALSE as a violation', () => {
    expect(r.not(undefined)).toBe(UNKNOWN);
    expect(r.violated(UNKNOWN)).toBe(false);
    expect(r.violated(undefined)).toBe(false);
    expect(r.violated(false)).toBe(true);
  });

  it('short-circuits only where the result is already decided', () => {
    let evaluated = false;
    expect(r.and(false, () => { evaluated = true; return true; })).toBe(false);
    expect(evaluated).toBe(false);
  });
});

describe('comparison', () => {
  it('compares with an indeterminate operand to UNKNOWN', () => {
    expect(r.eq(undefined, 1)).toBe(UNKNOWN);
    expect(r.gt(undefined, 0)).toBe(UNKNOWN);
  });

  it('unwraps STEP integers and typed values', () => {
    expect(r.eq(new r.StepInteger(3), 3)).toBe(true);
    expect(r.gt(new r.Typed('IfcLengthMeasure', 0.5), 0)).toBe(true);
  });

  it('compares enumeration items by name and never equal to a string', () => {
    expect(r.eq(new r.EnumValue('USERDEFINED'), new r.EnumValue('USERDEFINED'))).toBe(true);
    expect(r.eq(new r.EnumValue('USERDEFINED'), 'USERDEFINED')).toBe(false);
  });

  it('orders logical values FALSE < UNKNOWN < TRUE', () => {
    expect(r.lt(false, UNKNOWN)).toBe(true);
    expect(r.eq(UNKNOWN, false)).toBe(false);
  });
});

describe('aggregates', () => {
  it('indexes from the declared lower bound', () => {
    const a = r.assignArray([10, 20, 30], 0);
    expect(r.index(a, 0)).toBe(10);
    expect(r.hiindex(a)).toBe(2);
    expect(r.index([10, 20], 3)).toBeUndefined();
  });

  it('keeps SET members unique under union, the way IfcUniquePropertyName counts them', () => {
    let names = r.assignSet(r.aggregate([]));
    for (const n of ['FireRating', 'IsExternal', 'FireRating']) names = r.assignSet(r.add(names, n));
    expect(r.sizeof(names)).toBe(2);
    expect(r.sizeof(r.add([1], [1]))).toBe(2);
  });

  it('makes an indeterminate SET operand an evaluation error', () => {
    expect(() => r.add(r.assignSet([]), undefined)).toThrow(r.EvaluationError);
  });

  it('QUERY keeps members whose predicate is TRUE, not UNKNOWN', () => {
    expect(r.query([1, 2, undefined], (x) => r.gt(x, 1))).toEqual([2]);
    expect(r.query(undefined, () => true)).toEqual([]);
  });
});

describe('STEP record reader', () => {
  it('keeps every token kind a validator needs', () => {
    const rec = r.readStepRecord("#7=IFCX($,*,#12,5,5.,1.E-3,.T.,.U.,.ELEMENT.,'It''s \\X2\\00FC\\X0\\',IFCLABEL('x'),(1,(2.)),\"0FF\");");
    expect(rec.id).toBe(7);
    expect(rec.type).toBe('IFCX');
    const [unset, derived, ref, int, real, exp, t, u, en, str, typed, list, bin] = rec.attributes;
    expect(unset).toBeUndefined();
    expect(derived).toBe(r.DERIVED);
    expect(ref).toEqual(new r.Ref(12));
    expect(int).toEqual(new r.StepInteger(5));
    expect(real).toBe(5);
    expect(exp).toBe(0.001);
    expect([t, u]).toEqual([true, UNKNOWN]);
    expect(en).toEqual(new r.EnumValue('ELEMENT'));
    expect(str).toBe("It's ü");
    expect(typed).toEqual(new r.Typed('IFCLABEL', 'x'));
    expect(list).toEqual([new r.StepInteger(1), [2]]);
    expect(bin).toEqual(new r.BinaryValue('0FF'));
  });

  it('rejects a malformed record with its offset', () => {
    expect(() => r.readStepRecord('#1=IFCX(1,,2);')).toThrow(r.StepRecordError);
  });

  it('splits records without being fooled by semicolons in strings or comments', () => {
    const text = "DATA;\n#1=IFCA('a;b');\n/* #9=IFCZ(); */#2=IFCB(#1);\nENDSEC;";
    expect([...r.splitStepRecords(text)].map((x) => [x.id, x.type])).toEqual([[1, 'IFCA'], [2, 'IFCB']]);
  });
});
