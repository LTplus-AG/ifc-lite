/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6190: the shared Rules editor in the Lists builder authors every Lists
 * value predicate as a `listCondition` rule. Authored through the UI, saved,
 * reopened and run at one and two parsed models, the rule keeps the rows
 * `executeList` keeps for the same condition.
 */

import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcTypeEnum } from '@ifc-lite/data';
import { executeList, type ListDefinition, type PropertyCondition } from '@ifc-lite/lists';
import type { FilterRule, ModelTag } from '@ifc-lite/rules';
import { render, cleanup, click, type as typeInto } from '@/test/render.js';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { runListFederated, type ModelProviderPair } from '@/lib/lists/run-list';
import { ZONE_SET, models } from '@/lib/lists/__fixtures__/list-condition-models';
import { ListBuilder } from './ListBuilder.js';

const initial: ListDefinition = {
  id: 'walls', name: 'Walls', createdAt: 1, updatedAt: 1, entityTypes: [IfcTypeEnum.IfcWall], groups: [],
  columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
};
const state = {
  models: new Map([['m1', {}], ['m2', {}]]),
  modelTags: new Map<string, ModelTag>(),
  modelTagAssignments: new Map<string, ReadonlySet<string>>(),
};

function choose(select: HTMLSelectElement | null, value: string): void {
  assert.ok(select, `select for ${value}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  assert.ok(setter);
  act(() => { setter.call(select, value); select.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
const select = (root: ParentNode, label: string) => root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
const options = (el: HTMLSelectElement | null) => [...(el?.options ?? [])].map((o) => o.textContent);
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as Element;

function addListValue(container: HTMLElement): HTMLElement {
  const trigger = button(container, 'Add rule');
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent?.trim() === 'List value');
  assert.ok(item, 'the Lists builder offers List value');
  click(item);
  const rows = [...container.querySelectorAll<HTMLElement>('select[aria-label="List value source"]')];
  return rows[rows.length - 1]!.parentElement!;
}

function mount(pairs: ModelProviderPair[], list: ListDefinition, onSave: (d: ListDefinition) => void) {
  return render(
    <ListBuilder providers={pairs.map((p) => p.provider)} stores={pairs.map((p) => p.store)} modelIds={pairs.map((p) => p.modelId)}
      initial={list} onSave={onSave} onCancel={() => {}} onExecute={() => {}} />,
  );
}

describe('List value rules in the Lists builder (#6190)', () => {
  let before: ReturnType<typeof useViewerStore.getState>;
  beforeEach(() => {
    before = useViewerStore.getState();
    setLocale('en');
    useViewerStore.setState({ models: new Map(), zoneSets: [ZONE_SET] } as never);
  });
  afterEach(() => { cleanup(); useViewerStore.setState(before, true); });

  it('authors a zone and an exact spatial level rule, saves, reopens and runs them at one and two models', async () => {
    const pairs = await models();
    let saved: ListDefinition | undefined;
    const container = mount(pairs, initial, (d) => { saved = d; });

    const zoneRow = addListValue(container);
    choose(select(zoneRow, 'List value source'), 'zone');
    assert.equal(select(zoneRow, 'Zone set')?.value, ZONE_SET.id, 'the zone set is stored by id');
    assert.deepEqual(options(select(zoneRow, 'Zone set')), ['Sections'], 'and shown by name');
    assert.deepEqual(options(select(zoneRow, 'Zone display mode')), ['Zone', 'Straddles', 'Volume (mesh)', 'Volume breakdown (mesh)']);
    choose(select(zoneRow, 'Zone display mode'), 'Straddles');
    typeInto(zoneRow.querySelector<HTMLInputElement>('input[placeholder="true / false"]')!, 'true');

    const spatialRow = addListValue(container);
    assert.deepEqual(options(select(spatialRow, 'Spatial level')), ['Container', 'Storey', 'Building', 'Site', 'Project']);
    choose(select(spatialRow, 'Spatial level'), 'Container');
    typeInto(spatialRow.querySelector<HTMLInputElement>('input[placeholder="Container name"]')!, 'Room 1');

    click(button(container, 'Save'));
    assert.ok(saved);
    const zone: PropertyCondition = { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Straddles', operator: 'equals', value: 'true' };
    const level: PropertyCondition = { source: 'spatial', propertyName: 'Container', operator: 'equals', value: 'Room 1' };
    assert.deepEqual(saved.groups, [{ combinator: 'AND', rules: [{ kind: 'listCondition', ...zone }, { kind: 'listCondition', ...level }] }]);

    cleanup();
    const reopened = mount(pairs, saved, () => {});
    const [zoneAgain, levelAgain] = [...reopened.querySelectorAll<HTMLSelectElement>('select[aria-label="List value source"]')].map((s) => s.parentElement!);
    assert.equal(select(zoneAgain!, 'List value source')?.value, 'zone');
    assert.equal(select(zoneAgain!, 'Zone set')?.value, ZONE_SET.id);
    assert.equal(select(zoneAgain!, 'Zone display mode')?.value, 'Straddles');
    assert.equal(select(levelAgain!, 'Spatial level')?.value, 'Container');

    for (const scope of [pairs.slice(0, 1), pairs]) {
      const result = await runListFederated(saved, scope, { ...state, models: new Map(scope.map(({ modelId }) => [modelId, {}])) });
      const expected = scope.flatMap(({ modelId, provider }) =>
        executeList({ ...initial, legacyConditions: [zone, level] }, provider, modelId).rows);
      assert.deepEqual(result.rows.map((r) => `${r.modelId}:${r.entityId}`).sort(), expected.map((r) => `${r.modelId}:${r.entityId}`).sort());
      assert.ok(result.rows.length > 0, `the authored rules keep a straddling wall at ${scope.length} model(s)`);
    }
  });

  it('offers the comparisons each zone mode reads, and authors volume > 1.8 that runs like executeList (review finding on #6250)', async () => {
    const pairs = await models();
    let saved: ListDefinition | undefined;
    const container = mount(pairs, initial, (d) => { saved = d; });
    const row = addListValue(container);
    choose(select(row, 'List value source'), 'zone');
    const opsNow = () => [...(select(row, 'Operator')?.options ?? [])].map((o) => o.value);
    assert.deepEqual(opsNow(), ['equals', 'notEquals', 'contains', 'exists'], 'the zone name is text');
    choose(select(row, 'Zone display mode'), 'Straddles');
    assert.deepEqual(opsNow(), ['equals', 'notEquals', 'exists'], 'Straddles is a boolean');
    choose(select(row, 'Zone display mode'), 'Volume breakdown (mesh)');
    assert.deepEqual(opsNow(), ['equals', 'notEquals', 'contains', 'exists'], 'the breakdown is text');
    choose(select(row, 'Zone display mode'), 'Volume (mesh)');
    assert.deepEqual(opsNow(), ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'exists'], 'a volume is a number');
    choose(select(row, 'Operator'), 'gt');
    typeInto(row.querySelector<HTMLInputElement>('input[placeholder="volume"]')!, '1.8');
    click(button(container, 'Save'));
    const volume: PropertyCondition = { source: 'zone', psetName: ZONE_SET.id, propertyName: 'Volume (mesh)', operator: 'gt', value: '1.8' };
    assert.deepEqual(saved?.groups, [{ combinator: 'AND', rules: [{ kind: 'listCondition', ...volume }] }]);
    for (const scope of [pairs.slice(0, 1), pairs]) {
      const result = await runListFederated(saved!, scope, { ...state, models: new Map(scope.map(({ modelId }) => [modelId, {}])) });
      const expected = scope.flatMap(({ modelId, provider }) => executeList({ ...initial, legacyConditions: [volume] }, provider, modelId).rows);
      const keys = (rows: ReadonlyArray<{ modelId: string; entityId: number }>) => rows.map((r) => `${r.modelId}:${r.entityId}`).sort();
      assert.deepEqual(keys(result.rows), keys(expected));
      assert.deepEqual(keys(result.rows), scope.length === 1 ? ['m1:10'] : ['m1:10', 'm2:35'], 'only home-zone volumes above 1.8');
    }
  });

  it('keeps a zone rule on a deleted set, named as missing, instead of moving it to another set', async () => {
    const pairs = await models();
    const gone: FilterRule = { kind: 'listCondition', source: 'zone', psetName: 'zs-gone', propertyName: 'Zone', operator: 'equals', value: 'Zone A' };
    let saved: ListDefinition | undefined;
    const container = mount(pairs, { ...initial, groups: [{ combinator: 'AND', rules: [gone] }] }, (d) => { saved = d; });
    const zoneSet = select(container, 'Zone set');
    assert.equal(zoneSet?.value, 'zs-gone');
    assert.deepEqual(options(zoneSet), ['Missing zone set (zs-gone)', 'Sections']);
    click(button(container, 'Save'));
    assert.deepEqual(saved?.groups[0]?.rules, [gone]);
  });

  it('offers each source\'s own controls, and presence hides the value', async () => {
    const pairs = await models();
    const container = mount(pairs, initial, () => {});
    const row = addListValue(container);
    const controls: Record<string, string[]> = {
      zone: ['Zone set', 'Zone display mode'],
      spatial: ['Spatial level'],
      attribute: ['Attribute'],
      geometry: ['Coordinate axis'],
      property: ['Where a missing value may come from'],
      quantity: ['Where a missing value may come from'],
    };
    for (const source of ['zone', 'spatial', 'model', 'attribute', 'property', 'quantity', 'material', 'classification', 'geometry']) {
      choose(select(row, 'List value source'), source);
      for (const label of controls[source] ?? []) assert.ok(select(row, label), `${source} shows ${label}`);
      choose(select(row, 'Operator'), 'exists');
      assert.equal(row.querySelectorAll('input').length, source === 'property' || source === 'quantity' ? 2 : 0,
        `${source} presence needs no value`);
    }
    choose(select(row, 'List value source'), 'attribute');
    assert.ok(options(select(row, 'Attribute')).includes('GlobalId'), 'pseudo-attributes are offered');
  });
});
