/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #4317: `ListPanel.handleExecuteList` swallowed a run failure into
 * `console.error` with no user-visible consequence — the spinner stopped, the
 * panel never advanced to `results`, and nothing on screen said why. That
 * became reachable once `compileNameMatcher` (`packages/lists/src/name-pattern.ts`)
 * started THROWING on a catastrophic-backtracking or over-length `/regex/`
 * name-pattern column, via `@ifc-lite/regex-guard` (#4262/#4292): a user
 * typing such a pattern into a property/quantity column got a silent no-op
 * that reads identically to a genuine empty result.
 *
 * This drives the real button click through the real store-backed component
 * (not `handleExecuteList`'s source in isolation) and asserts on rendered DOM
 * text and real store state, mirroring
 * `SearchModal.filter.wiring.test.tsx`'s equivalent proof for the advanced
 * filter's `runFilter`.
 */

import '@/test/setup-dom.js';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { ListDefinition } from '@/lib/lists';
import { ListPanel } from './ListPanel.js';

const MODEL_ID = 'model-a';

/** One real, geometry-bearing IfcWall — enough for `getAllEntityIds` /
 *  `getEntitiesByType` to return a non-empty row set, so the column resolver
 *  actually runs (an empty source set would never reach `compileNameMatcher`
 *  and the test would pass for the wrong reason). */
function buildStore(): IfcDataStore {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(1, strings);
  builder.add(42, 'IFCWALL', '1abcdefghijklmnopqrstu', 'Wall A', '', '', true, false);
  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: 1,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: { ranges: new Uint32Array(0), index: new Map() }, byType: new Map([['IFCWALL', [42]]]) },
    strings,
    entities: builder.build(),
    // No properties/quantities on-demand map and no `.getForEntity` needed:
    // `findPropertyEntry` compiles BOTH matchers (set name, then property
    // name) before it ever looks at a pset, so the throw fires on the
    // property-name matcher regardless of whether any psets exist.
    properties: undefined,
    quantities: undefined,
    // The type-property fallback (issue #1745) calls `relationships.getRelated`
    // to find the element's IfcTypeProduct even when the instance itself has
    // no matching property — needed so `definitionWithNoMatch` resolves to a
    // clean "not found" instead of throwing on a missing stub.
    relationships: { count: 0, getRelated: () => [] },
    spatialHierarchy: undefined,
  } as unknown as IfcDataStore;
}

/** A saved list with one `property` column whose pattern the ReDoS guard
 *  rejects — the nested-quantifier catastrophic-backtracking shape, the same
 *  class covered by `packages/lists/src/name-pattern.test.ts`. */
function definitionWithBadPattern(): ListDefinition {
  return {
    id: 'list-bad-pattern',
    name: 'Bad Pattern List',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    entityTypes: [],
    conditions: [],
    columns: [
      { id: 'col-1', source: 'property', psetName: 'Pset_WallCommon', propertyName: '/(a+)+$/', label: 'Bad' },
    ],
  } as unknown as ListDefinition;
}

/** A list with an ordinary, always-absent property — a genuinely empty
 *  result, which must read as an ordinary empty result, NOT as an error
 *  (the issue's "both directions" requirement). */
function definitionWithNoMatch(): ListDefinition {
  return {
    id: 'list-empty',
    name: 'Empty List',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    entityTypes: [],
    conditions: [],
    columns: [
      { id: 'col-1', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'NeverThere', label: 'Missing' },
    ],
  } as unknown as ListDefinition;
}

function seedStore(definitions: ListDefinition[]) {
  useViewerStore.setState({
    models: new Map([[MODEL_ID, {
      id: MODEL_ID,
      name: MODEL_ID,
      visible: true,
      idOffset: 0,
      ifcDataStore: buildStore(),
    } as never]]),
    activeModelId: MODEL_ID,
    listDefinitions: definitions,
    activeListId: null,
    listResult: null,
    listExecuting: false,
    listError: null,
    listPanelVisible: true,
    pendingListDraft: null,
    zoneSets: [],
    zoneAssignments: {} as never,
    zoneApportionment: undefined,
  } as never);
}

let initialState: ReturnType<typeof useViewerStore.getState>;

describe('ListPanel — execution failure surfaces to the user (#4317)', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  it('a rejected name-pattern column ends in a visible error, not a silent empty result', async () => {
    const definition = definitionWithBadPattern();
    seedStore([definition]);
    const container = render(<ListPanel />);

    // The whole library row's onClick runs the list (`ListItem`'s root
    // div, same as clicking the hover-revealed Play button) — click the
    // row by its rendered name rather than the icon-only Play button,
    // which only becomes clickable UI on hover in a real browser.
    const row = container.querySelector(`button[aria-label="Run list ${definition.name}"]`);
    assert.ok(row, `expected a Run button for ${JSON.stringify(definition.name)}`);
    click(row as Element);

    // handleExecuteList runs its try/catch inside a requestAnimationFrame
    // callback; drain it.
    await advance(60);

    const state = useViewerStore.getState();
    assert.equal(state.listExecuting, false, 'a thrown run must still clear the executing flag (finally)');
    assert.equal(state.listResult, null, 'a rejected run must not publish a (false-clean) empty result');
    assert.ok(state.listError, 'the rejection must be recorded in the store, not only console.error-ed');
    assert.match(state.listError!, /rejected name pattern/, 'the reason must name the pattern, not a generic failure');

    // The mutation this guards against: a caught-but-unrendered error reads
    // identically to an empty result on screen.
    assert.match(
      container.textContent ?? '',
      /List failed/,
      'the failure must actually render, not just live in unread store state',
    );
  });

  it('a genuinely empty result set reads as an empty result, not as an error (both directions)', async () => {
    const definition = definitionWithNoMatch();
    seedStore([definition]);
    const container = render(<ListPanel />);

    const row = container.querySelector(`button[aria-label="Run list ${definition.name}"]`);
    assert.ok(row, `expected a Run button for ${JSON.stringify(definition.name)}`);
    click(row as Element);

    await advance(60);

    const state = useViewerStore.getState();
    assert.equal(state.listExecuting, false);
    assert.equal(state.listError, null, 'a clean run with zero matches must not set an error');
    assert.ok(state.listResult, 'a clean run must publish a result, even with every cell null');
    assert.equal(state.listResult!.totalCount, 1, 'the one wall is still a row — its column value is null, not the row itself');

    assert.doesNotMatch(
      container.textContent ?? '',
      /List failed/,
      'an ordinary empty/null result must not render as a failure',
    );
  });
});
