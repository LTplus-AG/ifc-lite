/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3395: express ids above 2^32.
 *
 * Every store this toolkit keys on an express id narrows it to 32 bits, so a
 * parse boundary that admitted `#4294967297` handed `CompactEntityIndex` an id
 * it stored as `1` — entity #1's key, serving entity #4294967297's byte range
 * and type, and out of the sort order `binarySearch` depends on. The bound now
 * lives at the boundary, the refusal is counted and reported, and the index
 * refuses to narrow rather than trusting its caller.
 *
 * `#4294967295` (u32::MAX) is a legitimate id and must keep loading: the two
 * directions of the threshold are asserted separately.
 */

import { RelationshipType } from '@ifc-lite/data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getReference } from '../src/attribute-helpers.js';
import {
  buildCompactEntityIndex,
  CompactEntityIndexBuilder,
} from '../src/compact-entity-index.js';
import { scanIfcEntities } from '../src/entity-scanner.js';
import { EntityExtractor } from '../src/entity-extractor.js';
import { WORKER_CODE } from '../src/scan-worker-inline.js';
import { IfcParser } from '../src/index.js';
import type { EntityRef } from '../src/types.js';

const ABOVE_U32 = 4_294_967_297; // 2^32 + 1 — truncates to 1 in a Uint32Array
const U32_MAX = 4_294_967_295;

const IFC_SOURCE = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCWALL('GID-one',$,'Wall one',$,$,$,$,$,.NOTDEFINED.);",
  `#${ABOVE_U32}=IFCWALL('GID-big',$,'Wall big',$,$,$,$,$,.NOTDEFINED.);`,
  `#${U32_MAX}=IFCWALL('GID-max',$,'Wall max',$,$,$,$,$,.NOTDEFINED.);`,
  'ENDSEC;',
  'END-ISO-10303-21;',
].join('\n');

function encodeSource(source: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(source);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function ref(expressId: number, byteOffset = 0): EntityRef {
  return { expressId, type: 'IFCWALL', byteOffset, byteLength: 10, lineNumber: 1 };
}

/**
 * A `Worker` stand-in that runs the real `WORKER_CODE` in-process.
 *
 * Under vitest `Worker` is undefined, so `scanIfcEntities` takes the tokenizer
 * path and the worker branch — the DEFAULT path in a browser — is never
 * exercised. Stubbing the class rather than the scan lets the genuine worker
 * source produce the genuine message, so what is under test is the plumbing
 * from that message to `EntityScanResult`, not a hand-written stand-in of it.
 */
class InProcessScanWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;

  terminate(): void {
    /* nothing to tear down: the scan ran synchronously in postMessage */
  }

  postMessage(buffer: ArrayBuffer): void {
    const workerSelf: {
      onmessage?: (event: { data: ArrayBuffer }) => void;
      postMessage?: (message: unknown) => void;
    } = {};
    workerSelf.postMessage = (message: unknown) => {
      queueMicrotask(() => this.onmessage?.({ data: message }));
    };
    // `WORKER_CODE` is a source STRING (it is turned into a Blob URL in
    // production), so evaluating it is the only way to run the real worker
    // rather than a re-implementation of it. Same pattern as
    // scan-worker-inline-collision.test.ts.
    // eslint-disable-next-line no-new-func
    const install = new Function('self', WORKER_CODE) as (scope: unknown) => void;
    install(workerSelf);
    workerSelf.onmessage?.({ data: buffer });
  }
}

describe('scanIfcEntities and an express id above 2^32', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses the record, keeps its neighbours, and reports the refusal', async () => {
    const diagnostics: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await scanIfcEntities(encodeSource(IFC_SOURCE), {
      onDiagnostic: (message) => diagnostics.push(message),
    });

    expect(result.scanPath).toBe('tokenizer');
    const ids = result.entityRefs.map((entityRef) => entityRef.expressId);
    expect(ids).toEqual([1, U32_MAX]);
    expect(result.oversizedIdCount).toBe(1);
    // The report half of the guard, on both channels the loader watches: a
    // record that vanishes without a trace is the same defect the truncation
    // was, and each channel fails on its own.
    expect(diagnostics.some((message) => message.includes('skipped 1 record(s)'))).toBe(true);
    expect(
      warn.mock.calls.some((args) => args.some((arg) => String(arg).includes('skipped 1 record(s)'))),
    ).toBe(true);
  });

  it('carries the worker path’s refusal count out of the worker message', async () => {
    // The browser default path. Its count crosses a postMessage boundary, so
    // it is plumbing the tokenizer path cannot stand in for: dropping it
    // leaves a load that is quietly one record short with `oversizedIdCount`
    // reading 0, which is indistinguishable from a clean file.
    vi.stubGlobal('Worker', InProcessScanWorker);
    const diagnostics: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await scanIfcEntities(encodeSource(IFC_SOURCE), {
      onDiagnostic: (message) => diagnostics.push(message),
    });

    expect(result.scanPath).toBe('worker');
    expect(result.entityRefs.map((entityRef) => entityRef.expressId)).toEqual([1, U32_MAX]);
    expect(result.oversizedIdCount).toBe(1);
    expect(diagnostics.some((message) => message.includes('skipped 1 record(s)'))).toBe(true);
  });

  it('carries the pre-scanned path’s refusal count out of the set-entity-index handoff', async () => {
    // The canonical viewer load: for a file at or above 2 MB the streaming
    // geometry pre-pass has already scanned it, and `scanIfcEntities` builds
    // the refs from the handed-over columns without scanning at all. A record
    // the pre-pass refused is ABSENT from `ids` — nothing on this side can
    // recount it — so if the count does not ride along with the columns the
    // load reports clean and comes back one record short. That is the gap two
    // reviewers found in the first #3395 change.
    const diagnostics: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = encodeSource(IFC_SOURCE);
    const text = new TextDecoder().decode(source);
    const spanOf = (id: number) => {
      const start = text.indexOf(`#${id}=`);
      return { start, length: text.indexOf(';', start) + 1 - start };
    };
    const one = spanOf(1);
    const max = spanOf(U32_MAX);

    const result = await scanIfcEntities(source, {
      disableWorkerScan: true,
      onDiagnostic: (message) => diagnostics.push(message),
      preScannedEntityIndex: {
        // Exactly what the pre-pass hands over: the oversized record is not
        // in the columns, because the Rust scanner already refused it.
        ids: new Uint32Array([1, U32_MAX]),
        starts: new Uint32Array([one.start, max.start]),
        lengths: new Uint32Array([one.length, max.length]),
        oversizedIdCount: 1,
      },
    });

    expect(result.scanPath).toBe('pre-scanned');
    expect(result.entityRefs.map((entityRef) => entityRef.expressId)).toEqual([1, U32_MAX]);
    expect(result.oversizedIdCount).toBe(1);
    expect(diagnostics.some((message) => message.includes('skipped 1 record(s)'))).toBe(true);
    expect(
      warn.mock.calls.some((args) => args.some((arg) => String(arg).includes('skipped 1 record(s)'))),
    ).toBe(true);
  });

  it('reports nothing on a pre-scanned handoff that refused nothing', async () => {
    // The other direction of the pre-scanned report, and the reason the field
    // is read rather than assumed: a pre-pass that refused nothing sends 0,
    // and an older host that sends no field at all must also stay quiet.
    const diagnostics: string[] = [];
    const source = encodeSource(IFC_SOURCE);
    const text = new TextDecoder().decode(source);
    const start = text.indexOf('#1=');
    const columns = {
      ids: new Uint32Array([1]),
      starts: new Uint32Array([start]),
      lengths: new Uint32Array([text.indexOf(';', start) + 1 - start]),
    };

    // A producer that REPORTS zero is a clean scan and says nothing.
    const reported = await scanIfcEntities(source, {
      disableWorkerScan: true,
      onDiagnostic: (message) => diagnostics.push(message),
      preScannedEntityIndex: { ...columns, oversizedIdCount: 0 },
    });
    expect(reported.scanPath).toBe('pre-scanned');
    expect(reported.oversizedIdCount).toBe(0);
    expect(diagnostics.some((m) => m.includes('skipped') || m.includes('not proof'))).toBe(false);

    // A producer that does NOT report is a different claim, and must not be
    // passed off as a clean scan. `PreScannedEntityIndex.oversizedIdCount`'s
    // own doc says `undefined` means "this producer does not report", which is
    // not what `0` asserts — an older wasm build sends the three columns and
    // nothing else. The number still reads 0 because the field is `number`, so
    // the distinction has to survive in the REPORT.
    diagnostics.length = 0;
    const unreported = await scanIfcEntities(source, {
      disableWorkerScan: true,
      onDiagnostic: (message) => diagnostics.push(message),
      preScannedEntityIndex: { ...columns, oversizedIdCount: undefined },
    });
    expect(unreported.scanPath).toBe('pre-scanned');
    expect(unreported.oversizedIdCount).toBe(0);
    expect(diagnostics.some((m) => m.includes('not proof that none were skipped'))).toBe(true);
    expect(diagnostics.some((m) => m.includes('skipped 0 record'))).toBe(false);
  });

  it('counts one refusal per refused RECORD, not per oversized reference', async () => {
    // An accepted record is left behind by skipping to its terminating ';', so
    // its argument list is never re-scanned. A REFUSED one is not: the scan
    // resumes a few bytes into it and walks the body, where `#4294967298` and
    // `#4294967299` are references, not declarations. Counting those made the
    // number the user is shown scale with the refused record's reference
    // count — "skipped 3 record(s)" for one dropped record — on exactly the
    // files this guard exists for, where ids above 2^32 come in runs and
    // reference each other. Rust's `EntityScanner` counts only what matches
    // `#<digits>[ws]*=`; both TypeScript scans now do too.
    //
    // Both paths, because they are separate copies of the same loop and the
    // inline worker's copy fails independently of the tokenizer's.
    const source = encodeSource(
      [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_SCHEMA(('IFC4'));",
        'ENDSEC;',
        'DATA;',
        "#1=IFCWALL('GID-one',$,'Wall one',$,$,$,$,$,.NOTDEFINED.);",
        `#${ABOVE_U32}=IFCWALL('GID-big',#${ABOVE_U32 + 1},#${ABOVE_U32 + 2},$,$,$,$,$,.NOTDEFINED.);`,
        'ENDSEC;',
        'END-ISO-10303-21;',
      ].join('\n'),
    );

    for (const useWorker of [false, true]) {
      if (useWorker) vi.stubGlobal('Worker', InProcessScanWorker);
      const diagnostics: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await scanIfcEntities(source, {
        disableWorkerScan: !useWorker,
        onDiagnostic: (message) => diagnostics.push(message),
      });

      expect(result.scanPath).toBe(useWorker ? 'worker' : 'tokenizer');
      expect(result.entityRefs.map((entityRef) => entityRef.expressId)).toEqual([1]);
      expect(result.oversizedIdCount).toBe(1);
      expect(diagnostics.some((message) => message.includes('skipped 1 record(s)'))).toBe(true);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('does not attribute an earlier path’s refusal count to the wasm scan', async () => {
    // `scanEntitiesFast` returns entity refs and nothing else, so the wasm path
    // has no count of its own — Rust reports that refusal straight to the
    // console instead. Reaching it means an earlier path already ran and left
    // `oversizedIdCount` set (here: a pre-scanned index whose columns build no
    // refs, which is what a file with nothing BUT refused records looks like).
    // Carrying that number forward would put a count on a scan that never
    // produced it, and warn the caller about records this scan did find.
    const diagnostics: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = encodeSource(IFC_SOURCE);

    const result = await scanIfcEntities(source, {
      disableWorkerScan: true,
      onDiagnostic: (message) => diagnostics.push(message),
      preScannedEntityIndex: {
        ids: new Uint32Array(),
        starts: new Uint32Array(),
        lengths: new Uint32Array(),
        oversizedIdCount: 4,
      },
      wasmApi: {
        scanEntitiesFastBytes: () => [
          { expressId: 1, type: 'IFCWALL', byteOffset: 0, byteLength: 10, lineNumber: 1 },
        ],
      },
    });

    expect(result.scanPath).toBe('wasm');
    expect(result.oversizedIdCount).toBe(0);
    expect(diagnostics.some((message) => message.includes('skipped'))).toBe(false);
    expect(
      warn.mock.calls.some((args) => args.some((arg) => String(arg).includes('skipped'))),
    ).toBe(false);
  });

  it('reports nothing on a file whose ids all fit', async () => {
    // The other direction of the report: a clean file must not warn, or the
    // message stops meaning anything.
    const diagnostics: string[] = [];
    const clean = IFC_SOURCE.split('\n')
      .filter((line) => !line.startsWith(`#${ABOVE_U32}=`))
      .join('\n');

    const result = await scanIfcEntities(encodeSource(clean), {
      onDiagnostic: (message) => diagnostics.push(message),
    });

    expect(result.entityRefs.map((entityRef) => entityRef.expressId)).toEqual([1, U32_MAX]);
    expect(result.oversizedIdCount).toBe(0);
    expect(diagnostics.some((message) => message.includes('skipped'))).toBe(false);
  });
});

describe('parseColumnar and an express id above 2^32', () => {
  it('serves entity #1 its own data, not the oversized record’s', async () => {
    const store = await new IfcParser().parseColumnar(encodeSource(IFC_SOURCE));

    // The truncation's signature: `#4294967297 % 2^32 === 1`, so #1's key
    // could resolve to the big record's GlobalId.
    expect(store.entities.getGlobalId(1)).toBe('GID-one');
    expect(store.entityIndex.byId.get(1)?.expressId).toBe(1);
  });

  it('does not index the oversized id under any key', async () => {
    const store = await new IfcParser().parseColumnar(encodeSource(IFC_SOURCE));

    // Asserting `get(ABOVE_U32) === undefined` alone would pass with the
    // defect present, because truncation is exactly what makes that lookup
    // miss. The key LIST is what discriminates: narrowing after the sort
    // produced [1, 4294967295, 1] — a duplicate key AND an out-of-order entry,
    // which is what breaks the binary search the index is built on.
    expect([...store.entityIndex.byId.keys()]).toEqual([1, U32_MAX]);
    expect(store.entityIndex.byId.get(ABOVE_U32)).toBeUndefined();
    expect(store.entityIndex.byId.has(ABOVE_U32)).toBe(false);
  });

  it('still loads an id of exactly u32::MAX', async () => {
    const store = await new IfcParser().parseColumnar(encodeSource(IFC_SOURCE));

    expect(store.entityIndex.byId.has(U32_MAX)).toBe(true);
    expect(store.entities.getGlobalId(U32_MAX)).toBe('GID-max');
  });
});

describe('reference readers and an express id above 2^32', () => {
  it('reads an oversized attribute reference as dangling, not as a low id', () => {
    const source = `#1=IFCWALL('GID-one',$,$,$,$,$,$,$,.NOTDEFINED.);\n#2=IFCRELAGGREGATES('r',$,$,$,#${ABOVE_U32},(#1));\n`;
    const extractor = new EntityExtractor(new Uint8Array(encodeSource(source)));
    const entity = extractor.extractEntity({
      expressId: 2,
      type: 'IFCRELAGGREGATES',
      byteOffset: source.indexOf('#2='),
      byteLength: source.length - source.indexOf('#2='),
      lineNumber: 2,
    });

    // Not 1: the RelatingObject must not resolve onto a real entity.
    expect(entity?.attributes[4]).toBeNull();
  });

  it('refuses to extract a record whose own id is out of contract', () => {
    // `EntityExtractor` re-reads `#<digits>` from the bytes rather than
    // trusting the ref it was handed, so it is its own admission site. It is
    // unreachable from a guarded scan, which is exactly why it needs its own
    // assertion: nothing else would notice if it started admitting again.
    const source = `#${ABOVE_U32}=IFCWALL('GID-big',$,$,$,$,$,$,$,.NOTDEFINED.);\n`;
    const extractor = new EntityExtractor(new Uint8Array(encodeSource(source)));

    expect(
      extractor.extractEntity({
        expressId: ABOVE_U32,
        type: 'IFCWALL',
        byteOffset: 0,
        byteLength: source.length,
        lineNumber: 1,
      }),
    ).toBeNull();
  });

  it('keeps an oversized related-object out of the relationship graph', async () => {
    // The byte-level `readRefId` path, and a second place the same collision
    // lands: `RelationshipEdges.edgeTargets` is a `Uint32Array`, so an
    // oversized RelatedObject that survives the read is stored as
    // `4294967297 % 2^32 === 1` and storey #2 reports containing wall #1 —
    // an element it was never related to.
    const source = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      "#1=IFCWALL('GID-one',$,$,$,$,$,$,$,.NOTDEFINED.);",
      "#2=IFCBUILDINGSTOREY('GID-storey',$,$,$,$,$,$,$,$,$,$);",
      `#10=IFCRELCONTAINEDINSPATIALSTRUCTURE('GID-rel',$,$,$,(#${ABOVE_U32}),#2);`,
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');
    const store = await new IfcParser().parseColumnar(encodeSource(source));

    expect(
      store.relationships.getRelated(2, RelationshipType.ContainsElements, 'forward'),
    ).toEqual([]);
  });

  it('refuses an oversized reference in getReference but keeps u32::MAX', () => {
    expect(getReference(`#${ABOVE_U32}`)).toBeUndefined();
    expect(getReference(ABOVE_U32)).toBeUndefined();
    expect(getReference(`#${U32_MAX}`)).toBe(U32_MAX);
  });
});

describe('CompactEntityIndex refuses to narrow an out-of-contract id', () => {
  it('throws from buildCompactEntityIndex, naming the id', () => {
    expect(() => buildCompactEntityIndex([ref(1), ref(ABOVE_U32)])).toThrow(
      String(ABOVE_U32),
    );
    expect(() => buildCompactEntityIndex([ref(1), ref(U32_MAX)])).not.toThrow();
  });

  it('throws from CompactEntityIndexBuilder.add, naming the id', () => {
    const builder = new CompactEntityIndexBuilder(4);
    builder.add(1, 'IFCWALL', 0, 10);
    expect(() => builder.add(ABOVE_U32, 'IFCWALL', 0, 10)).toThrow(String(ABOVE_U32));
    expect(() => builder.add(U32_MAX, 'IFCWALL', 0, 10)).not.toThrow();
  });

  it('leaves no phantom slot behind when add() refuses an id', () => {
    // The throw has to land before the slot is claimed. If it lands after
    // `count++`, a caller that catches it and still calls build() gets an
    // index one entry longer than it added, and that entry reads back as
    // express id 0 with the first type string and a zero byte range -- the
    // same one-entity-serves-another confusion the bound exists to stop.
    const builder = new CompactEntityIndexBuilder(4);
    builder.add(1, 'IFCWALL', 0, 10);
    expect(() => builder.add(ABOVE_U32, 'IFCWALL', 10, 10)).toThrow();
    builder.add(2, 'IFCSLAB', 20, 10);

    const index = builder.build();
    expect(index.size).toBe(2);
    expect([...index.keys()]).toEqual([1, 2]);
  });

  it('refuses a negative id, which aliases onto the top of the range', () => {
    // The bound's lower end, and it is not decoration: `scanIfcEntities`
    // accepts wasm-supplied refs through `normalizeWasmEntityRef`, which
    // admits any finite number. `new Uint32Array(1)[0] = -1` reads back as
    // 4294967295, so a negative id lands on u32::MAX — the same
    // one-entity-serves-another collision, at the other end.
    expect(() => buildCompactEntityIndex([ref(1), ref(-1)])).toThrow('-1');
    expect(() => new CompactEntityIndexBuilder(4).add(-1, 'IFCWALL', 0, 10)).toThrow('-1');
    expect(getReference(-1)).toBeUndefined();
    expect(getReference(0)).toBe(0);
  });
});
