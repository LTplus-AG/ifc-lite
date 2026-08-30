/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3346: `composeTeardown` drops an entry with `Object.is`, which cannot
 * see through a rebuilt `Set` / `Map` / array. `visibilitySlice.teardown.ts`
 * and `selectionSlice.teardown.ts` gate their `model-removed` arm with ONE
 * `touched` boolean covering several fields, so once ANY of those fields
 * names the removed model, every field in the group is rebuilt — including
 * the ones that, individually, did not change. A rebuilt-but-equal `Set` /
 * array is a fresh reference, so it survives `Object.is` and lands in the
 * composed patch, defeating any downstream `Object.is` / memo check on that
 * key.
 *
 * These tests assert on PRESENCE of a key in the composed patch (the
 * observable proxy for "a new reference was written"), which is what a
 * subscriber keyed on `Object.is` actually sees. `deepStrictEqual` on VALUE
 * would pass whether or not the reference moved and could not see this bug.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { useViewerStore } from './index.js';
import { viewerTeardown } from './teardown-registry.js';
import { modelRemovedScope } from './teardown-scope.js';
import type { FederatedModel } from './types.js';

function model(id: string, idOffset: number, maxExpressId: number): FederatedModel {
  return { id, name: id, visible: true, idOffset, maxExpressId } as unknown as FederatedModel;
}

describe('composeTeardown does not rewrite an untouched field as equal-but-new (#3346)', () => {
  it('visibilitySlice: hiddenEntitiesByModel naming the removed model must not rewrite isolatedEntities / ghostExceptEntities, which name only a survivor', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'A',
      // Only this field names the removed model — it is what makes
      // `visibilitySlice`'s `touched` boolean true.
      hiddenEntitiesByModel: new Map([['A', new Set([1])]]),
      isolatedEntitiesByModel: new Map(),
      // Neither of these names anything inside A's range: both survive B's
      // range untouched in VALUE, but `touched` still forces both through
      // `nonEmptyOrNull`, which allocates a fresh `Set` unconditionally.
      isolatedEntities: new Set([1050]),
      ghostExceptEntities: new Set([1060]),
      hiddenEntities: undefined,
      classFilter: null,
    });

    const state = useViewerStore.getState();
    const patch = viewerTeardown(modelRemovedScope(state, 'A'), state);

    // The field that actually moved must be in the patch, or this fixture
    // proves nothing about the mixed case.
    assert.ok(
      'hiddenEntitiesByModel' in patch,
      'hiddenEntitiesByModel must be rewritten: it is the field that actually named the removed model',
    );

    assert.ok(
      !('isolatedEntities' in patch),
      'isolatedEntities did not change value (1050 survives in model B) and must not be rewritten ' +
        'as an equal-but-new Set just because a sibling field in the same slice moved',
    );
    assert.ok(
      !('ghostExceptEntities' in patch),
      'ghostExceptEntities did not change value (1060 survives in model B) and must not be rewritten ' +
        'as an equal-but-new Set just because a sibling field in the same slice moved',
    );
  });

  it('visibilitySlice: hiddenEntitiesByModel naming the removed model must not rewrite classFilter, a PLAIN OBJECT ({ ids, label }) whose own ids name only a survivor', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'A',
      // Only this field names the removed model — it is what makes
      // `visibilitySlice`'s `touched` boolean true.
      hiddenEntitiesByModel: new Map([['A', new Set([1])]]),
      isolatedEntitiesByModel: new Map(),
      isolatedEntities: null,
      ghostExceptEntities: null,
      hiddenEntities: undefined,
      // Names only the surviving model B: `touched` still forces this through
      // `{ ids: kept, label }`, a FRESH plain object, unconditionally — even
      // though `kept`'s ids are identical to `classFilter.ids`.
      classFilter: { ids: new Set([1050]), label: 'Doors' },
    });

    const state = useViewerStore.getState();
    const patch = viewerTeardown(modelRemovedScope(state, 'A'), state);

    assert.ok(
      'hiddenEntitiesByModel' in patch,
      'hiddenEntitiesByModel must be rewritten: it is the field that actually named the removed model',
    );
    assert.ok(
      !('classFilter' in patch),
      'classFilter holds only a B-owned id and must not be rewritten as an equal-but-new ' +
        '{ ids, label } object just because hiddenEntitiesByModel, a sibling field, named the removed model',
    );
  });

  it('selectionSlice: selectedModelId naming the removed model must not rewrite selectedEntities / selectedEntitiesSet, which name only a survivor', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'A',
      // Only this field names the removed model — it is what makes
      // `selectionSlice`'s `refsTouched` boolean true.
      selectedModelId: 'A',
      selectedEntity: null,
      activeStorey: null,
      // Both name only the surviving model B: their CONTENT does not change,
      // but the filter that builds them runs unconditionally once
      // `refsTouched` is true, allocating a fresh array / Set either way.
      selectedEntities: [{ modelId: 'B', expressId: 5 }],
      selectedEntitiesSet: new Set(['B:5']),
      selectedEntityId: null,
      selectedEntityIds: new Set(),
      selectedStoreys: new Set(),
    });

    const state = useViewerStore.getState();
    const patch = viewerTeardown(modelRemovedScope(state, 'A'), state);

    assert.ok(
      'selectedModelId' in patch,
      'selectedModelId must be rewritten: it is the field that actually named the removed model',
    );

    assert.ok(
      !('selectedEntities' in patch),
      'selectedEntities holds only a B-owned entry and must not be rewritten as an equal-but-new ' +
        'array just because selectedModelId, a sibling field, named the removed model',
    );
    assert.ok(
      !('selectedEntitiesSet' in patch),
      'selectedEntitiesSet holds only a B-owned entry and must not be rewritten as an equal-but-new ' +
        'Set just because selectedModelId, a sibling field, named the removed model',
    );
  });
});
