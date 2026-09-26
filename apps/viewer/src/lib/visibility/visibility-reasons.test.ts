/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5869: one table of the mechanisms that keep geometry off screen drives
 * every user-facing reset (Home, Show all, the "A" key, the context menu).
 *
 * For every row, at 1 and 3 federated models: activate that mechanism alone,
 * see the table report it, run Home, and see it gone unless its row says the
 * reset deliberately keeps it. On main, Home left a hidden federated model
 * hidden, and nothing could say why.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore, type ViewerState } from '@/store';
import { resetVisibilityForHomeFromStore } from '@/store/homeView';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import type { VisibilitySlice } from '@/store/slices/visibilitySlice';
import type { LensSlice } from '@/store/slices/lensSlice';
import type { LevelDisplaySlice } from '@/store/slices/levelDisplaySlice';
import { planLensHiddenSync } from '@/components/viewer/lens-visibility-ownership';
import {
  VISIBILITY_REASONS,
  activeVisibilityReasons,
  type VisibilityReasonId,
} from './visibility-reasons';

const OFFSET = 1000;

/** Adding state to a visibility-bearing slice requires classifying it here. */
type StateKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? never : K;
}[keyof T];

const VISIBILITY_FIELDS = {
  hiddenEntities: ['hidden'],
  isolatedEntities: ['isolation'],
  ghostExceptEntities: ['ghost'],
  visibilityRevision: [], // Invalidation counter, not a hiding mechanism.
  classFilter: ['classFilter'],
  typeVisibility: ['typeVisibility'],
  hostHiddenIfcTypes: ['hostTypes'],
  typeViewMode: ['typeViewMode'],
  hasTypeGeometry: [], // Capability flag for the type view mode.
} satisfies Record<StateKeys<VisibilitySlice>, readonly VisibilityReasonId[]>;

const LENS_FIELDS = {
  savedLenses: [],
  activeLensId: ['lens'],
  lensPanelVisible: [],
  lensColorMap: [],
  lensAppliedColors: [],
  lensHiddenIds: ['lens'],
  lensAppliedHiddenIds: ['lens'],
  lensRuleIsolation: ['isolation'],
  lensRuleCounts: [],
  lensRuleEntityIds: [],
  lensAutoColorLegend: [],
  discoveredLensData: [],
} satisfies Record<StateKeys<LensSlice>, readonly VisibilityReasonId[]>;

const LEVEL_DISPLAY_FIELDS = {
  levelDisplayMode: ['storey', 'exploded'],
  explodedGap: [], // Only changes spacing while Exploded is already active.
  appliedStoreyOffsets: [], // Renderer bookkeeping, not a separate hide.
} satisfies Record<StateKeys<LevelDisplaySlice>, readonly VisibilityReasonId[]>;

it('enumerates the visibility-bearing store fields and gives each mechanism a row (#5869)', () => {
  const reasons = new Set([
    ...Object.values(VISIBILITY_FIELDS).flat(),
    ...Object.values(LENS_FIELDS).flat(),
    ...Object.values(LEVEL_DISPLAY_FIELDS).flat(),
    'storey', // selectionSlice.selectedStoreys
    'modelHidden', // modelSlice.models[].visible
    'isolation', // pinboardSlice.activeBasketViewId and ownership records
    'section', // sectionSlice.sectionPlane.enabled + sceneStateSlice.sceneState.section.visible (#5893)
    'measurements', // measurementSlice.measurements/polylineMeasurements + sceneState.measurements.visible (#5893)
  ]);
  assert.deepEqual(reasons, new Set(VISIBILITY_REASONS.map((reason) => reason.id)));
});

/** One way to switch each mechanism on, in global ids of the LAST model. */
const ACTIVATE: Record<VisibilityReasonId, (lastModelOffset: number) => Partial<ViewerState>> = {
  hidden: (o) => ({ hiddenEntities: new Set([o + 1]) }),
  isolation: (o) => ({ isolatedEntities: new Set([o + 2]) }),
  ghost: (o) => ({ ghostExceptEntities: new Set([o + 3]) }),
  classFilter: (o) => ({ classFilter: { ids: new Set([o + 4]), label: 'IfcWall' } }),
  storey: (o) => ({ selectedStoreys: new Set([o + 5]) }),
  exploded: () => ({ levelDisplayMode: 'exploded' }),
  modelHidden: () => {
    const models = new Map(useViewerStore.getState().models);
    const [lastId, last] = [...models].at(-1)!;
    models.set(lastId, { ...last, visible: false });
    return { models };
  },
  // A lens-owned hide joins whatever the user already hid, as the host's sync does.
  lens: (o) => ({
    activeLensId: 'lens', lensHiddenIds: new Set([o + 6]), lensAppliedHiddenIds: [o + 6],
    hiddenEntities: new Set([...useViewerStore.getState().hiddenEntities, o + 6]),
  }),
  typeVisibility: () => ({ typeVisibility: { ...useViewerStore.getState().typeVisibility, site: false } }),
  typeViewMode: () => ({ typeViewMode: 'types', hasTypeGeometry: true }),
  hostTypes: () => ({ hostHiddenIfcTypes: new Set(['IFCSPACE']) }),
  // Lasting scene state (#5893): the cut/measurements and the visibility
  // toggle are independent, so activating the reason means both are on.
  section: () => ({
    sectionPlane: { ...useViewerStore.getState().sectionPlane, enabled: true },
    sceneState: { ...useViewerStore.getState().sceneState, section: { visible: true } },
  }),
  measurements: (o) => ({
    measurements: [{ id: 'm', start: { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 }, end: { x: o, y: 0, z: 0, screenX: o, screenY: 0 }, distance: o }],
    sceneState: { ...useViewerStore.getState().sceneState, measurements: { visible: true } },
  }),
};

let initial: ViewerState;
const ids = (state: ViewerState): VisibilityReasonId[] => activeVisibilityReasons(state).map((r) => r.id);

beforeEach(() => {
  initial = useViewerStore.getState();
});

afterEach(() => {
  useViewerStore.setState(initial, true);
});

function seedModels(count: number): number {
  const models = Array.from({ length: count }, (_, i) => fixtureModel(`m${i}`, { idOffset: i * OFFSET }));
  useViewerStore.setState({
    ...fixtureModels(...models),
    hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null, classFilter: null,
    selectedStoreys: new Set(), activeLensId: null, lensHiddenIds: new Set(), lensAppliedHiddenIds: [],
    typeVisibility: { spaces: false, spatialZones: false, openings: false, virtualElements: false, site: true, ifcAnnotations: true, ifcGrid: true },
    typeViewMode: 'model', hasTypeGeometry: false, hostHiddenIfcTypes: null,
    levelDisplayMode: 'stacked',
  });
  return (count - 1) * OFFSET;
}

for (const modelCount of [1, 3]) {
  describe(`visibility reasons at ${modelCount} model(s) (#5869)`, () => {
    it('Home preserves a manual hide overlapping the lens without giving the lens ownership', () => {
      const offset = seedModels(modelCount);
      const manualOverlap = offset + 10;
      const manualOnly = offset + 11;
      const lensOwned = offset + 12;
      useViewerStore.setState({
        hiddenEntities: new Set([manualOverlap, manualOnly, lensOwned]),
        activeLensId: 'lens',
        lensHiddenIds: new Set([manualOverlap, lensOwned]),
        lensAppliedHiddenIds: [lensOwned],
      });

      resetVisibilityForHomeFromStore('home');
      const afterHome = useViewerStore.getState();
      assert.deepEqual(afterHome.hiddenEntities, new Set([manualOverlap, lensOwned]));
      assert.deepEqual(afterHome.lensAppliedHiddenIds, [lensOwned]);
      assert.deepEqual(ids(afterHome), ['lens'], 'Home clears manual-only hides');

      const teardown = planLensHiddenSync({
        applied: afterHome.lensAppliedHiddenIds,
        hiddenEntities: afterHome.hiddenEntities,
        lensHiddenIds: new Set(),
      });
      assert.deepEqual(teardown.show, [lensOwned]);
      assert.deepEqual(new Set([...afterHome.hiddenEntities].filter((id) => !teardown.show.includes(id))),
        new Set([manualOverlap]), 'deactivating the lens must leave the manual hide in place');
    });

    it('Home owns a new lens match even when no manual hidden reason is active (#5869)', () => {
      const offset = seedModels(modelCount);
      const newMatch = offset + 10;
      useViewerStore.setState({
        activeLensId: 'lens',
        lensHiddenIds: new Set([newMatch]),
        hiddenEntities: new Set(),
        lensAppliedHiddenIds: [],
      });

      resetVisibilityForHomeFromStore('home');
      const afterHome = useViewerStore.getState();
      assert.deepEqual(afterHome.hiddenEntities, new Set([newMatch]));
      assert.deepEqual(afterHome.lensAppliedHiddenIds, [newMatch]);
    });

    it('a fresh federation has no active reason', () => {
      seedModels(modelCount);
      assert.deepEqual(ids(useViewerStore.getState()), []);
    });

    it('Show All resets Solo mode together with its storey isolation (#5869)', () => {
      const offset = seedModels(modelCount);
      useViewerStore.setState({ levelDisplayMode: 'solo', selectedStoreys: new Set([offset + 5]) });
      assert.deepEqual(ids(useViewerStore.getState()), ['storey']);
      useViewerStore.getState().showAllInAllModels();
      assert.equal(useViewerStore.getState().levelDisplayMode, 'stacked');
      assert.deepEqual(useViewerStore.getState().selectedStoreys, new Set());
    });

    for (const reason of VISIBILITY_REASONS) {
      it(`${reason.id}: reported while active; Home ${reason.resetPolicy === 'cleared' ? 'clears it' : 'keeps it'}`, () => {
        const lastOffset = seedModels(modelCount);
        useViewerStore.setState(ACTIVATE[reason.id](lastOffset));
        assert.deepEqual(ids(useViewerStore.getState()), [reason.id],
          `activating ${reason.id} alone must report exactly that reason`);

        resetVisibilityForHomeFromStore('home');
        const after = ids(useViewerStore.getState());
        if (reason.resetPolicy === 'cleared') {
          assert.deepEqual(after, [], `Home must clear ${reason.id}`);
        } else {
          assert.deepEqual(after, [reason.id], `Home keeps ${reason.id}, and the table must still name it`);
        }
      });

      for (const action of ['showAll', 'showAllInAllModels'] as const) {
        it(`${action} applies the table policy to ${reason.id}`, () => {
          const lastOffset = seedModels(modelCount);
          useViewerStore.setState(ACTIVATE[reason.id](lastOffset));
          assert.deepEqual(ids(useViewerStore.getState()), [reason.id]);

          useViewerStore.getState()[action]();
          assert.deepEqual(ids(useViewerStore.getState()), reason.resetPolicy === 'kept' ? [reason.id] : []);
        });
      }

      it(`${reason.id}: its own clear turns off only that mechanism`, () => {
        const lastOffset = seedModels(modelCount);
        // Everything on at once, then clear just this one.
        for (const activate of Object.values(ACTIVATE)) useViewerStore.setState(activate(lastOffset));
        // Ghost and isolation are mutually exclusive setters in the slice, but
        // the raw state can hold both; the table must still clear one alone.
        const before = new Set(ids(useViewerStore.getState()));
        assert.ok(before.has(reason.id), `precondition: ${reason.id} is active alongside the others`);
        reason.clear(useViewerStore);
        const after = new Set(ids(useViewerStore.getState()));
        assert.equal(after.has(reason.id), reason.id === 'hostTypes',
          `${reason.id}'s clear must turn it off (host types are host config and have no clear)`);
        for (const other of before) {
          if (other !== reason.id) assert.ok(after.has(other), `clearing ${reason.id} must not clear ${other}`);
        }
      });
    }
  });
}

describe('Home with a hidden federated model (#5869)', () => {
  it('shows the model again', () => {
    seedModels(3);
    useViewerStore.getState().setModelsVisibility(['m1'], false);
    resetVisibilityForHomeFromStore('home');
    assert.deepEqual([...useViewerStore.getState().models.values()].map((m) => m.visible), [true, true, true]);
  });
});
