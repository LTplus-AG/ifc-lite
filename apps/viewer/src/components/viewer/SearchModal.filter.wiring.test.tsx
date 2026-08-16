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

import { after, afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { toGlobalIdFromModels } from '@/store/globalId';
import { toast } from '@/components/ui/toast';
import { Rule } from '@/lib/search/filter-rules';
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

/**
 * globalId for row 0, resolved through the SAME mapping the component uses
 * rather than hand-rolled `42 + ID_OFFSET` arithmetic — a test that
 * re-implements the conversion agrees with a component that gets it wrong.
 */
const ROW0_GLOBAL_ID = toGlobalIdFromModels(
  fixtureModels(fixtureModel(MODEL_ID, { idOffset: ID_OFFSET })).models,
  MODEL_ID,
  42,
);

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

// ── "Isolate in 3D" (#2532) ───────────────────────────────────────────────
//
// Replaces the source-text version of this suite (readFileSync + indexOf on
// SearchModal.filter.tsx): it could not fail on the defects the #2532 deep
// review found (blank viewport from a hidden-by-default type, the toggle-off
// double-click, the stale-federation id collision) and pinned a dead
// `setSelectedEntityIds([])` call as a contract (deleting it failed 3 of 9
// tests even though the later `setSelectedEntityIds(globalIds)` call already
// replaces both `selectedEntityIds` and `selectedEntityId` wholesale). These
// exercise the real render/click path instead, the same conversion #2396/
// #2415's row-click suite already went through above.

let framedIds: number[][] = [];

/** The toolbar's "Isolate in 3D" button — matched by its visible text, same
 *  as a user would find it, not by a handler prop. */
function isolateButton(container: HTMLElement): HTMLElement {
  const found = [...container.querySelectorAll('button')].filter(
    (b) => b.textContent?.trim() === 'Isolate in 3D',
  );
  assert.equal(found.length, 1, `expected exactly one "Isolate in 3D" button, found ${found.length}`);
  return found[0];
}

function seedIsolateStore(options: {
  columns: string[];
  rows: unknown[][];
  typeVisibility?: Partial<ReturnType<typeof useViewerStore.getState>['typeVisibility']>;
  models?: ReturnType<typeof fixtureModels>;
  /** Viewport's aggregation resolver (#2531). Absent by default, same as a
   *  renderer that has not registered its camera callbacks yet. */
  resolveHighlightIds?: (ids: number[]) => number[];
} = { columns: ['express_id', 'type'], rows: [[42, 'IfcWall']] }) {
  const seeded = options.models ?? fixtureModels(
    fixtureModel(MODEL_ID, {
      idOffset: ID_OFFSET,
      entities: [{ expressId: 42, type: 'IfcWall', name: 'Wall A' }],
    }),
  );
  framedIds = [];
  useViewerStore.setState({
    ...seeded,
    searchFilter: { rules: [{ field: 'Name', op: 'contains', value: 'Wall' }], combinator: 'AND', limit: 500 } as never,
    searchFilterResult: { columns: options.columns, rows: options.rows, truncated: false } as never,
    searchFilterRunning: false,
    searchFilterError: null,
    searchModalOpen: true,
    selectedEntityIds: new Set<number>(),
    selectedEntityId: null,
    selectedEntity: null,
    isolatedEntities: null,
    typeVisibility: { ...useViewerStore.getState().typeVisibility, ...options.typeVisibility },
    searchVimCycle: null,
    cameraCallbacks: {
      frameSelection: () => { framed += 1; },
      frameEntities: (ids: number[]) => { framedIds.push(ids); },
      ...(options.resolveHighlightIds ? { resolveHighlightIds: options.resolveHighlightIds } : {}),
    } as never,
  });
}

describe('advanced Filter tab — "Isolate in 3D" button', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(async () => {
    await advance(60);
    cleanup();
    framed = 0;
    framedIds = [];
    useViewerStore.setState(initialState, true);
  });

  after(() => {
    useViewerStore.setState(initialState, true);
  });

  it('isolates the resolved global ids, selects and frames them, and closes the modal', () => {
    seedIsolateStore({ columns: ['express_id', 'type'], rows: [[42, 'IfcWall']] });
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));

    const s = useViewerStore.getState();
    assert.deepEqual(s.isolatedEntities, new Set([ROW0_GLOBAL_ID]));
    assert.deepEqual(s.selectedEntityIds, new Set([ROW0_GLOBAL_ID]));
    assert.equal(s.searchModalOpen, false, 'the scrim would otherwise hide the framing (#2396)');
  });

  it('replaces a stale multi-selection left over from an earlier box-select', () => {
    seedIsolateStore({ columns: ['express_id', 'type'], rows: [[42, 'IfcWall']] });
    // A stale selection from an earlier box/basket selection, unrelated to
    // this result. frameEntities takes the resolved id set directly rather
    // than reading it back off selection state, so this must not leak in.
    useViewerStore.setState({ selectedEntityIds: new Set<number>([7, 8, 9]) });
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));

    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([ROW0_GLOBAL_ID]));
  });

  it('frames the explicit id set via frameEntities, not the ambient selection via frameSelection', async () => {
    seedIsolateStore({ columns: ['express_id', 'type'], rows: [[42, 'IfcWall']] });
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));
    assert.equal(framedIds.length, 0, 'framing is deferred to a 50ms timer');
    await advance(60);

    assert.deepEqual(framedIds, [[ROW0_GLOBAL_ID]]);
    assert.equal(framed, 0, 'must not also invoke frameSelection');
  });

  it('flips the hidden-by-default type-visibility toggle before isolating a matched IfcSpace, or the isolated set would render nothing (#1075)', () => {
    seedIsolateStore({
      columns: ['express_id', 'type'],
      rows: [[42, 'IfcSpace']],
      typeVisibility: { spaces: false },
    });
    assert.equal(useViewerStore.getState().typeVisibility.spaces, false, 'precondition: spaces start hidden');
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));

    assert.equal(useViewerStore.getState().typeVisibility.spaces, true);
    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([ROW0_GLOBAL_ID]));
  });

  it('does not flip type visibility for an already-visible class', () => {
    seedIsolateStore({ columns: ['express_id', 'type'], rows: [[42, 'IfcWall']] });
    const before = useViewerStore.getState().typeVisibility;
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));

    assert.deepEqual(useViewerStore.getState().typeVisibility, before);
  });

  it('pressing Isolate again on the identical result clears isolation instead of re-isolating', async () => {
    seedIsolateStore({ columns: ['express_id', 'type'], rows: [[42, 'IfcWall']] });
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));
    await advance(60);
    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([ROW0_GLOBAL_ID]));
    const framedAfterFirstClick = framedIds.length;

    click(isolateButton(container));
    await advance(60);

    assert.equal(useViewerStore.getState().isolatedEntities, null, 'the toggle must clear on the second press');
    assert.equal(
      framedIds.length,
      framedAfterFirstClick,
      'the un-isolate press must not also frame the (now meaningless) id set',
    );
  });

  // ── Assembly resolution (#2531 in the path #2532 added) ─────────────────
  //
  // An IfcElementAssembly carries no mesh of its own; its geometry hangs off
  // the IfcRelAggregates parts. The renderer resolves `isolatedEntities`
  // against mesh ids directly, so isolating the bare assembly id blanks the
  // view. Viewport exposes the aggregation resolver as
  // `cameraCallbacks.resolveHighlightIds` (backed by
  // expandToGeometryBearingIds, #2531); these stubs mirror its contract the
  // same way SearchModal.text.wiring.test.tsx does: a geometry-bearing id
  // passes through untouched, a geometry-less one resolves to its parts and
  // never to itself.

  it('isolates a geometry-less assembly as its geometry-bearing parts, not its bare id', async () => {
    const PART_A = ROW0_GLOBAL_ID + 500;
    const PART_B = ROW0_GLOBAL_ID + 501;
    seedIsolateStore({
      columns: ['express_id', 'type'],
      rows: [[42, 'IfcElementAssembly']],
      resolveHighlightIds: (ids) =>
        ids.flatMap((id) => (id === ROW0_GLOBAL_ID ? [PART_A, PART_B] : [id])),
    });
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));

    const s = useViewerStore.getState();
    assert.deepEqual(
      s.isolatedEntities,
      new Set([PART_A, PART_B]),
      'the isolation set must hold the renderable parts; the bare assembly id renders nothing',
    );
    // The selection additionally keeps the MATCHED assembly id (last, so it is
    // the primary selection) -- same #1133 convention as the text tab's commit.
    assert.deepEqual(s.selectedEntityIds, new Set([PART_A, PART_B, ROW0_GLOBAL_ID]));
    await advance(60);
    assert.deepEqual(framedIds, [[PART_A, PART_B]], 'framing must target the resolved parts too');
  });

  it('keeps the matched assembly as the primary selection; an expanded part must not steal selectedEntityId', () => {
    const PART_A = ROW0_GLOBAL_ID + 500;
    const PART_B = ROW0_GLOBAL_ID + 501;
    seedIsolateStore({
      columns: ['express_id', 'type'],
      rows: [[42, 'IfcElementAssembly']],
      resolveHighlightIds: (ids) =>
        ids.flatMap((id) => (id === ROW0_GLOBAL_ID ? [PART_A, PART_B] : [id])),
    });
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));

    // setSelectedEntityIds derives selectedEntityId from the LAST element
    // (selectionSlice.ts:160-163) and useModelSelection then syncs
    // selectedEntity -- so if the expanded parts came last, the Properties
    // panel would open on an arbitrary constituent instead of the assembly
    // the filter matched (#2660 review).
    assert.equal(
      useViewerStore.getState().selectedEntityId,
      ROW0_GLOBAL_ID,
      'the primary selection must be the matched assembly, not the last expanded part',
    );
  });

  it('passes geometry-bearing rows through the resolver untouched, so the fix does not broaden a plain result', () => {
    const PART_A = ROW0_GLOBAL_ID + 500;
    const WALL_GLOBAL_ID = toGlobalIdFromModels(
      fixtureModels(fixtureModel(MODEL_ID, { idOffset: ID_OFFSET })).models,
      MODEL_ID,
      43,
    );
    seedIsolateStore({
      columns: ['express_id', 'type'],
      rows: [
        [42, 'IfcElementAssembly'],
        [43, 'IfcWall'],
      ],
      resolveHighlightIds: (ids) =>
        ids.flatMap((id) => (id === ROW0_GLOBAL_ID ? [PART_A] : [id])),
    });
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));

    assert.deepEqual(
      useViewerStore.getState().isolatedEntities,
      new Set([PART_A, WALL_GLOBAL_ID]),
      'the wall keeps its own id; only the assembly is substituted',
    );
  });

  it('pressing Isolate again on the identical assembly result still toggles isolation off', async () => {
    const PART_A = ROW0_GLOBAL_ID + 500;
    seedIsolateStore({
      columns: ['express_id', 'type'],
      rows: [[42, 'IfcElementAssembly']],
      resolveHighlightIds: (ids) =>
        ids.flatMap((id) => (id === ROW0_GLOBAL_ID ? [PART_A] : [id])),
    });
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));
    await advance(60);
    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([PART_A]));

    click(isolateButton(container));
    await advance(60);

    assert.equal(
      useViewerStore.getState().isolatedEntities,
      null,
      'the same-set toggle must compare RESOLVED ids on both presses, or the second press re-isolates',
    );
  });

  it('keeps the raw ids when nothing resolves to geometry, identical to a renderer with no resolver', () => {
    seedIsolateStore({
      columns: ['express_id', 'type'],
      rows: [[42, 'IfcElementAssembly']],
      // An assembly with neither geometry nor geometry-bearing parts resolves
      // to nothing at all (expandToGeometryBearingIds drops it).
      resolveHighlightIds: () => [],
    });
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));

    // Pre-#2531 behaviour preserved for this corner: isolating an empty set
    // would hide the ENTIRE model, which is strictly worse than the raw id.
    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([ROW0_GLOBAL_ID]));
  });

  it('expands an assembly over HIDDEN-type parts through the aggregation graph and flips their toggles when the geometry resolver sees nothing', () => {
    // The renderer-backed resolver reads the type-visibility-FILTERED mesh
    // list (ViewportContainer's filteredGeometry), so an assembly whose only
    // parts are hidden IfcSpaces resolves to NOTHING -- and the bare-id
    // fallback alone would isolate a geometry-less id with the spaces toggle
    // still off: a blank view on a valid result (#2660 review). The fallback
    // must instead walk IfcRelAggregates in the data store, isolate the
    // parts, and flip their type gate.
    const models = fixtureModels(
      fixtureModel(MODEL_ID, {
        idOffset: ID_OFFSET,
        entities: [
          { expressId: 42, type: 'IfcElementAssembly', name: 'Zone assembly' },
          { expressId: 100, type: 'IfcSpace', name: 'Space A' },
          { expressId: 101, type: 'IfcSpace', name: 'Space B' },
        ],
        aggregates: { 42: [100, 101] },
      }),
    );
    const SPACE_A = toGlobalIdFromModels(models.models, MODEL_ID, 100);
    const SPACE_B = toGlobalIdFromModels(models.models, MODEL_ID, 101);
    seedIsolateStore({
      columns: ['express_id', 'type'],
      rows: [[42, 'IfcElementAssembly']],
      models,
      typeVisibility: { spaces: false },
      // Hidden parts own no mesh in the filtered geometry, so the real
      // resolver drops the assembly entirely (expandToGeometryBearingIds).
      resolveHighlightIds: () => [],
    });
    assert.equal(useViewerStore.getState().typeVisibility.spaces, false, 'precondition: spaces start hidden');
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));

    const s = useViewerStore.getState();
    assert.equal(s.typeVisibility.spaces, true, 'the parts\' type gate must flip, or nothing renders');
    assert.deepEqual(
      s.isolatedEntities,
      new Set([ROW0_GLOBAL_ID, SPACE_A, SPACE_B]),
      'the isolation set must include the aggregated parts, not just the bare assembly id',
    );
  });

  it('skips a row whose model was unloaded after the run instead of colliding with a loaded model\'s id space', () => {
    const models = fixtureModels(
      fixtureModel(MODEL_ID, { idOffset: ID_OFFSET, entities: [{ expressId: 42, type: 'IfcWall', name: 'Wall A' }] }),
    );
    seedIsolateStore({
      columns: ['express_id', 'type', 'model_id'],
      rows: [
        [42, 'IfcWall', MODEL_ID],
        [42, 'IfcWall', 'model-unloaded'],
      ],
      models,
    });
    const container = render(<SearchModalFilter />);

    click(isolateButton(container));

    // Row 2's model_id ('model-unloaded') is not in `models`, so it must be
    // dropped rather than falling back to the raw expressId 42, which would
    // collide with row 1's already-resolved global id in the SAME set.
    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([ROW0_GLOBAL_ID]));
  });

  it('shows an error toast and touches no store state when every row is unresolvable', () => {
    const errorMock = mock.method(toast, 'error', () => {});
    try {
      const models = fixtureModels(fixtureModel(MODEL_ID, { idOffset: ID_OFFSET }));
      seedIsolateStore({
        columns: ['express_id', 'type', 'model_id'],
        rows: [[42, 'IfcWall', 'model-unloaded']],
        models,
      });
      const container = render(<SearchModalFilter />);

      click(isolateButton(container));

      assert.equal(errorMock.mock.callCount(), 1);
      assert.equal(useViewerStore.getState().isolatedEntities, null);
      assert.equal(useViewerStore.getState().searchModalOpen, true, 'a no-op run must not close the modal');
    } finally {
      errorMock.mock.restore();
    }
  });

  // `evaluateFilterRulesFederated` is pure/in-memory — filter-evaluate.test.ts
  // drives it directly, no worker/WASM — so a real `runFilter` run IS
  // reachable here, no need for the "too heavy, keep it a source check"
  // escape hatch. It does need a REAL `IfcDataStore`, though: the
  // `fixtureDataStore` helper the rest of this file uses is a deliberately
  // narrow stub (three fields) that the evaluator's iteration-plan machinery
  // doesn't recognise, so this one test builds its model the same way
  // filter-evaluate.test.ts does, via `EntityTableBuilder`.
  //
  // Clicking "Run" against a rule that actually matches proves the run
  // reached the interesting code, not that it early-exited before it. Unlike
  // the deleted suite's other assertions, this is the one the #2532 review
  // singled out as carrying real value: isolateEntities/setSelectedEntityIds
  // must never be called from inside runFilter — "isolation is opt-in".
  it('runFilter (the Run button) never calls isolateEntities or setSelectedEntityIds', async () => {
    const strings = new StringTable();
    const builder = new EntityTableBuilder(1, strings);
    builder.add(42, 'IFCWALL', '1abcdefghijklmnopqrstu', 'Wall A', '', '', false, false);
    const store = {
      fileSize: 0,
      schemaVersion: 'IFC4',
      entityCount: 1,
      parseTime: 0,
      source: new Uint8Array(0),
      entityIndex: { byId: { ranges: new Uint32Array(0), index: new Map() }, byType: new Map([['IFCWALL', [42]]]) },
      strings,
      entities: builder.build(),
      properties: { count: 0 },
      quantities: { count: 0 },
      relationships: { count: 0 },
    } as unknown as IfcDataStore;

    framedIds = [];
    useViewerStore.setState({
      models: new Map([[MODEL_ID, {
        id: MODEL_ID, name: MODEL_ID, visible: true, idOffset: ID_OFFSET, ifcDataStore: store,
      } as never]]),
      activeModelId: MODEL_ID,
      searchFilter: { rules: [Rule.name('contains', 'Wall')], combinator: 'AND', limit: 500 } as never,
      searchFilterResult: null,
      searchFilterRunning: false,
      searchFilterError: null,
      searchModalOpen: true,
      selectedEntityIds: new Set<number>(),
      selectedEntityId: null,
      selectedEntity: null,
      isolatedEntities: null,
      searchVimCycle: null,
      cameraCallbacks: {
        frameSelection: () => { framed += 1; },
        frameEntities: (ids: number[]) => { framedIds.push(ids); },
      } as never,
    });
    const isolateSpy = mock.method(useViewerStore.getState(), 'isolateEntities', () => {});
    const selectSpy = mock.method(useViewerStore.getState(), 'setSelectedEntityIds', () => {});
    try {
      const container = render(<SearchModalFilter />);

      const runButton = [...container.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Run',
      );
      assert.ok(runButton, 'expected a "Run" button');
      click(runButton);

      // runFilter is async (awaits evaluateFilterRulesFederated); drain
      // microtasks until it settles rather than a fixed timer count.
      await advance(60);

      // Prove the run actually reached the evaluator and matched something —
      // otherwise a zero call count would just as well mean "didn't run".
      const result = useViewerStore.getState().searchFilterResult;
      assert.ok(result && result.rows.length > 0, 'precondition: the run must actually match the fixture entity');
      assert.equal(isolateSpy.mock.callCount(), 0, 'runFilter must never call isolateEntities');
      assert.equal(selectSpy.mock.callCount(), 0, 'runFilter must never call setSelectedEntityIds');
    } finally {
      isolateSpy.mock.restore();
      selectSpy.mock.restore();
    }
  });
});
