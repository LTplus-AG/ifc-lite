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
  serializeStepValue,
  serializeTypedMarker,
  resolveExpressBase,
  tokenIsRealLiteral,
  toStepReal,
  replaceStepArgument,
  splitTopLevelStepArguments,
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

describe('replaceStepArgument slot validation', () => {
  const LINE = "#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,(#30),$,$,$,.STANDARD.);";

  it('replaces the requested slot and leaves every other token byte-identical', () => {
    const out = replaceStepArgument(LINE, 5, '(#33)');
    expect(out).toBe("#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,(#33),$,$,$,.STANDARD.);");
  });

  it('returns null for a slot past the end rather than a silently unchanged line', () => {
    expect(replaceStepArgument(LINE, 99, '(#33)')).toBeNull();
  });

  // A negative or fractional index would assign a NAMED PROPERTY on the array
  // instead of an element; `join` skips it, so the function would hand back the
  // line unchanged but NON-NULL. Callers read non-null as "the replacement
  // happened" -- `rewriteTypeOwnedPsetLine` turns it into `repointed: true` --
  // so an unchanged non-null is a silent false success, the same shape as the
  // drop this module's caller was fixed for. Unreachable through the exporter
  // today (the only slot is a constant), pinned because the contract is public.
  for (const slot of [-1, -5, 1.5, Number.NaN]) {
    it(`returns null for the invalid slot ${String(slot)}`, () => {
      expect(replaceStepArgument(LINE, slot, '(#33)')).toBeNull();
    });
  }
});

/**
 * github.com/LTplus-AG/ifc-lite/issues/2470, second half: the helper's failure
 * SIGNALLING, one level below the null contract above.
 *
 * `splitTopLevelStepArguments` tracked quote state and paren depth to find the
 * top-level commas and then ignored where that scan ended up. Text that never
 * left a string, or never closed a nested list, still produced parts — parts
 * whose boundaries are wherever the scanner stopped rather than the record's
 * slots. `replaceStepArgument`'s regex pins only the two ENDS of the record, so
 * such a line reaches the split, gets a slot written by index, and comes back
 * NON-NULL: a success it did not achieve, and a corrupted line where #2469 had
 * a dropped one.
 *
 * Each malformed case below returned a string before the fix — the mutation
 * check for this block is to delete one rejection and watch its case go from
 * `null` to a plausible-looking rewritten line. The VALID block underneath is
 * the bounding control: rejecting everything would pass the block above alone,
 * and would take the type-object repoint down with it (every real IfcWallType
 * line goes through here).
 */
describe('replaceStepArgument rejects an argument list it could not scan', () => {
  it('returns null for an unterminated quoted string', () => {
    // The quote before `WT1` never closes, so everything after it is one
    // "string" and the remaining commas are invisible to the scan.
    expect(
      replaceStepArgument("#5=IFCWALLTYPE('0OSuGGYU',$,'WT1,$,$,(#30),$);", 1, "'X'"),
    ).toBeNull();
  });

  it('returns null for an unbalanced nested list', () => {
    // `(#30` never closes: the scan ends at depth 1 having swallowed every
    // comma after it.
    expect(
      replaceStepArgument("#5=IFCWALLTYPE('0OSuGGYU',$,'WT1',$,$,(#30,$,$,$,.STANDARD.);", 1, "'X'"),
    ).toBeNull();
  });

  it('returns null for a stray closing paren the scan recovers from', () => {
    // Depth goes NEGATIVE at the paren after `'a'` and back to zero at the one
    // before `'b'`, so the FINAL state is balanced and a final-state check alone
    // calls this well-formed. It is not: every comma while depth was negative
    // was swallowed, so the parts that come out are `["'a'),('b'", '$', '$',
    // '$', '$']` and writing slot 1 lands on an argument the record does not
    // have — the corrupted-output case, returned as a success.
    expect(replaceStepArgument("#7=IFCFOO('a'),('b',$,$,$,$);", 1, "'X'")).toBeNull();
  });

  it('writes the slot on a line with an EMPTY one rather than refusing it', () => {
    // Invalid STEP, and deliberately still accepted: an empty argument is ONE
    // part, exactly as the entity parser counts it, so slot 5 is still slot 5.
    // Refusing it is what would do damage — the parser resolves
    // `HasPropertySets` on such a line, so by the time the repoint runs the
    // export has already withheld the property set's own lines, and a refused
    // repoint leaves the record pointing at an entity that is no longer in the
    // file. The exporter-level case is `a line the parser accepted keeps its
    // slot 5 in step with the psets it dropped` in `slot5-caller-audit.test.ts`.
    expect(replaceStepArgument("#5=IFCWALLTYPE('0OSuGGYU',,'WT1',$,$,(#30));", 5, '(#33)'))
      .toBe("#5=IFCWALLTYPE('0OSuGGYU',,'WT1',$,$,(#33));");
    expect(replaceStepArgument("#5=IFCWALLTYPE('0OSuGGYU',$,'WT1',$,$,(#30),);", 5, '(#33)'))
      .toBe("#5=IFCWALLTYPE('0OSuGGYU',$,'WT1',$,$,(#33),);");
  });

  it('returns null for a record with no arguments at all', () => {
    // Not an empty SLOT — a record that has no slots, so slot 0 is still past
    // the end and the answer is the same null the bounds check gives.
    expect(replaceStepArgument('#5=IFCWALLTYPE();', 0, '(#33)')).toBeNull();
  });
});

describe('splitTopLevelStepArguments contract', () => {
  it('splits a well-formed list and keeps each token verbatim', () => {
    expect(splitTopLevelStepArguments("'a',$,(#1,#2),.T.")).toEqual(["'a'", '$', '(#1,#2)', '.T.']);
  });

  it('reads an EMPTY argument list as no arguments, not as a malformed one', () => {
    // `#1=IFCFOO();` is a record with no slots — different from `(,)`, which is
    // a record with a slot nothing was written into. Callers that ask for a
    // slot get their answer from the bounds check instead.
    expect(splitTopLevelStepArguments('')).toEqual([]);
    expect(splitTopLevelStepArguments('   ')).toEqual([]);
  });

  it('returns null, not partial parts, for each way the scan can end badly', () => {
    expect(splitTopLevelStepArguments("'a',$,'unterminated")).toBeNull();
    expect(splitTopLevelStepArguments("'a',(#1,#2")).toBeNull();
    expect(splitTopLevelStepArguments("'a'),('b',$")).toBeNull();
  });

  it('keeps an empty slot as a slot, so every index after it still lines up', () => {
    // The only malformity that does NOT shift the parts: one empty argument is
    // one part, which is how the entity parser reads it too.
    expect(splitTopLevelStepArguments("'a',,$")).toEqual(["'a'", '', '$']);
    expect(splitTopLevelStepArguments("'a',$,")).toEqual(["'a'", '$', '']);
  });
});

describe('replaceStepArgument still accepts every well-formed list', () => {
  it('keeps a comma inside a quoted string out of the split', () => {
    const line = "#5=IFCWALLTYPE('0OSuGGYU',$,'WT1, exterior',$,$,(#30),$,$,$,.STANDARD.);";
    expect(replaceStepArgument(line, 5, '(#33)')).toBe(
      "#5=IFCWALLTYPE('0OSuGGYU',$,'WT1, exterior',$,$,(#33),$,$,$,.STANDARD.);",
    );
  });

  it('keeps a doubled-quote escape and the parens inside a string intact', () => {
    const line = "#5=IFCWALLTYPE('0OSuGGYU',$,'O''Brien (west),$',$,$,(#30),$,$,$,.STANDARD.);";
    expect(replaceStepArgument(line, 5, '(#33)')).toBe(
      "#5=IFCWALLTYPE('0OSuGGYU',$,'O''Brien (west),$',$,$,(#33),$,$,$,.STANDARD.);",
    );
  });

  it('keeps a nested list argument intact', () => {
    const line = '#7=IFCFOO((1.,2.,3.),$,(#1,#2),$,$,(#30));';
    expect(replaceStepArgument(line, 5, '(#33)')).toBe('#7=IFCFOO((1.,2.,3.),$,(#1,#2),$,$,(#33));');
  });

  it('keeps a multi-line record intact', () => {
    const line = "#5=IFCWALLTYPE('0OSuGGYU',\n$,\n'WT1',$,$,(#30),$,$,$,.STANDARD.);";
    expect(replaceStepArgument(line, 5, '(#33)')).toBe(
      "#5=IFCWALLTYPE('0OSuGGYU',\n$,\n'WT1',$,$,(#33),$,$,$,.STANDARD.);",
    );
  });
});
