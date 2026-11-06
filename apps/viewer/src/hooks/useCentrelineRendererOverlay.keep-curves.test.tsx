/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { RefObject } from 'react';
import type { Renderer, SourceSnapCurve } from '@ifc-lite/renderer';
import { toast } from '@/components/ui/toast.js';
import { fixtureDataStore, fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { cleanup, render, waitFor } from '@/test/render.js';
import { entityRefToString, useViewerStore, type ViewerState } from '@/store/index.js';
import { selectedSweptDiskCache, type ProductSweptDisks } from '@/lib/analytic/swept-disk-cache.js';
import { sourceOccurrenceKey, type selectedCentrelineWorldLines } from '@/lib/analytic/selected-centreline-lines.js';
import { ZERO_ROTATION } from '@/lib/model-placement/rotation.js';
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
const originalToast = toast.error;
/** Every curve set the overlay handed the renderer, in order. */
let held: string[];
/** Whether the renderer draws a centreline after each line call, in order. */
let lineCalls: boolean[];
/** The line calls before the change under test. */
let lineMark: number;
/** What the renderer held when the overlay's own layout pass had run: what the next frame paints and picks. */
let atLayout: { curves: string; line: boolean };
let builds: number;
/** A build waits on this gate when one is set. */
let gate: Promise<void> | null;
let emptyBuild: boolean;
/** A swept-disk load that includes product 3 waits on this gate when one is set. */
let loadGate: Promise<void> | null;
/** Failure injection: the line build rejects, the GPU upload throws, the swept-disk load rejects. */
let fail: { build: boolean; upload: boolean; load: boolean };
/** Bumps the overlay's recoveryEpoch, as a GPU device recovery does. */
let recover: () => void;

const current = () => held[held.length - 1];
const lineDrawn = () => lineCalls[lineCalls.length - 1] ?? false;
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
  if (fail.build) throw new Error('line build failed');
  return lines(items);
};

function select(ids: readonly number[], primary = ids[ids.length - 1], modelId = MODEL): Partial<ViewerState> {
  return {
    selectedEntitiesSet: new Set(ids.map((expressId) => entityRefToString({ modelId, expressId }))),
    selectedEntity: primary === undefined ? null : { modelId, expressId: primary },
    selectedEntityIds: new Set(ids.map((id) => OFFSET + id)),
    selectedEntityId: primary === undefined ? null : OFFSET + primary,
  };
}

/**
 * Commits `patch` and runs its layout and passive effects, but no promise
 * continuation, so no swept-disk load or line build can finish before the
 * next assertion. (An async act would drain the whole rebuild first.)
 */
function commit(patch: Partial<ViewerState>): void {
  act(() => { flushSync(() => useViewerStore.setState(patch)); });
}

/** Lets every pending build and selection load settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const zero = { x: 0, y: 0, z: 0 };
const box = { min: zero, max: zero };
const geometry = (): NonNullable<ViewerState['geometryResult']> => ({ meshes: [], totalVertices: 0, totalTriangles: 0,
  coordinateInfo: { originShift: zero, wasmRtcOffset: zero, hasLargeCoordinates: false,
    originalBounds: box, shiftedBounds: box } }) as NonNullable<ViewerState['geometryResult']>;

function sourceModel() {
  const model = fixtureModel(MODEL, { idOffset: OFFSET });
  model.maxExpressId = 3;
  Object.assign(model.ifcDataStore!, { source: { byteLength: 1 } });
  model.geometryResult = geometry();
  return model;
}

/** A single-file legacy store: no federated models, products keyed `legacy:<expressId>`. */
function legacyStore(): Partial<ViewerState> {
  const ifcDataStore = fixtureDataStore();
  Object.assign(ifcDataStore, { source: { byteLength: 1 }, schemaVersion: 'IFC4' });
  return { ifcDataStore, geometryResult: geometry() } as Partial<ViewerState>;
}

function mount(ids: readonly number[], patch: Partial<ViewerState> = {}): void {
  useViewerStore.setState({ ...fixtureModels(sourceModel()), centrelineOverlayEnabled: true, ...select(ids),
    toGlobalId: (_modelId, expressId) => OFFSET + expressId, ...patch });
  const renderer = {
    setLineOverlay: (_channel: string, value: unknown) => {
      if (fail.upload && value !== null) throw new Error('device lost');
      lineCalls.push(value !== null);
    },
    setSourceSnapCurves: (curves: readonly SourceSnapCurve[]) => { held.push(curveKey(curves)); },
  } as unknown as Renderer;
  const ref: RefObject<Renderer | null> = { current: renderer };
  const Overlay = () => {
    const [epoch, setEpoch] = useState(0);
    recover = () => setEpoch((value) => value + 1);
    useCentrelineRendererOverlay(ref, true, epoch, lineBuilder);
    // Declared after the hook, so it runs after the hook's layout pass and before any passive effect.
    useLayoutEffect(() => { atLayout = { curves: current() ?? '', line: lineDrawn() }; });
    return null;
  };
  render(<Overlay />);
}

const ONE = '1@{"x":1,"y":0,"z":0}';
const THREE = '3@{"x":3,"y":0,"z":0}';

beforeEach(() => {
  prior = useViewerStore.getState();
  held = [];
  lineCalls = [];
  lineMark = 0;
  atLayout = { curves: '', line: false };
  builds = 0;
  gate = null;
  emptyBuild = false;
  loadGate = null;
  fail = { build: false, upload: false, load: false };
  recover = () => { throw new Error('the overlay is not mounted'); };
  toast.error = () => undefined;
  selectedSweptDiskCache.get = async (_model, ids) => {
    const wait = ids.includes(3) ? loadGate : null;
    if (wait) await wait;
    if (fail.load) throw new Error('swept-disk decode failed');
    return new Map(ids.flatMap((id) => {
      const source = SOURCES.get(id);
      return [[id, source ?? { occurrences: [], diagnostics: [] }] as const];
    }));
  };
});

afterEach(() => {
  cleanup();
  selectedSweptDiskCache.get = originalGet;
  toast.error = originalToast;
  useViewerStore.setState(prior);
});

async function mountInstalled(ids: readonly number[], expected: string, patch: Partial<ViewerState> = {}): Promise<number> {
  mount(ids, patch);
  await waitFor(() => current() === expected, 'the selected curves install');
  assert.ok(lineDrawn(), 'their centreline is drawn');
  lineMark = lineCalls.length;
  return held.length;
}

/** The drawn centreline stayed up through every line call since the install. */
function lineKept(): void {
  assert.ok(lineCalls.slice(lineMark).every(Boolean), 'the drawn centreline never blinks off');
  assert.ok(lineDrawn());
}

/** `since(from)` read only after at least one frame, so an every() over it is not vacuous. */
function sinceSome(from: number): string[] {
  const sets = since(from);
  assert.ok(sets.length > 0, 'the renderer received at least one curve set');
  return sets;
}

it('Ctrl-adding a product with no swept disk never empties the installed curves (#9086)', async () => {
  const from = await mountInstalled([1], ONE);
  const before = builds;
  commit(select([1, 2]));
  await settle();
  assert.ok(builds > before, 'the overlay rebuilt for the new selection');
  assert.deepEqual(sinceSome(from), since(from).map(() => ONE), 'every frame reads the same curve set');
  lineKept();
});

it('Ctrl-adding a non-swept product to two swept ones keeps the curve order (#9086)', async () => {
  const from = await mountInstalled([1, 3], `${ONE},${THREE}`);
  commit(select([1, 3], 1));
  await settle();
  const before = builds;
  commit(select([1, 3, 2]));
  await settle();
  assert.ok(builds > before, 'the overlay rebuilt with product 2 added first in the selection order');
  assert.deepEqual(sinceSome(from), since(from).map(() => `${ONE},${THREE}`), 'every frame reads the same curve set in one order');
  lineKept();
});

it('re-selecting the same product never empties the installed curves (#9086)', async () => {
  const from = await mountInstalled([1], ONE);
  const before = builds;
  commit(select([1]));
  await settle();
  assert.ok(builds > before, 'the overlay rebuilt for the new selection objects');
  assert.deepEqual(sinceSome(from), since(from).map(() => ONE));
  lineKept();
});

it('hiding an unrelated product keeps the curves; hiding the selected one clears them before paint', async () => {
  const from = await mountInstalled([1], ONE);
  commit({ hiddenEntities: new Set([OFFSET + 2]) });
  await settle();
  assert.deepEqual(sinceSome(from), since(from).map(() => ONE));
  lineKept();
  commit({ hiddenEntities: new Set([OFFSET + 1, OFFSET + 2]) });
  assert.deepEqual(atLayout, { curves: '', line: false }, 'a hidden product is neither drawn nor snappable before paint');
  await settle();
  assert.equal(current(), '');
});

it('a switch to another swept product drops the old curves before paint (#5778)', async () => {
  const from = await mountInstalled([1], ONE);
  commit(select([3]));
  assert.deepEqual(atLayout, { curves: '', line: false }, 'the old product is gone in the selection commit');
  await settle();
  assert.equal(current(), THREE);
  assert.ok(sinceSome(from).every((set) => !set.includes('1@')), 'no frame after the switch can snap to the old product');
});

it('Ctrl-adding a swept product keeps the old curves, then installs both', async () => {
  const from = await mountInstalled([1], ONE);
  commit(select([1, 3]));
  assert.deepEqual(atLayout, { curves: ONE, line: true }, 'the kept product stays drawn and snappable');
  await settle();
  assert.ok(sinceSome(from).every((set) => set.includes(ONE)), 'the kept product stays snappable throughout');
  assert.equal(current(), `${ONE},${THREE}`, 'both products install');
  lineKept();
});

it('deselecting everything clears the curves before paint', async () => {
  await mountInstalled([1], ONE);
  commit(select([]));
  assert.deepEqual(atLayout, { curves: '', line: false }, 'nothing selected, nothing drawn');
  await settle();
  assert.equal(current(), '');
});

it('turning the overlay off clears the curves before paint', async () => {
  await mountInstalled([1], ONE);
  commit({ centrelineOverlayEnabled: false });
  assert.deepEqual(atLayout, { curves: '', line: false }, 'the overlay is off');
  await settle();
  assert.equal(current(), '');
});

it('a placement change that moves the curves clears them, then installs the moved set', async () => {
  await mountInstalled([1], ONE);
  const modelPlacement = useViewerStore.getState().modelPlacement;
  commit({ modelPlacement: { ...modelPlacement, placements: new Map([[MODEL, {
    translation: [0, 5, 0], rotation: ZERO_ROTATION, locked: false,
  }]]) } });
  assert.deepEqual(atLayout, { curves: '', line: false }, 'curves at the old place cannot be snapped to');
  await settle();
  assert.notEqual(current(), '');
  assert.notEqual(current(), ONE, 'the reinstalled set is the moved one, so Live ends');
});

it('a georeference edit clears the curves before paint', async () => {
  await mountInstalled([1], ONE);
  commit({ georefMutations: new Map(useViewerStore.getState().georefMutations) });
  assert.deepEqual(atLayout, { curves: '', line: false }, 'the georeference moved the source');
});

it('unloading the model mid-rebuild clears the curves and rejects the late result', async () => {
  await mountInstalled([1], ONE);
  let release: () => void = () => undefined;
  gate = new Promise((resolve) => { release = resolve; });
  const before = builds;
  commit(select([1, 2]));
  await waitFor(() => builds > before, 'the rebuild is pending');
  assert.equal(current(), ONE);
  commit({ models: new Map() });
  assert.deepEqual(atLayout, { curves: '', line: false }, 'an unloaded model cannot be snapped to');
  gate = null;
  release();
  await settle();
  assert.equal(current(), '', 'the pending build of the unloaded model never installs');
});

it('a rebuild that draws nothing clears the kept curves', async () => {
  await mountInstalled([1], ONE);
  emptyBuild = true;
  commit(select([1, 2]));
  await settle();
  assert.equal(current(), '');
});

it('a late build for a superseded selection never installs its dropped product (epochs race)', async () => {
  const from = await mountInstalled([1], ONE);
  let release: () => void = () => undefined;
  gate = new Promise((resolve) => { release = resolve; });
  const before = builds;
  commit(select([1, 3]));
  await waitFor(() => builds > before, 'the build for products 1 and 3 is pending');
  commit(select([1]));
  assert.equal(current(), ONE);
  gate = null;
  release();
  await settle();
  assert.equal(current(), ONE);
  assert.ok(sinceSome(from).every((set) => set === ONE), 'product 3 was never snappable once deselected');
});

it('a switch that also clears the highlight never reinstalls the deselected product', async () => {
  // Switching away from a highlighted product clears the highlight in a second
  // commit, which re-runs the build while the swept-disk query still answers
  // the old selection.
  const from = await mountInstalled([1], ONE, { selectedDirectrixSegment: {
    modelId: MODEL, expressId: 1, occurrenceIndex: 0, segmentIndex: 0 } });
  let release: () => void = () => undefined;
  loadGate = new Promise((resolve) => { release = resolve; });
  const before = builds;
  commit(select([3]));
  await settle();
  assert.equal(useViewerStore.getState().selectedDirectrixSegment, null, 'the switch cleared the highlight');
  assert.equal(builds, before, 'the highlight change does not build the old selection\'s records');
  assert.ok(sinceSome(from).every((set) => !set.includes('1@')), 'the deselected product is never reinstalled');
  loadGate = null;
  release();
  await settle();
  assert.equal(current(), THREE);
});

it('replacing the model under the same id waits for its new swept disks', async () => {
  await mountInstalled([1, 3], `${ONE},${THREE}`, select([1, 3], 1));
  let release: () => void = () => undefined;
  loadGate = new Promise((resolve) => { release = resolve; });
  const before = builds;
  commit(fixtureModels(sourceModel()));
  const from = held.length;
  assert.equal(builds, before, 'the old model\'s records are not built against the new model');
  await settle();
  assert.equal(builds, before);
  assert.equal(current(), '', 'curves of the replaced model cannot be snapped to');
  assert.ok(since(from).every((set) => set === ''), 'the old model\'s records are not rebuilt for the new one');
  loadGate = null;
  release();
  await settle();
  assert.equal(current(), `${ONE},${THREE}`);
});

it('a new legacy store clears the curves of the old one before paint', async () => {
  const legacyOne = '1@{"x":1,"y":0,"z":0}';
  await mountInstalled([1, 3], `${legacyOne},${THREE}`,
    { models: new Map(), activeModelId: null, ...legacyStore(), ...select([1, 3], 1, 'legacy') });
  let release: () => void = () => undefined;
  loadGate = new Promise((resolve) => { release = resolve; });
  commit(legacyStore());
  assert.deepEqual(atLayout, { curves: '', line: false }, 'the replaced store cannot be snapped to');
  loadGate = null;
  release();
  await settle();
  assert.equal(current(), `${legacyOne},${THREE}`);
});

it('a highlight change while the selection reloads does not build the superseded records', async () => {
  // The highlight re-runs the build before the swept-disk query's new result
  // renders; only the `current()` stamp tells the old result apart.
  await mountInstalled([1, 3], `${ONE},${THREE}`, select([1, 3], 1));
  let release: () => void = () => undefined;
  loadGate = new Promise((resolve) => { release = resolve; });
  const before = builds;
  commit({ selectedDirectrixSegment: { modelId: MODEL, expressId: 1, occurrenceIndex: 0, segmentIndex: 0 } });
  assert.equal(builds, before, 'the records answering the old query are not built');
  assert.deepEqual(atLayout, { curves: '', line: false }, 'a highlight re-evaluates the curves');
  loadGate = null;
  release();
  await settle();
  assert.equal(current(), ONE, 'only the highlighted segment is snappable');
});

it('a tree click that makes another federated model active keeps the curves (#9086)', async () => {
  const other = fixtureModel('other', { idOffset: 2 * OFFSET });
  Object.assign(other.ifcDataStore!, { source: { byteLength: 1 } });
  other.geometryResult = geometry();
  const model = sourceModel();
  const from = await mountInstalled([1], ONE, { ...fixtureModels(model, other),
    ifcDataStore: model.ifcDataStore, toGlobalId: (modelId, expressId) => (modelId === MODEL ? OFFSET : 2 * OFFSET) + expressId });
  const before = builds;
  // HierarchyPanel: Ctrl-add a product of the other model, which also makes that model active.
  commit({ selectedEntitiesSet: new Set([`${MODEL}:1`, 'other:2']), selectedEntity: { modelId: 'other', expressId: 2 },
    selectedEntityIds: new Set([OFFSET + 1, 2 * OFFSET + 2]), selectedEntityId: 2 * OFFSET + 2,
    activeModelId: 'other', ifcDataStore: other.ifcDataStore });
  await settle();
  assert.ok(builds > before, 'the overlay rebuilt for the new selection');
  assert.deepEqual(sinceSome(from), since(from).map(() => ONE), 'the active model mirror does not move the curves');
  lineKept();
});

it('a GPU recovery reinstalls the curves on the recovered device', async () => {
  const from = await mountInstalled([1], ONE);
  await act(async () => { recover(); await Promise.resolve(); });
  await settle();
  assert.ok(since(from).includes(''), 'the lost device\'s curves were dropped');
  assert.equal(current(), ONE, 'the recovered device snaps to the selection again');
});

it('a rebuild that rejects, or whose GPU upload fails, clears the kept curves', async () => {
  await mountInstalled([1], ONE);
  fail.build = true;
  commit(select([1, 2]));
  await settle();
  assert.equal(current(), '', 'a failed build leaves nothing to snap to');
  fail.build = false;
  commit(select([1]));
  await settle();
  assert.equal(current(), ONE);
  fail.upload = true;
  commit(select([1, 2]));
  await settle();
  assert.equal(current(), '', 'curves without their drawn line are not snappable');
  assert.equal(lineDrawn(), false);
});

it('a swept-disk load that fails clears the kept curves', async () => {
  await mountInstalled([1], ONE);
  fail.load = true;
  commit(select([1, 2]));
  await settle();
  assert.equal(current(), '');
});

it('isolating or lens-hiding away the selected product clears its curves before paint', async () => {
  await mountInstalled([1], ONE);
  commit({ isolatedEntities: new Set([OFFSET + 2]) });
  assert.deepEqual(atLayout, { curves: '', line: false }, 'an isolated-out product cannot be snapped to');
  commit({ isolatedEntities: null });
  await settle();
  assert.equal(current(), ONE);
  commit({ lensHiddenIds: new Set([OFFSET + 1]) });
  assert.deepEqual(atLayout, { curves: '', line: false }, 'a lens-hidden product cannot be snapped to');
});

it('unmounting the overlay clears its curves', async () => {
  await mountInstalled([1], ONE);
  cleanup();
  assert.equal(current(), '');
});
