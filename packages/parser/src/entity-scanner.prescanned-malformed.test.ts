/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3790: the browser's sharded pre-pass is the load path a large model
 * takes, and it hands the parser worker a finished entity index instead of
 * letting it scan. #3695 made a malformed-record stop reportable on the paths
 * that scan (`worker`, `tokenizer`); on the `pre-scanned` path there is
 * nothing left to observe -- the record that stopped the scan, and every record
 * after it, is simply absent from the columns. So the flag has to travel WITH
 * the columns, exactly like `oversizedIdCount` (#3395) does, or the viewer
 * shows a model missing its tail and says the load went fine.
 *
 * These tests mock the handoff rather than the pre-pass: the producer is Rust
 * behind a worker, and what this side owns is "given a producer that reports a
 * stop, does the diagnostic reach the caller".
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

const RECORD_1 = "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);";
const RECORD_2 = "#2=IFCWALL('0000000000000000000002',$,'Wall2',$,$,$,$,$,$);";

const TEXT = [HEADER, RECORD_1, RECORD_2, FOOTER].join('\n');
const BUFFER = new TextEncoder().encode(TEXT).buffer;

/**
 * The columns a pre-pass that stopped at `#2` produces: `#1` and nothing else.
 * Byte offsets are read out of the same text the buffer holds, so the refs the
 * scanner rebuilds from them are real records rather than arbitrary spans.
 */
function columnsForFirstRecordOnly() {
  const start = TEXT.indexOf(RECORD_1);
  return {
    ids: Uint32Array.from([1]),
    starts: Uint32Array.from([start]),
    lengths: Uint32Array.from([RECORD_1.length]),
  };
}

describe('scanIfcEntities: a pre-scanned index that stopped at a malformed record', () => {
  it('reports malformedRecordCount and emits the diagnostic the scanning paths emit', async () => {
    const diagnostics: string[] = [];
    const result = await scanIfcEntities(BUFFER, {
      disableWorkerScan: true,
      preScannedEntityIndex: {
        ...columnsForFirstRecordOnly(),
        oversizedIdCount: 0,
        malformedRecordCount: 1,
      },
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.scanPath).toBe('pre-scanned');
    expect(result.malformedRecordCount).toBe(1);
    // `#2` is gone and is not recoverable from these columns. The point of the
    // issue is that the caller is TOLD, not that the record comes back.
    expect(result.entityRefs.map((r) => r.expressId)).toEqual([1]);
    expect(
      diagnostics.some((m) => m.includes('stopped early') && m.includes('a record had')),
    ).toBe(true);
  });

  it('stays silent for a pre-pass that reports a clean run', async () => {
    const diagnostics: string[] = [];
    const result = await scanIfcEntities(BUFFER, {
      disableWorkerScan: true,
      preScannedEntityIndex: {
        ...columnsForFirstRecordOnly(),
        oversizedIdCount: 0,
        malformedRecordCount: 0,
      },
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.malformedRecordCount).toBe(0);
    expect(diagnostics.some((m) => m.includes('stopped early'))).toBe(false);
  });

  it('does not turn an UNREPORTED stop into a claim, in either direction', async () => {
    // A producer that sends no flag has said nothing, and that is the state on
    // main today (#3699 unlanded). `EntityScanResult.malformedRecordCount` is
    // a `number` by a contract that predates this field, so the terminal value
    // reads 0 -- but this must not be read as "the pre-pass verified a clean
    // scan", and it is NOT reached by coercing an absent flag anywhere earlier
    // in the chain: `stitchShards` and `deliverEntityIndex` carry undefined all
    // the way to `PreScannedEntityIndex.malformedRecordCount`, which is
    // optional for exactly this reason (pinned in shard-stitch.malformed.test.ts
    // and entity-index-malformed-count.test.ts).
    //
    // The silence is deliberate too: no producer can say "I ran clean" yet, so
    // a diagnostic here would fire on every load of every file and mean nothing.
    const diagnostics: string[] = [];
    const result = await scanIfcEntities(BUFFER, {
      disableWorkerScan: true,
      preScannedEntityIndex: { ...columnsForFirstRecordOnly(), oversizedIdCount: 0 },
      onDiagnostic: (m) => diagnostics.push(m),
    });

    expect(result.malformedRecordCount).toBe(0);
    expect(diagnostics.some((m) => m.includes('stopped early'))).toBe(false);
  });
});
