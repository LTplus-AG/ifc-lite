/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { saveWorkspacePlacements, restoreWorkspacePlacements, placementFrameKey, placementFrameBaseKey } from './persistence';
import { emptyPlacementState, importPlacements } from './state';
import { makePlacementManifest, resolvePlacementManifest } from './manifest';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
function coordInfo(wasmRtcOffset?: CoordinateInfo['wasmRtcOffset']): CoordinateInfo {
  return { originShift: { x: 0, y: 0, z: 0 }, originalBounds: box, shiftedBounds: box,
    hasLargeCoordinates: false, ...(wasmRtcOffset ? { wasmRtcOffset } : {}) } as CoordinateInfo;
}

/** A non-georeferenced (local-engineering) workspace: `selectAnchorGeoref`
 * finds no usable map georef, so `placementFrameKey` falls to the
 * `local-engineering:*` branch under test. */
function localState(rtcOffset?: CoordinateInfo['wasmRtcOffset']) {
  const model = { ...fixtureModel('a'), sourceContentHash: 'source-a', loadedAt: 1,
    geometryResult: { coordinateInfo: coordInfo(rtcOffset) } as unknown as GeometryResult };
  return { ...useViewerStore.getState(), ...fixtureModels(model), modelPlacement: emptyPlacementState() };
}

/** A REAL parsed `ifcDataStore` with a usable `IfcProjectedCRS`/`IfcMapConversion`,
 * so `placementAnchor`/`selectAnchorGeoref` (`persistence.ts`) picks it as a
 * genuine georeferenced anchor, the same path `commitRealignmentFrame` and an
 * ordinary load both go through. `globalId` must be a distinct 22-char string
 * or the parser's entity index collides between the two fixture models. */
async function georeferencedModel(id: string, globalId: string, loadedAt: number, crsName: string, eastings: number) {
  const source = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('${globalId}',$,'P',$,$,$,$,(#10),#20);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);
#20=IFCUNITASSIGNMENT((#21));
#21=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#30=IFCPROJECTEDCRS('${crsName}',$,$,$,$,$,#21);
#31=IFCMAPCONVERSION(#10,#30,${eastings}.,1200000.,400.,1.,0.);
ENDSEC;
END-ISO-10303-21;
`;
  const ifcDataStore = await new IfcParser().parseColumnar(
    new TextEncoder().encode(source).buffer as ArrayBuffer, { disableWorkerScan: true },
  );
  return { ...fixtureModel(id), loadedAt, ifcDataStore, sourceContentHash: `source-${id}` };
}

describe('placementFrameKey distinguishes an RTC convergence (#4936)', () => {
  it('changes when federation convergence re-anchors the scene, and a saved pivot is not reused unshifted', () => {
    const disk = storage(), before = localState(undefined);
    const keyBefore = placementFrameKey(before);
    assert.equal(keyBefore, 'local-engineering:m:z-up');

    // A rotation pivot saved before the convergence: a workspace POINT, only
    // meaningful in the frame it was captured in.
    before.modelPlacement = importPlacements(before.modelPlacement,
      new Map([['a', { translation: [0, 0, 0], rotation: { angle: 0.5, pivot: [10, 0, 5] }, locked: false }]]));
    saveWorkspacePlacements(disk, before);

    // `convergeFederationRtcFrame` (#4897/#4906) stamps every converged
    // model's `coordinateInfo.wasmRtcOffset` with the shared anchor.
    const after = localState({ x: 1234567.891, y: -987654.321, z: 42.75 });
    const keyAfter = placementFrameKey(after);
    assert.notEqual(keyAfter, keyBefore, 'the frame key must change when the RTC anchor moves under the models');

    // The pivot saved under the old frame is not silently handed back under
    // the new one: nothing is found for the converged frame's key.
    assert.equal(restoreWorkspacePlacements(disk, after).size, 0);
  });

  it('refuses loudly when a manifest saved before a convergence is imported after it', () => {
    const before = localState(undefined);
    before.modelPlacement = importPlacements(before.modelPlacement,
      new Map([['a', { translation: [0, 0, 0], rotation: { angle: 0.25, pivot: [3, 0, -2] }, locked: false }]]));
    const manifest = makePlacementManifest(before.models, before.modelPlacement.placements, placementFrameKey(before));

    const after = localState({ x: 100, y: 200, z: 300 });
    assert.throws(() => resolvePlacementManifest(manifest, after.models, placementFrameKey(after)),
      /coordinate frame differs/);
  });

  it('stays the same across an unrelated re-read of an already-converged frame', () => {
    const offset = { x: 5, y: 6, z: 7 };
    // A concrete expected string, not two live calls compared to each other
    // (CodeRabbit, #4936 round 5 review): that would still pass if
    // `placementFrameKey` returned a constant, or anything else identical on
    // two calls with identical input. Pins down the actual key shape (ONE
    // JSON object wrapping the local-engineering base plus the live `rtc`,
    // never a string suffix, #4936 round 5 review) so a regression that
    // changes it, not just one that makes it nondeterministic, fails too.
    assert.equal(placementFrameKey(localState(offset)), '{"base":"local-engineering:m:z-up","rtc":{"x":5,"y":6,"z":7}}');
  });

  it('is one parseable JSON object once an RTC anchor is live, with the base recoverable from it', () => {
    const offset = { x: 5, y: 6, z: 7 };
    const parsed: unknown = JSON.parse(placementFrameKey(localState(offset)));
    assert.deepEqual(parsed, { base: 'local-engineering:m:z-up', rtc: offset });
  });

  // Codex P1 (#4936 round 5): "a placement committed BEFORE convergence stamps
  // the local-engineering key onto `modelPlacement`, `rebasePlacementFrame`
  // preserves it, and persistence compares against that stored key". There is
  // no such field to stamp (`PlacementState`, state.ts: only the explicit
  // `realignedFrameKey` pin exists), so this locks that in end to end: commit
  // a rotation, converge through the REAL store action, and the live key,
  // the manifest written next and the old manifest's acceptance all advance.
  it('a rotation committed before convergence does not pin the key: converging advances key and manifest', () => {
    useViewerStore.setState({ ...localState(undefined), repositionOpen: false });
    useViewerStore.getState().setModelRotation(['a'], { angle: 0.25, pivot: [3, 0, -2] });
    const before = useViewerStore.getState();
    const keyBefore = placementFrameKey(before);
    assert.equal(keyBefore, 'local-engineering:m:z-up');
    const disk = storage();
    saveWorkspacePlacements(disk, before);
    assert.ok(savedUnder(disk, keyBefore), 'sanity: the pre-convergence commit was saved under the bare base key');

    const anchor = { x: 100, y: 200, z: 300 };
    useViewerStore.setState((s) => {
      const model = s.models.get('a')!;
      const models = new Map(s.models);
      models.set('a', { ...model, geometryResult: { coordinateInfo: coordInfo(anchor) } as unknown as GeometryResult });
      return { models };
    });
    useViewerStore.getState().rebasePlacementFrame(new Map([['a', { x: 1, y: 2, z: 3 }]]));
    const after = useViewerStore.getState();
    assert.equal(after.modelPlacement.realignedFrameKey, null, 'neither the commit nor the rebase may pin a frame');
    const keyAfter = placementFrameKey(after);
    assert.equal(keyAfter, '{"base":"local-engineering:m:z-up","rtc":{"x":100,"y":200,"z":300}}');
    saveWorkspacePlacements(disk, after);
    assert.ok(savedUnder(disk, keyAfter), 'the next save must write under the converged key, not the pre-convergence one');
    assert.throws(() => resolvePlacementManifest(
      makePlacementManifest(before.models, before.modelPlacement.placements, keyBefore), after.models, keyAfter),
      /coordinate frame differs/, 'the pre-convergence manifest is no longer accepted once converged');
  });
});

/**
 * #4936 went through three rounds before landing on this design:
 *   1. `placementFrameKey` ignored the live RTC anchor for a non-georeferenced
 *      workspace entirely (a fixed `local-engineering:m:z-up` constant).
 *   2. Folding the RTC anchor in fixed that, but `applyModelTranslation` and
 *      `setModelRotation` (`modelPlacementSlice.ts`) each cached the computed
 *      result into `modelPlacement.frameKey`, so a LATER convergence
 *      (`convergeFederationRtcFrame`, #4897/#4906) rebased the live pivots
 *      correctly but the cached key never moved.
 *   3. A third site, `useModelPlacementPersistence.ts`'s restore effect, had
 *      the same bug, and a fourth variant surfaced even after all three
 *      call sites agreed: removing the model the cached key was keyed to
 *      (e.g. the earliest-loaded anchor) left the STALE key being served,
 *      because nothing about `modelPlacement.frameKey` was tied to which
 *      models were actually still loaded.
 *
 * The fix removes the cache entirely: `placementFrameKey`/`placementFrameBaseKey`
 * (`persistence.ts`) always recompute from live `state.models` on every call,
 * except for `modelPlacement.realignedFrameKey`, which is not a cache at all
 * but a genuine decision `commitRealignmentFrame` records once and nothing
 * else ever writes. These drive the REAL store actions (`openReposition` /
 * `applyModelTranslation` / `rebasePlacementFrame` / `updateModel`), not the
 * pure `state.ts` helpers, since the bug lived in the store wiring around
 * them, not in `state.ts` itself. */
describe('placementFrameKey recomputes live and is never cached across a commit (#4936 review)', () => {
  /** Loads a fresh single-model workspace, commits a translation, then
   * converges: the model's own `CoordinateInfo` picks up `wasmRtcOffset`
   * (what `convergeGeometryOntoRtcAnchor` writes) and `rebasePlacementFrame`
   * runs (what `federationRtcRebase.ts` calls after it), exactly the order
   * production runs them in. Returns the live `placementFrameKey` read
   * afterward, plus the store `disk` the placement was saved to. */
  function committedThenConverged(anchor: CoordinateInfo['wasmRtcOffset']) {
    useViewerStore.setState(localState(undefined));
    const store = useViewerStore.getState();
    store.openReposition(['a']);
    store.previewModelTranslation([3, 0, 0]);
    store.applyModelTranslation();
    assert.equal(useViewerStore.getState().modelPlacement.realignedFrameKey, null,
      'sanity: a plain commit never writes a pin');

    useViewerStore.setState((s) => {
      const model = s.models.get('a')!;
      const models = new Map(s.models);
      models.set('a', { ...model, geometryResult: { ...model.geometryResult, coordinateInfo: coordInfo(anchor) } as unknown as GeometryResult });
      return { models };
    });
    useViewerStore.getState().rebasePlacementFrame(new Map([['a', { x: 1, y: 2, z: 3 }]]));

    const disk = storage();
    saveWorkspacePlacements(disk, useViewerStore.getState());
    return { disk, key: placementFrameKey(useViewerStore.getState()) };
  }

  it('a placement committed before a convergence still round-trips through save/restore afterward', () => {
    const anchor = { x: 1234567.891, y: -987654.321, z: 42.75 };
    const { disk } = committedThenConverged(anchor);

    // A fresh session (no pin) reloading the same, already-converged
    // workspace: `placementFrameKey` recomputes live from the reloaded
    // model's own (already-anchored) `coordinateInfo`, matching what was
    // actually saved.
    const restored = restoreWorkspacePlacements(disk, localState(anchor)).get('a');
    assert.deepEqual(restored?.translation, [3, 0, 0],
      'the pre-convergence commit must not be dropped by a stale save key');
  });

  it('does not fall back to restoring under the pre-convergence key either', () => {
    const anchor = { x: 1234567.891, y: -987654.321, z: 42.75 };
    const { disk } = committedThenConverged(anchor);
    assert.equal(savedUnder(disk, 'local-engineering:m:z-up'), null,
      'nothing was ever saved under the stale pre-convergence key');
  });

  it('two sessions that each commit before converging match only when they reach the same live anchor', () => {
    const anchorA = { x: 10, y: 20, z: 30 }, anchorB = { x: 40, y: 50, z: 60 };
    assert.equal(committedThenConverged(anchorA).key, committedThenConverged(anchorA).key,
      'same live anchor after independent pre-convergence commits must match');
    assert.notEqual(committedThenConverged(anchorA).key, committedThenConverged(anchorB).key,
      'different live anchors after independent pre-convergence commits must not match');
  });

  it('a SECOND commit, made after a convergence has already happened, still recomputes live', () => {
    const anchorA = { x: 10, y: 20, z: 30 }, anchorB = { x: 40, y: 50, z: 60 };
    committedThenConverged(anchorA);
    // A second commit while the workspace is already converged onto anchor A.
    const store = useViewerStore.getState();
    store.openReposition(['a']);
    store.previewModelTranslation([0, 5, 0]);
    store.applyModelTranslation();

    // The federation converges again, this time onto a DIFFERENT anchor.
    useViewerStore.setState((s) => {
      const model = s.models.get('a')!;
      const models = new Map(s.models);
      models.set('a', { ...model, geometryResult: { ...model.geometryResult, coordinateInfo: coordInfo(anchorB) } as unknown as GeometryResult });
      return { models };
    });
    useViewerStore.getState().rebasePlacementFrame(new Map([['a', { x: 4, y: 5, z: 6 }]]));

    assert.equal(useViewerStore.getState().models.get('a')?.geometryResult?.coordinateInfo.wasmRtcOffset, anchorB,
      'sanity: the live anchor is now B, not A');
    assert.equal(placementFrameKey(useViewerStore.getState()), placementFrameKey(localState(anchorB)),
      'a commit made between two convergences must not freeze the FIRST anchor past the SECOND');
  });

  /** The scenario a second review round found the first architecture missed:
   * committing does not just risk freezing a stale RTC suffix, the model the
   * base identity itself was reading `CoordinateInfo` FROM can leave the
   * federation entirely. `placementFrameCoordinateInfo` (`persistence.ts`)
   * falls back to "the earliest-loaded model with a `geometryResult`" when
   * there is no georeferenced anchor, so removing that model must hand the
   * live key over to whichever model is left, not keep answering with the
   * removed model's frame. */
  it('removing the model the live key was reading from hands the key over to what remains', () => {
    const anchorA = { x: 111, y: 222, z: 333 }, anchorB = { x: 444, y: 555, z: 666 };
    const modelA = { ...fixtureModel('a'), sourceContentHash: 'source-a', loadedAt: 1,
      geometryResult: { coordinateInfo: coordInfo(anchorA) } as unknown as GeometryResult };
    const modelB = { ...fixtureModel('b'), sourceContentHash: 'source-b', loadedAt: 2,
      geometryResult: { coordinateInfo: coordInfo(anchorB) } as unknown as GeometryResult };
    useViewerStore.setState({ ...useViewerStore.getState(), ...fixtureModels(modelA, modelB), modelPlacement: emptyPlacementState() });

    // A commits, exactly as the reported scenario describes.
    const store = useViewerStore.getState();
    store.openReposition(['a']);
    store.previewModelTranslation([3, 0, 0]);
    store.applyModelTranslation();

    const keyWithA = placementFrameKey(useViewerStore.getState());
    assert.match(keyWithA, /"x":111/, 'sanity: the earliest-loaded model (A) drives the live key');

    // A leaves the federation (e.g. the 'model-removed' teardown's
    // `retainLoadedPlacements`, which never touches `realignedFrameKey`).
    useViewerStore.setState((s) => {
      const models = new Map(s.models);
      models.delete('a');
      return { models };
    });

    const keyAfterRemoval = placementFrameKey(useViewerStore.getState());
    assert.notEqual(keyAfterRemoval, keyWithA,
      'the live key must reflect B once A, the model it was keyed to, is gone');
    assert.match(keyAfterRemoval, /"x":444/, 'the live key now reads B\'s own frame, not a stale one');
  });

  /** The literal scenario reported: a GEOREFERENCED anchor, selected by
   * `placementAnchor`/`selectAnchorGeoref` from each model's OWN embedded
   * CRS (`IfcProjectedCRS`/`IfcMapConversion`), not the RTC/local-engineering
   * fallback above. Two real parsed models on two different CRS, so this
   * exercises the exact code path `placementFrameBaseKey` (persistence.ts)
   * uses for a genuinely georeferenced workspace. */
  it('removing the georeferenced anchor model hands the key over to the remaining CRS, not a stale one', async () => {
    const a = await georeferencedModel('a', 'AnchorA0000000000000001', 1, 'EPSG:2056', 2600000);
    const b = await georeferencedModel('b', 'AnchorB0000000000000001', 2, 'EPSG:4326', 500000);
    useViewerStore.setState({ ...useViewerStore.getState(), ...fixtureModels(a, b), modelPlacement: emptyPlacementState() });

    // A commits, exactly as the reported scenario describes.
    const store = useViewerStore.getState();
    store.openReposition(['a']);
    store.previewModelTranslation([3, 0, 0]);
    store.applyModelTranslation();
    assert.equal(useViewerStore.getState().modelPlacement.realignedFrameKey, null,
      'sanity: an ordinary commit never writes a pin, so there is nothing frozen to A here');

    const keyWithA = placementFrameKey(useViewerStore.getState());
    assert.match(keyWithA, /EPSG:2056/, 'sanity: the earliest-loaded model (A) drives the live key');

    // A leaves the federation.
    useViewerStore.setState((s) => {
      const models = new Map(s.models);
      models.delete('a');
      return { models };
    });

    const keyAfterRemoval = placementFrameKey(useViewerStore.getState());
    assert.notEqual(keyAfterRemoval, keyWithA,
      'the live key must reflect B\'s CRS once A, the model it was keyed to, is gone');
    assert.match(keyAfterRemoval, /EPSG:4326/, 'the live key now reads B\'s own CRS, not a stale one');
  });
});

function savedUnder(disk: ReturnType<typeof storage>, frame: string): string | null {
  return disk.getItem('ifc-lite:placements:v1:' + frame);
}

/** The serialized v1.47 georeferenced key, kept explicit so this migration
 * test proves compatibility with data that was actually shipped, rather than
 * deriving an old shape from the new spatial-reference identity. */
function v147GeoreferencedFrameKey(eastings: number, rtc: { x: number; y: number; z: number }, rotation: number): string {
  return JSON.stringify({
    crs: { name: 'EPSG:2056', mapUnitScale: 1 },
    conversion: { eastings, northings: 1200000, orthogonalHeight: 400,
      xAxisAbscissa: 1, xAxisOrdinate: 0, scale: undefined,
      factorX: undefined, factorY: undefined, factorZ: undefined },
    lengthUnitScale: 1, originShift: { x: 0, y: 0, z: 0 }, rtc, rotation,
  });
}

/** v1.47.0, the release before this fix, embedded the live RTC anchor in the
 * georeferenced base's `rtc` field BETWEEN `originShift` and `rotation`,
 * where `placementFrameKey` now folds it in as a trailing field
 * (`legacyGeoreferencedFrameKey`, persistence.ts). Reconstructs that exact
 * shape from `placementFrameBaseKey` (the current, rtc-free base, already
 * exported) rather than duplicating `legacyGeoreferencedFrameKey`'s own
 * logic, so this checks the real migration path end to end instead of two
 * copies of the same formula agreeing with each other. */
describe('restoreWorkspacePlacements falls back to the pre-#4936 (v1.47.0) legacy key (#4936 round 5 review)', () => {
  it('finds a georeferenced placement saved before this fix under the old embedded-rtc key', async () => {
    const a = await georeferencedModel('a', 'LegacyA0000000000000001', 1, 'EPSG:2056', 2600000);
    useViewerStore.setState({ ...useViewerStore.getState(), ...fixtureModels(a), modelPlacement: emptyPlacementState() });

    // Converge onto a live RTC anchor, same as production after federation settles.
    const anchor = { x: 111, y: 222, z: 333 };
    useViewerStore.setState((s) => {
      const model = s.models.get('a')!;
      const models = new Map(s.models);
      // A building rotation makes the two shapes actually differ: without one,
      // `rotation` is omitted from both JSON strings and the v1.47.0 key is
      // byte-identical to the current one (no fallback needed at all).
      models.set('a', { ...model, geometryResult: { ...model.geometryResult,
        coordinateInfo: { ...coordInfo(anchor), buildingRotation: 0.5 } } as unknown as GeometryResult });
      return { models };
    });

    const state = useViewerStore.getState();
    const legacyKey = v147GeoreferencedFrameKey(2600000, anchor, 0.5);
    assert.notEqual(legacyKey, placementFrameKey(state), 'sanity: the legacy shape differs from the current key');

    const legacyManifest = makePlacementManifest(state.models,
      new Map([['a', { translation: [7, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false }]]), legacyKey);
    const disk = storage();
    disk.setItem('ifc-lite:placements:v1:' + legacyKey, JSON.stringify(legacyManifest));

    const restored = restoreWorkspacePlacements(disk, state).get('a');
    assert.deepEqual(restored?.translation, [7, 0, 0], 'a real placement saved under the v1.47.0 key must still be found');
  });

  it('does not fall back once the workspace is pinned by an explicit re-alignment (#4936 round 6 review)', async () => {
    const a = await georeferencedModel('a', 'LegacyA0000000000000002', 1, 'EPSG:2056', 2600000);
    useViewerStore.setState({ ...useViewerStore.getState(), ...fixtureModels(a), modelPlacement: emptyPlacementState() });
    const anchor = { x: 111, y: 222, z: 333 };
    useViewerStore.setState((s) => {
      const model = s.models.get('a')!;
      const models = new Map(s.models);
      models.set('a', { ...model, geometryResult: { ...model.geometryResult,
        coordinateInfo: { ...coordInfo(anchor), buildingRotation: 0.5 } } as unknown as GeometryResult });
      return { models };
    });
    const unpinned = useViewerStore.getState();
    const legacyKey = v147GeoreferencedFrameKey(2600000, anchor, 0.5);
    const disk = storage();
    disk.setItem('ifc-lite:placements:v1:' + legacyKey, JSON.stringify(makePlacementManifest(unpinned.models,
      new Map([['a', { translation: [7, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false }]]), legacyKey)));
    assert.equal(restoreWorkspacePlacements(disk, unpinned).size, 1, 'sanity: unpinned, the legacy fallback still applies');

    // The user then re-aligned the workspace onto another CRS
    // (`commitRealignmentFrame` writes this pin). The legacy key is still
    // derivable from the model's own georef, but its manifest describes the
    // frame the workspace was re-aligned AWAY from.
    const pinned = { ...unpinned, modelPlacement: { ...unpinned.modelPlacement,
      realignedFrameKey: JSON.stringify({ explicitTarget: 'EPSG:3857' }) } };
    assert.notEqual(placementFrameKey(pinned), placementFrameKey(unpinned), 'sanity: the pin changes the current key');
    assert.equal(restoreWorkspacePlacements(disk, pinned).size, 0,
      'a pre-fix manifest for the un-pinned georef must not be applied inside the re-aligned frame');
  });

  it('does not fall back for a non-georeferenced (local-engineering) workspace, since that key never disambiguated by rtc', () => {
    const anchor = { x: 1, y: 2, z: 3 };
    const disk = storage();
    // The v1.47.0 local-engineering key never included rtc at all: a bare
    // constant, exactly the collision #4936 reports. Falling back to it
    // would hand this saved placement to ANY live anchor, wrong data
    // silently applied under a different RTC convergence.
    disk.setItem('ifc-lite:placements:v1:local-engineering:m:z-up',
      JSON.stringify(makePlacementManifest(localState(anchor).models,
        new Map([['a', { translation: [9, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false }]]), 'local-engineering:m:z-up')));
    assert.equal(restoreWorkspacePlacements(disk, localState(anchor)).size, 0,
      'no fallback for the ambiguous local-engineering key: it cannot tell which live anchor the saved data was really for');
  });
});
