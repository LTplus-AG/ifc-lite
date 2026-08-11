/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Search tab's `commit` — what happens when a user clicks a result row or
 * presses Enter on the highlighted one (#2434).
 *
 * `frameSelection` (Viewport.tsx) PREFERS the numeric multi-selection set over
 * the single selection, so a stale box/basket selection made `commit` frame the
 * OLD elements instead of the row just clicked. The fix is
 * `setSelectedEntityIds([])` BEFORE selecting, and the order is load-bearing:
 * clearing also nulls `selectedEntityId` (selectionSlice.ts:160-163), so the
 * reverse order discards the selection and frames nothing.
 *
 * This replaces a source-text version that read `SearchModal.text.tsx` and
 * asserted on the text of `commit`. It claimed the component "cannot be mounted
 * under `tsx --test`"; it can, given `src/test/`'s loader hooks and
 * `installLayout()` for the virtualizer. The conversion is not cosmetic: the
 * old file asserted the body of the handler but never that the handler reaches
 * the row, so a row whose `onClick` did nothing left it fully green.
 *
 * One old assertion is deliberately NOT carried over: "clears BEFORE entering
 * the vim cycle". `enterVimCycle` only writes `searchVimCycle`, so no ordering
 * against it is observable — an assertion on it would be pinning statement
 * order for its own sake, which is the habit this conversion exists to end.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';

// Disposer kept and called from the last `after` below. The node runner gives
// each test FILE its own process, so nothing else could observe the shim — this
// is hygiene, not a fix for a live leak.
const restoreLayout = installLayout();

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, press, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { toGlobalIdFromModels } from '@/store/globalId';
import type { SearchResult } from '@/lib/search/tier0-scan';
import { SearchModalText } from './SearchModal.text.js';

const MODEL_ID = 'model-a';
const ID_OFFSET = 1_000_000;

function result(expressId: number, name: string): SearchResult {
  return {
    modelId: MODEL_ID,
    expressId,
    typeName: 'IfcWall',
    name,
    globalId: '',
    description: '',
    objectType: '',
    matchField: 'name',
    score: 100,
  };
}

const RESULTS = [result(42, 'Wall A'), result(43, 'Wall B')];

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

let framed = 0;
let closed = 0;
let initialState: ReturnType<typeof useViewerStore.getState>;

function seedStore(): void {
  const seeded = fixtureModels(
    fixtureModel(MODEL_ID, {
      idOffset: ID_OFFSET,
      entities: [
        { expressId: 42, type: 'IfcWall', name: 'Wall A' },
        { expressId: 43, type: 'IfcWall', name: 'Wall B' },
      ],
    }),
  );
  useViewerStore.setState({
    ...seeded,
    searchQuery: 'Wall',
    searchFieldFilter: 'all',
    searchModelFilter: null,
    searchHighlightIndex: 0,
    searchVimCycle: null,
    // A stale multi-selection from an earlier box-select. Clearing this is the
    // whole point of the ordering in `commit`.
    selectedEntityIds: new Set<number>([7, 8]),
    selectedEntitiesSet: new Set<string>(),
    selectedEntityId: null,
    selectedEntity: null,
    cameraCallbacks: { frameSelection: () => { framed += 1; } } as never,
  });
}

function mount(): HTMLElement {
  return render(
    <SearchModalText results={RESULTS} availableModelIds={[MODEL_ID]} onClose={() => { closed += 1; }} />,
  );
}

/** Every rendered virtual row. The virtualizer positions each one absolutely. */
function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('div[role="option"]')];
}

/** The row showing `name`, which is what a user actually clicks. */
function row(container: HTMLElement, name: string): HTMLElement {
  const found = rows(container).filter((el) => el.textContent?.includes(name));
  assert.equal(found.length, 1, `expected exactly one row reading ${JSON.stringify(name)}, found ${found.length}`);
  return found[0];
}

describe('Search tab — committing a result row', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(async () => {
    // Every commit schedules a 50ms framing timer. Drain them here, or a test
    // that awaits collects an earlier test's timer and reads a count it did
    // not cause.
    await advance(60);
    cleanup();
    framed = 0;
    closed = 0;
    useViewerStore.setState(initialState, true);
  });

  after(() => {
    useViewerStore.setState(initialState, true);
  });

  it('renders the result rows at all (guards the harness, not the feature)', () => {
    seedStore();
    const container = mount();
    // Without the layout stub the virtualizer measures a 0px viewport and
    // emits zero rows, which would make every assertion below vacuously
    // unreachable rather than failing. Pin it.
    assert.equal(rows(container).length, RESULTS.length);
  });

  it('selects the clicked row and clears the stale multi-selection', () => {
    seedStore();
    const container = mount();

    click(row(container, 'Wall A'));

    const s = useViewerStore.getState();
    assert.equal(s.selectedEntityId, WALL_A_GLOBAL_ID);
    assert.equal(s.selectedEntityIds.size, 0, 'the stale box-selection must be cleared');
    assert.deepEqual(s.selectedEntity, { modelId: MODEL_ID, expressId: 42 });
  });

  it('clears BEFORE selecting, so the selection survives', () => {
    seedStore();
    const container = mount();

    click(row(container, 'Wall A'));

    // `setSelectedEntityIds([])` also nulls `selectedEntityId`, so clearing
    // after selecting throws the selection away. This asserts the VALUE and
    // not statement order: a swap leaves `selectedEntityId` null.
    assert.equal(useViewerStore.getState().selectedEntityId, WALL_A_GLOBAL_ID);
  });

  it('frames the selection, once, on the trailing timer', async () => {
    seedStore();
    const container = mount();

    click(row(container, 'Wall A'));
    assert.equal(framed, 0, 'framing is deferred to a 50ms timer, not called inline');

    await advance(60);
    assert.equal(framed, 1);
  });

  it('closes the modal, so the framing is not hidden behind the scrim', () => {
    seedStore();
    const container = mount();

    click(row(container, 'Wall A'));

    assert.equal(closed, 1);
  });

  it('enters the vim cycle at the clicked row, keyed by identity not row position', () => {
    seedStore();
    const container = mount();

    click(row(container, 'Wall B'));

    const cycle = useViewerStore.getState().searchVimCycle;
    assert.ok(cycle, 'committing a row must arm n/N stepping');
    assert.equal(cycle.results[cycle.index].expressId, 43);
    assert.equal(cycle.results[cycle.index].modelId, MODEL_ID);
  });

  it('Enter on the highlighted row commits the same way a click does', () => {
    seedStore();
    useViewerStore.setState({ searchHighlightIndex: 1 });
    const container = mount();

    const listbox = container.querySelector('div[role="listbox"]');
    assert.ok(listbox, 'the result list must be a listbox');
    press(listbox, 'Enter');

    const s = useViewerStore.getState();
    assert.equal(s.selectedEntity?.expressId, 43, 'Enter must commit the HIGHLIGHTED row');
    assert.equal(s.selectedEntityIds.size, 0);
    assert.equal(closed, 1);
  });
});

describe('Search tab — the additive (Shift) path', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(async () => {
    await advance(60);
    cleanup();
    framed = 0;
    closed = 0;
    useViewerStore.setState(initialState, true);
  });

  after(() => {
    useViewerStore.setState(initialState, true);
    restoreLayout();
  });

  it('Shift+click adds without clearing the multi-selection it is building up', async () => {
    seedStore();
    const container = mount();

    // Shift+click is the ADDITIVE branch: it must leave the existing
    // multi-selection alone, not close, and not move the camera.
    click(row(container, 'Wall A'), { shiftKey: true });

    const s = useViewerStore.getState();
    assert.ok(s.selectedEntitiesSet.has(`${MODEL_ID}:42`), 'Shift+click must add the row');
    assert.deepEqual([...s.selectedEntityIds].sort(), [7, 8], 'the multi-selection must survive');
    assert.equal(s.searchVimCycle, null, 'additive picks must not arm the n/N cycle');
    assert.equal(closed, 0, 'additive picks keep the modal open for the next one');

    await advance(60);
    assert.equal(framed, 0, 'additive picks must not move the camera');
  });

  it('Shift+click on an already-selected row toggles it back out', () => {
    seedStore();
    // Already in the multi-selection, as after a first Shift+click. Committing
    // additively again must REMOVE it — the plain `add` this replaced forced
    // the user to clear the whole selection to undo one row.
    useViewerStore.setState({ selectedEntitiesSet: new Set([`${MODEL_ID}:42`]) });
    const container = mount();

    click(row(container, 'Wall A'), { shiftKey: true });

    assert.equal(useViewerStore.getState().selectedEntitiesSet.size, 0);
  });

  it('the row checkbox toggles without committing the row', () => {
    seedStore();
    const container = mount();

    const checkbox = row(container, 'Wall A').querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(checkbox, 'each row must carry a selection checkbox');
    click(checkbox);

    const s = useViewerStore.getState();
    assert.ok(s.selectedEntitiesSet.has(`${MODEL_ID}:42`));
    // `stopPropagation` on the checkbox is what keeps the row's own onClick
    // from firing: without it, ticking a box also selects, frames and closes.
    assert.equal(closed, 0, 'ticking the box must not close the modal');
    assert.equal(s.searchVimCycle, null, 'ticking the box must not arm the cycle');
  });
});
