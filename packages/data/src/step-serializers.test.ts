/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { formatStepReal, serializeValue, generateHeader } from './step-serializers.js';

/** A conforming STEP REAL: mantissa carries a decimal point, exponent (if any)
 *  is uppercase `E`. */
const STEP_REAL_RE = /^-?\d+\.\d*(?:E[+-]?\d+)?$/;

describe('formatStepReal', () => {
  it('rewrites exponential magnitudes into valid STEP REAL literals', () => {
    expect(formatStepReal(5e-8)).toBe('5.E-8');
    expect(formatStepReal(1e21)).toBe('1.E+21');
    expect(formatStepReal(1.5e-7)).toBe('1.5E-7');
  });

  it('keeps normal-magnitude values with a decimal point', () => {
    expect(formatStepReal(0.001)).toBe('0.001');
    expect(formatStepReal(100)).toBe('100.');
    expect(formatStepReal(-0.35)).toBe('-0.35');
  });
});

describe('serializeValue (number)', () => {
  it('serialises numbers as valid STEP REAL literals, including exponentials', () => {
    // Regression: the small/mid-exponent range previously produced `5e-8.` and a
    // lowercase-`e` `1.5e-7`, both invalid ISO-10303-21.
    expect(serializeValue(5e-8)).toBe('5.E-8');
    expect(serializeValue(1e21)).toBe('1.E+21');
    expect(serializeValue(1.5e-7)).toBe('1.5E-7');
    expect(serializeValue(0.001)).toBe('0.001');
    expect(serializeValue(100)).toBe('100.');
    expect(serializeValue(-0.35)).toBe('-0.35');
    for (const v of [5e-8, 1e21, 1.5e-7, 0.001, 100, -0.35, 1e-12, 9.5e15]) {
      expect(serializeValue(v)).toMatch(STEP_REAL_RE);
    }
  });

  it('maps non-finite numbers to $', () => {
    expect(serializeValue(NaN)).toBe('$');
    expect(serializeValue(Infinity)).toBe('$');
  });
});

describe('generateHeader control-char handling', () => {
  it('collapses a newline in a header value to a space so the record stays one line', () => {
    const header = generateHeader({
      schema: 'IFC4',
      author: ['Line1\nLine2'],
      timeStamp: 'TS',
    });
    const fileNameLine = header.split('\n').find((l) => l.startsWith('FILE_NAME'));
    expect(fileNameLine).toBeDefined();
    // The author value must not have split the record onto a second line.
    expect(fileNameLine).toContain("('Line1 Line2')");
    expect(fileNameLine).not.toContain('Line2\n');
  });
});
