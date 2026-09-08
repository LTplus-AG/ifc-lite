/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SearchInline`'s shared select+frame path — the one both Enter-commit,
 * popover clicks and n/N cycle stepping run through (#2434).
 *
 * `frameSelection` (Viewport.tsx) PREFERS the numeric multi-selection set over
 * the single selection, so a stale box/basket selection made the camera frame
 * the OLD elements instead of the freshly-picked search result. The fix is
 * `setSelectedEntityIds([])` BEFORE selecting — and the order is load-bearing,
 * because clearing also nulls `selectedEntityId` (selectionSlice.ts:160-163),
 * so the reverse order discards the selection and frames nothing.
 *
 * This file replaces a source-text version that read `SearchInline.tsx` and
 * asserted on the text of `applySelection`. Its header claimed the component
 * "cannot be mounted under `tsx --test`"; it can — `src/test/` carries the
 * loader hooks and the DOM globals, and the store is a module-level Zustand
 * store that `setState` seeds. Every assertion below is on store state after a
 * real click or keystroke, so it goes red when the wiring breaks rather than
 * when someone renames a local.
 */

import '@/test/setup-dom.js';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, mouseDown, press, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { toGlobalIdFromModels } from '@/store/globalId';
import { SearchInline } from './SearchInline.js';

const MODEL_ID = 'model-a';
const ID_OFFSET = 1_000_000;

const ENTITIES = [
  { expressId: 42, type: 'IfcWall', name: 'Wall A' },
  { expressId: 43, type: 'IfcWall', name: 'Wall B' },
];

/**
 * Resolved through the SAME mapping the component uses rather than hand-rolled
 * `42 + ID_OFFSET` arithmetic — a test that re-implements the conversion agrees
 * with a component that gets it wrong.
 */
function globalIdOf(expressId: number): number {
  return toGlobalIdFromModels(
    fixtureModels(fixtureModel(MODEL_ID, { idOffset: ID_OFFSET })).models,
    MODEL_ID,
    expressId,
  );
}

const WALL_A_GLOBAL_ID = globalIdOf(42);
const WALL_B_GLOBAL_ID = globalIdOf(43);

let framed = 0;
let initialState: ReturnType<typeof useViewerStore.getState>;

function seedStore(): void {
  const seeded = fixtureModels(fixtureModel(MODEL_ID, { idOffset: ID_OFFSET, entities: ENTITIES }));
  useViewerStore.setState({
    ...seeded,
    // Seeded BEFORE mount, so `debouncedQuery` initialises to it and the
    // Tier-0 scan has run by first paint — no 80ms wait to get rows.
    searchQuery: 'Wall',
    searchOpen: true,
    // Pin the search to the Tier-0 linear scan. `useSearchIndex` otherwise
    // kicks off a fire-and-forget Tier-1 build on mount and resolves it
    // outside `act()`, which both warns and makes "which scanner produced
    // these rows" non-deterministic between tests. A record that is not
    // 'pending' makes the hook skip the model, and a non-'ready' one keeps
    // the Tier-0 fallback live — which is the path being asserted.
    searchIndexes: new Map([[MODEL_ID, { status: 'building', progress: 0 }]]) as never,
    searchHighlightIndex: 0,
    searchVimCycle: null,
    // A stale multi-selection from an earlier box-select. Clearing this is the
    // whole point of the ordering in `applySelection`.
    selectedEntityIds: new Set<number>([7, 8]),
    selectedEntitiesSet: new Set<string>(),
    selectedEntityId: null,
    selectedEntity: null,
    cameraCallbacks: { frameSelection: () => { framed += 1; } } as never,
  });
}

/** The popover row whose label is `name`, i.e. what a user actually clicks. */
function row(container: HTMLElement, name: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('button[role="option"]')].filter((el) =>
    el.textContent?.includes(name),
  );
  assert.equal(found.length, 1, `expected exactly one result row for ${JSON.stringify(name)}, found ${found.length}`);
  return found[0];
}

/**
 * `SearchPopover` commits on mousedown, not click — it must beat the input's
 * blur, which would tear the popover down first. So mousedown is the whole
 * user gesture here, and a `click()` would assert nothing.
 */
const pick = mouseDown;

/** A window-level keystroke, the way the global n/N listener receives it. */
function pressKey(key: string): void {
  press(window, key);
}

describe('SearchInline — picking a result', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(async () => {
    // Every pick schedules a 50ms framing timer. Drain them here, or a test
    // that awaits collects an earlier test's timer and reads a count it did
    // not cause.
    await advance(60);
    cleanup();
    framed = 0;
    useViewerStore.setState(initialState, true);
  });

  after(() => {
    useViewerStore.setState(initialState, true);
  });

  it('renders the result rows at all (guards the harness, not the feature)', () => {
    seedStore();
    const container = render(<SearchInline />);
    // With no rows every assertion below would be vacuously unreachable
    // rather than failing. Pin the count.
    assert.equal(container.querySelectorAll('button[role="option"]').length, ENTITIES.length);
  });

  it('selects the picked row and clears the stale multi-selection', () => {
    seedStore();
    const container = render(<SearchInline />);

    pick(row(container, 'Wall A'));

    const s = useViewerStore.getState();
    assert.equal(s.selectedEntityId, WALL_A_GLOBAL_ID);
    assert.equal(s.selectedEntityIds.size, 0, 'the stale box-selection must be cleared');
    assert.deepEqual(s.selectedEntity, { modelId: MODEL_ID, expressId: 42 });
  });

  it('clears BEFORE selecting, so the selection survives', () => {
    seedStore();
    const container = render(<SearchInline />);

    pick(row(container, 'Wall A'));

    // `setSelectedEntityIds([])` also nulls `selectedEntityId`, so clearing
    // after selecting throws the selection away. This asserts the VALUE and
    // not statement order: a swap leaves `selectedEntityId` null.
    assert.equal(useViewerStore.getState().selectedEntityId, WALL_A_GLOBAL_ID);
  });

  it('frames the selection, once, on the trailing timer', async () => {
    seedStore();
    const container = render(<SearchInline />);

    pick(row(container, 'Wall A'));
    assert.equal(framed, 0, 'framing is deferred to a 50ms timer, not called inline');

    await advance(60);
    assert.equal(framed, 1);
  });

  it('enters the vim cycle at the picked row', () => {
    seedStore();
    const container = render(<SearchInline />);

    pick(row(container, 'Wall B'));

    const cycle = useViewerStore.getState().searchVimCycle;
    assert.ok(cycle, 'committing a result must arm n/N stepping');
    assert.equal(cycle.results[cycle.index].expressId, 43);
    assert.equal(cycle.results[cycle.index].modelId, MODEL_ID);
  });

  it('Shift+pick adds without clearing the multi-selection it is building up', async () => {
    seedStore();
    const container = render(<SearchInline />);

    // Shift+Enter is the ADDITIVE branch: it must leave the existing
    // multi-selection alone. Reaching `setSelectedEntityIds([])` here — e.g.
    // by hoisting the clear above the `addToSelection` early return — wipes
    // the very set the gesture exists to grow.
    pick(row(container, 'Wall A'), { shiftKey: true });

    const s = useViewerStore.getState();
    assert.ok(s.selectedEntitiesSet.has(`${MODEL_ID}:42`), 'Shift+pick must add the row');
    assert.deepEqual([...s.selectedEntityIds].sort(), [7, 8], 'the multi-selection must survive');
    assert.equal(s.selectedEntityId, WALL_A_GLOBAL_ID);
    assert.equal(s.searchVimCycle, null, 'additive picks must not arm the n/N cycle');

    await advance(60);
    assert.equal(framed, 0, 'additive picks must not move the camera');
  });

  it('Shift+pick on an already-selected row toggles it back out', () => {
    seedStore();
    // Already in the multi-selection, as after a first Shift+pick. Committing
    // additively again must REMOVE it — the plain `add` this replaced forced
    // the user to clear the whole selection to undo one row.
    useViewerStore.setState({ selectedEntitiesSet: new Set([`${MODEL_ID}:42`]) });
    const container = render(<SearchInline />);

    pick(row(container, 'Wall A'), { shiftKey: true });

    assert.equal(useViewerStore.getState().selectedEntitiesSet.size, 0);
  });
});

describe('SearchInline — n/N cycle stepping reuses the same select+frame path', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(async () => {
    await advance(60);
    cleanup();
    framed = 0;
    useViewerStore.setState(initialState, true);
  });

  after(() => {
    useViewerStore.setState(initialState, true);
  });

  it('`n` selects, clears the multi-selection and frames the next match', async () => {
    seedStore();
    const container = render(<SearchInline />);

    pick(row(container, 'Wall A'));
    await advance(60);
    assert.equal(useViewerStore.getState().selectedEntityId, WALL_A_GLOBAL_ID);
    framed = 0;

    // Re-dirty the multi-selection: stepping must clear it too, or the camera
    // frames these instead of the match it just stepped onto.
    useViewerStore.setState({ selectedEntityIds: new Set<number>([7, 8]) });

    await advance(0);
    pressKey('n');

    const s = useViewerStore.getState();
    assert.equal(s.searchVimCycle?.index, 1, '`n` must step the cycle forward');
    assert.equal(s.selectedEntityId, WALL_B_GLOBAL_ID, 'stepping must re-select through applySelection');
    assert.equal(s.selectedEntityIds.size, 0, 'stepping must clear the stale multi-selection too');

    await advance(60);
    assert.equal(framed, 1, 'stepping must reframe');
  });

  it('`N` steps backwards through the same path', async () => {
    seedStore();
    const container = render(<SearchInline />);

    pick(row(container, 'Wall B'));
    await advance(60);
    framed = 0;

    await advance(0);
    pressKey('N');

    const s = useViewerStore.getState();
    assert.equal(s.searchVimCycle?.index, 0);
    assert.equal(s.selectedEntityId, WALL_A_GLOBAL_ID);
  });
});
