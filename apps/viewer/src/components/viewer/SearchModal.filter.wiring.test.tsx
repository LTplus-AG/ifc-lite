/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clicking a row in the advanced Filter tab selects, frames and closes (#2396,
 * #2415) — asserted by clicking a rendered row and reading the store, not by
 * grepping the handler's source.
 *
 * This file replaces a source-text version whose header claimed
 * `SearchModalFilter` "cannot be mounted under `tsx --test`". It can: the store
 * is a module-level Zustand store that `setState` seeds, and `src/test/` now carries the two loader hooks and the layout stub that the virtualized table
 * actually needed (#2434).
 *
 * The conversion was not cosmetic. The source-text version could not fail on
 * the defect it existed for: it asserted on the body of `handleRowClick` but
 * never that the handler reaches the row, so replacing
 * `onRowClick={handleRowClick}` with `onRowClick={() => {}}` — i.e. #2396
 * verbatim, a click that does nothing — left it green: 5/5 as it stood when
 * #2396 shipped, and 9/9 by the time #2415 had extended it. Five of the six
 * tests below go red on that same mutation.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';

installLayout();

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SearchModalFilter } from './SearchModal.filter.js';

const MODEL_ID = 'model-a';
const ID_OFFSET = 1_000_000;

/** Two selectable rows, `express_id` first so `selectionKeyIndex` is 0. */
const RESULT = {
  columns: ['express_id', 'Name'],
  rows: [
    [42, 'Wall A'],
    [43, 'Wall B'],
  ],
  truncated: false,
} as const;

/** globalId for row 0 — `toGlobalIdFromModels` adds the model's idOffset. */
const ROW0_GLOBAL_ID = 42 + ID_OFFSET;

let framed = 0;
let initialState: ReturnType<typeof useViewerStore.getState>;

function seedStore() {
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
    searchFilter: { rules: [{ field: 'Name', op: 'contains', value: 'Wall' }], combinator: 'AND', limit: 500 } as never,
    searchFilterResult: RESULT as never,
    searchFilterRunning: false,
    searchFilterError: null,
    searchModalOpen: true,
    // A stale multi-selection from an earlier box-select. Clearing this is the
    // whole point of the ordering in the handler.
    selectedEntityIds: new Set<number>([7, 8]),
    selectedEntityId: null,
    selectedEntity: null,
    searchVimCycle: null,
    cameraCallbacks: { frameSelection: () => { framed += 1; } } as never,
  });
}

/**
 * The cell showing `text`, which is what a user actually clicks. The click
 * bubbles to the row's handler, so this exercises the real path and needs no
 * test-only markup in the component.
 */
function cell(container: HTMLElement, text: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('div')].filter(
    (el) => el.children.length === 0 && el.textContent?.trim() === text,
  );
  assert.equal(found.length, 1, `expected exactly one cell reading ${JSON.stringify(text)}, found ${found.length}`);
  return found[0];
}

/** Every rendered virtual row. The virtualizer positions each one absolutely. */
function resultRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('div[style*="position: absolute"]')];
}

describe('advanced Filter tab — clicking a result row', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(async () => {
    // Every click schedules a 50ms framing timer. Drain them here, or a test
    // that awaits (the framing one) collects the earlier tests' timers too and
    // reads a count it did not cause.
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
    const container = render(<SearchModalFilter />);
    // Without the layout stub the virtualizer measures a 0px viewport and
    // emits zero rows, which would make every assertion below vacuously
    // unreachable rather than failing. Pin it.
    assert.equal(resultRows(container).length, RESULT.rows.length);
  });

  it('selects the clicked row and clears the stale multi-selection', () => {
    seedStore();
    const container = render(<SearchModalFilter />);

    click(cell(container, 'Wall A'));

    const s = useViewerStore.getState();
    assert.equal(s.selectedEntityId, ROW0_GLOBAL_ID);
    assert.equal(s.selectedEntityIds.size, 0, 'the stale box-selection must be cleared');
    assert.deepEqual(s.selectedEntity, { modelId: MODEL_ID, expressId: 42 });
  });

  it('clears BEFORE selecting, so the selection survives', () => {
    seedStore();
    const container = render(<SearchModalFilter />);

    click(cell(container, 'Wall A'));

    // `setSelectedEntityIds([])` also nulls `selectedEntityId`
    // (selectionSlice.ts:160-163), so clearing after selecting throws the
    // selection away. That is why this assertion is on the VALUE and not on
    // statement order: a swap leaves selectedEntityId null.
    assert.equal(useViewerStore.getState().selectedEntityId, ROW0_GLOBAL_ID);
  });

  it('frames the selection, once, after the trailing timer', async () => {
    seedStore();
    const container = render(<SearchModalFilter />);

    click(cell(container, 'Wall A'));
    assert.equal(framed, 0, 'framing is deferred to a 50ms timer, not called inline');

    await advance(60);
    assert.equal(framed, 1);
  });

  it('closes the modal, so the framing is not hidden behind the scrim', () => {
    seedStore();
    const container = render(<SearchModalFilter />);

    click(cell(container, 'Wall A'));

    // The dialog overlay is `fixed inset-0 bg-black/80`; leaving it open is
    // what made #2396 read as "the click does nothing".
    assert.equal(useViewerStore.getState().searchModalOpen, false);
  });

  it('enters the vim cycle at the clicked row, keyed by identity not row position', () => {
    seedStore();
    const container = render(<SearchModalFilter />);

    click(cell(container, 'Wall B'));

    const cycle = useViewerStore.getState().searchVimCycle;
    assert.ok(cycle, 'clicking a row must arm n/N stepping');
    assert.equal(cycle.results[cycle.index].expressId, 43);
    assert.equal(cycle.results[cycle.index].modelId, MODEL_ID);
  });
});
