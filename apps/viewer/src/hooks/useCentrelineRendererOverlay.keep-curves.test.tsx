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
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { toast } from '@/components/ui/toast.js';
import { fixtureDataStore, fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { cleanup, render, waitFor } from '@/test/render.js';
import { entityRefToString, useViewerStore, type FederatedModel, type ViewerState } from '@/store/index.js';
import { selectedSweptDiskCache, type ProductSweptDisks } from '@/lib/analytic/swept-disk-cache.js';
import { sourceOccurrenceKey, type selectedCentrelineWorldLines } from '@/lib/analytic/selected-centreline-lines.js';
import { ZERO_ROTATION } from '@/lib/model-placement/rotation.js';
import { findReferenceSpatialModel } from './ingest/federationAlign.js';
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
/** What the renderer held after each of the overlay's layout passes, before that render's passive effects. */
let layouts: Array<{ curves: string; line: boolean }>;
let layoutMark: number;
/** The first layout pass of the last commit: what the next frame paints and picks. */
const firstLayout = () => layouts[layoutMark];
/** What the next frame paints and picks: the first layout pass of the last commit, or what is held when it re-rendered nothing. */
const nextFrame = () => layouts[layoutMark] ?? { curves: current() ?? '', line: lineDrawn() };
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
/** Sets the overlay's isInitialized, as the Viewport does around renderer setup and teardown. */
let initialize: (value: boolean) => void;

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
function commit(change: Partial<ViewerState> | (() => void)): void {
  layoutMark = layouts.length;
  act(() => { flushSync(() => (typeof change === 'function' ? change() : useViewerStore.setState(change))); });
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

/** A second federated model, `other`, whose express ids are the same as `live`'s. */
function otherModel() {
  const model = sourceModel();
  return Object.assign(model, { id: 'other', name: 'other', idOffset: 2 * OFFSET });
}

/** `live` and `other` loaded together; `ids` select products of `live`, `otherIds` of `other`. */
function federated(ids: readonly number[], otherIds: readonly number[] = []): Partial<ViewerState> {
  const refs = [...ids.map((expressId) => ({ modelId: MODEL, expressId })),
    ...otherIds.map((expressId) => ({ modelId: 'other', expressId }))];
  const global = (modelId: string, expressId: number) => (modelId === MODEL ? OFFSET : 2 * OFFSET) + expressId;
  const primary = refs[refs.length - 1] ?? null;
  return { ...fixtureModels(sourceModel(), otherModel()), toGlobalId: global,
    selectedEntitiesSet: new Set(refs.map(entityRefToString)), selectedEntity: primary,
    selectedEntityIds: new Set(refs.map(({ modelId, expressId }) => global(modelId, expressId))),
    selectedEntityId: primary ? global(primary.modelId, primary.expressId) : null };
}

/** A single-file legacy store: no federated models, products keyed `legacy:<expressId>`. */
function legacyStore(): Partial<ViewerState> {
  const ifcDataStore = fixtureDataStore();
  Object.assign(ifcDataStore, { source: { byteLength: 1 }, schemaVersion: 'IFC4' });
  return { ifcDataStore, geometryResult: geometry() } as Partial<ViewerState>;
}

/** The overlay's renderer ref; the Viewport nulls or replaces it around a re-initialisation. */
let rendererRef: RefObject<Renderer | null>;

/** A renderer that records the curve sets and line calls it receives into the given lists. */
function fakeRenderer(curveSets: string[], lines: boolean[]): Renderer {
  return {
    setLineOverlay: (_channel: string, value: unknown) => {
      if (fail.upload && value !== null) throw new Error('device lost');
      lines.push(value !== null);
    },
    setSourceSnapCurves: (curves: readonly SourceSnapCurve[]) => { curveSets.push(curveKey(curves)); },
  } as unknown as Renderer;
}

function mount(ids: readonly number[], patch: Partial<ViewerState> = {}): void {
  useViewerStore.setState({ ...fixtureModels(sourceModel()), centrelineOverlayEnabled: true, ...select(ids),
    toGlobalId: (_modelId, expressId) => OFFSET + expressId, ...patch });
  rendererRef = { current: fakeRenderer(held, lineCalls) };
  const ref = rendererRef;
  const Overlay = () => {
    const [epoch, setEpoch] = useState(0);
    const [initialized, setInitialized] = useState(true);
    recover = () => setEpoch((value) => value + 1);
    initialize = setInitialized;
    useCentrelineRendererOverlay(ref, initialized, epoch, lineBuilder);
    // Declared after the hook, so it runs after the hook's layout pass and before any passive effect.
    useLayoutEffect(() => { layouts.push({ curves: current() ?? '', line: lineDrawn() }); });
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
  layouts = [];
  layoutMark = 0;
  builds = 0;
  gate = null;
  emptyBuild = false;
  loadGate = null;
  fail = { build: false, upload: false, load: false };
  recover = () => { throw new Error('the overlay is not mounted'); };
  initialize = () => { throw new Error('the overlay is not mounted'); };
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
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'a hidden product is neither drawn nor snappable before paint');
  await settle();
  assert.equal(current(), '');
});

it('a switch to another swept product drops the old curves before paint (#5778)', async () => {
  const from = await mountInstalled([1], ONE);
  commit(select([3]));
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'the old product is gone in the selection commit');
  await settle();
  assert.equal(current(), THREE);
  assert.ok(sinceSome(from).every((set) => !set.includes('1@')), 'no frame after the switch can snap to the old product');
});

it('Ctrl-adding a swept product keeps the old curves, then installs both', async () => {
  const from = await mountInstalled([1], ONE);
  commit(select([1, 3]));
  assert.deepEqual(firstLayout(), { curves: ONE, line: true }, 'the kept product stays drawn and snappable');
  await settle();
  assert.ok(sinceSome(from).every((set) => set.includes(ONE)), 'the kept product stays snappable throughout');
  assert.equal(current(), `${ONE},${THREE}`, 'both products install');
  lineKept();
});

it('deselecting one of two drawn products drops the shared line and every curve before paint', async () => {
  // The line is one buffer for both products: keeping product 1's curves
  // would leave them snappable while nothing draws them.
  await mountInstalled([1, 3], `${ONE},${THREE}`, select([1, 3], 1));
  commit(select([1]));
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'nothing is snappable without its drawn line');
  await settle();
  assert.equal(current(), ONE);
  assert.ok(lineDrawn(), 'the kept product is drawn again');
});

it('deselecting everything clears the curves before paint', async () => {
  await mountInstalled([1], ONE);
  commit(select([]));
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'nothing selected, nothing drawn');
  await settle();
  assert.equal(current(), '');
});

it('turning the overlay off clears the curves before paint', async () => {
  await mountInstalled([1], ONE);
  commit({ centrelineOverlayEnabled: false });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'the overlay is off');
  await settle();
  assert.equal(current(), '');
});

it('a placement change that moves the curves clears them, then installs the moved set', async () => {
  await mountInstalled([1], ONE);
  const modelPlacement = useViewerStore.getState().modelPlacement;
  commit({ modelPlacement: { ...modelPlacement, placements: new Map([[MODEL, {
    translation: [0, 5, 0], rotation: ZERO_ROTATION, locked: false,
  }]]) } });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'curves at the old place cannot be snapped to');
  await settle();
  assert.notEqual(current(), '');
  assert.notEqual(current(), ONE, 'the reinstalled set is the moved one, so Live ends');
});

it('a georeference edit clears the curves before paint', async () => {
  await mountInstalled([1], ONE);
  commit({ georefMutations: new Map(useViewerStore.getState().georefMutations) });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'the georeference moved the source');
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
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'an unloaded model cannot be snapped to');
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
  const from = held.length;
  commit(fixtureModels(sourceModel()));
  assert.equal(builds, before, 'the old model\'s records are not built against the new model');
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'curves of the replaced model cannot be snapped to');
  await settle();
  assert.equal(builds, before);
  assert.deepEqual(sinceSome(from), [''], 'nothing installs until the new model\'s swept disks load');
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
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'the replaced store cannot be snapped to');
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
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'a highlight re-evaluates the curves');
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
  assert.ok(lineCalls.slice(lineMark).includes(false), 'and its line');
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
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'an isolated-out product cannot be snapped to');
  commit({ isolatedEntities: null });
  await settle();
  assert.equal(current(), ONE);
  commit({ lensHiddenIds: new Set([OFFSET + 1]) });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'a lens-hidden product cannot be snapped to');
});

it('leaving initialisation clears the line and curves on the renderer that drew them, then a re-init reinstalls them', async () => {
  await mountInstalled([1], ONE);
  const from = held.length;
  // The Viewport nulls the ref and destroys the renderer before it reports the
  // renderer uninitialised; the clear must still reach the renderer that drew.
  const nextCurves: string[] = [];
  const nextLines: boolean[] = [];
  act(() => { flushSync(() => { rendererRef.current = null; initialize(false); }); });
  assert.deepEqual(since(from), [''], 'the renderer that drew the curves no longer holds them');
  assert.ok(lineCalls.slice(lineMark).includes(false), 'nor their line');
  act(() => { flushSync(() => initialize(false)); });
  assert.deepEqual(since(from), [''], 'staying uninitialised calls into no renderer');
  rendererRef.current = fakeRenderer(nextCurves, nextLines);
  await act(async () => { initialize(true); await Promise.resolve(); });
  await settle();
  assert.equal(nextCurves[nextCurves.length - 1], ONE, 'the new renderer snaps to the selection');
  assert.equal(nextLines[nextLines.length - 1], true, 'and draws it');
  assert.deepEqual(since(from), [''], 'the old renderer receives nothing more');
});

it('unmounting the overlay clears its curves', async () => {
  await mountInstalled([1], ONE);
  cleanup();
  assert.equal(current(), '');
  assert.equal(lineDrawn(), false);
});

/*
 * A new `models` Map is not by itself a change to the curves (#9158): only the
 * model fields that place or source them, and the visibility of a model the
 * selection reaches, are.
 */

it('collapsing or renaming the drawn model keeps the curves and does not rebuild (#9158)', async () => {
  const from = await mountInstalled([1], ONE);
  const before = builds;
  assert.equal(useViewerStore.getState().activeModelId, MODEL, 'the drawn model is the active one');
  commit(() => useViewerStore.getState().setModelCollapsed(MODEL, true));
  assert.deepEqual(firstLayout(), { curves: ONE, line: true }, 'a collapsed row moves no curve');
  commit(() => useViewerStore.getState().setModelName(MODEL, 'renamed'));
  assert.deepEqual(firstLayout(), { curves: ONE, line: true }, 'a renamed model moves no curve');
  commit(() => useViewerStore.getState().setModelCollapsed(MODEL, false));
  await settle();
  assert.equal(useViewerStore.getState().models.get(MODEL)?.name, 'renamed', 'the store applied the rename');
  assert.equal(builds, before, 'nothing rebuilt');
  assert.deepEqual(since(from), [], 'the renderer was handed no curve set, so Live holds');
  lineKept();
});

it('toggling an unrelated model with the same express ids keeps the curves and does not rebuild (#9158)', async () => {
  const from = await mountInstalled([1], ONE, federated([1]));
  const before = builds;
  commit(() => useViewerStore.getState().setModelVisibility('other', false));
  assert.deepEqual(firstLayout(), { curves: ONE, line: true }, 'other:1 is not the drawn live:1');
  commit(() => useViewerStore.getState().setModelVisibility('other', true));
  commit(() => useViewerStore.getState().setModelCollapsed('other', true));
  await settle();
  assert.equal(builds, before, 'nothing rebuilt');
  assert.deepEqual(since(from), []);
  lineKept();
});

it('hiding the drawn product\'s model clears before paint, not a same-id model; showing it reinstalls (#9158)', async () => {
  await mountInstalled([], ONE, federated([], [1]));
  const before = builds;
  commit(() => useViewerStore.getState().setModelVisibility(MODEL, false));
  assert.deepEqual(firstLayout(), { curves: ONE, line: true }, 'live:1 is not the drawn other:1');
  await settle();
  assert.equal(builds, before, 'live holds no selected product');
  commit(() => useViewerStore.getState().setModelVisibility('other', false));
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'a product of a hidden model cannot be snapped to');
  await settle();
  assert.equal(current(), '');
  assert.equal(lineDrawn(), false);
  commit(() => useViewerStore.getState().setModelVisibility('other', true));
  await settle();
  assert.equal(current(), ONE, 'the shown model\'s product is snappable again');
  assert.ok(lineDrawn());
});

it('hiding the model of a selected non-swept product rebuilds but keeps the curves (#9158)', async () => {
  const from = await mountInstalled([1], ONE, federated([1], [2]));
  commit(() => useViewerStore.getState().setModelVisibility('other', false));
  assert.deepEqual(firstLayout(), { curves: ONE, line: true });
  await settle();
  commit(() => useViewerStore.getState().setModelVisibility('other', true));
  await settle();
  assert.deepEqual(sinceSome(from), since(from).map(() => ONE), 'every frame reads the same curve set');
  lineKept();
});

it('showing the hidden model of a selected swept product adds its curves (#9158)', async () => {
  await mountInstalled([1], ONE, { ...federated([1], [3]),
    ...fixtureModels(sourceModel(), Object.assign(otherModel(), { visible: false })) });
  commit(() => useViewerStore.getState().setModelVisibility('other', true));
  assert.deepEqual(firstLayout(), { curves: ONE, line: true }, 'the drawn product stays until both install');
  await settle();
  assert.equal(current(), `${ONE},${THREE}`, 'other:3 is snappable once its model shows');
});

it('removing the drawn model clears before paint (#9158)', async () => {
  await mountInstalled([1], ONE, federated([1]));
  const models = useViewerStore.getState().models;
  commit({ models: new Map([['other', models.get('other')!]]) });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'a removed model cannot be snapped to');
  await settle();
  assert.equal(current(), '');
});

it('a model field that places the curves clears them before paint (#9158)', async () => {
  await mountInstalled([1], ONE);
  const model = useViewerStore.getState().models.get(MODEL)!;
  commit({ models: new Map([[MODEL, { ...model, geometryResult: geometry() }]]) });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'a new geometry result re-places the source');
  await settle();
  assert.equal(current(), ONE);
  // Alignment replaces the frame on the kept geometry object.
  const kept = useViewerStore.getState().models.get(MODEL)!;
  kept.geometryResult!.coordinateInfo = { ...kept.geometryResult!.coordinateInfo };
  commit({ models: new Map([[MODEL, kept]]) });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'a new coordinate frame re-places the source');
  await settle();
  commit({ models: new Map([[MODEL, { ...useViewerStore.getState().models.get(MODEL)!, federationAlignmentStatus: 'anchor' }]]) });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'an alignment change re-places the source');
});

it('a new anchor candidate, or a pinned anchor, keeps the curves of a model that is not aligned (#9229)', async () => {
  // `live` was never re-baked into an anchor's frame, so no anchor places its curves.
  const from = await mountInstalled([1], ONE, federated([1]));
  const before = builds;
  const models = useViewerStore.getState().models;
  const other = models.get('other')!;
  commit({ models: new Map([...models, ['other', { ...other, spatialReference: {} as FederatedModel['spatialReference'] }]]) });
  assert.deepEqual(firstLayout(), { curves: ONE, line: true }, 'another model\'s georeference moves no curve of live');
  commit({ anchorModelIdOverride: 'other' });
  assert.deepEqual(nextFrame(), { curves: ONE, line: true }, 'nor does pinning it');
  await settle();
  assert.equal(builds, before);
  assert.deepEqual(since(from), []);
});

it('hiding the drawn model mid-rebuild clears before paint and rejects the late result (#9158)', async () => {
  await mountInstalled([1], ONE, federated([1], [2]));
  let release: () => void = () => undefined;
  gate = new Promise((resolve) => { release = resolve; });
  const before = builds;
  commit(() => useViewerStore.getState().setModelVisibility('other', false));
  await waitFor(() => builds > before, 'the rebuild for the hidden non-swept product is pending');
  assert.equal(current(), ONE);
  commit(() => useViewerStore.getState().setModelVisibility(MODEL, false));
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'a product of a hidden model cannot be snapped to');
  gate = null;
  release();
  await settle();
  assert.equal(current(), '', 'the pending build never installs the hidden product');
  assert.equal(lineDrawn(), false);
});

it('a product selected through the renderer ids alone keeps its model\'s visibility in the key (#9158)', async () => {
  // An empty basket: the query resolves the renderer's global ids to `other:1`.
  await mountInstalled([], ONE, { ...federated([], [1]), selectedEntitiesSet: new Set(), selectedEntity: null,
    selectedEntityIds: new Set([2 * OFFSET + 1]), selectedEntityId: null });
  const before = builds;
  commit(() => useViewerStore.getState().setModelVisibility(MODEL, false));
  assert.deepEqual(firstLayout(), { curves: ONE, line: true }, 'live holds no selected product');
  await settle();
  assert.equal(builds, before);
  commit(() => useViewerStore.getState().setModelVisibility('other', false));
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'the resolved product\'s model is hidden');
});

it('with the overlay off, a renderer-id selection resolves nothing for the model keys (#9158)', async () => {
  const resolve = useViewerStore.getState().resolveGlobalIdFromModels;
  let resolved = 0;
  mount([], { ...federated([], [1]), centrelineOverlayEnabled: false, selectedEntitiesSet: new Set(),
    selectedEntity: null, selectedEntityIds: new Set([2 * OFFSET + 1]), selectedEntityId: null,
    resolveGlobalIdFromModels: (globalId: number) => { resolved++; return resolve(globalId); } });
  commit({ selectedEntityIds: new Set([2 * OFFSET + 1, 2 * OFFSET + 3]) });
  await settle();
  assert.equal(resolved, 0, 'a select-all costs nothing while the overlay is off');
  assert.equal(builds, 0);
  commit({ centrelineOverlayEnabled: true });
  await settle();
  assert.ok(resolved > 0, 'turning it on resolves the selection');
  assert.equal(current(), `${ONE},${THREE}`);
});

/*
 * Only the models the selection reaches place its curves (#9229). An aligned
 * model's curves map through the reference its meshes were re-baked into,
 * which pinning another anchor does not move until a re-align.
 */

const crs: ProjectedCRS = { id: 3, name: 'EPSG:2056', verticalDatum: 'EPSG:5729', mapUnitScale: 1 } as ProjectedCRS;

/** A georeferenced model in EPSG:2056, its project origin at `eastings`. */
function georeferenced(id: string, idOffset: number, eastings: number, loadedAt: number): FederatedModel {
  const model = Object.assign(sourceModel(), { id, name: id, idOffset, loadedAt });
  const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3, eastings, northings: 1_200_000,
    orthogonalHeight: 400, xAxisAbscissa: 1, xAxisOrdinate: 0, factorX: 1, factorY: 1, factorZ: 1 };
  Object.assign(model.ifcDataStore!, { lengthUnitScale: 1,
    georeferencing: { hasGeoreference: true, projectedCRS: crs, mapConversion: conversion } });
  return model;
}

/**
 * `anchor` drives the frame, `live` (10 m east of it) was aligned into it on
 * load, and `third` lies 100 m east; `live:1` is selected. With `recorded`
 * false, `live` carries no record of the reference it was aligned into.
 */
function alignedFederation(recorded = true): Partial<ViewerState> {
  const anchor = Object.assign(georeferenced('anchor', 3 * OFFSET, 2_600_000, 1), { federationAlignmentStatus: 'anchor' as const });
  const third = georeferenced('third', 4 * OFFSET, 2_600_100, 3);
  const live = Object.assign(georeferenced(MODEL, OFFSET, 2_600_010, 2), {
    federationAlignmentStatus: 'same-crs' as const, preAlignment: { coordinateInfo: geometry().coordinateInfo },
  }) as FederatedModel;
  const prior = useViewerStore.getState();
  useViewerStore.setState({ ...fixtureModels(anchor, third), georefMutations: new Map(), anchorModelIdOverride: null });
  // What the load recorded: the anchor the federation picked when `live` joined.
  if (recorded) live.alignmentReference = findReferenceSpatialModel()!.placement;
  useViewerStore.setState({ models: prior.models });
  const offsets: Record<string, number> = { [MODEL]: OFFSET, anchor: 3 * OFFSET, third: 4 * OFFSET };
  return { ...fixtureModels(anchor, live, third), georefMutations: new Map(), anchorModelIdOverride: null,
    toGlobalId: (modelId, expressId) => offsets[modelId]! + expressId, ...select([1]) };
}

it('pinning another anchor without a re-align keeps the curves on the meshes, even through a rebuild (#9229)', async () => {
  mount([1], alignedFederation());
  await waitFor(() => (current() ?? '') !== '', 'the aligned curves install');
  const aligned = current();
  assert.notEqual(aligned, ONE, 'the curves are mapped into the anchor frame, not drawn in their own');
  const from = held.length;
  const before = builds;
  commit({ anchorModelIdOverride: 'third' });
  assert.deepEqual(nextFrame(), { curves: aligned, line: true }, 'no mesh moved, so neither does a curve');
  await settle();
  assert.equal(builds, before, 'nothing rebuilt');
  assert.deepEqual(since(from), [], 'Live holds');
  commit(select([1]));
  await settle();
  assert.ok(builds > before, 'a re-selection rebuilds');
  assert.equal(current(), aligned, 'the rebuilt curves still lie where the meshes are, not in the pinned anchor\'s frame');
  // The re-align re-bakes `live` into `third`'s frame; the curves follow it.
  const placed = useViewerStore.getState().models.get(MODEL)!;
  commit({ models: new Map([...useViewerStore.getState().models,
    [MODEL, { ...placed, alignmentReference: findReferenceSpatialModel()!.placement }]]) });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'a new alignment reference re-places the curves before paint');
  await settle();
  assert.ok(current() !== '' && current() !== aligned, 'the curves move into the re-aligned frame');
});

it('a model aligned with no recorded reference follows the anchor the federation picks, pin included (#9229)', async () => {
  mount([1], alignedFederation(false));
  await waitFor(() => (current() ?? '') !== '', 'the aligned curves install');
  const aligned = current();
  commit({ anchorModelIdOverride: 'third' });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'the pinned anchor re-places these curves before paint');
  await settle();
  assert.ok(current() !== '' && current() !== aligned, 'they install in the pinned anchor\'s frame');
  const moved = current();
  const models = useViewerStore.getState().models;
  commit({ models: new Map([...models, ['anchor', { ...models.get('anchor')!, geometryResult: geometry() }]]) });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'any model can become the anchor, so any model\'s change clears');
  await settle();
  assert.equal(current(), moved);
});

it('loading, streaming, reordering or removing a model the selection doesn\'t reach keeps the curves (#9229)', async () => {
  // One model, then two, then three, and back: the drawn `live:1` never moves.
  const from = await mountInstalled([1], ONE);
  const before = builds;
  const third = Object.assign(sourceModel(), { id: 'third', name: 'third', idOffset: 3 * OFFSET });
  const steps: Array<[string, () => Map<string, FederatedModel>]> = [
    ['a second model loads', () => new Map([...useViewerStore.getState().models, ['other', otherModel()]])],
    ['a third model loads', () => new Map([...useViewerStore.getState().models, ['third', third]])],
    ['the third streams a batch', () => new Map([...useViewerStore.getState().models,
      ['third', { ...third, geometryResult: geometry(), loadedAt: 9 }]])],
    ['the models reorder', () => new Map([...useViewerStore.getState().models].reverse())],
    ['the second is removed', () => new Map([...useViewerStore.getState().models].filter(([id]) => id !== 'other'))],
    ['the third is removed', () => new Map([...useViewerStore.getState().models].filter(([id]) => id !== 'third'))],
  ];
  for (const [label, models] of steps) {
    commit({ models: models() });
    assert.deepEqual(firstLayout(), { curves: ONE, line: true }, label);
  }
  await settle();
  assert.equal(useViewerStore.getState().models.size, 1);
  assert.equal(builds, before, 'nothing rebuilt');
  assert.deepEqual(since(from), [], 'the renderer was handed no curve set, so Live holds');
  lineKept();
});

it('a new legacy geometry result under the same store clears the curves before paint and re-places them (#9229)', async () => {
  const legacyOne = '1@{"x":1,"y":0,"z":0}';
  await mountInstalled([1], legacyOne, { models: new Map(), activeModelId: null, ...legacyStore(), ...select([1], 1, 'legacy') });
  const shifted = geometry();
  shifted.coordinateInfo = { ...shifted.coordinateInfo, originShift: { x: 5, y: 0, z: 0 } };
  commit({ geometryResult: shifted });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'curves placed by the old geometry cannot be snapped to');
  await settle();
  assert.ok(current() !== '' && current() !== legacyOne, 'the curves install in the new geometry\'s frame');
  // Alignment can also replace the frame on the kept geometry object.
  const placed = current();
  const kept = useViewerStore.getState().geometryResult!;
  kept.coordinateInfo = { ...kept.coordinateInfo, originShift: zero };
  commit({ hiddenEntities: new Set(useViewerStore.getState().hiddenEntities) });
  assert.deepEqual(firstLayout(), { curves: '', line: false }, 'a frame replaced on the kept geometry clears');
  await settle();
  assert.ok(current() !== placed);
});

it('the overlay resolves a renderer-id selection once per change, not once more for its query (#9229)', async () => {
  const resolve = useViewerStore.getState().resolveGlobalIdFromModels;
  let resolved = 0;
  await mountInstalled([], ONE, { ...federated([], [1]), selectedEntitiesSet: new Set(), selectedEntity: null,
    selectedEntityIds: new Set([2 * OFFSET + 1]), selectedEntityId: null,
    resolveGlobalIdFromModels: (globalId: number) => { resolved++; return resolve(globalId); } });
  resolved = 0;
  commit(() => useViewerStore.getState().setModelCollapsed('other', true));
  await settle();
  assert.equal(resolved, 1, 'one selected id, one resolution');
});
