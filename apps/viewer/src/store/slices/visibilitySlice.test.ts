/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createStore } from 'zustand/vanilla';
import { createVisibilitySlice, type VisibilitySlice } from './visibilitySlice.js';
import { getPersistedTypeVisibility } from '../constants.js';
import { useViewerStore, type ViewerState } from '../index.js';

describe('VisibilitySlice', () => {
  let state: VisibilitySlice;

  beforeEach(() => {
    // Give the slice its real cross-slice reset surface while keeping every
    // assertion in this file isolated from the module-level viewer store.
    const testStore = createStore<ViewerState>()((set, get, api) => ({
      ...useViewerStore.getState(),
      models: new Map(), selectedStoreys: new Set(), levelDisplayMode: 'stacked',
      activeLensId: null, lensHiddenIds: new Set(), lensAppliedHiddenIds: [],
      ...createVisibilitySlice(set, get, api),
    }));
    state = testStore.getState();
    testStore.subscribe((next) => { state = next; });
  });

  describe('initial state', () => {
    it('should initialise type visibility from persisted preferences', () => {
      const persisted = getPersistedTypeVisibility();
      assert.strictEqual(state.typeVisibility.spaces, persisted.spaces);
      assert.strictEqual(state.typeVisibility.openings, persisted.openings);
      assert.strictEqual(state.typeVisibility.site, persisted.site);
      assert.strictEqual(state.typeVisibility.ifcAnnotations, persisted.ifcAnnotations);
      assert.strictEqual(state.typeVisibility.ifcGrid, persisted.ifcGrid);
    });
  });

  describe('showAllInAllModels', () => {
    it('should clear all visibility state', () => {
      // Set up some state
      state.hideEntities([100, 200, 300, 400]);
      state.isolateEntity(500);

      state.showAllInAllModels();

      assert.strictEqual(state.hiddenEntities.size, 0);
      assert.strictEqual(state.isolatedEntities, null);
    });
  });

  describe('legacy visibility: showEntity', () => {
    it('should show hidden entity', () => {
      state.hideEntity(123);
      state.showEntity(123);
      assert.ok(!state.hiddenEntities.has(123));
    });
  });

  describe('legacy visibility: toggleEntityVisibility', () => {
    it('should toggle visibility', () => {
      state.toggleEntityVisibility(123);
      assert.ok(state.hiddenEntities.has(123));

      state.toggleEntityVisibility(123);
      assert.ok(!state.hiddenEntities.has(123));
    });
  });

  describe('legacy visibility: isolateEntity', () => {
    it('should isolate single entity', () => {
      state.isolateEntity(123);
      assert.ok(state.isolatedEntities?.has(123));
      assert.strictEqual(state.isolatedEntities?.size, 1);
    });

    it('should toggle isolation off when re-isolating same entity', () => {
      state.isolateEntity(123);
      state.isolateEntity(123);
      assert.strictEqual(state.isolatedEntities, null);
    });
  });

  describe('legacy visibility: clearIsolation', () => {
    it('should clear isolation', () => {
      state.isolateEntity(123);
      state.clearIsolation();
      assert.strictEqual(state.isolatedEntities, null);
    });
  });

  describe('legacy visibility: showAll', () => {
    it('should clear all visibility state', () => {
      state.hideEntity(123);
      state.isolateEntity(456);

      state.showAll();

      assert.strictEqual(state.hiddenEntities.size, 0);
      assert.strictEqual(state.isolatedEntities, null);
    });
  });

  describe('legacy visibility: isolateEntities (multi-entity isolate)', () => {
    it('isolates exactly the requested ids and unhides them', () => {
      state.hideEntities([100, 300]);
      state.isolateEntities([100, 200]);

      assert.deepStrictEqual([...state.isolatedEntities!].sort((a, b) => a - b), [100, 200]);
      // The isolated ids must be unhidden — otherwise "isolate" produces an
      // empty viewport (isolated AND hidden = nothing on screen).
      assert.ok(!state.hiddenEntities.has(100));
      // Ids outside the isolation keep their hidden flag.
      assert.ok(state.hiddenEntities.has(300));
    });

    it('toggles isolation off only when the SAME exact set is re-isolated', () => {
      state.isolateEntities([100, 200]);
      state.isolateEntities([100, 200]);
      assert.strictEqual(state.isolatedEntities, null);
    });

    it('does NOT toggle off on a same-size set that merely overlaps', () => {
      // The membership check is `ids.every(...)`, not `ids.some(...)`.
      // With `some`, isolating {100,200} then {100,999} would CLEAR the
      // isolation instead of switching to the new pair — the user clicks a
      // different pair of elements and the whole model reappears.
      state.isolateEntities([100, 200]);
      state.isolateEntities([100, 999]);

      assert.notStrictEqual(state.isolatedEntities, null);
      assert.deepStrictEqual([...state.isolatedEntities!].sort((a, b) => a - b), [100, 999]);
    });

    it('does not toggle off when the new set is a different size', () => {
      state.isolateEntities([100, 200]);
      state.isolateEntities([100]);
      assert.deepStrictEqual([...state.isolatedEntities!], [100]);
    });
  });

  describe('visibility resets: showAll / clearAllFilters', () => {
    /** Put every independent "something is hidden or dimmed" channel into a non-default state. */
    function armAllFilters() {
      state.hideEntity(123);
      state.isolateEntity(456);
      state.setClassFilter([1, 2, 3], 'IfcWall');
      state.setGhostExceptEntities(new Set([7, 8]));
      // setGhostExceptEntities clears isolation by design — re-arm it so
      // the reset assertions below cover all four channels at once.
      state.isolateEntities([456]);
    }

    it('showAll clears hidden, isolation, the class filter AND X-Ray ghosting', () => {
      armAllFilters();
      state.showAll();

      assert.strictEqual(state.hiddenEntities.size, 0);
      assert.strictEqual(state.isolatedEntities, null);
      // A surviving classFilter keeps every non-matching element hidden
      // after the user pressed "Show all" — geometry stays missing with no
      // remaining UI affordance that explains why.
      assert.strictEqual(state.classFilter, null);
      // A surviving ghostExceptEntities leaves the model translucent.
      assert.strictEqual(state.ghostExceptEntities, null);
    });

    it('clearAllFilters clears isolation, the class filter and ghosting but keeps hidden entities', () => {
      armAllFilters();
      state.clearAllFilters();

      assert.strictEqual(state.isolatedEntities, null);
      assert.strictEqual(state.classFilter, null);
      assert.strictEqual(state.ghostExceptEntities, null);
      // Both directions pinned: clearAllFilters is NOT showAll — manually
      // hidden entities must survive it.
      assert.ok(state.hiddenEntities.has(123));
    });

    it('setHiddenEntities replaces hidden and clears isolation, class filter and ghosting', () => {
      armAllFilters();
      state.setHiddenEntities(new Set([900]));

      assert.deepStrictEqual([...state.hiddenEntities], [900]);
      assert.strictEqual(state.isolatedEntities, null);
      assert.strictEqual(state.classFilter, null);
      assert.strictEqual(state.ghostExceptEntities, null);
    });

    it('setIsolatedEntities clears hidden entities and ghosting (mutually exclusive modes)', () => {
      state.hideEntity(123);
      state.setGhostExceptEntities(new Set([7]));
      state.setIsolatedEntities(new Set([456]));

      assert.deepStrictEqual([...state.isolatedEntities!], [456]);
      // Leftover hidden ids would subtract from the isolated set, so a BCF
      // viewpoint with defaultVisibility=false would show fewer elements
      // than the viewpoint asked for.
      assert.strictEqual(state.hiddenEntities.size, 0);
      // Isolation hides the rest; ghosting shows it translucent. Both at
      // once is contradictory, so isolation wins.
      assert.strictEqual(state.ghostExceptEntities, null);
    });

    it('setIsolatedEntities(null) clears isolation', () => {
      state.setIsolatedEntities(new Set([1]));
      state.setIsolatedEntities(null);
      assert.strictEqual(state.isolatedEntities, null);
    });

    it('setGhostExceptEntities clears isolation, and clearGhost undoes only the ghosting', () => {
      state.isolateEntity(456);
      state.setGhostExceptEntities(new Set([7, 8]));

      assert.deepStrictEqual([...state.ghostExceptEntities!].sort((a, b) => a - b), [7, 8]);
      assert.strictEqual(state.isolatedEntities, null);

      state.clearGhost();
      assert.strictEqual(state.ghostExceptEntities, null);
    });

    it('showAllInAllModels clears the class filter as well as the hidden/isolated sets', () => {
      state.hideEntities([100, 200, 500]);
      state.setClassFilter([1, 2], 'IfcWall');

      state.showAllInAllModels();

      assert.strictEqual(state.hiddenEntities.size, 0);
      assert.strictEqual(state.isolatedEntities, null);
      assert.strictEqual(state.classFilter, null);
      assert.strictEqual(state.ghostExceptEntities, null);
    });
  });

  describe('legacy visibility: setClassFilter', () => {
    it('stores the ids and label', () => {
      state.setClassFilter([1, 2, 3], 'IfcWall');
      assert.strictEqual(state.classFilter?.label, 'IfcWall');
      assert.deepStrictEqual([...state.classFilter!.ids].sort((a, b) => a - b), [1, 2, 3]);
    });

    it('toggles off when the same id set is re-applied', () => {
      state.setClassFilter([1, 2, 3], 'IfcWall');
      state.setClassFilter([1, 2, 3], 'IfcWall');
      assert.strictEqual(state.classFilter, null);
    });

    it('switches to a different class rather than toggling off', () => {
      state.setClassFilter([1, 2, 3], 'IfcWall');
      state.setClassFilter([4, 5, 6], 'IfcSlab');
      assert.strictEqual(state.classFilter?.label, 'IfcSlab');
    });

    it('does NOT toggle off on a same-size class that merely overlaps', () => {
      // Membership is `ids.every(...)`. With `some`, a second class whose id
      // set happens to share one member (an element counted under both, or
      // just an id collision across models) would CLEAR the filter instead
      // of switching to it — the user clicks a class row and the filter
      // silently turns off.
      state.setClassFilter([1, 2, 3], 'IfcWall');
      state.setClassFilter([1, 8, 9], 'IfcSlab');

      assert.notStrictEqual(state.classFilter, null);
      assert.strictEqual(state.classFilter?.label, 'IfcSlab');
      assert.deepStrictEqual([...state.classFilter!.ids].sort((a, b) => a - b), [1, 8, 9]);
    });

    it('clearClassFilter removes it', () => {
      state.setClassFilter([1], 'IfcWall');
      state.clearClassFilter();
      assert.strictEqual(state.classFilter, null);
    });
  });

  describe('legacy visibility: isEntityVisible', () => {
    it('should return true for visible entity', () => {
      assert.strictEqual(state.isEntityVisible(123), true);
    });

    it('should return false for hidden entity', () => {
      state.hideEntity(123);
      assert.strictEqual(state.isEntityVisible(123), false);
    });

    it('should return false for non-isolated entity when isolation active', () => {
      state.isolateEntity(100);
      assert.strictEqual(state.isEntityVisible(100), true);
      assert.strictEqual(state.isEntityVisible(200), false);
    });

    it('returns false for an entity outside an active class filter', () => {
      // classFilter is a third, INDEPENDENT gate (Class tab type-group
      // clicks). Without this test the whole `classFilter` branch of
      // isEntityVisible can be deleted with every suite still green — and
      // "hide everything except IfcWall" would stop hiding anything.
      state.setClassFilter([100, 101], 'IfcWall');
      assert.strictEqual(state.isEntityVisible(100), true);
      assert.strictEqual(state.isEntityVisible(200), false);
    });

    it('requires an entity to pass EVERY gate, not just one', () => {
      state.setClassFilter([100, 200], 'IfcWall');
      state.isolateEntities([100, 300]);
      // 100 is in both → visible. 200 passes the class filter but fails
      // isolation; 300 the reverse. Neither may be visible.
      assert.strictEqual(state.isEntityVisible(100), true);
      assert.strictEqual(state.isEntityVisible(200), false);
      assert.strictEqual(state.isEntityVisible(300), false);

      // …and an explicit hide overrides passing both.
      state.hideEntity(100);
      assert.strictEqual(state.isEntityVisible(100), false);
    });
  });

  describe('type visibility: toggleTypeVisibility', () => {
    it('should toggle each type key independently', () => {
      const keys = ['spaces', 'openings', 'site', 'ifcAnnotations', 'ifcGrid'] as const;
      for (const key of keys) {
        const before = { ...state.typeVisibility };
        state.toggleTypeVisibility(key);
        assert.strictEqual(state.typeVisibility[key], !before[key], `toggle ${key}`);
        for (const other of keys) {
          if (other === key) continue;
          assert.strictEqual(
            state.typeVisibility[other],
            before[other],
            `toggling ${key} must not change ${other}`,
          );
        }
      }
    });

    it('replaces the typeVisibility object identity on every toggle', () => {
      // `useDrawingGeneration` decides whether to regenerate an open section by
      // comparing `typeVisibility` BY IDENTITY against the previous render's
      // value (issue #2060). That is only sound because this slice spreads a
      // fresh object per toggle. A refactor to structural sharing — mutating in
      // place, or returning the same object when the value is unchanged —
      // would leave the drawing stale with the hook's own tests still green,
      // since they pass their own object literals. Fail here instead.
      const before = state.typeVisibility;
      state.toggleTypeVisibility('spaces');
      assert.notStrictEqual(
        state.typeVisibility,
        before,
        'toggleTypeVisibility must return a NEW typeVisibility object',
      );
    });

    it('resetTypeVisibility restores semantic defaults', () => {
      // Flip everything away from defaults first.
      state.toggleTypeVisibility('spaces');   // false -> true
      state.toggleTypeVisibility('site');     // true  -> false
      state.toggleTypeVisibility('ifcGrid');  // true  -> false
      state.resetTypeVisibility();
      assert.deepStrictEqual(state.typeVisibility, {
        spaces: false,
        spatialZones: false,
        openings: false,
        virtualElements: false,
        site: true,
        ifcAnnotations: true,
        ifcGrid: true,
      });
    });
  });
});
