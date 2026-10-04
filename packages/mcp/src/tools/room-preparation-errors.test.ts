/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, existsSync } from 'node:fs';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import type { LoadedModel } from '../context.js';
import { liveToolSession } from '../test/live-tool-session.js';

const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url), available = existsSync(wasm);
beforeAll(async () => {
  if (!available) { console.warn('Run pnpm build:wasm for real Room preparation controls'); return; }
  const runtime = await import('@ifc-lite/wasm'); runtime.initSync({ module: readFileSync(wasm) });
});
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('@ifc-lite/wasm'); });
const snapshot = (model: LoadedModel) => {
  const view = model.backend.ensureEditor().getMutationView();
  return structuredClone({ source: model.store.source.slice(0, model.store.source.byteLength),
    graph: new StepExporter(model.store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content,
    records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
};

for (const route of ['room_command', 'query_rooms']) for (const fault of ['export', 'parse', 'process', 'import'] as const) {
  it.skipIf(!available)(`#6232 / #6759 ${route} reports unexpected native ${fault} failure as INTERNAL_ERROR atomically`, async () => {
    const { registry, call } = await liveToolSession(2), model = registry.get('beta')!, peer = registry.get('alpha')!;
    const before = snapshot(model), peerBefore = snapshot(peer), disposed = vi.spyOn(GeometryProcessor.prototype, 'dispose');
    const fail = () => { throw new Error(`Unexpected ${fault} infrastructure failure`); };
    const actualProcess = GeometryProcessor.prototype.process;
    const injected = fault === 'export' ? vi.spyOn(StepExporter.prototype, 'export').mockImplementationOnce(fail)
      : fault === 'parse' ? vi.spyOn(IfcParser.prototype, 'parseColumnar').mockImplementationOnce(fail)
        : fault === 'process' ? vi.spyOn(GeometryProcessor.prototype, 'process').mockImplementationOnce(fail)
          : vi.spyOn(GeometryProcessor.prototype, 'process').mockImplementationOnce(async function (this: GeometryProcessor, ...args: Parameters<GeometryProcessor['process']>) {
            const result = await actualProcess.apply(this, args);
            vi.doMock('@ifc-lite/wasm', fail);
            return result;
          });
    try {
      const result = await call(route, { model_id: 'beta', storey_express_id: 42, ...(route === 'room_command' ? { command: { action: 'query' } } : {}) });
      expect(result.structuredContent).toMatchObject({ code: 'INTERNAL_ERROR', message: expect.stringContaining(fault === 'import' ? 'Native Room preparation failed:' : `Unexpected ${fault} infrastructure failure`) });
      expect(disposed).toHaveBeenCalledTimes(fault === 'process' || fault === 'import' ? 1 : 0);
      injected.mockRestore(); vi.doUnmock('@ifc-lite/wasm');
      expect(snapshot(model)).toEqual(before); expect(snapshot(peer)).toEqual(peerBefore);
      // A fresh successful request proves failed preparation is not cached or locked.
      expect((await call(route, { model_id: 'beta', storey_express_id: 42, ...(route === 'room_command' ? { command: { action: 'query' } } : {}) })).isError).not.toBe(true);
    } finally { for (const loaded of registry.list()) loaded.backend.dispose(); }
  });
}

for (const route of ['room_command', 'query_rooms']) it.skipIf(!available)(`#6232 ${route} keeps invalid live-storey preparation as INVALID_INPUT`, async () => {
  const { registry, call } = await liveToolSession(1), model = registry.get('alpha')!;
  try {
    const before = snapshot(model);
    const result = await call(route, { storey_express_id: 1222, ...(route === 'room_command' ? { command: { action: 'query' } } : {}) });
    expect(result.structuredContent?.code).toBe('INVALID_INPUT'); expect(snapshot(model)).toEqual(before);
  } finally { model.backend.dispose(); }
});
