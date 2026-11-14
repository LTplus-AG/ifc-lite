/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9296 (modelling parity, type-editing row): a wall type made in the Model
 * workspace and given a property set showed that set on the type, and exported
 * it under HasPropertySets, but the wall drawn with the type showed nothing.
 * The panel looked the type up in the parsed file's relationships, which do not
 * hold a type assigned this session.
 *
 * Real parsed store, real session writes (`addWall`, the inspector's
 * "New type…"), real `PropertiesPanel` and inline editor.
 */

import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PropertyValueType } from '@ifc-lite/data';
import { advance, cleanup, click, press, render, type } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { openInlineEditor, panelRows } from '@/test/properties-panel-harness.js';
import '@/lib/commands/modeling/builtin';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';
import { createElementType, setElementType } from './model-inspector/inspector-edits.js';
import { PropertiesPanel } from './PropertiesPanel.js';

const s = () => useViewerStore.getState();
const SET = 'Pset_WallCommon';

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(button, `button "${text}" must render`);
  return button as HTMLButtonElement;
}

/** The value a set holds for FireRating on `entityId`, read through the live overlay. */
function fireRating(entityId: number): unknown {
  return s().mutationViews.get(MODEL_ID)?.getForEntity(entityId)
    .find((pset) => pset.name === SET)?.properties.find((p) => p.name === 'FireRating')?.value;
}

let wall = 0;
let other = 0;
let typeId = 0;
let restoreRemesh: () => void;

beforeEach(async () => {
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
  const add = (y: number) => {
    const added = s().addWall(MODEL_ID, STOREY, { Start: [0, y, 0], End: [5, y, 0], Thickness: 0.2, Height: 3, Name: `W${y}` });
    assert.ok('expressId' in added);
    return added.expressId;
  };
  wall = add(0);
  other = add(3);
  assert.equal(s().enterModelWorkspace(), true);
  const created = createElementType(MODEL_ID, 'wall', 'WT-200', wall);
  assert.ok(created !== null, 'the inspector creates the type');
  typeId = created;
  assert.equal(setElementType(MODEL_ID, other, typeId), true);
  // What "Add property" on the selected type writes.
  s().setProperty(MODEL_ID, typeId, SET, 'FireRating', 'REI30', PropertyValueType.Label);
  s().bumpMutationVersion();
  useViewerStore.setState({
    selectedEntity: { modelId: MODEL_ID, expressId: wall },
    selectedEntityId: toGlobalIdFromModels(s().models, MODEL_ID, wall),
    propertiesActiveTab: 'properties',
  });
});

afterEach(() => {
  cleanup();
  s().exitModelWorkspace();
  restoreRemesh();
});

async function editInherited(container: HTMLElement, value: string): Promise<void> {
  const row = await openInlineEditor(container, `${typeId}:${SET}:FireRating`);
  const input = row.querySelector<HTMLInputElement>('input[aria-label="FireRating"]');
  assert.ok(input, 'the inline editor opens on the inherited value');
  type(input, value);
  press(input, 'Enter');
  await advance(0);
}

describe('a type made this session shows its property sets on its occurrences (#9296)', () => {
  it('lists the type\'s set on the wall as inherited, under the type\'s name', async () => {
    const container = render(<PropertiesPanel />);
    await advance(0);
    assert.deepEqual(panelRows(container), [`${typeId}:${SET}:FireRating`]);
    assert.match(container.textContent ?? '', /WT-200/, 'the inherited group names the type');
  });

  it('Apply To Type writes the one shared value: no copy lands on the wall', async () => {
    const container = render(<PropertiesPanel />);
    await advance(0);
    await editInherited(container, 'REI60');
    assert.match(container.textContent ?? '', /2 occurrences may reflect the update/, 'the scope counts both walls of the type');
    click(buttonByText('Apply To Type'));
    await advance(0);
    assert.equal(fireRating(typeId), 'REI60');
    assert.equal(fireRating(wall), undefined, 'the wall holds no copy');
    assert.deepEqual(panelRows(container), [`${typeId}:${SET}:FireRating`]);
  });

  it('Override On This Element writes the value on the wall only, and one undo takes it back', async () => {
    const container = render(<PropertiesPanel />);
    await advance(0);
    await editInherited(container, 'REI90');
    click(buttonByText('Override On This Element'));
    await advance(0);
    assert.equal(fireRating(wall), 'REI90', 'the wall carries its own value');
    assert.equal(fireRating(typeId), 'REI30', 'the type keeps its value');
    assert.equal(fireRating(other), undefined, 'the other wall of the type still only inherits');
    assert.deepEqual(panelRows(container), [`${typeId}:${SET}:FireRating`, `${wall}:${SET}:FireRating`].sort());

    replayWorkspaceHistory(s(), 'undo');
    await advance(0);
    assert.equal(fireRating(wall), undefined);
    assert.deepEqual(panelRows(container), [`${typeId}:${SET}:FireRating`]);
  });
});
