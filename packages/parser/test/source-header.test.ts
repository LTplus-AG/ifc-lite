/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Direct coverage for {@link parseSourceHeader}, and for
 * {@link detectSchemaVersion}'s last-resort scan, which the ladder in
 * `schema-version-detection.test.ts` reaches only through its `IFC2X2` case.
 *
 * The header is read on every parse (`columnar-parser`) and written back out on
 * every STEP export (`step-exporter`), so a decoding error here silently
 * rewrites a file's authorship and provenance. The only prior coverage was
 * `packages/export/src/source-header-roundtrip.test.ts`, whose fixtures contain
 * no STEP escape of any kind (`''`, `\X2\`, `\X4\`, `\S\`, `\P?\`), no `$`/`*`
 * sentinel, no quoted delimiter, and no non-default `implementation_level` —
 * so eight independent mutations to this module survived the whole monorepo.
 *
 * All fixtures here are synthetic and carry no real-world identifiers.
 */

import { describe, expect, it } from 'vitest';
import { detectSchemaVersion, parseSourceHeader } from '../src/source-header.js';
import { StepTextScan } from '../src/step-lexing.js';
import { contiguousSourceBytes, type IfcSourceBytes } from '../src/source-bytes.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Wrap HEADER records in a minimal, well-formed STEP envelope. */
function header(records: string, data = "#1=IFCWALL('a',$);"): Uint8Array {
  return enc(
    ['ISO-10303-21;', 'HEADER;', records, 'ENDSEC;', 'DATA;', data, 'ENDSEC;', 'END-ISO-10303-21;'].join(
      '\n',
    ),
  );
}

const FILE_NAME_ALL = (fields: string) => `FILE_NAME(${fields});`;

describe('parseSourceHeader', () => {
  it('returns undefined for input with no recognisable header records', () => {
    expect(parseSourceHeader(enc('not a step file at all'))).toBeUndefined();
  });

  it('reads the declared implementation_level rather than falling back to the default', () => {
    // Every pre-existing fixture used '2;1', which is byte-identical to the
    // hard-coded fallback in the parser — so an assertion of `'2;1'` held
    // whether or not the field was parsed at all. Use a value that cannot be
    // produced by the default.
    const h = parseSourceHeader(header("FILE_DESCRIPTION(('ViewDefinition [X]'),'3;7');"));
    expect(h?.implementationLevel).toBe('3;7');
  });

  it('falls back to 2;1 only when implementation_level is genuinely absent', () => {
    const h = parseSourceHeader(header("FILE_DESCRIPTION(('ViewDefinition [X]'));"));
    expect(h?.implementationLevel).toBe('2;1');
  });

  describe('sentinels', () => {
    it('maps the `*` derived sentinel to undefined, not to a literal asterisk', () => {
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'n.ifc','2026-01-01T00:00:00',('A'),('O'),'P','S',*")),
      );
      expect(h?.authorization).toBeUndefined();
      expect(h?.name).toBe('n.ifc');
    });

    it('maps the `$` unset sentinel to undefined', () => {
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'n.ifc','2026-01-01T00:00:00',('A'),('O'),$,'S','auth'")),
      );
      expect(h?.preprocessorVersion).toBeUndefined();
      expect(h?.originatingSystem).toBe('S');
    });

    it('drops `$` and `*` entries from a list field instead of emitting them as text', () => {
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'n.ifc','2026-01-01T00:00:00',('A',$,'B',*),('O'),'P','S','auth'")),
      );
      expect(h?.author).toEqual(['A', 'B']);
    });

    it('yields an empty list for a `$` list field', () => {
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'n.ifc','2026-01-01T00:00:00',$,('O'),'P','S','auth'")),
      );
      expect(h?.author).toEqual([]);
    });
  });

  describe('field positions', () => {
    it('maps every FILE_NAME slot to its own field', () => {
      // Guards against an off-by-one in the positional read: each value is
      // distinct so a shifted index cannot land on a matching string.
      const h = parseSourceHeader(
        header(
          FILE_NAME_ALL(
            "'the-name','the-stamp',('the-author'),('the-org'),'the-preproc','the-origsys','the-authorization'",
          ),
        ),
      );
      expect(h?.name).toBe('the-name');
      expect(h?.timeStamp).toBe('the-stamp');
      expect(h?.author).toEqual(['the-author']);
      expect(h?.organization).toEqual(['the-org']);
      expect(h?.preprocessorVersion).toBe('the-preproc');
      expect(h?.originatingSystem).toBe('the-origsys');
      expect(h?.authorization).toBe('the-authorization');
    });
  });

  describe('quote and nesting awareness', () => {
    it('does not split a list item at a comma inside a quoted string', () => {
      const h = parseSourceHeader(
        header("FILE_DESCRIPTION(('Coords [Base: Survey, Site: Origin]','Second'),'2;1');"),
      );
      expect(h?.description).toEqual(['Coords [Base: Survey, Site: Origin]', 'Second']);
    });

    it('does not split a list item at a comma inside nested parentheses', () => {
      const h = parseSourceHeader(header("FILE_DESCRIPTION(('a (x, y) b','Second'),'2;1');"));
      expect(h?.description).toEqual(['a (x, y) b', 'Second']);
    });

    it('does not end the record at a closing parenthesis inside a quoted string', () => {
      // `extractRecordArgs` walks to the matching `)`. If it ignores quote
      // state, this record ends inside the name and every later field is lost.
      const h = parseSourceHeader(
        header(
          FILE_NAME_ALL("'name) with paren','2026-01-01T00:00:00',('A'),('O'),'P','S','the-auth'"),
        ),
      );
      expect(h?.name).toBe('name) with paren');
      expect(h?.authorization).toBe('the-auth');
    });
  });

  describe('string escapes', () => {
    it("collapses the `''` doubled-quote escape to a single apostrophe", () => {
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'it''s a name','2026-01-01T00:00:00',$,$,$,$,$")),
      );
      expect(h?.name).toBe("it's a name");
    });

    it('decodes a \\X2\\ UTF-16 directive to real Unicode', () => {
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'Tr\\X2\\00FC\\X0\\mpler','2026-01-01T00:00:00',$,$,$,$,$")),
      );
      expect(h?.name).toBe('Trümpler');
    });

    it('decodes a \\X4\\ UTF-32 directive to real Unicode', () => {
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'e\\X4\\0001F600\\X0\\nd','2026-01-01T00:00:00',$,$,$,$,$")),
      );
      expect(h?.name).toBe('e\u{1F600}nd');
    });

    it('decodes an \\S\\ high-bit directive to real Unicode', () => {
      // \S\d => code point of 'd' + 0x80 = 0xE4 = 'ä'.
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'\\S\\dpfel','2026-01-01T00:00:00',$,$,$,$,$")),
      );
      expect(h?.name).toBe('äpfel');
    });

    it('decodes an \\X\\ single-byte directive to real Unicode', () => {
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'\\X\\C4pfel','2026-01-01T00:00:00',$,$,$,$,$")),
      );
      expect(h?.name).toBe('Äpfel');
    });

    it('resolves `\\\\` to one literal backslash without eating a following directive', () => {
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'C:\\\\temp\\\\Tr\\X2\\00FC\\X0\\m','2026-01-01T00:00:00',$,$,$,$,$")),
      );
      expect(h?.name).toBe('C:\\temp\\Trüm');
    });

    it('keeps a \\X2\\ directive intact when an escaped backslash immediately follows it', () => {
      // `\X2\00FC\X0\` + `\\` ends in three consecutive backslashes; a naive
      // split at every doubled backslash consumes the directive terminator.
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'Tr\\X2\\00FC\\X0\\\\\\m','2026-01-01T00:00:00',$,$,$,$,$")),
      );
      expect(h?.name).toBe('Trü\\m');
    });

    it('keeps a \\X4\\ directive intact when an escaped backslash immediately follows it', () => {
      // Same trap as the \X2\ case above, on the UTF-32 directive: the \X4\
      // span must be consumed whole before the `\\` pair escape is considered,
      // or the terminator is eaten and the directive never decodes.
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'e\\X4\\0001F600\\X0\\\\\\nd','2026-01-01T00:00:00',$,$,$,$,$")),
      );
      expect(h?.name).toBe('e\u{1F600}\\nd');
    });

    it('treats a backslash as a valid \\S\\ operand rather than a pair escape', () => {
      // `\S\` takes exactly one operand character, and that character may
      // itself be a backslash (code point 0x5C + 0x80 = 0xDC). If the operand
      // is not consumed with the directive, the `\\` pair escape claims it and
      // the directive is left unterminated.
      const h = parseSourceHeader(
        header(FILE_NAME_ALL("'\\S\\\\end','2026-01-01T00:00:00',$,$,$,$,$")),
      );
      expect(h?.name).toBe('Üend');
    });
  });

  describe('tolerant shapes', () => {
    it('accepts a bare value where a list was expected', () => {
      // Some writers emit `FILE_SCHEMA('IFC4')` without the inner list.
      const h = parseSourceHeader(header("FILE_SCHEMA('IFC4');"));
      expect(h?.schemaIdentifiers).toEqual(['IFC4']);
    });

    it('reads the schema token verbatim from a well-formed list', () => {
      const h = parseSourceHeader(header("FILE_SCHEMA(('IFC4X3_ADD2'));"));
      expect(h?.schemaIdentifiers).toEqual(['IFC4X3_ADD2']);
    });
  });

  describe('scan bounds', () => {
    it('stops at the first ENDSEC so DATA-section text is never read as a header', () => {
      // A quoted attribute in the DATA section can contain the literal text
      // `FILE_NAME(...)`. Without the ENDSEC cut it is parsed as the header.
      const src = header(
        "FILE_DESCRIPTION(('ViewDefinition [X]'),'2;1');",
        "#1=IFCWALL('FILE_NAME(''body-name'',''body-stamp'',$,$,$,$,$);',$);",
      );
      const h = parseSourceHeader(src);
      expect(h?.description).toEqual(['ViewDefinition [X]']);
      // No FILE_NAME record exists in the HEADER section, so these stay unset.
      expect(h?.name).toBeUndefined();
      expect(h?.timeStamp).toBeUndefined();
    });
  });
});

/**
 * The header is read on every parse and every STEP export. If it materialised
 * the source to find its first 64 KiB, a 342 MB model would allocate 342 MB to
 * read a few hundred bytes — exactly the pin #2183 is about.
 *
 * These assert the RANGE contract, not just that the widened overload
 * compiles: a source that refuses to hand over the whole file must still parse.
 */
describe('parseSourceHeader reads a RANGE, never the whole source (#2183)', () => {
  /** Mirrors MAX_HEADER_BYTES in src/source-header.ts. */
  const MAX_HEADER_BYTES = 64 * 1024;

  const HEADER = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((\'ViewDefinition [CoordinationView]\'),\'2;1\');",
    "FILE_NAME(\'x.ifc\',\'2024-01-01T00:00:00\',(\'A\'),(\'B\'),\'p\',\'o\',\'\');",
    "FILE_SCHEMA((\'IFC4\'));",
    'ENDSEC;',
    'DATA;',
  ].join('\n');

  /**
   * A source that throws if anyone asks for all of it.
   *
   * An explicit delegate rather than a `Proxy`: `ContiguousSourceBytes` reads
   * `#private` fields in its getters, and behind a proxy those run with `this`
   * bound to the proxy, so every read would throw for the wrong reason and the
   * test would pass on a materialising implementation too.
   *
   * Refusing `materialize` is NOT enough on its own. `decodeUtf8(0, byteLength)`
   * reads the whole file just as surely — a 342 MB string on a 342 MB model,
   * which is the allocation #2183 exists to remove — and an implementation that
   * decoded everything and then trimmed the result to 64 KiB would still return
   * the right header. So bound the READ as well as the materialise: any range
   * ending past the cap throws.
   */
  function rangeOnly(text: string): IfcSourceBytes {
    const inner = contiguousSourceBytes(new TextEncoder().encode(text));
    const refuse = (via: string) => (): never => {
      throw new Error(`parseSourceHeader materialised the source via ${via}`);
    };
    const bounded = (via: string, end: number): void => {
      if (end > MAX_HEADER_BYTES) {
        throw new Error(
          `parseSourceHeader read to ${end} via ${via}, past the ${MAX_HEADER_BYTES}-byte cap`,
        );
      }
    };
    return {
      get byteLength() { return inner.byteLength; },
      get length() { return inner.length; },
      get isResident() { return inner.isResident; },
      get contentKey() { return inner.contentKey; },
      slice: (s2, e2) => { bounded('slice', e2); return inner.slice(s2, e2); },
      decodeUtf8: (s2, e2) => { bounded('decodeUtf8', e2); return inner.decodeUtf8(s2, e2); },
      materialize: refuse('materialize'),
      withMaterialized: refuse('withMaterialized'),
      withMaterializedAsync: refuse('withMaterializedAsync'),
      toTransferable: refuse('toTransferable'),
    };
  }

  /**
   * A DATA section past the cap, so "read everything" is distinguishable from
   * "read the header". With a body smaller than 64 KiB, decoding the whole
   * source IS a bounded read and the gate below would have no teeth.
   */
  const BODY = Array.from({ length: 6000 }, (_, i) => `#${i + 1}=IFCWALL($);`).join('\n');

  it('parses from an IfcSourceBytes without materialising it', () => {
    const h = parseSourceHeader(rangeOnly(`${HEADER}\n${BODY}\n`));
    expect(h?.schemaIdentifiers).toEqual(['IFC4']);
    expect(h?.name).toBe('x.ifc');
    expect(h?.author).toEqual(['A']);
  });

  it('agrees byte-for-byte with the raw Uint8Array overload', () => {
    const text = `${HEADER}\n${BODY}\n`;
    const viaBytes = parseSourceHeader(new TextEncoder().encode(text));
    const viaSource = parseSourceHeader(rangeOnly(text));
    expect(viaSource).toEqual(viaBytes);
    // Guard against both arms being undefined, which would pass vacuously.
    expect(viaBytes?.schemaIdentifiers).toEqual(['IFC4']);
  });

  it('still caps the decode: a header pushed past 64 KiB is not found', () => {
    // Proves the cap is applied to the SOURCE length, not silently dropped
    // when the input is an accessor.
    const padded = `${' '.repeat(64 * 1024)}${HEADER}`;
    expect(parseSourceHeader(rangeOnly(padded))).toBeUndefined();
    expect(parseSourceHeader(rangeOnly(HEADER))).toBeDefined();
  });
});

/**
 * Keyword and terminator searches must skip quoted text (#3284).
 *
 * The searches used a raw `indexOf`, which cannot tell a record keyword or the
 * section terminator from the same text sitting inside a header field's VALUE.
 * Header values carry arbitrary prose, so this is reachable by content rather
 * than by malformed syntax. Both cases below are the issue's, verbatim, and
 * both were confirmed to fail before the fix: the first returned `undefined`,
 * the second dropped every FILE_NAME field.
 *
 * The Rust half already guarded this in `schema_detect::find_unquoted`; these pin
 * that the two halves now agree rather than each deciding where the header ends.
 */
const NAME_AND_SCHEMA =
  "FILE_NAME('a.ifc','ts',('Jane'),('Acme'),'pp','Revit','auth');\nFILE_SCHEMA(('IFC4'));";

describe('quoted header values are not mistaken for structure (#3284)', () => {
  it('an ENDSEC inside a FILE_DESCRIPTION value does not truncate the header', () => {
    const h = parseSourceHeader(
      header(`FILE_DESCRIPTION(('note: the ENDSEC; marker is described here'),'2;1');\n${NAME_AND_SCHEMA}`),
    );
    // Before the fix this whole header read as `undefined`: the quoted ENDSEC
    // truncated the text before any record could be found.
    expect(h).toBeDefined();
    expect(h?.description).toEqual(['note: the ENDSEC; marker is described here']);
    expect(h?.name).toBe('a.ifc');
    expect(h?.schemaIdentifiers).toEqual(['IFC4']);
  });

  it('a FILE_NAME mentioned inside a FILE_DESCRIPTION value does not shadow the real record', () => {
    const h = parseSourceHeader(
      header(`FILE_DESCRIPTION(('per the FILE_NAME convention'),'2;1');\n${NAME_AND_SCHEMA}`),
    );
    // Before the fix `indexOf('FILE_NAME')` matched the quoted prose; the next
    // character is not `(`, so extraction bailed and every field was lost.
    expect(h?.name).toBe('a.ifc');
    expect(h?.author).toEqual(['Jane']);
    expect(h?.organization).toEqual(['Acme']);
    expect(h?.originatingSystem).toBe('Revit');
  });

  it("a doubled '' inside a value nets to a no-op, so quote tracking stays aligned", () => {
    // STEP escapes a literal apostrophe as ''. That toggles quote state twice,
    // which must leave the scanner exactly where it started -- otherwise every
    // keyword after an apostrophe is read with the quote state inverted.
    const h = parseSourceHeader(
      header(`FILE_DESCRIPTION(('O''Brien mentions ENDSEC; here'),'2;1');\n${NAME_AND_SCHEMA}`),
    );
    expect(h?.description).toEqual(["O'Brien mentions ENDSEC; here"]);
    expect(h?.name).toBe('a.ifc');
  });
});

/**
 * Ways the quote-aware scan itself can go wrong, all found by review of the
 * #3284 fix rather than by the original report.
 *
 * Each produces the SAME total-loss outcome the fix exists to prevent, which is
 * why they are pinned here: a scan that mis-tracks its own state loses the whole
 * header just as thoroughly as the raw `indexOf` did.
 */
describe('the quote-aware scan does not lose the header to its own state (#3284)', () => {
  it('an apostrophe inside a STEP comment does not invert quote state', () => {
    // ISO 10303-21 allows /* ... */ wherever whitespace is allowed. A comment
    // carrying an apostrophe has an odd quote count, so a scan that toggles on
    // it reads every later keyword in the wrong state and finds no record.
    const h = parseSourceHeader(
      header(`/* John's export */\nFILE_DESCRIPTION(('d'),'2;1');\n${NAME_AND_SCHEMA}`),
    );
    expect(h).toBeDefined();
    expect(h?.name).toBe('a.ifc');
    expect(h?.originatingSystem).toBe('Revit');
  });

  it('a value whose uppercase is longer does not shift later record offsets', () => {
    // 'ß'.toUpperCase() is 'SS'. Scanning an uppercased copy and then indexing
    // the original puts every later offset one character out, so the FILE_NAME
    // record is read from the wrong position and every field is lost. German
    // header values are ordinary, not exotic.
    const h = parseSourceHeader(header(`FILE_DESCRIPTION(('Straße'),'2;1');\n${NAME_AND_SCHEMA}`));
    expect(h?.description).toEqual(['Straße']);
    expect(h?.name).toBe('a.ifc');
    expect(h?.author).toEqual(['Jane']);
    expect(h?.originatingSystem).toBe('Revit');
  });

  it('a comment between a keyword and its ( does not lose the record', () => {
    // 10303-21 allows a comment wherever whitespace is allowed, so this sits
    // between FILE_SCHEMA and its argument list. A scan that skips whitespace
    // only sees `/` where it wants `(` and drops the schema declaration.
    const h = parseSourceHeader(
      header(
        "FILE_DESCRIPTION(('d'),'2;1');\n" +
          "FILE_NAME('a.ifc','ts',('Jane'),('Acme'),'pp','Revit','auth');\n" +
          "FILE_SCHEMA /* the real one */ (('IFC4'));",
      ),
    );
    expect(h?.schemaIdentifiers).toEqual(['IFC4']);
    expect(h?.name).toBe('a.ifc');
  });

  it('a comma inside a comment does not split one argument into two', () => {
    // The argument splitter tracks quotes and nesting. A comment is neither, so
    // its comma reads as a top-level separator and shifts every later argument
    // by one slot: originatingSystem comes back holding the preprocessor field.
    const h = parseSourceHeader(
      header(
        "FILE_DESCRIPTION(('d'),'2;1');\n" +
          "FILE_NAME('a.ifc','ts',('Jane'),('Acme'),/* pp, then sys */'pp','Revit','auth');\n" +
          "FILE_SCHEMA(('IFC4'));",
      ),
    );
    expect(h?.originatingSystem).toBe('Revit');
    expect(h?.preprocessorVersion).toBe('pp');
    expect(h?.authorization).toBe('auth');
  });

  it('an unterminated comment terminates the scan rather than restarting it', () => {
    // The skip must always ADVANCE the caller's index. Returning the `*/`
    // offset and using -1 for "unterminated" turns into 0 at the caller, so the
    // scan restarts at the top, finds the same comment, and never terminates.
    // A timeout here rather than a wrong value is the failure being pinned.
    const h = parseSourceHeader(
      header(`FILE_DESCRIPTION(('d'),'2;1');\n${NAME_AND_SCHEMA}\n/* never closed`),
    );
    expect(h?.name).toBe('a.ifc');
  });

  it('an unterminated comment does not swallow the records after it', () => {
    // An unterminated `/*` is not a comment, so it costs one stray character
    // and nothing else. Treating it as one that runs to end-of-text would lose
    // every record below it, which is a worse answer than the older
    // comment-blind scan gave for the same input.
    const h = parseSourceHeader(
      header(`/* never closed\nFILE_DESCRIPTION(('d'),'2;1');\n${NAME_AND_SCHEMA}`),
    );
    expect(h?.name).toBe('a.ifc');
    expect(h?.schemaIdentifiers).toEqual(['IFC4']);
  });

  it('the accepted whitespace set is exactly the ASCII one', () => {
    // One hand-written list against one stdlib helper is how the halves came
    // apart: Rust's `u8::is_ascii_whitespace` follows the WhatWG set and
    // EXCLUDES vertical tab, while this list includes it. The set is asserted
    // byte by byte on both sides rather than delegated. The mirror of this test
    // is in `rust/export/tests/source_header_comments.rs`.
    for (const sep of [' ', '\t', '\n', '\r', '\u000B', '\u000C']) {
      const h = parseSourceHeader(header(`FILE_SCHEMA${sep}(('IFC2X3'));`));
      expect(h?.schemaIdentifiers, `separator ${JSON.stringify(sep)}`).toEqual(['IFC2X3']);
    }

    // And nothing outside it. U+00A0 is not whitespace in ISO 10303-21, so the
    // record is malformed and both halves decline it.
    const nbsp = parseSourceHeader(header(`FILE_SCHEMA\u00A0(('IFC2X3'));`));
    expect(nbsp?.schemaIdentifiers ?? []).toEqual([]);
  });

  it('a long s is not folded to S, so it cannot fake a keyword', () => {
    // 'ſ'.toUpperCase() is 'S', so a full Unicode fold reads ENDſEC as ENDSEC
    // and truncates the header before FILE_SCHEMA. 10303-21 case-insensitivity
    // is ASCII, and the compare is ASCII-only to match.
    const h = parseSourceHeader(header(`ENDſEC;\nFILE_DESCRIPTION(('d'),'2;1');\n${NAME_AND_SCHEMA}`));
    expect(h?.schemaIdentifiers).toEqual(['IFC4']);
    expect(h?.name).toBe('a.ifc');
  });
});

describe('the comment scan stays linear on hostile input (#3284)', () => {
  it('never searches for a closer more than once after one fails', () => {
    // The property, not the timing. Searching at every `/*` is quadratic: a
    // failing search runs to the end of the text, the caller advances one
    // character, and the next `/*` repeats it. A 64 KiB header with 21000
    // unterminated `/*` took 5.7 seconds that way.
    //
    // One failure proves no closer exists at or after any later position, and
    // the scan only moves forward, so at most one search can ever fail and no
    // search after it should happen at all. Asserting the count pins that
    // without a wall-clock threshold that would flake on a loaded machine.
    // `/*` repeated would OVERLAP into `*/` and terminate itself, so the
    // opens are spaced. Caught by this test failing at 999 searches first time.
    const text = `HEADER;\n${'/* '.repeat(1000)}\nFILE_SCHEMA;`;
    expect(text).not.toContain('*/');
    const scan = new StepTextScan(text);
    for (let i = 0; i < text.length; i++) scan.skipLexicalAt(i);
    expect(scan.searches).toBe(1);
  });

  it('still finds every terminated comment when they are packed together', () => {
    // The memo must not fire early: 500 real comments, none unterminated, so
    // every search succeeds and each consumes a span the others do not.
    const text = `HEADER;\n${'/*x*/'.repeat(500)}FILE_SCHEMA;`;
    const scan = new StepTextScan(text);
    let i = 0;
    let skipped = 0;
    while (i < text.length) {
      const end = scan.skipLexicalAt(i);
      if (end >= 0) { skipped++; i = end; } else i++;
    }
    expect(skipped).toBe(500);
    expect(scan.searches).toBe(500);
  });
});

describe('the last-resort schema scan folds ASCII only (#3284)', () => {
  it('a dotless i in header prose does not select a schema', () => {
    // `'ı'.toUpperCase()` is `'I'`, so uppercasing the whole header made
    // `ıFC5` in a description read as `IFC5`. This scan only runs when no
    // FILE_SCHEMA identifier resolved, and it is already a loose substring
    // match, but a fold ISO 10303-21 does not use is not one of the ways it is
    // allowed to be loose.
    const before =
      'ISO-10303-21;\nHEADER;\n' +
      "FILE_DESCRIPTION(('exported by ıFC5 Studio'),'2;1');\n" +
      'ENDSEC;\nDATA;\nENDSEC;\n';
    expect(detectSchemaVersion(enc(before), parseSourceHeader(enc(before)))).toBe('IFC4');

    // And INSIDE the token, which is the harder direction. Dropping a
    // non-ASCII character instead of passing it through joins the fragments
    // either side of it, so `IFCı5` would become `IFC5` -- a false match built
    // out of a character that was never part of the word. Folding correctly
    // and deleting incorrectly agree on the case above and disagree here.
    const inside =
      'ISO-10303-21;\nHEADER;\n' +
      "FILE_DESCRIPTION(('exported by IFCı5 Studio'),'2;1');\n" +
      'ENDSEC;\nDATA;\nENDSEC;\n';
    expect(detectSchemaVersion(enc(inside), parseSourceHeader(enc(inside)))).toBe('IFC4');
  });

  it('lower-case prose still resolves, which is what the fold is FOR', () => {
    // The other two cases here pass even if `asciiUpper` folds nothing: one
    // asserts the IFC4 default, and the other feeds input that is already
    // upper-case. This is the one that dies if the fold stops folding, and it
    // is the direction the doc comment promises -- every file that resolved
    // before keeps resolving the same way.
    const text =
      'ISO-10303-21;\nHEADER;\n' +
      "FILE_DESCRIPTION(('exported by acme ifc4x3 exporter'),'2;1');\n" +
      'ENDSEC;\nDATA;\nENDSEC;\n';
    expect(detectSchemaVersion(enc(text), parseSourceHeader(enc(text)))).toBe('IFC4X3');
  });

  it('still finds a real identifier in the same position', () => {
    const text =
      'ISO-10303-21;\nHEADER;\n' +
      "FILE_DESCRIPTION(('exported by IFC5 Studio'),'2;1');\n" +
      'ENDSEC;\nDATA;\nENDSEC;\n';
    expect(detectSchemaVersion(enc(text), parseSourceHeader(enc(text)))).toBe('IFC5');
  });
});
