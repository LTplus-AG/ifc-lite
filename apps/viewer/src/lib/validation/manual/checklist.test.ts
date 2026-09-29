/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `.checklist.json` parse / serialize and structural edits (#6401). */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKLIST_VERSION, blankChecklist, parseChecklistFile, parseChecklistText, serializeChecklist, type ChecklistTemplate } from './checklist.js';
import { addGroup, addItem, moveGroup, moveItem, removeGroup, removeItem, renameGroup, updateItem } from './checklist-edit.js';

const TEMPLATE: ChecklistTemplate = {
  version: CHECKLIST_VERSION,
  name: 'BIM coordination',
  groups: [
    { id: 'g1', name: 'Delivery', items: [{ id: 'i1', text: 'Uploaded to the CDE on time' }] },
    { id: 'g2', name: 'Structure', items: [{ id: 'i2', text: 'Objects are on the right storey', description: 'Spot-check each level' }, { id: 'i3', text: 'Storeys are named' }] },
  ],
};

describe('parseChecklistFile (#6401)', () => {
  it('round-trips a template through the file text unchanged', () => {
    const result = parseChecklistText(serializeChecklist(TEMPLATE));
    assert.ok(result.ok);
    assert.deepEqual(result.template, TEMPLATE);
  });

  it('writes the template only — an answer smuggled onto an item never reaches the file', () => {
    const withExtras = structuredClone(TEMPLATE) as unknown as { groups: Array<{ items: Array<Record<string, unknown>> }> };
    withExtras.groups[0].items[0].status = 'pass';
    withExtras.groups[0].items[0].comment = 'looked fine';
    const text = serializeChecklist(withExtras as unknown as ChecklistTemplate);
    assert.equal(text.includes('status'), false);
    assert.equal(text.includes('looked fine'), false);
  });

  it('refuses an id used twice, even across a group and an item, since answers key on item id alone', () => {
    const dup = structuredClone(TEMPLATE);
    dup.groups[1].items[0].id = 'g1';
    const result = parseChecklistFile(dup);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : '', /groups\[1\]\.items\[0\]\.id "g1" is used twice/);
  });

  it('says a newer file is newer, rather than calling it broken', () => {
    const result = parseChecklistFile({ ...TEMPLATE, version: CHECKLIST_VERSION + 1 });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : '', /newer version/);
  });

  it('names the JSON path of a malformed field, and reports bad JSON without throwing', () => {
    const bad = parseChecklistFile({ ...TEMPLATE, groups: [{ id: 'g', name: 'x', items: [{ id: 'i', text: 3 }] }] });
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.error : '', /groups\[0\]\.items\[0\]\.text/);
    const notJson = parseChecklistText('{ nope');
    assert.equal(notJson.ok, false);
    assert.match(!notJson.ok ? notJson.error : '', /not valid JSON/);
  });
});

describe('checklist structural edits (#6401)', () => {
  it('adds, renames and removes groups and items, and returns ids for new ones', () => {
    const { template: withGroup, id: groupId } = addGroup(blankChecklist(), 'Delivery');
    assert.ok(groupId);
    const { template: withItem, id: itemId } = addItem(withGroup, groupId, 'On time');
    assert.ok(itemId);
    const renamed = updateItem(renameGroup(withItem, groupId, 'Handover'), groupId, itemId, { description: 'Check the date' });
    assert.deepEqual(renamed.groups, [{ id: groupId, name: 'Handover', items: [{ id: itemId, text: 'On time', description: 'Check the date' }] }]);
    assert.deepEqual(removeItem(renamed, groupId, itemId).groups[0].items, []);
    assert.deepEqual(removeGroup(renamed, groupId).groups, []);
  });

  it('reorders groups and items, and a move off either end is a no-op', () => {
    assert.deepEqual(moveGroup(TEMPLATE, 'g2', -1).groups.map((g) => g.id), ['g2', 'g1']);
    assert.equal(moveGroup(TEMPLATE, 'g1', -1), TEMPLATE);
    assert.equal(moveGroup(TEMPLATE, 'g2', 1), TEMPLATE);
    assert.deepEqual(moveItem(TEMPLATE, 'g2', 'i2', 1).groups[1].items.map((i) => i.id), ['i3', 'i2']);
    assert.equal(moveItem(TEMPLATE, 'g2', 'i3', 1), TEMPLATE);
  });

  it('clears a description when it is emptied, and leaves the template alone for an unknown target', () => {
    assert.equal(updateItem(TEMPLATE, 'g2', 'i2', { description: '' }).groups[1].items[0].description, undefined);
    assert.equal(updateItem(TEMPLATE, 'g2', 'missing', { text: 'x' }), TEMPLATE);
    assert.equal(addItem(TEMPLATE, 'missing', 'x').id, null);
  });
});
