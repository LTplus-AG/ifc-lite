/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DFJSON counterpart to `headless-backend.hbjson.test.ts`.
 *
 * DFJSON shipped reading `store.source` directly, so it carried the whole of
 * issue #1908 unfixed: anything authored through the in-store edit APIs (the
 * CLI equivalent of the viewer's Space Sketch tool) was invisible to the
 * Dragonfly exporter by construction, exactly as HBJSON was before #1956.
 * Both formats now share the gate in `energy-export.ts`, and this file pins
 * the DFJSON half of that contract independently — a shared helper means a
 * regression in the gate would otherwise only be caught by the HBJSON suite.
 */

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StepExporter } from '@ifc-lite/export';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { createHeadlessContext } from './loader.js';
import { exportDfjson } from './energy-export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same committed viewer demo sample as the HBJSON suite (always present, so
// this never needs `pnpm fixtures`). One storey (#42) and one pre-existing
// IfcSpace whose Body is a Tessellation — `rooms.rs` only builds rooms from
// extrusion profiles, so that space is skipped for a reason unrelated to the
// mutation-view bug.
const SAMPLE_IFC = join(__dirname, '../../../apps/viewer/public/samples/hello-wall.ifc');
const STOREY_EXPRESS_ID = 42;

/** Room2Ds across every building/story in a Dragonfly model. */
function room2dCount(dfjson: string): number {
  const parsed = JSON.parse(dfjson) as {
    buildings?: { unique_stories?: { room_2ds?: unknown[] }[] }[];
  };
  return (parsed.buildings ?? []).reduce(
    (n, b) => n + (b.unique_stories ?? []).reduce((m, s) => m + (s.room_2ds?.length ?? 0), 0),
    0,
  );
}

describe('HeadlessBackend dfjson export (#1908 for the Dragonfly path)', () => {
  it('an unedited model (no mutation view) exports unchanged — the common case must not regress', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const dfjson = await bim.export.dfjson({ name: 'baseline' });
    // The one pre-existing space is a Tessellation body and is skipped for a
    // reason unrelated to the mutation view. This asserts the no-mutation-view
    // path still runs `store.source` straight through.
    expect(room2dCount(dfjson)).toBe(0);
  }, 30_000);

  it('a space drawn through the in-store editor is present in the DFJSON output', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const modelId = bim.model.activeId();
    expect(modelId).not.toBeNull();

    bim.store.addSpace(modelId as string, STOREY_EXPRESS_ID, {
      Position: [10, 10, 0],
      Width: 4,
      Depth: 3,
      Height: 3,
      LongName: 'Drawn Room',
    });

    const dfjson = await bim.export.dfjson({ name: 'edited' });
    // Before the shared gate, `dfjson` read `store.source` directly and this
    // overlay-only entity was invisible to it, so this stayed at 0.
    expect(room2dCount(dfjson)).toBe(1);
  }, 30_000);

  it('a mutation view that is registered but carries no edits skips the StepExporter regeneration', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const modelId = bim.model.activeId() as string;

    // `removeEntity` on a non-existent id lazily registers a mutation view but
    // records no mutation — the same shape as the viewer registering a view
    // just by opening a panel. Gating on mere existence would route this
    // through a redundant full re-serialization.
    const removed = bim.store.removeEntity({ modelId, expressId: 999_999_999 });
    expect(removed).toBe(false);

    // room2dCount alone stays 0 either way, so it cannot detect a dropped
    // gate; spy on StepExporter.export to pin that the regen is skipped.
    const exportSpy = vi.spyOn(StepExporter.prototype, 'export');
    try {
      const dfjson = await bim.export.dfjson({ name: 'registered-but-empty' });
      expect(room2dCount(dfjson)).toBe(0);
      expect(exportSpy).not.toHaveBeenCalled();
    } finally {
      exportSpy.mockRestore();
    }
  }, 30_000);

  it('disposes the GeometryProcessor WASM handle on the success path', async () => {
    const { store } = await createHeadlessContext(SAMPLE_IFC);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');
    try {
      await exportDfjson(store, null, 'dispose-success');
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      disposeSpy.mockRestore();
    }
  }, 30_000);

  it('disposes the GeometryProcessor WASM handle even when exportDfjson throws', async () => {
    // `GeometryProcessor.exportDfjson` returning null (engine unavailable)
    // makes `exportDfjson` in energy-export.ts throw — the early-return the
    // shared `runEnergyExport` try/finally must cover, not just the happy path.
    const { store } = await createHeadlessContext(SAMPLE_IFC);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');
    const exportSpy = vi.spyOn(GeometryProcessor.prototype, 'exportDfjson').mockReturnValue(null);
    try {
      await expect(exportDfjson(store, null, 'dispose-throw')).rejects.toThrow(
        'Geometry engine unavailable for DFJSON export.',
      );
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      exportSpy.mockRestore();
      disposeSpy.mockRestore();
    }
  }, 30_000);

  it('an explicit --name keeps a dotted display name verbatim', async () => {
    // `Tower.v2` is a legitimate model identifier; only the modelName fallback
    // is a filename and gets a real IFC extension stripped. A blanket
    // `.replace(/\.[^.]+$/, '')` would silently ship this model as `Tower`.
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const dfjson = await bim.export.dfjson({ name: 'Tower.v2' });
    const parsed = JSON.parse(dfjson) as { identifier?: string; name?: string };
    const emitted = parsed.identifier ?? parsed.name ?? '';
    expect(emitted).toContain('Tower');
    expect(emitted).not.toBe('Tower');
  }, 30_000);
});
