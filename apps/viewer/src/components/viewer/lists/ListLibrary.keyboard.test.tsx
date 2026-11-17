/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ListDefinition } from '@ifc-lite/lists';
import { activate, cleanup, render, click } from '@/test/render.js';
import { ListLibrary } from './ListLibrary.js';

afterEach(cleanup);

const saved: ListDefinition = {
  id: 'saved', name: 'My list', createdAt: 0, updatedAt: 0,
  entityTypes: [], groups: [], columns: [],
};

it('#5823 opens a list from its row with the keyboard while actions stay independent', () => {
  const executed: string[] = [];
  const edited: string[] = [];
  const ui = render(
    <ListLibrary definitions={[saved]} activeListId={null} executing={false} hasData
      onExecute={(list) => executed.push(list.id)} onEdit={(list) => edited.push(list.id)}
      onCreateNew={() => {}} onDuplicate={() => {}} onDelete={() => {}}
      onExport={() => {}} />,
  );
  const row = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('My list'));
  assert.ok(row);
  activate(row, 'Enter');
  activate(row, ' ');
  const edit = ui.querySelector('button[aria-label="Edit list My list"]');
  assert.ok(edit);
  click(edit);
  assert.deepEqual(executed, ['saved', 'saved']);
  assert.deepEqual(edited, ['saved']);
});

it('#8802 a long saved-list name truncates instead of running into the row actions', () => {
  const longName = 'Ground floor external wall fire ratings by storey and type for the tender package';
  const ui = render(
    <ListLibrary definitions={[{ ...saved, name: longName, description: 'Walls with Pset_WallCommon' }]}
      activeListId={null} executing={false} hasData onExecute={() => {}} onEdit={() => {}}
      onCreateNew={() => {}} onDuplicate={() => {}} onDelete={() => {}} onExport={() => {}} />,
  );
  const name = [...ui.querySelectorAll<HTMLElement>('[data-list-name]')].find((el) => el.textContent === longName);
  assert.ok(name, 'the saved list renders its name');
  // The name may shrink below its text width and clips with an ellipsis.
  assert.equal(name.classList.contains('min-w-0'), true);
  assert.equal(name.classList.contains('truncate'), true);
  assert.equal(name.classList.contains('shrink-0'), false);
  assert.equal(name.getAttribute('title'), longName);
  // The description takes only the space left; the actions never shrink.
  const description = name.nextElementSibling;
  assert.equal(description?.classList.contains('flex-1'), true);
  assert.equal(description?.classList.contains('truncate'), true);
  const actions = name.closest('button')?.nextElementSibling;
  assert.equal(actions?.classList.contains('shrink-0'), true);
});
