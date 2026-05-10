/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
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

    const rebuilt = fromTransport(received, new Uint8Array(store.source.buffer.slice(0)));
    expect(rebuilt.entityCount).toBe(store.entityCount);

    channel.port1.close();
    channel.port2.close();
  }, 120_000);
});
