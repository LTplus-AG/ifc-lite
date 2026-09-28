/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { Renderer } from '@ifc-lite/renderer';
import { toast } from '@/components/ui/toast.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { cleanup, render, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import { selectedSweptDiskCache, type ProductSweptDisks } from '@/lib/analytic/swept-disk-cache.js';
import type { selectedCentrelineWorldLines } from '@/lib/analytic/selected-centreline-lines.js';
import { useCentrelineRendererOverlay } from './useCentrelineRendererOverlay.js';

afterEach(cleanup);

it('clears the old centreline before a selection-switch paint and rejects its late result (#5778)', async () => {
  const prior = useViewerStore.getState();
  const originalGet = selectedSweptDiskCache.get;
  const model = fixtureModel('switch', { idOffset: 1_000_000 });
  model.maxExpressId = 2;
  Object.assign(model.ifcDataStore!, { source: { byteLength: 1 } });
  selectedSweptDiskCache.get = async (_model, ids) => new Map(ids.map((id) => [id, {
    occurrences: [], diagnostics: [],
  }]));
  type Lines = Awaited<ReturnType<typeof selectedCentrelineWorldLines>>;
  let resolveOld: (lines: Lines) => void = () => { throw new Error('old line builder did not start'); };
  const oldLines = new Promise<Lines>((resolve) => { resolveOld = resolve; });
  let builds = 0;
  const lineBuilder: typeof selectedCentrelineWorldLines = async () => {
    builds++;
    return builds === 1 ? oldLines : { vertices: [], diagnostics: [] };
  };
  let line: Parameters<Renderer['setLineOverlay']>[1] = null;
  let lineAtLayout: Parameters<Renderer['setLineOverlay']>[1] | undefined;
  let staleUploads = 0;
  const renderer = {
    setLineOverlay(_channel: Parameters<Renderer['setLineOverlay']>[0], value: Parameters<Renderer['setLineOverlay']>[1]) {
      line = value;
      if (useViewerStore.getState().selectedEntityId === 1_000_002 && value !== null) staleUploads++;
    },
  } as unknown as Renderer;
  const ref: RefObject<Renderer | null> = { current: renderer };
  const Overlay = () => {
    const id = useViewerStore((state) => state.selectedEntityId);
    useCentrelineRendererOverlay(ref, true, 0, lineBuilder);
    useLayoutEffect(() => {
      if (id !== 1_000_002) return;
      lineAtLayout = line;
      resolveOld({ vertices: [0, 0, 0, 1, 0, 0], diagnostics: [] });
    }, [id]);
    return null;
  };
  try {
    useViewerStore.setState({ ...fixtureModels(model), centrelineOverlayEnabled: true,
      selectedEntityIds: new Set([1_000_001]), selectedEntityId: 1_000_001,
      selectedEntitiesSet: new Set(), selectedEntity: { modelId: 'switch', expressId: 1 } });
    render(<Overlay />);
    await waitFor(() => builds === 1, 'the first source line build is pending');
    // Stand in for the last rendered source line while the next source is pending.
    line = new Float32Array([0, 0, 0, 1, 0, 0]);
    await act(async () => {
      flushSync(() => useViewerStore.setState({ selectedEntityIds: new Set([1_000_002]),
        selectedEntityId: 1_000_002, selectedEntity: { modelId: 'switch', expressId: 2 } }));
      await Promise.resolve();
    });
    assert.equal(lineAtLayout, null, 'the previous frame is cleared in the selection commit');
    assert.equal(staleUploads, 0, 'the old async source cannot repopulate the channel');
    assert.equal(line, null);
  } finally {
    cleanup();
    selectedSweptDiskCache.get = originalGet;
    useViewerStore.setState(prior);
  }
});

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
    const renderer = { setLineOverlay: () => {}, setSourceSnapCurves: () => {} } as unknown as Renderer;
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
    const countBeforeDisable = notices.length;
    await act(async () => {
      useViewerStore.setState({ centrelineOverlayEnabled: false });
      await Promise.resolve();
    });
    assert.equal(notices.length, countBeforeDisable,
      'disabling the overlay must not repeat its previous omission warning');
  } finally {
    cleanup();
    selectedSweptDiskCache.get = originalGet;
    toast.error = originalToast;
    useViewerStore.setState(prior);
  }
});

it('re-uploads the selected centreline after successful device recovery (#5778)', async () => {
  const prior = useViewerStore.getState();
  const originalGet = selectedSweptDiskCache.get;
  const model = fixtureModel('recovery', { idOffset: 1_000_000 });
  model.maxExpressId = 1;
  Object.assign(model.ifcDataStore!, { source: { byteLength: 1 } });
  selectedSweptDiskCache.get = async () => new Map([[1, { occurrences: [], diagnostics: [] }]]);
  const uploads: Array<Parameters<Renderer['setLineOverlay']>[1]> = [];
  const renderer = { setLineOverlay: (_channel: string, value: Parameters<Renderer['setLineOverlay']>[1]) => {
    if (value !== null) uploads.push(value);
  } } as unknown as Renderer;
  const ref: RefObject<Renderer | null> = { current: renderer };
  let recover: () => void = () => { throw new Error('recovery state is not mounted'); };
  const lineBuilder: typeof selectedCentrelineWorldLines = async () => ({
    vertices: [0, 0, 0, 1, 0, 0], diagnostics: [],
  });
  const Overlay = () => {
    const [epoch, setEpoch] = useState(0);
    recover = () => setEpoch((value) => value + 1);
    useCentrelineRendererOverlay(ref, true, epoch, lineBuilder);
    return null;
  };
  try {
    useViewerStore.setState({ ...fixtureModels(model), centrelineOverlayEnabled: true,
      selectedEntityIds: new Set([1_000_001]), selectedEntityId: 1_000_001,
      selectedEntitiesSet: new Set(), selectedEntity: { modelId: 'recovery', expressId: 1 } });
    render(<Overlay />);
    await waitFor(() => uploads.length === 1, 'the first GPU upload completes');
    await act(async () => { recover(); await Promise.resolve(); });
    await waitFor(() => uploads.length === 2, 'the replacement GPU receives the selected line');
  } finally {
    cleanup();
    selectedSweptDiskCache.get = originalGet;
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
    const renderer = { setLineOverlay: () => {}, setSourceSnapCurves: () => {} } as unknown as Renderer;
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
