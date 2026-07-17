/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import {
  assembleStepBlob,
  assembleStepBytes,
  serializePropertyValue,
  serializeAttributeValue,
  toStepReal,
} from './step-serialization.js';

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
  it('formats scaled values through the shared STEP REAL rewrite', async () => {
    const { toStepRealScaled } = await import('./unit-normalize.js');
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

/**
 * Reference implementation of the OLD (pre-rewrite) `assembleStepBytes`:
 * single-pass `encoder.encode()` per entity, keeping every encoded chunk
 * alive in a persistent `Uint8Array[]` until the final copy. Kept here
 * (rather than trusting a snapshot) so the byte-identity test fails loudly
 * if the new two-pass `encodeInto` assembler ever drifts from it, on a
 * UTF-8 corpus that specifically exercises multi-byte characters.
 */
function assembleStepBytesReference(header: string, entities: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const headBytes = encoder.encode(`${header}DATA;\n`);
  const tailBytes = encoder.encode('ENDSEC;\nEND-ISO-10303-21;\n');
  const newline = encoder.encode('\n');

  let totalSize = headBytes.byteLength + tailBytes.byteLength;
  const entityBytes: Uint8Array[] = new Array(entities.length);
  for (let i = 0; i < entities.length; i++) {
    entityBytes[i] = encoder.encode(entities[i]);
    totalSize += entityBytes[i].byteLength + newline.byteLength;
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;
  result.set(headBytes, offset);
  offset += headBytes.byteLength;
  for (let i = 0; i < entityBytes.length; i++) {
    result.set(entityBytes[i], offset);
    offset += entityBytes[i].byteLength;
    result.set(newline, offset);
    offset += newline.byteLength;
  }
  result.set(tailBytes, offset);
  return result;
}

const HEADER = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\n";

/** UTF-8 corpus: ASCII, Latin-1 accents, 2/3-byte BMP chars, and a 4-byte
 * surrogate-pair emoji, all inside STEP entity strings (the realistic case:
 * IFCLABEL/IFCTEXT attribute values carry user text). */
const UTF8_ENTITIES = [
  "#1=IFCWALL('0000000000000000000001',$,'Plain ASCII wall',$,$,$,$,$,$);",
  "#2=IFCLABEL('Wand mit Umlauten: äöüÄÖÜß und Zeichen: café, naïve');",
  "#3=IFCTEXT('日本語のテキスト and 中文文本 mixed with ASCII');",
  "#4=IFCLABEL('Emoji stress test: 🏗️🏢🧱🪟 and combining marks: é');",
  "#5=IFCLABEL('');", // empty string entity
  `#6=IFCTEXT('${'x'.repeat(5000)}${'ü'.repeat(2000)}${'文'.repeat(1000)}');`, // forces scratch-buffer growth
];

describe('assembleStepBytes', () => {
  it('is byte-identical to the pre-rewrite single-pass reference on ASCII-only entities', () => {
    const entities = [
      "#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);",
      "#2=IFCWALL('0000000000000000000002',$,'Wall 1',$,$,$,$,$,$);",
    ];
    const expected = assembleStepBytesReference(HEADER, entities);
    const actual = assembleStepBytes(HEADER, entities);
    expect(actual).toEqual(expected);
  });

  it('is byte-identical to the pre-rewrite reference on a multi-byte UTF-8 corpus', () => {
    const expected = assembleStepBytesReference(HEADER, UTF8_ENTITIES);
    const actual = assembleStepBytes(HEADER, UTF8_ENTITIES);
    expect(actual.length).toBe(expected.length);
    expect(actual).toEqual(expected);
  });

  it('handles zero entities', () => {
    const expected = assembleStepBytesReference(HEADER, []);
    const actual = assembleStepBytes(HEADER, []);
    expect(actual).toEqual(expected);
  });

  it('round-trips through TextDecoder back to the original entity text', () => {
    const bytes = assembleStepBytes(HEADER, UTF8_ENTITIES);
    const text = new TextDecoder('utf-8').decode(bytes);
    for (const entity of UTF8_ENTITIES) {
      expect(text).toContain(entity);
    }
  });
});

describe('assembleStepBlob', () => {
  it('has byte content identical to assembleStepBytes on a multi-byte UTF-8 corpus', async () => {
    const blob = assembleStepBlob(HEADER, UTF8_ENTITIES);
    const blobBytes = new Uint8Array(await blob.arrayBuffer());
    const bytes = assembleStepBytes(HEADER, UTF8_ENTITIES);
    expect(blobBytes).toEqual(bytes);
  });

  it('has byte content identical to assembleStepBytes on ASCII-only entities', async () => {
    const entities = [
      "#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);",
      "#2=IFCWALL('0000000000000000000002',$,'Wall 1',$,$,$,$,$,$);",
    ];
    const blob = assembleStepBlob(HEADER, entities);
    const blobBytes = new Uint8Array(await blob.arrayBuffer());
    const bytes = assembleStepBytes(HEADER, entities);
    expect(blobBytes).toEqual(bytes);
  });

  it('handles zero entities identically to assembleStepBytes', async () => {
    const blob = assembleStepBlob(HEADER, []);
    const blobBytes = new Uint8Array(await blob.arrayBuffer());
    const bytes = assembleStepBytes(HEADER, []);
    expect(blobBytes).toEqual(bytes);
  });

  it('reports the combined byte size via blob.size', async () => {
    const blob = assembleStepBlob(HEADER, UTF8_ENTITIES);
    const bytes = assembleStepBytes(HEADER, UTF8_ENTITIES);
    expect(blob.size).toBe(bytes.byteLength);
  });
});
