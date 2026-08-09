/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Direct coverage for {@link parseSourceHeader}.
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
import { parseSourceHeader } from '../src/source-header.js';
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
