/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { toast } from '@/components/ui/toast.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import { selectedSweptDiskCache, type ProductSweptDisks } from '@/lib/analytic/swept-disk-cache.js';
import { useCentrelineRendererOverlay } from './useCentrelineRendererOverlay.js';

afterEach(cleanup);

it('keeps the active source within 256 products and visibly reports omitted sources (#5778)', async () => {
  const prior = useViewerStore.getState();
  const originalGet = selectedSweptDiskCache.get;
  const originalToast = toast.error;
  const requested: number[][] = [];
  const notices: string[] = [];
  const model = fixtureModel('selection', { idOffset: 1_000_000 });
  model.maxExpressId = 300;
  // The cache checks source identity before the controlled extraction stub runs.
  Object.assign(model.ifcDataStore!, { source: { byteLength: 1 } });
  const zero = { x: 0, y: 0, z: 0 };
  const box = { min: zero, max: zero };
  model.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: { originShift: zero, wasmRtcOffset: zero, hasLargeCoordinates: false,
      originalBounds: box, shiftedBounds: box } };
  selectedSweptDiskCache.get = async (_model, ids) => {
    requested.push([...ids]);
    return new Map(ids.map((id) => [id, {
      occurrences: [], diagnostics: id === 300 ? ['product #300: modified by boolean operation'] : [],
    }]));
  };
  toast.error = (message) => { notices.push(message); };
  try {
    useViewerStore.setState({ ...fixtureModels(model), centrelineOverlayEnabled: true,
      selectedEntityIds: new Set(Array.from({ length: 300 }, (_, index) => 1_000_001 + index)),
      selectedEntityId: 1_000_300, selectedEntitiesSet: new Set(),
      selectedEntity: { modelId: 'selection', expressId: 300 } });
    const renderer = { setLineOverlay: () => {} } as unknown as Renderer;
    const Overlay = () => {
      useCentrelineRendererOverlay({ current: renderer } as RefObject<Renderer | null>, true);
      return null;
    };
    render(<Overlay />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.equal(requested.length, 1);
    assert.equal(requested[0]?.length, 256);
    assert.equal(requested[0]?.[0], 300, 'the active product leads the bounded extraction');
    assert.ok(notices.some((message) => /44 selected products were omitted/.test(message)),
      'the viewer reports selection truncation');
  } finally {
    cleanup();
    selectedSweptDiskCache.get = originalGet;
    toast.error = originalToast;
    useViewerStore.setState(prior);
  }
});

it('shows a visible warning for one CSG-modified source with no usable centreline (#5778)', async () => {
  const prior = useViewerStore.getState();
  const originalGet = selectedSweptDiskCache.get;
  const originalToast = toast.error;
  const notices: string[] = [];
  const model = fixtureModel('modified', { idOffset: 1_000_000 });
  model.maxExpressId = 7;
  Object.assign(model.ifcDataStore!, { source: { byteLength: 1 } });
  const zero = { x: 0, y: 0, z: 0 };
  const box = { min: zero, max: zero };
  model.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: { originShift: zero, wasmRtcOffset: zero, hasLargeCoordinates: false,
      originalBounds: box, shiftedBounds: box } };
  selectedSweptDiskCache.get = async () => new Map<number, ProductSweptDisks>([[7, {
    occurrences: [{
      solid_id: 9, directrix_id: 10, mapping_path: [], source_modified: true,
      Radius: 0.01, InnerRadius: null, status: { type: 'complete' },
      Directrix: [{ type: 'line', start: [0, 0, 0], end: [1, 0, 0] }],
      directrix_metrics: { total_length: 1, segments: [
        { segment_index: 0, length: 1, bend_angle: null },
      ] },
    }],
    diagnostics: [],
  }]]);
  toast.error = (message) => { notices.push(message); };
  try {
    useViewerStore.setState({ ...fixtureModels(model), centrelineOverlayEnabled: true,
      selectedEntityIds: new Set([1_000_007]), selectedEntityId: 1_000_007,
      selectedEntitiesSet: new Set(), selectedEntity: { modelId: 'modified', expressId: 7 } });
    const renderer = { setLineOverlay: () => {} } as unknown as Renderer;
    const Overlay = () => {
      useCentrelineRendererOverlay({ current: renderer } as RefObject<Renderer | null>, true);
      return null;
    };
    render(<Overlay />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.ok(notices.some((message) => /CSG-modified analytic source/.test(message)),
      'the omitted source is explained in the viewer');
  } finally {
    cleanup();
    selectedSweptDiskCache.get = originalGet;
    toast.error = originalToast;
    useViewerStore.setState(prior);
  }
});
