/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import {
  serializePropertyValue,
  serializeAttributeValue,
  serializeStepValue,
  serializeTypedMarker,
  resolveExpressBase,
  tokenIsRealLiteral,
  toStepReal,
  escapeStepString,
} from './step-serialization.js';
import { toStepRealScaled } from './unit-normalize.js';

describe('resolveExpressBase', () => {
  it('resolves defined types to their EXPRESS primitive, following alias chains', () => {
    expect(resolveExpressBase('IfcBoolean')).toBe('BOOLEAN');
    expect(resolveExpressBase('IfcLogical')).toBe('LOGICAL');
    expect(resolveExpressBase('IfcInteger')).toBe('INTEGER');
    expect(resolveExpressBase('IfcLengthMeasure')).toBe('REAL');
    // nested alias: IfcPositiveLengthMeasure -> IfcLengthMeasure -> REAL
    expect(resolveExpressBase('IfcPositiveLengthMeasure')).toBe('REAL');
    expect(resolveExpressBase('IfcLabel')).toBe('STRING');
  });

  it('returns null for unknown types and entity/select types', () => {
    expect(resolveExpressBase('IfcWall')).toBeNull();
    expect(resolveExpressBase('NotARealType')).toBeNull();
  });
});

describe('serializeTypedMarker', () => {
  it('emits a type-qualified token per the declared primitive', () => {
    expect(serializeTypedMarker('IfcBoolean', true)).toBe('IFCBOOLEAN(.T.)');
    expect(serializeTypedMarker('IfcBoolean', false)).toBe('IFCBOOLEAN(.F.)');
    expect(serializeTypedMarker('IfcLengthMeasure', 3)).toBe('IFCLENGTHMEASURE(3.)');
    expect(serializeTypedMarker('IfcInteger', 5)).toBe('IFCINTEGER(5)');
    expect(serializeTypedMarker('IfcLabel', "O'Brien")).toBe("IFCLABEL('O''Brien')");
    // subsumes { real }
    expect(serializeTypedMarker('IfcReal', 450)).toBe('IFCREAL(450.)');
  });

  it('is reachable through the { typed } marker in serializeStepValue', () => {
    expect(serializeStepValue({ typed: { type: 'IfcBoolean', value: true } })).toBe('IFCBOOLEAN(.T.)');
    expect(serializeStepValue({ typed: { type: 'IfcLengthMeasure', value: 3 } })).toBe('IFCLENGTHMEASURE(3.)');
  });

  // The marker accepts `value: string`, so a caller may copy a STEP token or a
  // word straight from the parser. Boolean/logical inner values must normalize
  // rather than fall to JS truthiness (`'.F.'` is a truthy string).
  it('normalizes string / numeric boolean and logical inner values', () => {
    expect(serializeTypedMarker('IfcBoolean', '.F.')).toBe('IFCBOOLEAN(.F.)');
    expect(serializeTypedMarker('IfcBoolean', 'false')).toBe('IFCBOOLEAN(.F.)');
    expect(serializeTypedMarker('IfcBoolean', 0)).toBe('IFCBOOLEAN(.F.)');
    expect(serializeTypedMarker('IfcBoolean', '.T.')).toBe('IFCBOOLEAN(.T.)');
    expect(serializeTypedMarker('IfcLogical', '.T.')).toBe('IFCLOGICAL(.T.)');
    expect(serializeTypedMarker('IfcLogical', '.F.')).toBe('IFCLOGICAL(.F.)');
    expect(serializeTypedMarker('IfcLogical', '.U.')).toBe('IFCLOGICAL(.U.)');
    expect(serializeTypedMarker('IfcLogical', 'UNKNOWN')).toBe('IFCLOGICAL(.U.)');
  });
});

describe('tokenIsRealLiteral', () => {
  it('recognizes REAL literals with either sign', () => {
    for (const t of ['0.4', '-0.4', '+0.4', '4.', '1.5E-7', '+1E3', '-2.E+5']) {
      expect(tokenIsRealLiteral(t)).toBe(true);
    }
  });

  it('rejects INTEGER literals and non-numeric tokens', () => {
    for (const t of ['4', '-4', '+4', '#42', '.AREA.', '$', "'x'", '']) {
      expect(tokenIsRealLiteral(t)).toBe(false);
    }
  });
});

/** A conforming STEP REAL: mantissa carries a decimal point, exponent (if any)
 *  is uppercase `E`. Rejects the invalid `5e-8.` / lowercase-`e` forms. */
const STEP_REAL_RE = /^-?\d+\.\d*(?:E[+-]?\d+)?$/;

describe('toStepReal', () => {
  it('rewrites exponential magnitudes into valid STEP REAL literals', () => {
    // Regression: these previously produced `5e-8.` / `1e+21.` (invalid) or a
    // lowercase `e`, all nonconforming ISO-10303-21.
    expect(toStepReal(5e-8)).toBe('5.E-8');
    expect(toStepReal(1e21)).toBe('1.E+21');
    expect(toStepReal(1.5e-7)).toBe('1.5E-7');
  });

  it('keeps normal-magnitude values with a decimal point', () => {
    expect(toStepReal(0.001)).toBe('0.001');
    expect(toStepReal(100)).toBe('100.');
    expect(toStepReal(-0.35)).toBe('-0.35');
  });

  it('maps non-finite input to 0.', () => {
    expect(toStepReal(NaN)).toBe('0.');
    expect(toStepReal(Infinity)).toBe('0.');
  });

  it('every output matches the STEP REAL grammar', () => {
    for (const v of [5e-8, 1e21, 1.5e-7, 0.001, 100, -0.35, -2.5e12, 3.14]) {
      expect(toStepReal(v)).toMatch(STEP_REAL_RE);
    }
  });
});

describe('serializePropertyValue (Real)', () => {
  it('emits a valid STEP REAL inside IFCREAL for exponential and normal values', () => {
    expect(serializePropertyValue(5e-8, PropertyValueType.Real)).toBe('IFCREAL(5.E-8)');
    expect(serializePropertyValue(1e21, PropertyValueType.Real)).toBe('IFCREAL(1.E+21)');
    expect(serializePropertyValue(1.5e-7, PropertyValueType.Real)).toBe('IFCREAL(1.5E-7)');
    expect(serializePropertyValue(0.001, PropertyValueType.Real)).toBe('IFCREAL(0.001)');
    expect(serializePropertyValue(100, PropertyValueType.Real)).toBe('IFCREAL(100.)');
    expect(serializePropertyValue(-0.35, PropertyValueType.Real)).toBe('IFCREAL(-0.35)');
  });

  it('maps non-finite Real input to $', () => {
    expect(serializePropertyValue(NaN, PropertyValueType.Real)).toBe('$');
    expect(serializePropertyValue(Infinity, PropertyValueType.Real)).toBe('$');
    expect(serializePropertyValue(-Infinity, PropertyValueType.Real)).toBe('$');
    expect(serializePropertyValue('not a number', PropertyValueType.Real)).toBe('$');
  });
});

describe('serializeAttributeValue (string attributes)', () => {
  // A source attribute already written as a quoted STEP string must stay a
  // quoted string — user free-text can never be reinterpreted as a typed token.
  const stringToken = "'Old Name'";

  it('quotes free-text that resembles STEP tokens', () => {
    expect(serializeAttributeValue('#12', stringToken)).toBe("'#12'");
    expect(serializeAttributeValue('$', stringToken)).toBe("'$'");
    expect(serializeAttributeValue('*', stringToken)).toBe("'*'");
    expect(serializeAttributeValue('.FOO.', stringToken)).toBe("'.FOO.'");
  });

  it('escapes apostrophes inside a string attribute value', () => {
    expect(serializeAttributeValue("O'Brien", stringToken)).toBe("'O''Brien'");
  });

  it('clears a string attribute to $ on empty input', () => {
    expect(serializeAttributeValue('', stringToken)).toBe('$');
  });

  it('still infers typed tokens when the source token is not a quoted string', () => {
    // Enum source -> enum; numeric source -> number; ref passthrough.
    expect(serializeAttributeValue('bar', '.FOO.')).toBe('.BAR.');
    expect(serializeAttributeValue('5', '3')).toBe('5');
    expect(serializeAttributeValue('#7', '$')).toBe('#7');
  });

  it('escapes quotes and backslashes together', () => {
    expect(serializeAttributeValue("a'b\\c", stringToken)).toBe("'a''b\\\\c'");
    expect(serializeAttributeValue("\\'", stringToken)).toBe("'\\\\'''");
  });

  it("treats a value of two literal quote chars ('') as content, not empty", () => {
    expect(serializeAttributeValue("''", stringToken)).toBe("''''''");
  });

  it('preserves leading/trailing whitespace of a string value verbatim', () => {
    expect(serializeAttributeValue('  padded  ', stringToken)).toBe("'  padded  '");
    // Whitespace-wrapped token-lookalikes stay strings too.
    expect(serializeAttributeValue(' $ ', stringToken)).toBe("' $ '");
    expect(serializeAttributeValue(' #12 ', stringToken)).toBe("' #12 '");
  });

  it('recognizes a quoted source token with surrounding whitespace', () => {
    expect(serializeAttributeValue('#12', "  'Old'  ")).toBe("'#12'");
  });

  it("does not mistake a lone quote char token (') for a quoted string", () => {
    // Malformed 1-char token: falls through to inference, quoting the value.
    expect(serializeAttributeValue('free text', "'")).toBe("'free text'");
  });
});

describe('toStepRealScaled', () => {
  it('formats scaled values through the shared STEP REAL rewrite', () => {
    expect(toStepRealScaled(5e-8)).toBe('5.E-8');
    expect(toStepRealScaled(1e21)).toBe('1.E+21');
    expect(toStepRealScaled(-0)).toBe('0.');
    expect(toStepRealScaled(NaN)).toBe('0.');
    expect(toStepRealScaled(Infinity)).toBe('0.');
    expect(toStepRealScaled(-Infinity)).toBe('0.');
    // 12-sig-digit rounding erases FP noise from unit multiplies.
    expect(toStepRealScaled(0.1 + 0.2)).toBe('0.3');
    for (const v of [Number.MAX_VALUE, Number.MIN_VALUE, -1.5e-300, 1e-7, 123.456]) {
      expect(toStepRealScaled(v)).toMatch(STEP_REAL_RE);
    }
  });
});

describe('escapeStepString non-ASCII encoding (ISO 10303-21 6.3.3.4)', () => {
  // ISO 10303-21 restricts a string literal's plain-text bytes to the "basic
  // graphic" range 32-126; anything outside it is a control directive
  // (\X\HH, \X2\HHHH\X0\, \X4\HHHHHHHH\X0\), never a raw byte. buildingSMART's
  // own IFC string-encoding guidance states the same for IFC2X3/IFC4/IFC4X3:
  // "characters ... represented by decimal value 32 to 126 ... any other
  // character ... has to be encoded" (e.g. German 'Ä' as '\X2\00C4\X0\').
  // A reader that treats the file bytes as ISO-8859-1 (the byte encoding real
  // consumers - and the base standard - assume) turns a raw UTF-8 multi-byte
  // sequence into mojibake or an outright parse break; this is a reported,
  // reproduced defect in real IFC tooling (IfcOpenShell#699, files rejected
  // by Solibri) for exactly this shape of writer bug.
  it('encodes a BMP character as \\X2\\HHHH\\X0\\, not raw UTF-8', () => {
    expect(escapeStepString('Trümpler')).toBe('Tr\\X2\\00FC\\X0\\mpler');
  });

  it('encodes a non-BMP character (emoji) as \\X4\\HHHHHHHH\\X0\\', () => {
    expect(escapeStepString('😀')).toBe('\\X4\\0001F600\\X0\\');
  });

  it('leaves printable ASCII untouched', () => {
    expect(escapeStepString('plain text 123')).toBe('plain text 123');
  });
});
