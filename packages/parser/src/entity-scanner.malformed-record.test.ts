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
    expect(diagnostics.some((m) => m.includes('stopped early') && m.includes('1 record'))).toBe(true);
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
