/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import 'fake-indexeddb/auto';
import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcCreator } from '@ifc-lite/create';
import { BinaryCacheWriter } from '@ifc-lite/cache';
import { useViewerStore } from '@/store';
import { waitFor } from '@/test/render.js';
import { hook, skip, blankFile } from '@/test/blank-ifc-loader-harness.js';

for (const kind of ['primary', 'federated'] as const) {
  for (const trigger of ['idle', 'pagehide', 'next-file'] as const) {
    it(`NEW-5: real ${kind} load captures cache geometry before ${trigger}`, { skip }, async () => {
      assert.ok(hook);
      const creator = new IfcCreator({ Name: 'Deferred cache regression' });
      const storey = creator.addIfcBuildingStorey({ Name: 'Level', Elevation: 0 });
      creator.addIfcWall(storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
      // Valid whitespace crosses the production cache floor, without faking
      // parser output, geometry events, the cache plan, or the binary writer.
      const file = new File([creator.toIfc().content, ' '.repeat(11 * 1024 * 1024)], `${crypto.randomUUID()}.ifc`);
      const previousIdle = globalThis.requestIdleCallback;
      const previousCancel = globalThis.cancelIdleCallback;
      let idle: IdleRequestCallback | undefined;
      globalThis.requestIdleCallback = callback => { idle = callback; return 1; };
      globalThis.cancelIdleCallback = () => {};
      const originalWrite = BinaryCacheWriter.prototype.write;
      let writes = 0;
      let observed: NonNullable<Parameters<typeof originalWrite>[1]> | undefined;
      mock.method(BinaryCacheWriter.prototype, 'write', function (this: BinaryCacheWriter, ...args: Parameters<typeof originalWrite>) {
        writes++;
        observed = args[1];
        return originalWrite.apply(this, args);
      });
      try {
        const modelId = crypto.randomUUID();
        await act(async () => hook?.loadFile(file, { kind, modelId }));
        await waitFor(() => !!idle, 'completed real load schedules its cache write');
        assert.equal(writes, 0, 'encode must not start in the load completion task');
        const model = useViewerStore.getState().models.get(modelId);
        assert.ok(model?.geometryResult?.meshes.length, 'fixture produces real wall geometry');
        const live = model.geometryResult.meshes[0];
        const before = { position: live.positions[0], color: [...live.color], id: live.expressId };
        live.positions[0] += 123;
        live.color[0] = 0.123456;
        if (trigger === 'idle') idle?.({ didTimeout: false, timeRemaining: () => 50 });
        else if (trigger === 'pagehide') window.dispatchEvent(new Event('pagehide'));
        else await act(async () => hook?.loadFile(blankFile('MILLIMETRE')));
        await waitFor(() => writes === 1, 'captured cache reaches real binary encoder exactly once');
        assert.ok(observed?.meshes.length);
        assert.equal(observed.meshes[0].positions[0], before.position, 'later scene edits cannot alter cached vertex data');
        assert.deepEqual(observed.meshes[0].color, before.color, 'later colour edits cannot alter cached colours');
        // Federated finalisation may re-home the LIVE ids; the cache must
        // retain raw source ids, verified independently through the source index.
        assert.ok(model.ifcDataStore?.entityIndex.byId.has(observed.meshes[0].expressId));
        window.dispatchEvent(new Event('pagehide'));
        assert.equal(writes, 1);
      } finally {
        window.dispatchEvent(new Event('pagehide'));
        globalThis.requestIdleCallback = previousIdle;
        globalThis.cancelIdleCallback = previousCancel;
      }
    });
  }
}
