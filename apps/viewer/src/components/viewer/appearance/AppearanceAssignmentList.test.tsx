/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, click, cleanup } from '@/test/render.js';
import { DEFAULT_APPEARANCE_SETTINGS } from '@/lib/appearance/settings.js';
import { resolveAppearanceAssignments } from '@/lib/appearance/assignments/resolve.js';
import type { AppearanceAssignment } from '@/lib/appearance/assignments/types.js';
import { AppearanceAssignmentList } from './AppearanceAssignmentList.js';
afterEach(cleanup);
function assignment(id: string): AppearanceAssignment {
  return { id, model: { slotId: 'model-slot', modelId: 'model', name: 'Building', sourceSha256: 'a'.repeat(64), revision: 'r' },
    source: { id: 'b'.repeat(64), name: id, width: 2, height: 2 }, settings: { ...DEFAULT_APPEARANCE_SETTINGS },
    query: { kind: 'model' }, members: [{ expressId: 10, GlobalId: 'wall' }], excludedGlobalIds: [] };
}
function Harness({ disabled = false }: { disabled?: boolean }) {
  const [assignments, setAssignments] = useState([assignment('Brick'), assignment('Paint')]);
  return <AppearanceAssignmentList rows={resolveAppearanceAssignments(assignments)} disabled={disabled} objectName={() => 'East wall'}
    onRemove={id => setAssignments(rows => rows.filter(row => row.id !== id))}
    onMove={(id, direction) => setAssignments(rows => { const next = [...rows], index = next.findIndex(row => row.id === id);
      [next[index], next[index + direction]] = [next[index + direction], next[index]]; return next; })}
    onExclude={(id, GlobalId, excluded) => setAssignments(rows => rows.map(row => row.id === id
      ? { ...row, excludedGlobalIds: excluded ? [...row.excludedGlobalIds, GlobalId] : row.excludedGlobalIds.filter(guid => guid !== GlobalId) } : row))} />;
}
it('mounted assignment order and explicit exceptions change the reviewed winner #4420', () => {
  const ui = render(<Harness />);
  const rows = () => [...ui.querySelectorAll('li')];
  assert.match(rows()[0].textContent!, /0 objects.*1 replaced/);
  click(rows()[1].querySelector('input')!);
  assert.match(rows()[0].textContent!, /1 objects/);
  assert.match(rows()[1].textContent!, /0 objects · 1 excluded/);
  click(rows()[1].querySelector('input')!);
  click(ui.querySelector('[aria-label="Move assignment 2 earlier"]')!);
  assert.match(rows()[0].textContent!, /Paint.*0 objects/);
  assert.match(rows()[1].textContent!, /Brick.*1 objects/);
  click(ui.querySelector('[aria-label="Remove assignment 2"]')!);
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent!, /Paint.*1 objects/);
});
it('mounted assignment review is locked during coordinated publication #4420', () => {
  const ui = render(<Harness disabled />);
  assert.ok([...ui.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')].every(control => control.disabled));
});
