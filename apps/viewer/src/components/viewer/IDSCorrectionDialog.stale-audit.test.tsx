/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5200 — `IDSCorrectionDialog`'s `failedEntities` comes from `specResult`,
 * a captured one-time audit snapshot. Nothing invalidates it when an entity
 * is deleted, so a correction opened after a delete (dialog CLOSED at
 * delete time — no race needed) would list a tombstoned entity, offer it
 * selected, and `handleApply` would write to it via the exact canonical
 * path (`store.setProperty` -> `MutablePropertyView.setProperty`), none of
 * which check `isDeleted`.
 *
 * The fix makes `getCorrectableRequirements` drop entities the active
 * `MutablePropertyView` reports as deleted, and the dialog's `correctable`
 * memo depends on `mutationVersion` so a delete is picked up the next time
 * the dialog (re)computes it. Because the dialog's list, its "N selected /
 * of M" label, and `handleApply`'s write set all derive from that one
 * filtered array, there is nothing left to silently skip at apply time.
 *
 * This mounts the real `IDSCorrectionDialog` against a real
 * `MutablePropertyView` (the `BulkPropertyEditor.collab-gate.test.tsx`
 * fixture-store pattern) and drives Apply through the actual button, so the
 * assertions are on the mutation view's own state — not a mock.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, type as typeInto, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IDSEntityResult, IDSRequirement, IDSSpecificationResult } from '@ifc-lite/ids';
import { IDSCorrectionDialog, getCorrectableRequirements } from './IDSCorrectionDialog.js';

const MODEL_ID = 'model-a';

const requirement: IDSRequirement = {
  id: 'req-fire-rating',
  optionality: 'required',
  facet: {
    type: 'property',
    propertySet: { type: 'simpleValue', value: 'Pset_Test' },
    baseName: { type: 'simpleValue', value: 'Foo' },
  },
};

function entityResult(expressId: number, name: string): IDSEntityResult {
  return {
    expressId,
    modelId: MODEL_ID,
    entityType: 'IfcWall',
    entityName: name,
    passed: false,
    requirementResults: [
      {
        requirement: { ...requirement, label: 'Pset_Test.Foo is present' },
        status: 'fail',
        facetType: 'property',
        checkedDescription: 'Pset_Test.Foo is present',
      },
    ],
  };
}

function specResultWith(entities: IDSEntityResult[]): IDSSpecificationResult {
  return {
    specification: {
      id: 'spec-a',
      name: 'Wall requirements',
      ifcVersions: ['IFC4'],
      applicability: { facets: [] },
      requirements: [requirement],
    },
    status: 'fail',
    applicableCount: entities.length,
    passedCount: 0,
    failedCount: entities.length,
    passRate: 0,
    entityResults: entities,
  };
}

function seedStore(): void {
  const model = fixtureModel(MODEL_ID, {
    entities: [
      { expressId: 1, type: 'IfcWall', name: 'Wall A' },
      { expressId: 2, type: 'IfcWall', name: 'Wall B' },
    ],
  });
  // `fixtureDataStore` deliberately leaves `.properties` and `.source`
  // unset (see store-fixture.ts's own doc comment). The IDS bridge's
  // `collectAllPropertySets` falls back to the parser's
  // `extractPropertiesOnDemand`, which — with neither an on-demand map nor
  // `.source` present — reads `store.properties.getForEntity` UNGUARDED
  // (`columnar-parser.ts`'s `extractPropertiesOnDemand`), so a bare fixture
  // throws before the correction's own `getPropertyValue` call is reached.
  // A `properties` stub with one harmless, non-matching pset satisfies that
  // fallback without pretending a Pset_Test.Foo value already exists.
  const stubDataStore = model.ifcDataStore as unknown as {
    properties?: { getForEntity: (id: number) => unknown[] };
    quantities?: { getForEntity: (id: number) => unknown[] };
  };
  stubDataStore.properties = {
    getForEntity: () => [{ name: '__fixture_stub__', properties: [] }],
  };
  stubDataStore.quantities = { getForEntity: () => [] };
  const seeded = fixtureModels(model);
  useViewerStore.setState({
    ...seeded,
    mutationViews: new Map(),
    mutationVersion: 0,
    collabRole: null,
  });
}

function rawValueInput(): HTMLInputElement {
  const input = [...document.body.querySelectorAll('input')].find(
    (i) => i.placeholder && i.placeholder.length > 0 && i.type !== 'checkbox',
  ) as HTMLInputElement | undefined;
  assert.ok(input, 'the correction value input must render');
  return input!;
}

function applyButton(): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Apply to'),
  ) as HTMLButtonElement | undefined;
  assert.ok(btn, 'Apply button must render');
  return btn!;
}

function checkboxLabelsText(): string[] {
  return [...document.body.querySelectorAll('label')]
    .filter((l) => l.querySelector('input[type="checkbox"]'))
    .map((l) => l.textContent ?? '');
}

describe('IDSCorrectionDialog — stale audit snapshot vs. deleted entities (#5200)', () => {
  afterEach(() => {
    cleanup();
  });

  it('a normal correction on live entities applies to ALL of them and reports the right count (no-regression pin)', async () => {
    seedStore();
    const specResult = specResultWith([entityResult(1, 'Wall A'), entityResult(2, 'Wall B')]);

    render(
      <IDSCorrectionDialog
        open
        onOpenChange={() => {}}
        specResult={specResult}
        modelId={MODEL_ID}
        onRevalidate={async () => {}}
      />,
    );
    await advance(0);

    assert.deepEqual(
      checkboxLabelsText().map((t) => t.trim()),
      ['Wall A', 'Wall B'],
      'both live entities must be listed',
    );

    typeInto(rawValueInput(), 'F90');
    click(applyButton());
    await advance(50);

    const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
    assert.ok(view, 'a mutation view must be registered');
    assert.equal(view!.getPropertyValue(1, 'Pset_Test', 'Foo'), 'F90');
    assert.equal(view!.getPropertyValue(2, 'Pset_Test', 'Foo'), 'F90');

    const summary = document.body.textContent ?? '';
    assert.match(summary, /2/, 'the summary must report 2 entities corrected');
  });

  it('an entity deleted with the dialog CLOSED does not appear, is not selected, and is NOT written to when it opens later', async () => {
    seedStore();

    // Register the mutation view and delete entity 2 BEFORE the dialog ever
    // opens — the exact #5200 repro: no race, the dialog's audit snapshot is
    // just stale by the time it's opened.
    const view = new MutablePropertyView(null, MODEL_ID);
    useViewerStore.getState().registerMutationView(MODEL_ID, view);
    assert.equal(view.deleteEntity(2), true, 'entity 2 must tombstone');
    useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });

    const specResult = specResultWith([entityResult(1, 'Wall A'), entityResult(2, 'Wall B')]);

    render(
      <IDSCorrectionDialog
        open
        onOpenChange={() => {}}
        specResult={specResult}
        modelId={MODEL_ID}
        onRevalidate={async () => {}}
      />,
    );
    await advance(0);

    const labels = checkboxLabelsText().map((t) => t.trim());
    assert.deepEqual(labels, ['Wall A'], 'the deleted entity (Wall B) must not be listed at all');

    typeInto(rawValueInput(), 'F90');
    click(applyButton());
    await advance(50);

    assert.equal(
      view.getPropertyValue(1, 'Pset_Test', 'Foo'),
      'F90',
      'the live entity must still be corrected',
    );
    assert.equal(
      view.getPropertyValue(2, 'Pset_Test', 'Foo'),
      null,
      'Apply must NOT write to the deleted entity — this is the #5200 stale-snapshot bug',
    );
    assert.equal(view.isDeleted(2), true, 'entity 2 must still be tombstoned (no resurrection via the write path)');

    const summary = document.body.textContent ?? '';
    assert.match(summary, /1/, 'the reported count must reflect the ONE entity actually written to, not the original 2');
  });
});

describe('getCorrectableRequirements — isDeleted filtering (#5200)', () => {
  it('drops a tombstoned entity from failedEntities while keeping live ones', () => {
    const specResult = specResultWith([entityResult(1, 'Wall A'), entityResult(2, 'Wall B')]);
    const result = getCorrectableRequirements(specResult, (expressId) => expressId === 2);
    assert.equal(result.length, 1);
    assert.deepEqual(
      result[0].failedEntities.map((e) => e.expressId),
      [1],
      'only the live entity should remain',
    );
  });

  it('with no isDeleted predicate, behaves exactly as before (both entities present)', () => {
    const specResult = specResultWith([entityResult(1, 'Wall A'), entityResult(2, 'Wall B')]);
    const result = getCorrectableRequirements(specResult);
    assert.deepEqual(result[0].failedEntities.map((e) => e.expressId), [1, 2]);
  });

  it('a predicate that reports EVERYTHING deleted empties the requirement entirely (mutation-test control)', () => {
    const specResult = specResultWith([entityResult(1, 'Wall A'), entityResult(2, 'Wall B')]);
    const result = getCorrectableRequirements(specResult, () => true);
    assert.equal(result.length, 0, 'a requirement with zero surviving entities must not be offered at all');
  });
});
