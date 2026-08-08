/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IfcParser } from '../src/index.js';
import {
  collectTransferables,
  fromTransport,
  toTransport,
  transportByteSize,
} from '../src/data-store-transport.js';
import { extractPropertiesOnDemand } from '../src/columnar-parser.js';
import { contiguousSourceBytes, type IfcSourceBytes } from '../src/source-bytes.js';

/**
 * Resolve a fixture from the external ara3d worktree. Tests skip cleanly
 * when the fixture is unavailable so fresh clones don't break.
 */
function fixture(name: string): string | null {
  const candidates = [
    resolve('/Users/louistrue/Development/ifc-lite-fixtures-wt/tests/models/ara3d', name),
    resolve(__dirname, '..', '..', '..', 'tests', 'models', 'ara3d', name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readFixture(name: string): ArrayBuffer | null {
  const path = fixture(name);
  if (!path) return null;
  const bytes = readFileSync(path);
  // Copy into a clean ArrayBuffer (Node Buffer aliases a shared pool).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

describe('parseColumnar on SharedArrayBuffer source', () => {
  it('parses a fixture whose source is SAB-backed (no TextDecoder/SAB error)', async () => {
    if (typeof SharedArrayBuffer === 'undefined') {
      console.warn('skip: SharedArrayBuffer unavailable in this runtime');
      return;
    }
    const buffer = readFixture('duplex.ifc') ?? readFixture('IfcOpenHouse_IFC4.ifc');
    if (!buffer) {
      console.warn('skip: ara3d fixture missing — `pnpm fixtures` to fetch');
      return;
    }
    // Copy bytes into a SAB so parseColumnar must walk the SAB-safe path.
    const sab = new SharedArrayBuffer(buffer.byteLength);
    new Uint8Array(sab).set(new Uint8Array(buffer));

    const parser = new IfcParser();
    // disableWorkerScan: true keeps the scan in-process so the SAB-decode
    // path is exercised by the parser itself, not the inline scan worker.
    const store = await parser.parseColumnar(sab as unknown as ArrayBuffer, {
      disableWorkerScan: true,
    });
    expect(store.entityCount).toBeGreaterThan(0);
    expect(store.schemaVersion).toMatch(/^IFC/);
    expect(store.entities.count).toBeGreaterThan(0);

    // Also exercise an on-demand extractor (which decodes subarrays of
    // store.source on the fly) to confirm the main-thread post-parse
    // path is also SAB-safe.
    const sampleId = store.entities.expressId[0];
    const result = store.entities.getName(sampleId);
    expect(typeof result).toBe('string');
  }, 120_000);
});

describe('data-store-transport', () => {
  it('toTransport / fromTransport round-trips a small fixture losslessly', async () => {
    const buffer = readFixture('IfcOpenHouse_IFC4.ifc') ?? readFixture('duplex.ifc');
    if (!buffer) {
      console.warn('skip: ara3d fixture missing — `pnpm fixtures` to fetch');
      return;
    }

    const parser = new IfcParser();
    const original = await parser.parseColumnar(buffer, { disableWorkerScan: true });

    const { payload, transfers } = toTransport(original);
    expect(transfers.length).toBeGreaterThan(0);
    expect(transportByteSize(payload)).toBeGreaterThan(0);

    // Every transfer must be unique (postMessage rejects duplicates).
    const uniq = new Set(transfers);
    expect(uniq.size).toBe(transfers.length);

    // Every transferable must be an ArrayBuffer.
    for (const t of transfers) {
      expect(t).toBeInstanceOf(ArrayBuffer);
    }

    const rebuilt = fromTransport(payload, original.source);
    expect(rebuilt.fileSize).toBe(original.fileSize);
    expect(rebuilt.entityCount).toBe(original.entityCount);
    expect(rebuilt.schemaVersion).toBe(original.schemaVersion);

    // Entity table closures behave the same.
    expect(rebuilt.entities.count).toBe(original.entities.count);
    for (let i = 0; i < Math.min(50, original.entities.count); i++) {
      const id = original.entities.expressId[i];
      expect(rebuilt.entities.getName(id)).toBe(original.entities.getName(id));
      expect(rebuilt.entities.getGlobalId(id)).toBe(original.entities.getGlobalId(id));
      expect(rebuilt.entities.getTypeName(id)).toBe(original.entities.getTypeName(id));
      expect(rebuilt.entities.hasGeometry(id)).toBe(original.entities.hasGeometry(id));
    }

    // CompactEntityIndex round-trips and supports get().
    const sampleId = original.entities.expressId[0];
    expect(rebuilt.entityIndex.byId.has(sampleId)).toBe(true);
    const ref = rebuilt.entityIndex.byId.get(sampleId);
    expect(ref?.expressId).toBe(sampleId);
    expect(ref?.byteLength).toBeGreaterThan(0);

    // byType matches.
    for (const [type, ids] of original.entityIndex.byType) {
      expect(rebuilt.entityIndex.byType.get(type)).toEqual(ids);
    }

    // Spatial hierarchy round-trips (when present).
    if (original.spatialHierarchy) {
      expect(rebuilt.spatialHierarchy).toBeDefined();
      expect(rebuilt.spatialHierarchy!.project.expressId).toBe(original.spatialHierarchy.project.expressId);
      expect(rebuilt.spatialHierarchy!.project.children.length).toBe(original.spatialHierarchy.project.children.length);
    }

    // On-demand property extraction works on the rebuilt store using the
    // same source buffer the original used (round-trip preserves the
    // byteOffset / byteLength columns the extractor depends on).
    const elementWithProps = [...(original.onDemandPropertyMap?.keys() ?? [])][0];
    if (elementWithProps !== undefined) {
      const originalProps = extractPropertiesOnDemand(original, elementWithProps);
      const rebuiltProps = extractPropertiesOnDemand(rebuilt, elementWithProps);
      expect(rebuiltProps.length).toBe(originalProps.length);
      if (originalProps.length > 0) {
        expect(rebuiltProps[0].name).toBe(originalProps[0].name);
        expect(rebuiltProps[0].properties.length).toBe(originalProps[0].properties.length);
      }
    }
  }, 120_000);

  it('collectTransferables returns no duplicates even when arrays alias buffers', async () => {
    const buffer = readFixture('duplex.ifc') ?? readFixture('IfcOpenHouse_IFC4.ifc');
    if (!buffer) {
      console.warn('skip: ara3d fixture missing — `pnpm fixtures` to fetch');
      return;
    }
    const parser = new IfcParser();
    const store = await parser.parseColumnar(buffer, { disableWorkerScan: true });
    const { payload } = toTransport(store);
    const transfers = collectTransferables(payload);
    expect(new Set(transfers).size).toBe(transfers.length);
  }, 120_000);

  it('round-trips a mid-size fixture (~35 MB) without losing entities', async () => {
    const buffer = readFixture('advanced_model.ifc') ?? readFixture('FM_ARC_DigitalHub.ifc');
    if (!buffer) {
      console.warn('skip: ara3d mid-size fixture missing — `pnpm fixtures` to fetch');
      return;
    }
    const parser = new IfcParser();
    const original = await parser.parseColumnar(buffer, { disableWorkerScan: true });
    const { payload } = toTransport(original);
    const rebuilt = fromTransport(payload, original.source);

    expect(rebuilt.entityCount).toBe(original.entityCount);
    expect(rebuilt.entities.count).toBe(original.entities.count);
    // Spot-check: every entity in byType must still be findable via byId.
    const sampleType = [...original.entityIndex.byType.keys()][0];
    if (sampleType) {
      for (const id of original.entityIndex.byType.get(sampleType)!.slice(0, 100)) {
        expect(rebuilt.entityIndex.byId.has(id)).toBe(true);
      }
    }
  }, 180_000);

  it('transferable buffers detach when posted (real postMessage round-trip)', async () => {
    const buffer = readFixture('duplex.ifc') ?? readFixture('IfcOpenHouse_IFC4.ifc');
    if (!buffer) {
      console.warn('skip: ara3d fixture missing — `pnpm fixtures` to fetch');
      return;
    }

    // MessageChannel exists in Node ≥ 14 and exercises the same
    // structured-clone + transfer-list code path the worker boundary uses,
    // without requiring a Web Worker to spin up under vitest.
    const parser = new IfcParser();
    const store = await parser.parseColumnar(buffer, { disableWorkerScan: true });
    const { payload, transfers } = toTransport(store);

    // Snapshot a few field summaries before transfer (after posting, the
    // sender's typed-array views are detached and length=0).
    const expectedEntityCount = payload.entities.count;
    const expectedFileSize = payload.fileSize;

    const channel = new MessageChannel();
    const received = await new Promise<typeof payload>((resolveMsg, rejectMsg) => {
      channel.port2.onmessage = (e) => resolveMsg(e.data);
      channel.port2.onmessageerror = () => rejectMsg(new Error('messageerror'));
      channel.port1.postMessage(payload, transfers as unknown as readonly Transferable[]);
    });

    expect(received.fileSize).toBe(expectedFileSize);
    expect(received.entities.count).toBe(expectedEntityCount);
    expect(received.entities.expressId).toBeInstanceOf(Uint32Array);
    expect(received.entities.expressId.length).toBe(expectedEntityCount);

    // The receiving side rebuilds from its own copy of the bytes, exactly as
    // the worker boundary does. fromTransport accepts either shape.
    const rebuilt = fromTransport(received, store.source.materialize().slice());
    expect(rebuilt.entityCount).toBe(store.entityCount);

    channel.port1.close();
    channel.port2.close();
  }, 120_000);
});

/**
 * `WorkerParser` hydrates TWO stores from one parse: the early partial store
 * (so the spatial tree paints before geometry) and the final one. Both alias
 * the same SharedArrayBuffer.
 *
 * `contentKey` is a full-file FNV-1a walk, memoised PER ACCESSOR INSTANCE, and
 * the viewer's per-source overlay hooks read it off whichever store is active.
 * So if `fromTransport` wrapped its input rather than passing the accessor
 * through, the two stores would hold two instances and a 342 MB model would be
 * walked twice on the main thread mid-load -- on exactly the models #2183 is
 * about, and invisibly, since the KEY would still be identical.
 *
 * These pin the pass-through that makes sharing one accessor in `WorkerParser`
 * actually work.
 */
describe('fromTransport source identity (#2183)', () => {
  const STEP = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n"
    + "#1=IFCWALL('0YvCT2_$X3_xJG3rzD8L_8',$,'Wall-A',$,$,$,$,$,$);\n"
    + "ENDSEC;\nEND-ISO-10303-21;\n";

  /**
   * Parsed ONCE for the whole block. `parseColumnar` is not free and it logs,
   * and vitest runs test files concurrently: parsing per test put enough load
   * on a 2-core CI runner to push the 44k-entity equivalence suite in this same
   * package past its timeout. `toTransport` is re-run per use so no two
   * hydrations share a payload -- which is the shape `WorkerParser` actually
   * produces, one payload per message.
   */
  let parsed: Awaited<ReturnType<IfcParser['parseColumnar']>>;

  beforeAll(async () => {
    parsed = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STEP).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
  });

  function transportOf(): ReturnType<typeof toTransport>['payload'] {
    return toTransport(parsed).payload;
  }

  it('hands the SAME accessor instance to the store', () => {
    const source = contiguousSourceBytes(new TextEncoder().encode(STEP));
    const store = fromTransport(transportOf(), source);
    expect(store.source).toBe(source);
  });

  it('hashes ONCE across a partial + final pair sharing one accessor', () => {
    const bytes = new TextEncoder().encode(STEP);
    let walks = 0;
    const inner = contiguousSourceBytes(bytes);
    const counted: IfcSourceBytes = {
      get byteLength() { return inner.byteLength; },
      get length() { return inner.length; },
      get isResident() { return inner.isResident; },
      get contentKey() { walks++; return inner.contentKey; },
      slice: (a, b) => inner.slice(a, b),
      decodeUtf8: (a, b) => inner.decodeUtf8(a, b),
      materialize: () => inner.materialize(),
      withMaterialized: (f) => inner.withMaterialized(f),
      withMaterializedAsync: (f) => inner.withMaterializedAsync(f),
      toTransferable: () => inner.toTransferable(),
    };

    const partial = fromTransport(transportOf(), counted);
    const final = fromTransport(transportOf(), counted);

    // Neither hydration may touch the key on its own; only a consumer should.
    // `isSourceBytes` deliberately skips `contentKey` for exactly this reason.
    expect(walks).toBe(0);

    // One read each, as the overlay hooks do. `walks` counts reads of the
    // DOUBLE, not underlying FNV passes, so it is 2 here either way and is not
    // the gate -- accessor identity is: sharing one instance is what makes the
    // memo in ContiguousSourceBytes collapse these to a single walk.
    const a = partial.source.contentKey;
    const b = final.source.contentKey;
    expect(walks).toBe(2);
    expect(a).toBe(b);
    expect(a).toEqual(expect.any(String));
    expect(partial.source).toBe(final.source);
  });

  it('accepts raw bytes too, and agrees on the key', () => {
    // Many callers still pass raw bytes; that must keep working and must agree
    // with the accessor path. Deliberately NOT asserting that the two stores
    // get distinct accessors: memoising `asSourceBytes` per buffer would be a
    // legitimate improvement (it is what the viewer's old WeakMap effectively
    // did), and pinning today's non-sharing would make that a test failure.
    const bytes = new TextEncoder().encode(STEP);
    const one = fromTransport(transportOf(), bytes);
    const two = fromTransport(transportOf(), bytes);
    expect(one.source.contentKey).toBe(two.source.contentKey);
    expect(one.source.byteLength).toBe(bytes.byteLength);
  });
});
