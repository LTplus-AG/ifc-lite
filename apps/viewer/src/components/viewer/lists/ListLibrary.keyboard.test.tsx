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
  entityTypes: [], conditions: [], columns: [],
};

it('#5823 opens a list from its row with the keyboard while actions stay independent', () => {
  const executed: string[] = [];
  const edited: string[] = [];
  const ui = render(
    <ListLibrary definitions={[saved]} activeListId={null} executing={false} hasData
      onExecute={(list) => executed.push(list.id)} onEdit={(list) => edited.push(list.id)}
      onCreateNew={() => {}} onDuplicate={() => {}} onDelete={() => {}}
      onExport={() => {}} onImport={() => {}} />,
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
