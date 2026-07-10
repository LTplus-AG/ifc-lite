/* Adversarial probes for PR #1680 parser gate (wasmBytesScanAllowed).
 * Written to break the feature; safe to delete. */

import { describe, expect, it, vi } from 'vitest';
import { scanIfcEntities, wasmBytesScanAllowed } from './entity-scanner.js';

const SMALL_IFC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
  "#2=IFCWALL('0000000000000000000002',$,$,$,$,$,$,$,$);",
  "#3=IFCWALL('0000000000000000000003',$,$,$,$,$,$,$,$);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

function ifcBuffer(): ArrayBuffer {
  return new TextEncoder().encode(SMALL_IFC).buffer;
}

describe('ADVERSARIAL: wasmBytesScanAllowed boundary', () => {
  it('gate is decimal 2.5e9 (matches geometry huge-file 1e9 GB, NOT GiB)', () => {
    // If it were GiB the threshold would be 2.5 * 1024^3 = 2_684_354_560.
    expect(wasmBytesScanAllowed(2_500_000_000)).toBe(false); // strict <: agrees with geometry >= at the boundary
    expect(wasmBytesScanAllowed(2_500_000_001)).toBe(false);
    // A GiB-based reader would wrongly allow this; assert we do NOT.
    expect(wasmBytesScanAllowed(2_684_354_560)).toBe(false);
  });
});

describe('ADVERSARIAL: null selectWasmScanFunction reaches the JS tokeniser', () => {
  it('when scanEntitiesFastBytes throws, the scan falls through to the tokeniser', async () => {
    // Positive control for the whole fallback chain: even a broken wasm API must
    // not strand the parse — the JS tokeniser recovers. (The >2.5GB gate returns
    // null the same way, taking the identical fall-through path.)
    const scanEntitiesFastBytes = vi.fn(() => {
      throw new Error('unreachable executed'); // simulate the wasm32 OOM trap
    });
    const res = await scanIfcEntities(ifcBuffer(), {
      disableWorkerScan: true,
      wasmApi: { scanEntitiesFastBytes },
    });
    expect(scanEntitiesFastBytes).toHaveBeenCalledTimes(1);
    expect(res.scanPath).toBe('tokenizer');
    // The tokeniser still finds both walls + the project.
    expect(res.entityRefs.length).toBeGreaterThanOrEqual(3);
  });

  it('a supplied wasm byte API IS used for an in-budget buffer (proves it is wired, so the gate matters)', async () => {
    const scanEntitiesFastBytes = vi.fn(() => [
      { expressId: 1, type: 'IFCPROJECT', byteOffset: 0, byteLength: 10, lineNumber: 1 },
    ]);
    const res = await scanIfcEntities(ifcBuffer(), {
      disableWorkerScan: true,
      wasmApi: { scanEntitiesFastBytes },
    });
    expect(scanEntitiesFastBytes).toHaveBeenCalledTimes(1);
    expect(res.scanPath).toBe('wasm');
  });
});
