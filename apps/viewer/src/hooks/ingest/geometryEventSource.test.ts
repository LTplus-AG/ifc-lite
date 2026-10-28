/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955 M2-C: the loader's geometry seam. A retained load must never put
 * exact geometry on screen — not from the geometry cache, not from the
 * server, not for a refused product — and the exact path must be untouched.
 *
 * `useIfcLoader` reads the cache only when `cachePlan.shouldCache` and asks the
 * server only when `serverEnabled`; both come from the kernel decided here.
 * The retained stream is driven through the real `RetainedClient` by a host
 * protocol fixture (no kernel or geometry implementation is imitated).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryProcessor, type StreamingGeometryEvent } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { chooseGeometryKernel } from '@/store/geometryKernel';
import { RetainedClient } from '@/lib/retained/retained-client';
import { beginRetainedLoad } from '@/lib/retained/retainedLoad';
import { ScriptedHostWorker, complete, published, refused, start, stepFile } from '@/test/retained-host-fixture';
import { planCacheWrite } from '../cacheTier.js';
import { forwardEntityIndexTo } from '../entityIndexHandoff.js';
import { createModelLoadActivity } from '../modelLoadCanceller.js';
import { beginGeometryKernel, openGeometryEvents, type GeometryEventRequest } from './geometryEventSource.js';

const MIB = 1024 * 1024;
const TIERS = { meshOnlyEnabled: true, minSize: 10 * MIB, maxSourceSize: 150 * MIB, maxMeshOnlySize: 400 * MIB };

function seedModel(id: string): void {
  useViewerStore.getState().addModel({
    id, name: `${id}.ifc`, ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 0, fileSize: 0, idOffset: 0, maxExpressId: 0, loadState: 'streaming-geometry',
  });
}

function request(modelId: string): GeometryEventRequest {
  return {
    processor: new GeometryProcessor(), view: new Uint8Array([1, 2, 3]), fileSizeMB: 0,
    signal: new AbortController().signal, stallPhaseHandle: {}, onEntityIndex: forwardEntityIndexTo(() => null),
    trace: undefined, modelId, activity: createModelLoadActivity(`${modelId}.ifc`),
  };
}

async function drain(events: AsyncIterable<StreamingGeometryEvent>): Promise<StreamingGeometryEvent[]> {
  const out: StreamingGeometryEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

afterEach(() => {
  chooseGeometryKernel('exact');
  useViewerStore.getState().clearAllModels();
});

describe('#7955 M2-C geometry event source', () => {
  it('a retained load never reads or writes the exact geometry cache and never asks the server', () => {
    chooseGeometryKernel('retained');
    const kernel = beginGeometryKernel(stepFile(), { kind: 'primary' }, () => {});
    assert.equal(kernel.kind, 'retained');
    assert.equal(kernel.refused, undefined, 'a primary STEP load is in retained scope');
    for (const bytes of [20 * MIB, 200 * MIB]) {
      const exactPlan = planCacheWrite(bytes, TIERS);
      assert.equal(exactPlan.shouldCache, true, `precondition: an exact load of ${bytes / MIB} MiB would use the cache`);
      const plan = kernel.cachePlan(exactPlan);
      assert.equal(plan.shouldCache, false, `retained ${bytes / MIB} MiB: the loader must not call getCached nor write the cache`);
      assert.equal(plan.persistSource, false);
      assert.equal(plan.tier, 'none');
    }
    assert.equal(kernel.serverEnabled, false, 'retained: the loader must not call loadFromServer');
  });

  it('the exact kernel keeps the cache plan and the server exactly as planned', () => {
    const kernel = beginGeometryKernel(stepFile(), { kind: 'primary' }, () => {});
    assert.equal(kernel.kind, 'exact');
    assert.equal(kernel.events, undefined, 'exact streams through processAdaptive');
    const plan = planCacheWrite(20 * MIB, TIERS);
    assert.deepEqual(kernel.cachePlan(plan), plan);
    assert.equal(kernel.serverEnabled, true);
    assert.equal(kernel.refuseSource('ifcx', 1, { modelId: 'm', activity: createModelLoadActivity('m') }), false);
  });

  it('refused products never appear in any batch and are listed with code and origin', async () => {
    seedModel('m');
    const worker = new ScriptedHostWorker([
      start([10, 20, 30, 40]),
      published(10),
      refused(20, 'opening_strategy', { site: 'opening', entity: 77, cause: 'unsupported_profile' }),
      published(30, 5),
      refused(40, 'operation_unsupported'),
      complete,
    ]);
    const client = new RetainedClient(() => worker);
    chooseGeometryKernel('retained');
    const kernel = beginRetainedLoad(client, stepFile(), { kind: 'primary' }, () => {});
    assert.ok(kernel);
    const events = await drain(openGeometryEvents(kernel, request('m')));
    client.unload();

    const batched = events.flatMap((event) => event.type === 'batch' ? event.meshes.map((mesh) => mesh.expressId) : []);
    assert.deepEqual(batched, [10, 30], 'only published products reach the renderer');
    assert.equal(events.at(-1)?.type, 'complete');
    assert.equal(worker.requests.length, 1);
    assert.equal(worker.requests[0].options.detail, 'view');

    const summary = useViewerStore.getState().models.get('m')?.retainedGeometry;
    assert.ok(summary, 'the retained summary is on the model');
    assert.equal(summary.candidates, 4);
    assert.equal(summary.published, 2);
    assert.deepEqual(summary.refused.map(({ expressId, code }) => [expressId, code]), [[20, 'opening_strategy'], [40, 'operation_unsupported']]);
    assert.deepEqual(summary.refused[0].origin, { site: 'opening', entity: 77, cause: 'unsupported_profile' });
    assert.equal(summary.completeness, 'incomplete');
    assert.deepEqual(summary.obligationsUnmet, ['IfcAppearance', 'OpeningClosure']);
  });
});
