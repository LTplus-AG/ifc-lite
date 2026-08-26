/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  enumVal,
  formatStepReal,
  generateHeader,
  generateStepFileWithRegistry,
  ref,
  serializeValue,
  toStepLineWithRegistry,
} from './step-serializers.js';

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

  it('handles extreme magnitudes and toString exponent switchovers', () => {
    // Exactly at toString's switch to exponent notation (1e21 / 1e-7).
    expect(formatStepReal(1e21)).toBe('1.E+21');
    expect(formatStepReal(1e-7)).toBe('1.E-7');
    // Just below the switchover: plain notation, decimal point appended.
    expect(formatStepReal(1e20)).toBe('100000000000000000000.');
    expect(formatStepReal(1e-6)).toBe('0.000001');
    // Float extremes.
    expect(formatStepReal(Number.MAX_VALUE)).toBe('1.7976931348623157E+308');
    expect(formatStepReal(Number.MIN_VALUE)).toBe('5.E-324'); // 5e-324 denormal
    expect(formatStepReal(-1.5e-300)).toBe('-1.5E-300');
    // Negative zero: sign is dropped (STEP has no -0 semantics).
    expect(formatStepReal(-0)).toBe('0.');
  });

  it('adversarial: every finite double formats to the STEP REAL grammar', () => {
    const values = [
      -0, 0, 1, -1, 0.1, -0.1, 1e21, -1e21, 1e-7, -1e-7, 1e20, 1e-6,
      Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE,
      Number.MAX_SAFE_INTEGER, Number.EPSILON, 5e-324, -1.5e-300,
      123456789.123456, 2 ** 31, 2 ** 53, 1 / 3,
    ];
    for (const v of values) {
      expect(formatStepReal(v)).toMatch(STEP_REAL_RE);
      // Value fidelity: parsing the literal back yields the same double
      // (E is valid exponent syntax for parseFloat via lowercase rewrite).
      expect(parseFloat(formatStepReal(v).replace('E', 'e'))).toBe(v === 0 ? 0 : v);
    }
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
    expect(serializeValue(-Infinity)).toBe('$');
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

describe('generateHeader non-ASCII encoding (ISO 10303-21 6.3.3.4)', () => {
  // Same spec clause / buildingSMART guidance as the export package's
  // `escapeStepString` test: a string literal's plain-text bytes are
  // restricted to decimal 32-126; a byte outside that range must be a
  // `\X2\`/`\X4\` control directive, never emitted raw.
  it('encodes a BMP character in FILE_NAME as \\X2\\HHHH\\X0\\, not raw UTF-8', () => {
    const header = generateHeader({ schema: 'IFC4', author: ['Trümpler'] });
    const fileNameLine = header.split('\n').find((l) => l.startsWith('FILE_NAME'));
    expect(fileNameLine).toContain('Tr\\X2\\00FC\\X0\\mpler');
    expect(fileNameLine).not.toContain('Trümpler');
  });
});

describe('serializeValue (non-numeric branches)', () => {
  // Only the number branch was covered, so dropping the leading dot from an
  // enum (`.ELEMENT.` -> `ELEMENT.`), swapping the boolean tokens, or losing
  // the `#` on an entity reference passed the whole suite. Each token below is
  // the ISO-10303-21 literal for its value kind.
  it('emits the ISO-10303-21 literal for every value kind', () => {
    expect(serializeValue(null)).toBe('$');
    expect(serializeValue(undefined)).toBe('$');
    expect(serializeValue('*')).toBe('*');
    expect(serializeValue(true)).toBe('.T.');
    expect(serializeValue(false)).toBe('.F.');
    expect(serializeValue('Wall-A')).toBe("'Wall-A'");
    expect(serializeValue(ref(42))).toBe('#42');
    expect(serializeValue(enumVal('ELEMENT'))).toBe('.ELEMENT.');
    expect(serializeValue([])).toBe('()');
    expect(serializeValue([1, 'a', ref(7), enumVal('T')])).toBe("(1.,'a',#7,.T.)");
    // Nested lists keep their own parentheses.
    expect(serializeValue([[1, 2], [3]])).toBe('((1.,2.),(3.))');
  });

  it('doubles a quote and a backslash inside a string literal', () => {
    expect(serializeValue("O'Brien")).toBe("'O''Brien'");
    expect(serializeValue('a\\b')).toBe("'a\\\\b'");
  });
});

describe('generateHeader FILE_NAME field order (ISO 10303-21)', () => {
  // FILE_NAME's positional fields are (name, time_stamp, author, organization,
  // preprocessor_version, originating_system, authorization).
  // `preprocessorVersion` and `originatingSystem` BOTH default to
  // `application`, so any fixture that leaves them alone writes the identical
  // string into both slots and a swap of the two is undetectable — likewise
  // author/organization, which both default to ''. Every field here is
  // distinct, so no positional permutation can pass.
  it('places each field in its own slot', () => {
    const header = generateHeader({
      schema: 'IFC4X3_ADD2',
      filename: 'model.ifc',
      timeStamp: '2026-01-02T03:04:05',
      author: ['Author-A'],
      organization: ['Org-B'],
      application: 'App-C',
      preprocessorVersion: 'Preproc-D',
      originatingSystem: 'Origin-E',
      authorization: 'Auth-F',
      description: ['Desc-G'],
      implementationLevel: 'Impl-H',
    });
    expect(header).toContain(
      "FILE_NAME('model.ifc','2026-01-02T03:04:05',('Author-A'),('Org-B')," +
        "'Preproc-D','Origin-E','Auth-F');",
    );
    expect(header).toContain("FILE_DESCRIPTION(('Desc-G'),'Impl-H');");
    expect(header).toContain("FILE_SCHEMA(('IFC4X3_ADD2'));");
  });

  it('defaults preprocessor_version and originating_system to the application', () => {
    const header = generateHeader({ schema: 'IFC4', application: 'App-C', timeStamp: 'TS' });
    expect(header).toContain("FILE_NAME('output.ifc','TS',(''),(''),'App-C','App-C','');");
  });
});

describe('escapeStepString astral-plane characters', () => {
  // The BMP test above covers the `\X2\` directive only. A code point above
  // U+FFFF takes the OTHER branch — `\X4\HHHHHHHH\X0\`, eight hex digits — and
  // emitting a `\X2\` for it (or padding to four) yields a literal no reader
  // can decode. Nothing exercised that branch.
  it('encodes U+1D11E with the eight-digit X4 directive', () => {
    // U+1D11E MUSICAL SYMBOL G CLEF — one astral code point, two UTF-16 units.
    expect(serializeValue('\u{1D11E}')).toBe("'\\X4\\0001D11E\\X0\\'");
    const header = generateHeader({ schema: 'IFC4', author: ['x\u{1D11E}y'], timeStamp: 'TS' });
    expect(header).toContain("('x\\X4\\0001D11E\\X0\\y')");
  });
});

describe('toStepLineWithRegistry / generateStepFileWithRegistry', () => {
  const REGISTRY = {
    entities: {
      IfcWall: {
        allAttributes: [{ name: 'GlobalId' }, { name: 'OwnerHistory' }, { name: 'Name' }],
      },
    },
  };

  it('emits attributes in registry order, uppercasing the type', () => {
    const line = toStepLineWithRegistry(REGISTRY, {
      expressId: 12,
      type: 'IfcWall',
      // Deliberately out of registry order: the registry decides the attribute
      // order, not the object's own key order.
      Name: 'Wall-A',
      GlobalId: '0YvCT2_$X3_xJG3rzD8L_8',
      OwnerHistory: null,
    });
    expect(line).toBe("#12=IFCWALL('0YvCT2_$X3_xJG3rzD8L_8',$,'Wall-A');");
  });

  it('throws on a type the registry does not know', () => {
    expect(() => toStepLineWithRegistry(REGISTRY, { expressId: 1, type: 'IfcNope' })).toThrow(
      /Unknown entity type: IfcNope/,
    );
  });

  // "Sort entities by ID for deterministic output" — reversing that comparator
  // passed every test, because nothing read the DATA section's order.
  it('writes the data section in ascending express-id order', () => {
    const file = generateStepFileWithRegistry(
      REGISTRY,
      [
        { expressId: 30, type: 'IfcWall', GlobalId: 'c', OwnerHistory: null, Name: 'C' },
        { expressId: 10, type: 'IfcWall', GlobalId: 'a', OwnerHistory: null, Name: 'A' },
        { expressId: 20, type: 'IfcWall', GlobalId: 'b', OwnerHistory: null, Name: 'B' },
      ],
      { schema: 'IFC4', timeStamp: 'TS' },
    );
    const ids = [...file.matchAll(/^#(\d+)=/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([10, 20, 30]);
  });
});


/**
 * The `@ifc-lite/data` serializer's escaper is the second TS copy of the rule
 * pinned in `@ifc-lite/export`'s `step-serialization.test.ts` and in
 * `ifc_lite_export::step_text::escape`: ONE SPACE PER CONTROL CHARACTER, not
 * one per run (#3284 item 2). `escapeStepString` is module-private here, so a
 * run reaches it through the two public funnels that use it — `serializeValue`
 * for an attribute value and `generateHeader` for a header field. The expected
 * strings are the Rust half's observed output for the same inputs.
 */
describe('control-character runs are one space each (#3284, parity with the Rust escape)', () => {
  const RUST_VECTORS: ReadonlyArray<readonly [string, string, string]> = [
    ['tab run', 'a\t\t\tb', 'a   b'],
    ['crlf', 'a\r\nb', 'a  b'],
    ['mixed C0 + DEL', 'a\u0000\u000B\u001F\u007Fb', 'a    b'],
    ['single control char', 'a\tb', 'a b'],
    ['quote doubling around a run', "O'Brien\t\tx", "O''Brien  x"],
    // Negative control: nothing to replace, byte-identical output.
    ['no control chars', 'plain text 123', 'plain text 123'],
  ];

  it.each(RUST_VECTORS)('serializeValue escapes %s as the Rust half does', (_l, input, expected) => {
    expect(serializeValue(input)).toBe(`'${expected}'`);
  });

  it.each(RUST_VECTORS)('generateHeader escapes %s as the Rust half does', (_l, input, expected) => {
    const line = generateHeader({ schema: 'IFC4', author: [input], timeStamp: 'TS' })
      .split('\n')
      .find((l) => l.startsWith('FILE_NAME'));
    expect(line).toContain(`('${expected}')`);
  });

  it('keeps the run length and still emits no control byte, at every length', () => {
    // Both directions: same length as the input (one space per control char),
    // and no control character survives — a run left intact would also keep
    // its length, so neither assertion alone would fail the old collapse.
    for (const n of [1, 2, 3, 8]) {
      const serialized = serializeValue(`a${'\n'.repeat(n)}b`);
      expect(serialized).toBe(`'a${' '.repeat(n)}b'`);
      // eslint-disable-next-line no-control-regex
      expect(serialized).not.toMatch(/[\u0000-\u001F\u007F]/);
    }
  });
});
