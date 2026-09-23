/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens classification must read the live mutation overlay, not just the
 * file's pre-edit value (#5207). The search/filter-rule evaluator already
 * applies the overlay for property, attribute and quantity reads
 * (`filter-evaluate-mutations.ts`); the lens adapter did not, so editing a
 * property/Name/quantity and then applying (or re-applying) a lens rule
 * keyed on the new value missed the element, and a rule keyed on the OLD
 * value still matched it.
 *
 * Each of the three edit kinds is covered by its own `evaluateLens` run,
 * against a real `IfcParser.parseColumnar` store and a real
 * `MutablePropertyView` wired the way `configureMutationView` wires it for
 * the live viewer — per the issue's own executed reproduction table.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { evaluateAutoColorLens, evaluateLens } from '@ifc-lite/lens';
import type { Lens } from '@ifc-lite/lens';
import type { FederatedModel } from '@/store/types';
import { configureMutationView } from '@/utils/configureMutationView';
import { createLensDataProvider } from './adapter';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#41=IFCWALL('0Wall00000000000000041',$,'Wall-A',$,$,$,$,$,$);
#50=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('F90'),$);
#51=IFCPROPERTYSET('0Pset00000000000000051',$,'Pset_WallCommon',$,(#50));
#52=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000052',$,$,$,(#41),#51);
#60=IFCQUANTITYLENGTH('Length',$,$,5000.,$);
#61=IFCELEMENTQUANTITY('0Qto00000000000000061',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#60));
#62=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000062',$,$,$,(#41),#61);
ENDSEC;
END-ISO-10303-21;`;

async function parsedStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(FIXTURE);
  return new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
}

/** A configured `MutablePropertyView`, wired the same way
 *  `configureMutationView` (apps/viewer/src/utils) wires the live viewer's
 *  per-model view — the on-demand property/quantity extractors and the
 *  base-attribute resolver all come from that one function, not hand-rolled
 *  here, so the test exercises the real wiring. */
function liveView(store: IfcDataStore): MutablePropertyView {
  const view = new MutablePropertyView(store.properties ?? null, 'm1');
  configureMutationView(view, store);
  return view;
}

/** Only the fields `createLensDataProvider` reads off a FederatedModel. */
function federatedModel(id: string, ifcDataStore: IfcDataStore): FederatedModel {
  return { id, name: id, ifcDataStore, idOffset: 0, maxExpressId: 999 } as FederatedModel;
}

function ruleOn(propOrAttrOrQty: Lens['rules'][number]['criteria'], value: string): Lens {
  return {
    id: 'lens',
    name: 'Lens',
    rules: [
      { id: 'r', name: 'r', enabled: true, criteria: { ...propOrAttrOrQty, ...valueField(propOrAttrOrQty, value) }, action: 'colorize', color: '#ff0000' },
    ],
  };
}

// Each criteria "type" keys its comparison value under a different field
// name (LensCriteria in packages/lens/src/types.ts) — this just routes to
// the right one so the three tests below can share one `ruleOn` helper.
function valueField(criteria: Lens['rules'][number]['criteria'], value: string) {
  if (criteria.type === 'property') return { propertyValue: value };
  if (criteria.type === 'attribute') return { attributeValue: value };
  return { quantityValue: value };
}

describe('lens adapter reads the live mutation overlay (#5207)', () => {
  it('enumerates live source rows and creations, excluding tombstones and created-then-deleted rows (#5249)', async () => {
    const store = await parsedStore();
    const view = liveView(store);
    const models = new Map([['m1', federatedModel('m1', store)]]);
    const base = createLensDataProvider(models, null);
    const sourceIds: number[] = [];
    base.forEachEntity((id) => sourceIds.push(id));

    view.setExpressIdWatermark(999);
    const created = view.createEntity('IfcWall', []);
    const forgotten = view.createEntity('IfcDoor', []);
    view.deleteEntity(41);
    view.deleteEntity(forgotten.expressId);
    const refs = new Map([[created.expressId, { modelId: 'm1', expressId: created.expressId }]]);
    const provider = createLensDataProvider(models, null, new Map([['m1', view]]),
      (globalId) => refs.get(globalId) ?? { modelId: 'm1', expressId: globalId });
    assert.equal(provider.getEntityType(created.expressId), 'IfcWall', 'created id resolves before an enumeration callback');
    const liveIds: number[] = [];
    provider.forEachEntity((id) => liveIds.push(id));

    assert.deepEqual(liveIds, [...sourceIds.filter((id) => id !== 41), created.expressId]);
    assert.equal(provider.getEntityCount(), liveIds.length);
    assert.equal(liveIds.includes(forgotten.expressId), false);
    const colorized = evaluateAutoColorLens({ source: 'ifcType' }, provider);
    assert.equal(colorized.colorMap.has(41), false);
    assert.equal(colorized.colorMap.has(created.expressId), true);
  });

  it('keeps each federated model\'s live entity set isolated (#5249)', async () => {
    const store = await parsedStore();
    const first = liveView(store);
    const second = new MutablePropertyView(store.properties ?? null, 'm2');
    configureMutationView(second, store);
    first.deleteEntity(41);
    second.setExpressIdWatermark(999);
    const created = second.createEntity('IfcWall', []);
    const models = new Map([
      ['m1', federatedModel('m1', store)],
      ['m2', { ...federatedModel('m2', store), idOffset: 1_000_000 }],
    ]);
    const createdGlobalId = 1_000_000 + created.expressId;
    const provider = createLensDataProvider(models, null, new Map([['m1', first], ['m2', second]]),
      (globalId) => globalId === createdGlobalId ? { modelId: 'm2', expressId: created.expressId } : null);
    assert.equal(provider.getEntityType(createdGlobalId), 'IfcWall', 'created id resolves to its own model');
    const byModel = new Map<string, number[]>();
    provider.forEachEntity((globalId, modelId) => {
      const ids = byModel.get(modelId) ?? [];
      ids.push(globalId);
      byModel.set(modelId, ids);
    });

    assert.equal(byModel.get('m1')?.includes(41), false);
    assert.equal(byModel.get('m2')?.includes(1_000_000 + 41), true);
    assert.equal(byModel.get('m1')?.includes(created.expressId), false);
    assert.equal(byModel.get('m2')?.includes(createdGlobalId), true);
    assert.equal(provider.getEntityCount(), [...byModel.values()].reduce((count, ids) => count + ids.length, 0));
  });

  it('a property edit: rule on the new value matches, rule on the old value does not', async () => {
    const store = await parsedStore();
    const view = liveView(store);
    view.setProperty(41, 'Pset_WallCommon', 'FireRating', 'F999', PropertyValueType.String);

    const models = new Map([['m1', federatedModel('m1', store)]]);
    const mutationViews = new Map([['m1', view]]);
    const provider = createLensDataProvider(models, null, mutationViews);

    const newRule = ruleOn({ type: 'property', propertySet: 'Pset_WallCommon', propertyName: 'FireRating', operator: 'equals' }, 'F999');
    const oldRule = ruleOn({ type: 'property', propertySet: 'Pset_WallCommon', propertyName: 'FireRating', operator: 'equals' }, 'F90');

    assert.deepEqual(evaluateLens(newRule, provider).ruleEntityIds.get('r'), [41], 'matches the edited value');
    assert.deepEqual(evaluateLens(oldRule, provider).ruleEntityIds.get('r'), [], 'no longer matches the stale value');
  });

  it('an attribute (Name) edit: rule on the new value matches, rule on the old value does not', async () => {
    const store = await parsedStore();
    const view = liveView(store);
    view.setAttribute(41, 'Name', 'Wall-A-RENAMED');

    const models = new Map([['m1', federatedModel('m1', store)]]);
    const mutationViews = new Map([['m1', view]]);
    const provider = createLensDataProvider(models, null, mutationViews);

    const newRule = ruleOn({ type: 'attribute', attributeName: 'Name', operator: 'equals' }, 'Wall-A-RENAMED');
    const oldRule = ruleOn({ type: 'attribute', attributeName: 'Name', operator: 'equals' }, 'Wall-A');

    assert.deepEqual(evaluateLens(newRule, provider).ruleEntityIds.get('r'), [41], 'matches the edited value');
    assert.deepEqual(evaluateLens(oldRule, provider).ruleEntityIds.get('r'), [], 'no longer matches the stale value');
  });

  it('a quantity edit: rule on the new value matches, rule on the old value does not', async () => {
    const store = await parsedStore();
    const view = liveView(store);
    view.setQuantity(41, 'Qto_WallBaseQuantities', 'Length', 9999, QuantityType.Length);

    const models = new Map([['m1', federatedModel('m1', store)]]);
    const mutationViews = new Map([['m1', view]]);
    const provider = createLensDataProvider(models, null, mutationViews);

    const newRule = ruleOn({ type: 'quantity', quantitySet: 'Qto_WallBaseQuantities', quantityName: 'Length', operator: 'equals' }, '9999');
    const oldRule = ruleOn({ type: 'quantity', quantitySet: 'Qto_WallBaseQuantities', quantityName: 'Length', operator: 'equals' }, '5000');

    assert.deepEqual(evaluateLens(newRule, provider).ruleEntityIds.get('r'), [41], 'matches the edited value');
    assert.deepEqual(evaluateLens(oldRule, provider).ruleEntityIds.get('r'), [], 'no longer matches the stale value');
  });

  it('no-regression: an entity with NO edits classifies exactly as before', async () => {
    const store = await parsedStore();
    const view = liveView(store); // configured, but nothing edited

    const models = new Map([['m1', federatedModel('m1', store)]]);
    const withView = createLensDataProvider(models, null, new Map([['m1', view]]));
    const withoutView = createLensDataProvider(models, null, undefined);

    const rule = ruleOn({ type: 'property', propertySet: 'Pset_WallCommon', propertyName: 'FireRating', operator: 'equals' }, 'F90');

    assert.deepEqual(evaluateLens(rule, withView).ruleEntityIds.get('r'), [41], 'unedited entity still matches its base value with a (no-op) view present');
    assert.deepEqual(
      evaluateLens(rule, withView).ruleEntityIds.get('r'),
      evaluateLens(rule, withoutView).ruleEntityIds.get('r'),
      'identical classification with and without a mutation view when nothing was edited',
    );
  });
});
