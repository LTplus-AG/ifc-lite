/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A quoted string that opens (an unescaped `'`) but never closes leaves the
 * "skip to the next `;`" scan with no terminator to find for that record —
 * and, before this fix, no way back either: the scan just ran to
 * end-of-buffer and stopped, silently reporting whatever it had found so
 * far as a complete, successful result.
 *
 * The same shape of bug as #3395 (an oversized express id refused with no
 * signal), but worse in effect: that one drops a single record, this one
 * used to drop everything after it too. Real-world triggers include a file
 * truncated mid-string (by a bad download or a failed export) and a single
 * corrupted record from a lossy round-trip through another tool.
 */

import { describe, expect, it } from 'vitest';
import { scanIfcEntities } from './entity-scanner.js';

const HEADER = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
].join('\n');

const FOOTER = ['ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');

function ifcBuffer(dataLines: string[]): ArrayBuffer {
  const text = [HEADER, ...dataLines, FOOTER].join('\n');
  return new TextEncoder().encode(text).buffer;
}

describe('scanIfcEntities: unterminated string literal', () => {
  it('reports malformedRecordCount and a diagnostic, and stops at the broken record', async () => {
    const buffer = ifcBuffer([
      "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
      // Opens a quote in the Name argument and never closes it.
      "#2=IFCWALL('0000000000000000000002',$,'Wall2 unterminated,$,$,$,$,$,$);",
      // A well-formed record after the corruption — currently unrecoverable
      // (there is no reliable resync point once a string fails to close),
      // and the point of this test: the caller must be TOLD that, not left
      // to trust a short `entityRefs` as if it were complete.
      "#3=IFCWALL('0000000000000000000003',$,'Wall3',$,$,$,$,$,$);",
    ]);

    const diagnostics: string[] = [];
    const result = await scanIfcEntities(buffer, {
      disableWorkerScan: true,
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.scanPath).toBe('tokenizer');
    expect(result.malformedRecordCount).toBe(1);
    // #3 is not recovered — asserting that honestly, so a future resync
    // attempt has to update this test rather than silently regress it.
    expect(result.entityRefs.map((r) => r.expressId)).toEqual([1]);
    expect(diagnostics.some((m) => m.includes('stopped early') && m.includes('a record had'))).toBe(true);
  });

  it('does not report malformedRecordCount, or emit its diagnostic, for a well-formed file', async () => {
    const buffer = ifcBuffer([
      "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
      "#2=IFCWALL('0000000000000000000002',$,'Wall2',$,$,$,$,$,$);",
      "#3=IFCWALL('0000000000000000000003',$,'Wall3',$,$,$,$,$,$);",
    ]);

    const diagnostics: string[] = [];
    const result = await scanIfcEntities(buffer, {
      disableWorkerScan: true,
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.malformedRecordCount).toBe(0);
    expect(result.entityRefs.map((r) => r.expressId)).toEqual([1, 2, 3]);
    expect(diagnostics.some((m) => m.includes('stopped early'))).toBe(false);
  });
});

describe('scanIfcEntities: unterminated comment inside a record', () => {
  it('reports malformedRecordCount and a diagnostic too, not just for an unterminated string', async () => {
    // Same silent-drop shape as the unterminated string above, but through
    // tokenizer.ts's OTHER "no terminator" branch (an unclosed `/* ... */`
    // rather than an unclosed `'`). That branch used to `return` out of the
    // generator before reaching the `malformedRecords++` it shares with the
    // string case, so this shape reached `scanIfcEntities` as a quiet,
    // successful-looking short result -- see tokenizer.test.ts for the
    // isolated repro.
    const buffer = ifcBuffer([
      "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
      "#2=IFCWALL('0000000000000000000002', /* never closes $,$,$,$,$,$,$);",
      "#3=IFCWALL('0000000000000000000003',$,'Wall3',$,$,$,$,$,$);",
    ]);

    const diagnostics: string[] = [];
    const result = await scanIfcEntities(buffer, {
      disableWorkerScan: true,
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.scanPath).toBe('tokenizer');
    expect(result.malformedRecordCount).toBe(1);
    expect(result.entityRefs.map((r) => r.expressId)).toEqual([1]);
    expect(diagnostics.some((m) => m.includes('stopped early') && m.includes('a record had'))).toBe(true);
  });
});

describe('scanIfcEntities: unterminated comment before the record body opens', () => {
  it('reports malformedRecordCount and a diagnostic for a leading unterminated comment', async () => {
    // A comment before '=', the type name, or '(' is valid ISO 10303-21 --
    // but if it never closes, the record has no body to fall back on for a
    // resync point. This exercises the earlier of the two "no terminator"
    // shapes: skipTrivia's t.stop return, which used to skip the count
    // entirely (see tokenizer.test.ts for the isolated repro).
    const buffer = ifcBuffer([
      "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
      '#2 /* never closes',
    ]);

    const diagnostics: string[] = [];
    const result = await scanIfcEntities(buffer, {
      disableWorkerScan: true,
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.scanPath).toBe('tokenizer');
    expect(result.malformedRecordCount).toBe(1);
    expect(result.entityRefs.map((r) => r.expressId)).toEqual([1]);
    expect(diagnostics.some((m) => m.includes('stopped early') && m.includes('a record had'))).toBe(true);
    // The message must not claim the construct was a string literal when it
    // was actually a comment -- the whole point of #3695's remaining
    // review finding.
    expect(diagnostics.some((m) => m.includes('string literal or comment'))).toBe(true);
  });
});

describe('scanIfcEntities: shapes the per-site increments missed (round 2)', () => {
  // These three shapes are none of the ones already covered above: they run
  // through the outer, non-entity part of the loop (a HEADER string, or a
  // stray literal between two DATA records), or through the '#id=TYPE('
  // header itself being cut off before any of the record-body logic runs.
  // The single post-loop check (`stopped`/`declOpen` in scanEntitiesFast)
  // catches all of them; the old per-exit-site increments caught none.

  it('reports malformedRecordCount for an unterminated quote in the HEADER section', async () => {
    // An unescaped apostrophe splits one string into two: 'it' closes
    // immediately (no doubled quote follows), then the bare "s a file"
    // opens a second string at its own trailing quote, and that one never
    // closes before EOF. The classic real-world trigger this whole PR is
    // about, just above DATA rather than inside a record.
    const text = "ISO-10303-21;\nHEADER;\nFILE_NAME('it's a file',$,$,$,$,$,$);\n";
    const buffer = new TextEncoder().encode(text).buffer;

    const diagnostics: string[] = [];
    const result = await scanIfcEntities(buffer, {
      disableWorkerScan: true,
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.scanPath).toBe('tokenizer');
    expect(result.malformedRecordCount).toBe(1);
    expect(result.entityRefs).toEqual([]);
    expect(diagnostics.some((m) => m.includes('stopped early'))).toBe(true);
  });

  it('reports malformedRecordCount for a stray unclosed comment between two DATA records', async () => {
    const text = "#1=IFCWALL($,$,$);\n/* never closes\n#2=IFCWALL($,$,$);\n";
    const buffer = new TextEncoder().encode(text).buffer;

    const diagnostics: string[] = [];
    const result = await scanIfcEntities(buffer, {
      disableWorkerScan: true,
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.scanPath).toBe('tokenizer');
    expect(result.malformedRecordCount).toBe(1);
    expect(result.entityRefs.map((r) => r.expressId)).toEqual([1]);
    expect(diagnostics.some((m) => m.includes('stopped early'))).toBe(true);
  });

  it.each([
    ['#2 at EOF, before any =', '#2'],
    ['#2= at EOF, before the type name', '#2='],
    ['#2=IFCWA at EOF, mid type name, before (', '#2=IFCWA'],
  ])('reports malformedRecordCount for a declaration cut off: %s', async (_label, cutoff) => {
    const text = `#1=IFCWALL($,$,$);\n${cutoff}`;
    const buffer = new TextEncoder().encode(text).buffer;

    const diagnostics: string[] = [];
    const result = await scanIfcEntities(buffer, {
      disableWorkerScan: true,
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.scanPath).toBe('tokenizer');
    expect(result.malformedRecordCount).toBe(1);
    expect(result.entityRefs.map((r) => r.expressId)).toEqual([1]);
    expect(diagnostics.some((m) => m.includes('stopped early'))).toBe(true);
  });
});

describe('scanIfcEntities: declOpen false positive from a reference inside an abandoned record (round 3)', () => {
  it('does not report malformedRecordCount when the LAST record is refused for an oversized express id', async () => {
    // #4294967297 is refused (#3395) after the '=' check passes, so the scan
    // resumes right past the '=' and walks "IFCWALL(#1,#2);..." byte by
    // byte. The '#1' and '#2' reference tokens inside that abandoned
    // record's own argument list each look like a fresh declaration start:
    // digits, then a byte that is not '=', with the rest of the buffer
    // (",#2)" / ")") still ahead of them. Before this fix, declOpen stayed
    // armed on that non-EOF mismatch and never got a later chance to clear,
    // so a file whose scan ran cleanly to the very end still reported
    // "stopped early" -- see the isolated repro in tokenizer.test.ts.
    const text =
      "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);\n" +
      '#4294967297=IFCWALL(#1,#2);\n';
    const buffer = new TextEncoder().encode(text).buffer;

    const diagnostics: string[] = [];
    const result = await scanIfcEntities(buffer, {
      disableWorkerScan: true,
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.scanPath).toBe('tokenizer');
    expect(result.oversizedIdCount).toBe(1);
    expect(result.malformedRecordCount).toBe(0);
    expect(result.entityRefs.map((r) => r.expressId)).toEqual([1]);
    expect(diagnostics.some((m) => m.includes('stopped early'))).toBe(false);
  });

  it('control: a declaration genuinely cut off at EOF still reports malformedRecordCount 1', async () => {
    // Same shape of input (a well-formed record, then a second one that
    // never completes), but this time the second one is cut off by real
    // end-of-buffer rather than abandoned mid-file for a non-EOF reason --
    // the fix above must not have swallowed this together with the false
    // positive.
    const text = "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);\n#2=IFCWA";
    const buffer = new TextEncoder().encode(text).buffer;

    const result = await scanIfcEntities(buffer, { disableWorkerScan: true });

    expect(result.scanPath).toBe('tokenizer');
    expect(result.malformedRecordCount).toBe(1);
    expect(result.entityRefs.map((r) => r.expressId)).toEqual([1]);
  });
});
