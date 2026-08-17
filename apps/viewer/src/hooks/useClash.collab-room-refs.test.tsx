/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A clash row must be clickable in a COLLABORATIVE session.
 *
 * The collab recipient's model is put into `state.models` by
 * `collabSlice.ts` through `upsertModel` (`room:<id>`, `idOffset: 0` — the
 * hydrated meshes are already in the reconstructed store's id space). That
 * path never calls `registerModelOffset`, so the model exists for the store
 * but not for the `federationRegistry` singleton.
 *
 * `useClash`'s `refOf` resolved a clash ref through the SINGLETON
 * (`fromGlobalId`), which answers `null` for a model it does not know — so
 * `focusClash` bailed at `refs.length === 0` and every row in the panel was
 * inert. Selection from the 3D view, by contrast, resolves through
 * `resolveGlobalIdFromModels` (the store-state resolver `resolveEntityRef`
 * documents as the single source of truth) and works fine on the same model:
 * two resolvers, one id space, different answers.
 *
 * Mounts the REAL `useClash()` hook over a REAL parsed model with real meshes,
 * registered exactly the way the collab room registers it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { summarizeClashes, type Clash, type ClashResult, type ClashRule } from '@ifc-lite/clash';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { rememberFederationIdentity } from '@/lib/clash/federation-identity.js';
import { elementPairExclusion } from '@/lib/clash/exclusions.js';
import {
  CLASH_MODEL_UNLOADED_MESSAGE,
  CLASH_REF_UNRESOLVED_MESSAGE,
  CLASH_SUPERSEDED_MESSAGE,
  useClash,
} from './useClash.js';

// ─── Fixture: two walls, meshed as overlapping unit boxes ───────────────────

function ifc4(body: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

const TWO_WALLS = [
  "#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);",
  "#2=IFCWALL('0bbbbbbbbbbbbbbbbbbbbb',$,'Wall B',$,$,$,$,$,.STANDARD.);",
].join('\n');

/**
 * The SAME two walls after a peer inserted one ahead of them: id 1 is now
 * Wall C and id 2 is now Wall A.
 *
 * The renumbering is written out by hand here rather than produced by the real
 * IFCX path — these fixtures are STEP, so `IfcParser` takes the express ids
 * straight from the `#N` labels. What it STANDS IN FOR is
 * `packages/ifcx/src/entity-extractor.ts`, where a collab re-derivation assigns
 * express ids from a counter walked over composed-node order
 * (`nextExpressId++`), so an insertion genuinely does shift every id after it.
 * The test is about what `refOf` does with a renumbered store, not about which
 * parser renumbered it.
 */
const THREE_WALLS_C_FIRST = [
  "#1=IFCWALL('0ccccccccccccccccccccc',$,'Wall C',$,$,$,$,$,.STANDARD.);",
  "#2=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);",
  "#3=IFCWALL('0bbbbbbbbbbbbbbbbbbbbb',$,'Wall B',$,$,$,$,$,.STANDARD.);",
].join('\n');

async function parse(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A unit box (12 triangles) with its min corner at `(dx, 0, 0)`. */
function boxMesh(expressId: number, dx: number): MeshData {
  const positions = new Float32Array([
    dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0,
    dx, 0, 1, dx + 1, 0, 1, dx + 1, 1, 1, dx, 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  return {
    expressId,
    ifcType: 'IfcWall',
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
  };
}

function geometry(meshes: MeshData[]): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } };
  const coordinateInfo: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: false,
  };
  return { meshes, totalTriangles: 12 * meshes.length, totalVertices: 8 * meshes.length, coordinateInfo };
}

/** The rule `runAll` builds: every element vs every other, hard clash. */
const ALL_RULE: ClashRule = { id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' };

const ROOM_MODEL_ID = 'room:demo-room';

// ─── Harness ────────────────────────────────────────────────────────────────

type ClashApi = ReturnType<typeof useClash>;

let api: ClashApi | null = null;

function Probe(): null {
  api = useClash();
  return null;
}

let root: Root | null = null;

/**
 * Seed the store the way a collab RECIPIENT is seeded: `upsertModel` with a
 * `room:*` id and `idOffset: 0`, and no `registerModelOffset` — verbatim the
 * shape of `collabSlice.ts`'s reconstruct (`get().upsertModel({ id:
 * roomModelId, ..., idOffset: 0, maxExpressId })`).
 */
async function seedRoom(): Promise<void> {
  const store = await parse(TWO_WALLS);
  // clearAllModels() also clears the federationRegistry singleton, so this test
  // starts from the "joined a room, loaded no local file" state.
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({
    clashResult: null,
    clashGroups: null,
    clashError: null,
    clashRunning: false,
    clashSelectedId: null,
    isolatedEntities: null,
    ghostExceptEntities: null,
  });
  useViewerStore.getState().upsertModel({
    id: ROOM_MODEL_ID,
    name: 'Shared model',
    ifcDataStore: store,
    geometryResult: geometry([boxMesh(1, 0), boxMesh(2, 0.5)]),
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: Date.now(),
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 2,
    loadState: 'complete',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(api, 'useClash must be mounted');
}

beforeEach(() => {
  api = null;
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  useViewerStore.getState().clearAllModels();
});

describe('clash results are usable in a collaborative room', () => {
  it('setup sanity: the room model is in the store but NOT in the federation registry', async () => {
    await seedRoom();
    const s = useViewerStore.getState();
    assert.ok(s.models.has(ROOM_MODEL_ID), 'the room model must be a real store model');
    assert.equal(s.getModelOffset(ROOM_MODEL_ID), null,
      'the collab path never registers the room model with the federation registry');
    // The 3D-click path resolves the very same id space without trouble.
    assert.deepEqual(s.resolveGlobalIdFromModels(1), { modelId: ROOM_MODEL_ID, expressId: 1 },
      'the store-state resolver (3D selection) resolves room ids fine');
  });

  it('clicking a clash row FOCUSES the pair (it must not be inert)', async () => {
    await seedRoom();
    await act(async () => { await api!.run([ALL_RULE]); });

    const afterRun = useViewerStore.getState();
    assert.equal(afterRun.clashError, null, 'the run must complete in a room');
    const clash = afterRun.clashResult?.clashes[0];
    assert.ok(clash, 'the overlapping pair must be found');

    await act(async () => { api!.focusClash(clash!, 'highlight'); });

    const s = useViewerStore.getState();
    assert.equal(s.clashSelectedId, clash!.id,
      'the clicked row must become the focused clash — focusClash bailed at refs.length === 0');
    assert.ok(s.clashHighlightColors && s.clashHighlightColors.size === 2,
      'both members of the pair must be painted the clash A/B colours');
  });

  it('isolating a clash row hides the rest of the room model', async () => {
    await seedRoom();
    await act(async () => { await api!.run([ALL_RULE]); });
    const clash = useViewerStore.getState().clashResult?.clashes[0];
    assert.ok(clash, 'the overlapping pair must be found');

    await act(async () => { api!.focusClash(clash!, 'isolate'); });

    const isolated = useViewerStore.getState().isolatedEntities;
    assert.ok(isolated, 'the isolate focus mode must install an isolation set');
    assert.deepEqual([...isolated].sort(), [clash!.a.ref, clash!.b.ref].sort(),
      'exactly the clashing pair must be isolated');
  });

  /**
   * The room model's ids are RAW express ids (`idOffset: 0`), and a normally
   * loaded model registers at offset 0 too — so the two id ranges overlap.
   * Resolving a clash ref by searching offset ranges then answers with
   * whichever model the search reaches first; resolving it by the model the
   * ref was gathered FROM (`ClashElementRef.model`) cannot be wrong.
   *
   * This pins the resolver, not a reachability claim: it drives `highlightAll`
   * over a result whose refs name the room model while a registered model
   * covers the same numbers.
   */
  it('a ref resolves to the model it was gathered from, not another model with the same id range', async () => {
    await seedRoom();
    // A normally loaded model: registered (offset 0) AND in the store, its
    // range [0, 100] covering the room model's raw ids.
    const other = await parse(TWO_WALLS);
    useViewerStore.getState().registerModelOffset('A', 100);
    useViewerStore.getState().upsertModel({
      id: 'A',
      name: 'A.ifc',
      ifcDataStore: other,
      geometryResult: geometry([]),
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: Date.now(),
      fileSize: 0,
      idOffset: 0,
      maxExpressId: 100,
      loadState: 'complete',
    });
    assert.deepEqual(useViewerStore.getState().fromGlobalId(1), { modelId: 'A', expressId: 1 },
      'setup sanity: the registry claims the room model\'s ids for the registered model');

    await act(async () => { await api!.run([ALL_RULE]); });
    const clash = useViewerStore.getState().clashResult?.clashes[0];
    assert.ok(clash, 'the overlapping pair must be found');
    assert.equal(clash!.a.model, ROOM_MODEL_ID, 'setup sanity: the pair was gathered from the room model');

    await act(async () => { api!.highlightAll(); });

    assert.equal(useViewerStore.getState().selectedEntity?.modelId, ROOM_MODEL_ID,
      'the highlighted element must belong to the room model that produced the clash');
  });

  it('Highlight all selects every clashing element in the room', async () => {
    await seedRoom();
    await act(async () => { await api!.run([ALL_RULE]); });
    await act(async () => { api!.highlightAll(); });

    const s = useViewerStore.getState();
    assert.ok(s.selectedEntityIds.size > 0,
      'every clashing element must be highlighted — highlightAll returned early on unresolved refs');
    assert.equal(s.selectedEntity?.modelId, ROOM_MODEL_ID,
      'the highlighted refs must resolve to the room model');
  });

  /**
   * The id space a published result was computed on can be REPLACED under the
   * very same model id, and the collab room does it on every peer edit:
   * `collabSlice`'s live `onDocUpdate → reconstruct()` re-derives the model
   * from the CRDT and calls `setIfcDataStore(payload.dataStore)`, which
   * (`dataSlice`) swaps the store under the same key and leaves `idOffset` and
   * `maxExpressId` exactly as the first build left them. Express ids are a
   * sequential counter over composed-node order, so any structural edit
   * renumbers everything after it.
   *
   * Resolving "model id + number" against the NEW store then still succeeds —
   * the numbers are dense and in range — and answers with a DIFFERENT element
   * than the row names. A row reading "Wall A vs Wall B" would isolate and
   * colour Wall C and Wall A. That is strictly worse than the dead row this
   * PR set out to fix: a dead row tells the user nothing happened, a
   * mis-targeted one tells them something false.
   */
  it('a peer edit that renumbers the model must not let a stale row target the wrong element', async () => {
    await seedRoom();
    await act(async () => { await api!.run([ALL_RULE]); });
    const clash = useViewerStore.getState().clashResult?.clashes[0];
    assert.ok(clash, 'the overlapping pair must be found');
    assert.deepEqual([clash!.a.name, clash!.b.name].sort(), ['Wall A', 'Wall B'],
      'setup sanity: the row names the two walls the run examined');

    // The peer edit, verbatim: a re-derived store swapped in under the same id.
    const edited = await parse(THREE_WALLS_C_FIRST);
    await act(async () => { useViewerStore.getState().setIfcDataStore(edited); });

    const s0 = useViewerStore.getState();
    assert.equal(s0.models.get(ROOM_MODEL_ID)?.ifcDataStore, edited,
      'setup sanity: the peer edit replaced the store under the same model id');
    assert.equal(edited.entities.getName(1), 'Wall C',
      'setup sanity: the numbers the stale row carries now name different elements');

    await act(async () => { api!.focusClash(clash!, 'isolate'); });

    const s = useViewerStore.getState();
    assert.equal(s.clashSelectedId, null,
      'a row whose id space was superseded must not focus — it would target the wrong element');
    assert.equal(s.isolatedEntities, null,
      'and must not isolate anything: isolating Wall C for a row reading "Wall A" is a lie');
    assert.match(s.clashError ?? '', /re-run/i,
      'the refusal must be EXPLAINED — a silently inert panel is the defect #2696 named');
  });

  /**
   * `refOf` subtracts the owning model's `idOffset`, and every model in the
   * tests above has `idOffset: 0` — so nothing above can tell the subtraction
   * from a no-op. This pins the subtrahend and the range guard on a model with
   * a NON-ZERO offset.
   *
   * The result is hand-built rather than produced by `run()` so the OUT-OF-RANGE
   * half (global 1099, past model B's `maxExpressId`) can be stated directly —
   * a real run only ever emits ids it owns. The in-range half is covered end to
   * end by `useClash.federated-id-offset.test.tsx`, which resolves a ref the
   * real `run()` built for a model at a real non-zero offset.
   */
  it('a ref from a model with a non-zero idOffset resolves to the LOCAL express id, in range', async () => {
    await seedRoom();
    const store = await parse(TWO_WALLS);
    // A federated second model at offset 100: its global ids are 101 and 102.
    useViewerStore.getState().upsertModel({
      id: 'B',
      name: 'B.ifc',
      ifcDataStore: store,
      geometryResult: geometry([]),
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: Date.now(),
      fileSize: 0,
      idOffset: 100,
      maxExpressId: 2,
      loadState: 'complete',
    });

    const el = (ref: number, name: string) => ({ key: name, ref, model: 'B', tag: 'IfcWall', name });
    const clash = (id: string, a: number, b: number): Clash => ({
      id,
      a: el(a, `#${a}`),
      b: el(b, `#${b}`),
      rule: 'all-clashes',
      status: 'hard' as const,
      distance: -0.5,
      point: [0, 0, 0] as [number, number, number],
      bounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
      severity: 'major' as const,
    });
    // Second pair: an id far above the model's parse-time maximum (offset 100 +
    // local 999). No loaded model owns it, so it must NOT resolve.
    const result: ClashResult = {
      clashes: [clash('c1', 101, 102), clash('c2', 1099, 101)],
      summary: summarizeClashes([]),
      rulesRun: [ALL_RULE],
      settings: { tolerance: 0.001, excludeVoidsAndHosts: true },
    };
    result.summary = summarizeClashes(result.clashes);
    await act(async () => { useViewerStore.getState().setClashResult(result); });

    // `highlightAll` ADDS to the selection; start from empty so the assertion
    // below reads exactly what this result resolved to.
    useViewerStore.getState().clearEntitySelection();
    await act(async () => { api!.highlightAll(); });

    const selected = [...useViewerStore.getState().selectedEntitiesSet].sort();
    assert.deepEqual(selected, ['B:1', 'B:2'],
      'global 101/102 must resolve to LOCAL 1/2 (idOffset subtracted), and 1099 to nothing');
    // The 1099 half is refused because model B, though loaded, does not own the
    // number. That refusal used to be SILENT while the supersede refusal beside
    // it set a message, so the row went dead with nothing on screen — the
    // asymmetry that reads as "the click is broken" (#2697 review).
    assert.equal(useViewerStore.getState().clashError, CLASH_REF_UNRESOLVED_MESSAGE,
      'a ref its own loaded model cannot answer for must be refused OUT LOUD');
  });

  /**
   * The supersede check is deliberately asked PER MODEL, not of the federation
   * as a whole. The publish gate's whole-federation question is right for a
   * write that happens once as a unit; asked of a single ref it would disable
   * rows nothing moved under — unload the second of two files and every row
   * wholly inside the first would stop working.
   *
   * Hand-built so the identity can be bound directly and ONE model's table
   * swapped in isolation: a real two-model run would have to arrange a
   * cross-model overlap first, and what is under test here is the per-model
   * scoping of the gate, not detection.
   */
  it('superseding ONE model refuses only that model\'s refs, not the whole result', async () => {
    await seedRoom();
    const roomStore = useViewerStore.getState().models.get(ROOM_MODEL_ID)!.ifcDataStore!;
    const bStore = await parse(TWO_WALLS);
    useViewerStore.getState().upsertModel({
      id: 'B',
      name: 'B.ifc',
      ifcDataStore: bStore,
      geometryResult: geometry([]),
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: Date.now(),
      fileSize: 0,
      idOffset: 100,
      maxExpressId: 2,
      loadState: 'complete',
    });

    const el = (model: string, ref: number) => ({ key: `${model}#${ref}`, ref, model, tag: 'IfcWall' });
    const result: ClashResult = {
      clashes: [{
        id: 'c1',
        a: el(ROOM_MODEL_ID, 1),
        b: el('B', 101),
        rule: 'all-clashes',
        status: 'hard' as const,
        distance: -0.5,
        point: [0, 0, 0] as [number, number, number],
        bounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
        severity: 'major' as const,
      }],
      summary: summarizeClashes([]),
      rulesRun: [ALL_RULE],
      settings: { tolerance: 0.001, excludeVoidsAndHosts: true },
    };
    result.summary = summarizeClashes(result.clashes);
    // Exactly what a run gathering from both models would have recorded.
    rememberFederationIdentity(result, new Map<string, unknown>([
      [ROOM_MODEL_ID, roomStore.entities],
      ['B', bStore.entities],
    ]));
    await act(async () => { useViewerStore.getState().setClashResult(result); });

    // Only B's id space is replaced. The room model is untouched.
    const bEdited = await parse(THREE_WALLS_C_FIRST);
    await act(async () => { useViewerStore.getState().updateModel('B', { ifcDataStore: bEdited }); });

    useViewerStore.getState().clearEntitySelection();
    await act(async () => { api!.highlightAll(); });

    assert.deepEqual([...useViewerStore.getState().selectedEntitiesSet], [`${ROOM_MODEL_ID}:1`],
      'the untouched model\'s ref must still resolve; only the superseded model\'s ref is refused');
    assert.equal(useViewerStore.getState().clashError, CLASH_SUPERSEDED_MESSAGE,
      'and the refusal of the superseded half must still be explained');

    // Focusing the same half-superseded pair: `focusClash` proceeds on the one
    // side it can still resolve (`refs.length === 0` is its only bail), and
    // paints only that side. Stated explicitly because "half a pair" is the
    // direct consequence of checking per model rather than per result.
    await act(async () => { api!.focusClash(result.clashes[0], 'isolate'); });
    const s = useViewerStore.getState();
    assert.equal(s.clashSelectedId, 'c1', 'the resolvable half must still focus the row');
    assert.deepEqual([...(s.isolatedEntities ?? [])], [1],
      'only the still-valid element is isolated — the superseded one is not guessed at');
  });

  /**
   * A model the identity NAMES and that is no longer loaded is known-gone, not
   * unknown — and must be refused rather than fall through to the registry.
   *
   * `refOf`'s last resort, when `ref.model` is not in `state.models`, is
   * `fromGlobalId` — a range search over the `federationRegistry` singleton.
   * The reasoning that made that safe was that the two paths which drop a model
   * unregister it in the same action, so the registry has forgotten it too and
   * the search answers `null`. That holds only for a model the registry ever
   * HELD. The collab room model is put into the store by `collabSlice`'s
   * `upsertModel({ id: 'room:<id>', idOffset: 0 })` and never goes through
   * `registerModelOffset`, so `removeModel` → `unregisterModel` is a no-op on
   * it and there is nothing to forget — while a normally loaded file's
   * registered range still covers the very same low numbers.
   *
   * Leaving a room (`collabSlice.ts`) is the ordinary way in: `removeModel`
   * runs `endClashScenePresentation(..., 'model-removed')` → `clearClashFocus`,
   * NOT `clearClash`, so the published result survives the room model and every
   * row stays clickable. Clicking one then range-searched into a different
   * file and isolated two of ITS elements, with no error — the same
   * "mis-targeted beats dead" defect as the peer-edit case above, reached
   * through absence instead of replacement.
   */
  it('a row whose model was REMOVED must refuse, not range-search into another file', async () => {
    await seedRoom();
    // A normally loaded local file, registered so the singleton owns its range.
    // Registered first and at offset 0, so its range covers the room model's
    // raw ids 1 and 2 — exactly the collision the fallback search walks into.
    const other = await parse(TWO_WALLS);
    useViewerStore.getState().registerModelOffset('A', 100);
    useViewerStore.getState().upsertModel({
      id: 'A',
      name: 'A.ifc',
      ifcDataStore: other,
      geometryResult: geometry([]),
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: Date.now(),
      fileSize: 0,
      idOffset: 0,
      maxExpressId: 100,
      loadState: 'complete',
    });
    assert.deepEqual(useViewerStore.getState().fromGlobalId(1), { modelId: 'A', expressId: 1 },
      'setup sanity: the registry claims the room model\'s ids for the registered local file');

    await act(async () => { await api!.run([ALL_RULE]); });
    const clash = useViewerStore.getState().clashResult?.clashes[0];
    assert.ok(clash, 'the overlapping pair must be found');
    assert.equal(clash!.a.model, ROOM_MODEL_ID, 'setup sanity: the pair was gathered from the room model');

    // Leaving the room, verbatim: the room model is removed, the result is not.
    await act(async () => { useViewerStore.getState().removeModel(ROOM_MODEL_ID); });
    const afterRemove = useViewerStore.getState();
    assert.equal(afterRemove.models.has(ROOM_MODEL_ID), false, 'setup sanity: the room model is gone');
    assert.ok(afterRemove.clashRawResult, 'setup sanity: removeModel keeps the result — it only ends the focus');

    await act(async () => { api!.focusClash(clash!, 'isolate'); });

    const s = useViewerStore.getState();
    assert.equal(s.clashSelectedId, null,
      'a row naming a model that is GONE must not focus — its numbers belong to nothing loaded');
    assert.equal(s.isolatedEntities, null,
      'and must isolate nothing: isolating another file\'s elements for a room row is a lie');
    assert.equal(s.clashError, CLASH_MODEL_UNLOADED_MESSAGE,
      'the refusal must be explained, not silent — and as UNLOADED, not "replaced": '
      + 'nothing was replaced, and a re-run cannot bring back a model that is not there');
  });

  /**
   * The counter-example to the test above: refusing a NAMED-but-gone model must
   * not spread to a model the identity has no entry for. The run took no
   * elements from such a model, so it holds no ref into it and nothing about
   * its absence can invalidate a number. Unloading an unrelated file must leave
   * every row of the surviving model working.
   */
  it('a model the result never referenced can be unloaded without disabling any row', async () => {
    await seedRoom();
    const unrelated = await parse(TWO_WALLS);
    useViewerStore.getState().upsertModel({
      id: 'unrelated',
      name: 'unrelated.ifc',
      ifcDataStore: unrelated,
      geometryResult: geometry([]),
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: Date.now(),
      fileSize: 0,
      idOffset: 500,
      maxExpressId: 2,
      loadState: 'complete',
    });

    await act(async () => { await api!.run([ALL_RULE]); });
    const clash = useViewerStore.getState().clashResult?.clashes[0];
    assert.ok(clash, 'the overlapping pair must be found');

    await act(async () => { useViewerStore.getState().removeModel('unrelated'); });
    await act(async () => { api!.focusClash(clash!, 'isolate'); });

    const s = useViewerStore.getState();
    assert.equal(s.clashSelectedId, clash!.id,
      'unloading a model the result never referenced must not disable its rows');
    assert.deepEqual([...(s.isolatedEntities ?? [])].sort(), [clash!.a.ref, clash!.b.ref].sort(),
      'the pair must still isolate normally');
    assert.equal(s.clashError, null, 'and nothing must be reported as superseded');
  });

  /**
   * The gate must be asked of `clashRawResult`, the object the publish site
   * bound the identity to — NOT of `clashResult`, which is re-derived.
   *
   * `applyClashExclusions` returns the very same object while nothing is
   * suppressed (`if (suppressed === 0) return { result, ... }`), so with no
   * exclusion rules the two store fields hold ONE object and the distinction is
   * invisible: swapping `clashRawResult` for `clashResult` in `refOf` leaves
   * every other test in this file green. The moment a rule actually suppresses
   * a row, `deriveGroups` publishes `{ ...result, clashes: kept }` — a fresh
   * object the identity WeakMap has never seen. `clashRefModelIsCurrent`
   * answers `true` for an unknown result by design (unknown must never refuse),
   * so reading the derived object would silently disable the gate for exactly
   * the users who excluded something, and their stale rows would go back to
   * isolating the wrong elements.
   *
   * So: exclude one row, supersede the model, and require the OTHER row to
   * still be refused.
   */
  it('the supersede gate survives an exclusion rule re-deriving the result', async () => {
    await seedRoom();
    await act(async () => { await api!.run([ALL_RULE]); });
    const roomStore = useViewerStore.getState().models.get(ROOM_MODEL_ID)!.ifcDataStore!;

    // A second row, so one can be excluded and one left to refuse. Hand-built
    // onto the run's own result object so it keeps the identity `run()` bound.
    const raw = useViewerStore.getState().clashRawResult!;
    const first = raw.clashes[0];
    const spare: Clash = {
      ...first,
      id: 'spare',
      a: { ...first.a, key: 'spare-a', ref: 1 },
      b: { ...first.b, key: 'spare-b', ref: 2 },
    };
    const withSpare: ClashResult = { ...raw, clashes: [...raw.clashes, spare] };
    withSpare.summary = summarizeClashes(withSpare.clashes);
    rememberFederationIdentity(withSpare, new Map<string, unknown>([[ROOM_MODEL_ID, roomStore.entities]]));
    await act(async () => { useViewerStore.getState().setClashResult(withSpare); });

    // Exclude the spare. This is what forces the re-derivation.
    await act(async () => {
      useViewerStore.getState().addClashExclusion(elementPairExclusion(spare.a, spare.b));
    });
    const derived = useViewerStore.getState();
    assert.notEqual(derived.clashResult, derived.clashRawResult,
      'setup sanity: an enabled exclusion must make the published result a DIFFERENT object');
    const survivor = derived.clashResult!.clashes[0];
    assert.equal(survivor.id, first.id, 'setup sanity: the un-excluded row is the one still published');

    // The peer edit that renumbers the id space under the same model id.
    const edited = await parse(THREE_WALLS_C_FIRST);
    await act(async () => { useViewerStore.getState().setIfcDataStore(edited); });

    await act(async () => { api!.focusClash(survivor, 'isolate'); });

    const s = useViewerStore.getState();
    assert.equal(s.clashSelectedId, null,
      'a superseded row must still be refused after an exclusion re-derived the result');
    assert.equal(s.isolatedEntities, null,
      'and must still isolate nothing — the gate was read off the derived object and went blind');
    assert.equal(s.clashError, CLASH_SUPERSEDED_MESSAGE, 'the refusal must still be explained');
  });
});
