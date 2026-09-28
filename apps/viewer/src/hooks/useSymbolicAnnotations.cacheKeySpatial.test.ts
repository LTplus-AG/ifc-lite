/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import {
  FIXTURE_REL_CONTAINED_1,
  FIXTURE_OPENING,
  FIXTURE_STOREY_2,
  FIXTURE_WALL_A,
  guid,
  parseFixtureModel,
} from '@/components/viewer/anonymized-export/anonymized-export-fixture.test-support';
import { useViewerStore } from '../store/index.js';
import { __setOverlayWorkerFactoryForTest } from '../lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic } from '../lib/overlay-parse/symbolic-flat.js';
import { useSymbolicAnnotations } from './useSymbolicAnnotations.js';
import { symbolicLineVertexData, type SymbolicLineChannels, type SymbolicLineVertices } from './symbolic-line-channels.js';
import type { AnchoredRendererLineVertices } from '../lib/renderer/line-overlay-rte.js';
import {
  __resetSymbolicAnnotationsCacheForTests,
  __symbolicAnnotationsCacheHasForTests,
  __symbolicAnnotationsSourceKeyForTests,
  ensureParseFor,
  getParseFor,
} from './symbolic-parse-cache.js';
import { __parseResultCacheSizeForTests } from './symbolic-parse-result-cache.js';
import { __sourceFlatCacheSizeForTests } from './symbolic-source-flat-cache.js';

function oneAnnotation(ownerId = 2, worldY = Number.NaN) {
  const flat = createEmptyFlatSymbolic();
  flat.typeNames = ['IfcAnnotation'];
  flat.polyPoints = Float32Array.from([0, 0, 1, 0]);
  flat.polyStart = Uint32Array.from([0, 2]);
  flat.polyOwner = Uint32Array.from([ownerId]);
  flat.polyWorldY = Float32Array.from([worldY]);
  flat.polyFlags = Uint8Array.from([0]);
  flat.polyType = Uint16Array.from([0]);
  return flat;
}

function store(storeyId: number, elevation: number, contentKey = 'same-source-bytes'): IfcDataStore {
  return {
    source: { contentKey, byteLength: 10, toTransferable: () => ({}) },
    spatialHierarchy: {
      elementToStorey: new Map([[2, storeyId]]),
      storeyElevations: new Map([[storeyId, elevation]]),
    },
  } as unknown as IfcDataStore;
}

function firstWorldY(vertices: SymbolicLineVertices): number {
  assert.ok(symbolicLineVertexData(vertices).length > 0, 'the hook should emit the annotation line');
  const partition = Array.isArray(vertices)
    ? vertices[0]!
    : vertices as AnchoredRendererLineVertices;
  return partition.origin[1] + partition.localVertices[1]!;
}

describe('symbolic cache follows live spatial bucket mappings (#5236/#5249)', () => {
  beforeEach(() => {
    __resetSymbolicAnnotationsCacheForTests();
    useViewerStore.setState({
      models: new Map(),
      ifcDataStore: null,
      geometryResult: null,
      loading: false,
      mutationVersion: 0,
    } as never);
  });

  it('reuses source bytes but rebuilds the result when the storey mapping changes', async () => {
    let workerParses = 0;
    const previous = __setOverlayWorkerFactoryForTest(() => {
      const worker = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(request: { id: number }) {
          workerParses++;
          queueMicrotask(() => worker.onmessage?.({ data: { id: request.id, ok: true, flat: oneAnnotation() } }));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });

    try {
      const first = store(90, 10);
      const refreshed = store(91, 30);

      await Promise.all(ensureParseFor([first]));
      const firstResult = getParseFor(first);
      assert.equal([...firstResult!.byStorey.values()][0].storeyElevation, 10);

      await Promise.all(ensureParseFor([refreshed]));
      const refreshedResult = getParseFor(refreshed);
      assert.equal([...refreshedResult!.byStorey.values()][0].storeyElevation, 30,
        'same bytes with a refreshed hierarchy must not return stale spatial buckets');
      assert.equal(workerParses, 1, 'identical source bytes reuse the worker output');
      assert.equal([...getParseFor(first)!.byStorey.values()][0].storeyElevation, 10,
        'the earlier store keeps its own spatial result');

      first.spatialHierarchy!.storeyElevations.set(90, 25);
      useViewerStore.setState({ mutationVersion: 1 } as never);
      await Promise.all(ensureParseFor([first]));
      assert.equal([...getParseFor(first)!.byStorey.values()][0].storeyElevation, 25,
        'mutating the live hierarchy must invalidate its bucketed result');
      assert.equal(workerParses, 1, 'rebucketing after a hierarchy edit reuses worker output');
    } finally {
      __setOverlayWorkerFactoryForTest(previous);
    }
  });

  it('files concurrent parses under the spatial snapshot named by each key', async () => {
    interface HeldWorker {
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage(request: { id: number }): void;
      terminate(): void;
    }
    const workerRef: { current: HeldWorker | null } = { current: null };
    let requestId: number | null = null;
    const previous = __setOverlayWorkerFactoryForTest(() => {
      const worker: HeldWorker = {
        onmessage: null,
        postMessage(request) { requestId = request.id; },
        terminate() {},
      };
      workerRef.current = worker;
      return worker as unknown as Worker;
    });

    try {
      const target = store(90, 10);
      useViewerStore.setState({ ifcDataStore: target, mutationVersion: 0 } as never);
      const underTen = ensureParseFor([target])[0]!;
      await new Promise((resolve) => setTimeout(resolve, 0));

      target.spatialHierarchy!.storeyElevations.set(90, 25);
      useViewerStore.setState({ mutationVersion: 1 } as never);
      const underTwentyFive = ensureParseFor([target])[0]!;
      const live = workerRef.current;
      assert.ok(live, 'the first request should have started a worker parse');
      const postedId = requestId as number | null;
      assert.ok(postedId !== null, 'the worker request should have an id');
      live.onmessage?.({ data: { id: postedId, ok: true, flat: oneAnnotation() } });
      await Promise.all([underTen, underTwentyFive]);

      const twentyFive = getParseFor(target);
      assert.equal([...twentyFive!.byStorey.values()][0].storeyElevation, 25);

      target.spatialHierarchy!.storeyElevations.set(90, 10);
      useViewerStore.setState({ mutationVersion: 0 } as never);
      const ten = getParseFor(target);
      assert.equal([...ten!.byStorey.values()][0].storeyElevation, 10,
        'an in-flight parse must not file the later map under the earlier map key');
    } finally {
      __setOverlayWorkerFactoryForTest(previous);
    }
  });

  it('uses each model view for effective containment, created storeys, and deleted owners', async () => {
    let flatOwnerId = FIXTURE_WALL_A;
    let flatWorldY = Number.NaN;
    const previous = __setOverlayWorkerFactoryForTest(() => {
      const worker = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(request: { id: number }) {
          queueMicrotask(() => worker.onmessage?.({
            data: { id: request.id, ok: true, flat: oneAnnotation(flatOwnerId, flatWorldY) },
          }));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });

    try {
      const target = await parseFixtureModel();
      const byType = new Map(target.entityIndex?.byType ?? []);
      byType.set('IFCANNOTATION', [FIXTURE_WALL_A]);
      target.entityIndex = { ...target.entityIndex, byType } as never;
      const sibling = { ...target, spatialHierarchy: {
        ...target.spatialHierarchy!,
        elementToStorey: new Map(target.spatialHierarchy!.elementToStorey),
        storeyElevations: new Map(target.spatialHierarchy!.storeyElevations),
      } } as IfcDataStore;

      await Promise.all(ensureParseFor([target]));
      assert.equal([...getParseFor(target)!.byStorey.values()][0].storeyElevation, 0);

      const view = new MutablePropertyView(null, 'symbolic-retarget');
      view.setExpressIdWatermark(100);
      view.setAttribute(FIXTURE_REL_CONTAINED_1, 'RelatingStructure', `#${FIXTURE_STOREY_2}`);
      await Promise.all(ensureParseFor([{ store: target, mutationView: view }]));
      const moved = getParseFor({ store: target, mutationView: view })!;
      assert.deepEqual([...moved.byStorey.values()].map(bucket => bucket.storeyElevation), [3],
        'NaN primitive elevation resolves through the effective retargeted storey');
      assert.equal([...getParseFor(sibling)!.byStorey.values()][0].storeyElevation, 0,
        'the byte-identical sibling without this view retains its source bucket');

      const createdView = new MutablePropertyView(null, 'symbolic-created-storey');
      createdView.setExpressIdWatermark(100);
      createdView.deleteEntity(FIXTURE_REL_CONTAINED_1);
      const createdStorey = createdView.createEntity('IfcBuildingStorey', [
        guid(101), null, 'Authored storey', null, null, null, null, null, null, 6,
      ]);
      createdView.createEntity('IfcRelContainedInSpatialStructure', [
        guid(102), null, null, null, [`#${FIXTURE_WALL_A}`], `#${createdStorey.expressId}`,
      ]);
      useViewerStore.setState({ mutationVersion: 1 } as never);
      await Promise.all(ensureParseFor([{ store: target, mutationView: createdView }]));
      const createdBucket = getParseFor({ store: target, mutationView: createdView })!;
      assert.deepEqual([...createdBucket.byStorey.values()].map(bucket => bucket.storeyElevation), [6],
        'a queued containment to a newly-created storey supplies its effective elevation');

      createdView.deleteEntity(FIXTURE_WALL_A);
      useViewerStore.setState({ mutationVersion: 2 } as never);
      await Promise.all(ensureParseFor([{ store: target, mutationView: createdView }]));
      const deleted = getParseFor({ store: target, mutationView: createdView })!;
      assert.equal(deleted.byStorey.size + deleted.loose.length + deleted.looseTexts.length + deleted.looseFills.length, 0,
        'a tombstoned symbolic owner is removed instead of becoming a loose primitive');

      // This source owner has no raw spatial membership, so deleting it does
      // not change the hierarchy digest. A finite primitive worldY remains
      // authoritative for live (nondeleted) owners, but the revision key and
      // frozen tombstone set must still remove it after deletion.
      flatOwnerId = FIXTURE_OPENING;
      flatWorldY = 7;
      __resetSymbolicAnnotationsCacheForTests();
      await Promise.all(ensureParseFor([target]));
      assert.equal([...getParseFor(target)!.byStorey.values()][0].storeyElevation, 7,
        'finite geometry elevation stays authoritative when no effective storey applies');
      const tombstone = new MutablePropertyView(null, 'symbolic-uncontained-delete');
      tombstone.deleteEntity(FIXTURE_OPENING);
      useViewerStore.setState({ mutationVersion: 3 } as never);
      await Promise.all(ensureParseFor([{ store: target, mutationView: tombstone }]));
      const removed = getParseFor({ store: target, mutationView: tombstone })!;
      assert.equal(removed.byStorey.size + removed.loose.length + removed.looseTexts.length + removed.looseFills.length, 0,
        'deleting a finite-worldY owner invalidates its result even when spatial maps are unchanged');
    } finally {
      __setOverlayWorkerFactoryForTest(previous);
    }
  });

  it('bounds retained bucketed results as hierarchy mappings change', async () => {
    const previous = __setOverlayWorkerFactoryForTest(() => {
      const worker = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(request: { id: number }) {
          queueMicrotask(() => worker.onmessage?.({ data: { id: request.id, ok: true, flat: oneAnnotation() } }));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });

    try {
      const first = store(90, 0);
      const firstKey = __symbolicAnnotationsSourceKeyForTests(first);
      await Promise.all(ensureParseFor([first]));
      assert.ok(firstKey && __symbolicAnnotationsCacheHasForTests(firstKey));

      for (let elevation = 1; elevation <= 40; elevation++) {
        await Promise.all(ensureParseFor([store(90, elevation, `flat-source-${elevation}`)]));
      }

      assert.ok(__parseResultCacheSizeForTests() <= 32, 'bucketed result cache must stay bounded');
      assert.ok(__sourceFlatCacheSizeForTests() <= 32, 'worker flat-output cache must stay bounded');
      assert.equal(__symbolicAnnotationsCacheHasForTests(firstKey!), false,
        'the oldest large result is evicted after enough hierarchy variants');
    } finally {
      __setOverlayWorkerFactoryForTest(previous);
    }
  });

  it('does not reuse a negative source type prefilter after the entity index refreshes', async () => {
    let workerParses = 0;
    const previous = __setOverlayWorkerFactoryForTest(() => {
      const worker = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(request: { id: number }) {
          workerParses++;
          queueMicrotask(() => worker.onmessage?.({ data: { id: request.id, ok: true, flat: oneAnnotation() } }));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });

    try {
      const absent = store(90, 10);
      absent.entityIndex = { byType: new Map([['IFCWALL', []]]) } as never;
      await Promise.all(ensureParseFor([absent]));
      assert.equal(getParseFor(absent)?.byStorey.size ?? 0, 0);
      assert.equal(workerParses, 0, 'a negative source type index skips the worker');

      const refreshed = store(90, 10);
      refreshed.entityIndex = { byType: new Map([['IFCANNOTATION', [2]]]) } as never;
      await Promise.all(ensureParseFor([refreshed]));
      assert.equal([...getParseFor(refreshed)!.byStorey.values()][0].storeyElevation, 10,
        'the refreshed entity index must produce the source annotation bucket');
      assert.equal(workerParses, 1, 'the newly positive index must run the worker parse');
    } finally {
      __setOverlayWorkerFactoryForTest(previous);
    }
  });

  it('reparses live buckets when mutationVersion advances after an in-place hierarchy edit', async () => {
    let workerParses = 0;
    let rendered: SymbolicLineChannels = { annotation: new Float32Array(), grid: new Float32Array() };
    const previous = __setOverlayWorkerFactoryForTest(() => {
      const worker = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(request: { id: number }) {
          workerParses++;
          queueMicrotask(() => worker.onmessage?.({ data: { id: request.id, ok: true, flat: oneAnnotation() } }));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });
    let root: Root | null = null;
    const container = document.createElement('div');
    document.body.appendChild(container);
    function Probe(): null {
      rendered = useSymbolicAnnotations({ enabled: true });
      return null;
    }

    try {
      const target = store(90, 10);
      useViewerStore.setState({ ifcDataStore: target, mutationVersion: 0 } as never);
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(Probe));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(firstWorldY(rendered.annotation), 10, 'the first parse uses the initial storey elevation');

      target.spatialHierarchy!.storeyElevations.set(90, 25);
      await act(async () => {
        useViewerStore.setState({ mutationVersion: 1 } as never);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      assert.equal(firstWorldY(rendered.annotation), 25,
        'the mounted symbolic hook must re-key and rebucket after mutationVersion changes');
      assert.equal(workerParses, 1, 'a live hierarchy refresh reuses the source worker parse');
    } finally {
      if (root) await act(async () => root!.unmount());
      container.remove();
      __setOverlayWorkerFactoryForTest(previous);
    }
  });
});
