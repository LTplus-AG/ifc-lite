/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcTypeEnum } from '@ifc-lite/data';
import { IfcParser } from '@ifc-lite/parser';
import type { ListDefinition } from '@ifc-lite/lists';
import { render, cleanup, click, type as typeInto } from '@/test/render.js';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { createListDataProvider } from '@/lib/lists/adapter';
import { runListFederated } from '@/lib/lists/run-list';
import { ListBuilder } from './ListBuilder.js';

const authoredIfc = fileURLToPath(new URL('../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url));
const missingFixture = !existsSync(authoredIfc) && 'Run pnpm fixtures to fetch AC20-FZK-Haus.ifc';

afterEach(() => { cleanup(); setLocale('en'); });

it('authors and executes an exact Building List filter on one and two Archicad models (#5894, #6190)', { skip: missingFixture }, async () => {
  const before = useViewerStore.getState();
  try {
    setLocale('en');
    useViewerStore.setState({ models: new Map(), zoneSets: [] } as never);
    const bytes = readFileSync(authoredIfc);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const provider = createListDataProvider(store, 'AC20-FZK-Haus.ifc');
    const wallIds = provider.getEntitiesByType(IfcTypeEnum.IfcWallStandardCase);
    const buildingName = wallIds.map((id) => provider.getBuildingName?.(id)).find((name) => !!name);
    assert.ok(buildingName, 'the authored IFC must contain a named building with walls');
    const initial: ListDefinition = {
      id: 'ac20-building', name: 'AC20 building', createdAt: 1, updatedAt: 1,
      entityTypes: [IfcTypeEnum.IfcWallStandardCase], groups: [],
      columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
    };
    let saved: ListDefinition | undefined;
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={initial}
        onSave={(definition) => { saved = definition; }} onCancel={() => {}} onExecute={() => {}} />,
    );
    const trigger = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Add rule') as Element;
    act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
    act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
    click([...document.body.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'List value') as Element);
    assert.equal(container.querySelector<HTMLSelectElement>('select[aria-label="List value source"]')?.value, 'spatial');
    assert.equal(container.querySelector<HTMLSelectElement>('select[aria-label="Spatial level"]')?.value, 'Building');
    typeInto(container.querySelector<HTMLInputElement>('input[placeholder="Building name"]')!, buildingName);
    click([...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save') as Element);
    assert.ok(saved);
    assert.deepEqual(saved.groups, [{ combinator: 'AND', rules: [
      { kind: 'listCondition', source: 'spatial', propertyName: 'Building', operator: 'equals', value: buildingName },
    ] }]);
    assert.deepEqual(saved.unreadableConditions, []);

    const pairs = [
      { modelId: 'm1', provider, store },
      { modelId: 'm2', provider: createListDataProvider(store, 'AC20-FZK-Haus copy.ifc'), store },
    ];
    const state = { models: new Map([['m1', {}], ['m2', {}]]), modelTags: new Map(), modelTagAssignments: new Map() };
    const one = await runListFederated(saved, pairs.slice(0, 1), state);
    const many = await runListFederated(saved, pairs, state);
    assert.ok(one.rows.length > 0, 'the saved filter finds the authored building');
    const absent = await runListFederated({ ...saved, groups: [{ combinator: 'AND', rules: [
      { kind: 'listCondition', source: 'spatial', propertyName: 'Building', operator: 'equals', value: '__absent_building__' },
    ] }] }, pairs.slice(0, 1), state);
    assert.equal(absent.rows.length, 0, 'a different authored Building value removes the result');
    assert.deepEqual(many.rows.map(({ modelId }) => modelId).filter((id) => id === 'm1').length, one.rows.length);
    assert.deepEqual(many.rows.map(({ modelId }) => modelId).filter((id) => id === 'm2').length, one.rows.length);
    assert.ok(many.rows.every(({ entityId, modelId }) => {
      const owner = pairs.find((pair) => pair.modelId === modelId);
      return owner?.provider.getBuildingName?.(entityId) === buildingName;
    }), 'every result belongs to the selected authored building in its own model');
  } finally {
    useViewerStore.setState(before, true);
  }
});
