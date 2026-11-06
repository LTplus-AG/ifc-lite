/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { flushSync } from 'react-dom';
import type { RefObject } from 'react';
import type { Renderer, SourceSnapCurve } from '@ifc-lite/renderer';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { cleanup, render, waitFor } from '@/test/render.js';
import { entityRefToString, useViewerStore, type ViewerState } from '@/store/index.js';
import { selectedSweptDiskCache, type ProductSweptDisks } from '@/lib/analytic/swept-disk-cache.js';
import { sourceOccurrenceKey, type selectedCentrelineWorldLines } from '@/lib/analytic/selected-centreline-lines.js';
import { useCentrelineRendererOverlay } from './useCentrelineRendererOverlay.js';

/*
 * The per-frame Measure Point pass ends Live whenever a read sees a different
 * source-curve set from the last read (#9030). A selection change that keeps
 * the swept product must therefore never leave the channel empty, or holding a
 * different set, between frames (#9086); one that drops it must still clear
 * its curves before paint (#5778).
 */

const OFFSET = 1_000_000;
const MODEL = 'live';
type Lines = Awaited<ReturnType<typeof selectedCentrelineWorldLines>>;

/** A one-segment line directrix from x = 0 to x = `end`. */
function swept(end: number): ProductSweptDisks {
  return {
    occurrences: [{
      solid_id: 9, directrix_id: 10, mapping_path: [], source_modified: false,
      Radius: 0.01, InnerRadius: null, status: { type: 'complete' },
      Directrix: [{ type: 'line', start: [0, 0, 0], end: [end, 0, 0] }],
      directrix_metrics: { total_length: end, segments: [{ segment_index: 0, length: end, bend_angle: null }] },
    }],
    diagnostics: [],
  } as unknown as ProductSweptDisks;
}

/** Products 1 and 3 are swept disks; product 2 is not. */
const SOURCES = new Map<number, ProductSweptDisks>([[1, swept(1)], [3, swept(3)]]);

/** What a pick can snap to: each curve's product and where it ends. */
const curveKey = (curves: readonly SourceSnapCurve[]) => curves
  .map((curve) => `${curve.identity.expressId}@${JSON.stringify(curve.pointAt(1))}`).join(',');

let prior: ViewerState;
const originalGet = selectedSweptDiskCache.get;
/** Every curve set the overlay handed the renderer, in order. */
let held: string[];
let builds: number;
/** A build waits on this gate when one is set. */
let gate: Promise<void> | null;
let emptyBuild: boolean;

const current = () => held[held.length - 1];
/** The curve sets the renderer held from `from` on. */
const since = (from: number) => held.slice(from);

function lines(items: Parameters<typeof selectedCentrelineWorldLines>[0]): Lines {
  if (emptyBuild) return { vertices: [], diagnostics: [], renderedOccurrences: new Set() };
  return {
    vertices: [0, 0, 0, 1, 0, 0], diagnostics: [],
    renderedOccurrences: new Set(items.flatMap((item) => item.occurrences.length > 0
      ? [sourceOccurrenceKey(item.ref.modelId, item.ref.expressId, 0)] : [])),
  };
}

const lineBuilder: typeof selectedCentrelineWorldLines = async (items) => {
  builds++;
  const wait = gate;
  if (wait) await wait;
  return lines(items);
};

function select(ids: readonly number[], primary = ids[ids.length - 1]): Partial<ViewerState> {
  return {
    selectedEntitiesSet: new Set(ids.map((expressId) => entityRefToString({ modelId: MODEL, expressId }))),
    selectedEntity: primary === undefined ? null : { modelId: MODEL, expressId: primary },
    selectedEntityIds: new Set(ids.map((id) => OFFSET + id)),
    selectedEntityId: primary === undefined ? null : OFFSET + primary,
  };
}

/** Commits `patch` synchronously: what the renderer holds afterwards is what the next frame paints. */
async function commit(patch: Partial<ViewerState>): Promise<void> {
  await act(async () => {
    flushSync(() => useViewerStore.setState(patch));
    await Promise.resolve();
  });
}

/** Lets every pending build and selection load settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function mount(ids: readonly number[]): void {
  const model = fixtureModel(MODEL, { idOffset: OFFSET });
  model.maxExpressId = 3;
  Object.assign(model.ifcDataStore!, { source: { byteLength: 1 } });
  const zero = { x: 0, y: 0, z: 0 };
  const box = { min: zero, max: zero };
  model.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: { originShift: zero, wasmRtcOffset: zero, hasLargeCoordinates: false,
      originalBounds: box, shiftedBounds: box } };
  useViewerStore.setState({ ...fixtureModels(model), centrelineOverlayEnabled: true, ...select(ids),
    toGlobalId: (_modelId, expressId) => OFFSET + expressId });
  const renderer = {
    setLineOverlay: () => undefined,
    setSourceSnapCurves: (curves: readonly SourceSnapCurve[]) => { held.push(curveKey(curves)); },
  } as unknown as Renderer;
  const ref: RefObject<Renderer | null> = { current: renderer };
  const Overlay = () => {
    useCentrelineRendererOverlay(ref, true, 0, lineBuilder);
    return null;
  };
  render(<Overlay />);
}

const ONE = '1@{"x":1,"y":0,"z":0}';
const THREE = '3@{"x":3,"y":0,"z":0}';

beforeEach(() => {
  prior = useViewerStore.getState();
  held = [];
  builds = 0;
  gate = null;
  emptyBuild = false;
  selectedSweptDiskCache.get = async (_model, ids) => new Map(ids.flatMap((id) => {
    const source = SOURCES.get(id);
    return [[id, source ?? { occurrences: [], diagnostics: [] }] as const];
  }));
});

afterEach(() => {
  cleanup();
  selectedSweptDiskCache.get = originalGet;
  useViewerStore.setState(prior);
});

async function mountInstalled(ids: readonly number[], expected: string): Promise<number> {
  mount(ids);
  await waitFor(() => current() === expected, 'the selected curves install');
  return held.length;
}

it('Ctrl-adding a product with no swept disk never empties the installed curves (#9086)', async () => {
  const from = await mountInstalled([1], ONE);
  const before = builds;
  await commit(select([1, 2]));
  await settle();
  assert.ok(builds > before, 'the overlay rebuilt for the new selection');
  assert.deepEqual(since(from), since(from).map(() => ONE), 'every frame reads the same curve set');
});

it('Ctrl-adding a non-swept product to two swept ones keeps the curve order (#9086)', async () => {
  const from = await mountInstalled([1, 3], `${ONE},${THREE}`);
  await commit(select([1, 3], 1));
  await settle();
  const before = builds;
  await commit(select([1, 3, 2]));
  await settle();
  assert.ok(builds > before, 'the overlay rebuilt with product 2 leading the query');
  assert.deepEqual(since(from), since(from).map(() => `${ONE},${THREE}`), 'every frame reads the same curve set in one order');
});

it('re-selecting the same product never empties the installed curves (#9086)', async () => {
  const from = await mountInstalled([1], ONE);
  const before = builds;
  await commit(select([1]));
  await settle();
  assert.ok(builds > before, 'the overlay rebuilt for the new selection objects');
  assert.deepEqual(since(from), since(from).map(() => ONE));
});

it('hiding an unrelated product keeps the curves; hiding the selected one clears them before paint', async () => {
  const from = await mountInstalled([1], ONE);
  await commit({ hiddenEntities: new Set([OFFSET + 2]) });
  await settle();
  assert.deepEqual(since(from), since(from).map(() => ONE));
  await commit({ hiddenEntities: new Set([OFFSET + 1, OFFSET + 2]) });
  assert.equal(current(), '', 'a hidden product cannot be snapped to');
  await settle();
  assert.equal(current(), '');
});

it('a switch to another swept product drops the old curves before paint (#5778)', async () => {
  const from = await mountInstalled([1], ONE);
  await commit(select([3]));
  assert.equal(current(), '', 'the old product is gone in the selection commit');
  await settle();
  assert.equal(current(), THREE);
  assert.ok(since(from).every((set) => !set.includes('1@')), 'no frame after the switch can snap to the old product');
});

it('Ctrl-adding a swept product keeps the old curves, then installs both', async () => {
  const from = await mountInstalled([1], ONE);
  await commit(select([1, 3]));
  assert.equal(current(), ONE);
  await settle();
  assert.ok(since(from).every((set) => set.includes(ONE)), 'the kept product stays snappable throughout');
  assert.equal(current(), `${ONE},${THREE}`, 'both products install');
});

it('deselecting everything clears the curves before paint', async () => {
  await mountInstalled([1], ONE);
  await commit(select([]));
  assert.equal(current(), '');
  await settle();
  assert.equal(current(), '');
});

it('turning the overlay off clears the curves before paint', async () => {
  await mountInstalled([1], ONE);
  await commit({ centrelineOverlayEnabled: false });
  assert.equal(current(), '');
  await settle();
  assert.equal(current(), '');
});

it('a placement change that moves the curves clears them, then installs the moved set', async () => {
  await mountInstalled([1], ONE);
  const modelPlacement = useViewerStore.getState().modelPlacement;
  await commit({ modelPlacement: { ...modelPlacement, placements: new Map([[MODEL, {
    translation: { x: 0, y: 5, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, locked: false,
  }]]) } as typeof modelPlacement });
  assert.equal(current(), '', 'curves at the old place cannot be snapped to');
  await settle();
  assert.notEqual(current(), '');
  assert.notEqual(current(), ONE, 'the reinstalled set is the moved one, so Live ends');
});

it('a georeference edit clears the curves before paint', async () => {
  await mountInstalled([1], ONE);
  await commit({ georefMutations: new Map(useViewerStore.getState().georefMutations) });
  assert.equal(current(), '');
});

it('unloading the model mid-rebuild clears the curves and rejects the late result', async () => {
  await mountInstalled([1], ONE);
  let release: () => void = () => undefined;
  gate = new Promise((resolve) => { release = resolve; });
  const before = builds;
  await commit(select([1, 2]));
  await waitFor(() => builds > before, 'the rebuild is pending');
  assert.equal(current(), ONE);
  await commit({ models: new Map() });
  assert.equal(current(), '', 'an unloaded model cannot be snapped to');
  gate = null;
  release();
  await settle();
  assert.equal(current(), '', 'the pending build of the unloaded model never installs');
});

it('a rebuild that draws nothing clears the kept curves', async () => {
  await mountInstalled([1], ONE);
  emptyBuild = true;
  await commit(select([1, 2]));
  await settle();
  assert.equal(current(), '');
});

it('a late build for a superseded selection never installs its dropped product (epochs race)', async () => {
  const from = await mountInstalled([1], ONE);
  let release: () => void = () => undefined;
  gate = new Promise((resolve) => { release = resolve; });
  const before = builds;
  await commit(select([1, 3]));
  await waitFor(() => builds > before, 'the build for products 1 and 3 is pending');
  await commit(select([1]));
  assert.equal(current(), ONE);
  gate = null;
  release();
  await settle();
  assert.equal(current(), ONE);
  assert.ok(since(from).every((set) => set === ONE), 'product 3 was never snappable once deselected');
});
