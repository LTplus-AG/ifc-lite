/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { clearContentDatabase, refuseContentWrites } from '@/test/content-fixture';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createContentLibrary, initialContentStatus } from '../storage/content-library';
import { readContentRows } from '../storage/content-database';
import { createContentBackup, importContentBackup, readContentRecovery, preserveLegacyChange, parseContentBackup } from '../storage/content-backup';
import { clashGroupsContent, decodeClashGroupWorkspace, DEFAULT_GROUP_WORKSPACE, type ClashGroupWorkspace } from './group-workspace';
import { MANUAL_CLASH_GROUPS_KEY } from './manual-groups';

beforeEach(async () => { await clearContentDatabase(); localStorage.removeItem(MANUAL_CLASH_GROUPS_KEY); });
function workspace(name = 'Coordination', member = 'wall pipe'): ClashGroupWorkspace {
  return { version: 1, id: DEFAULT_GROUP_WORKSPACE, name, groups: [{ id: 'riser', name: 'Riser',
    members: [{ reviewKey: member, occurrenceKey: '' }] }] };
}
function library() {
  let entries: ClashGroupWorkspace[] = [], status = initialContentStatus();
  const controller = createContentLibrary(clashGroupsContent, () => entries, (next, state) => { entries = next; status = state; });
  return { ...controller, entries: () => entries, status: () => status };
}
const empty = { validation: [], comparison: [], document: [] };

// #6851: migrate one complete membership partition and retain original bytes in the same transaction.
test('legacy schema-2 preserves valid neighbours, absent membership and the complete original', async () => {
  const original = JSON.stringify({ schemaVersion: 2, groups: [...workspace().groups, null,
    { id: 'invalid', name: 'Duplicate claim', members: workspace().groups[0].members }] });
  localStorage.setItem(MANUAL_CLASH_GROUPS_KEY, original);
  const current = library();
  assert.equal(await current.initialize(), true);
  assert.equal(current.status().recovered, true);
  assert.deepEqual(current.entries()[0].groups, workspace().groups);
  assert.equal(localStorage.getItem(MANUAL_CLASH_GROUPS_KEY), original);
  assert.equal((await readContentRecovery()).find(row => row.key === MANUAL_CLASH_GROUPS_KEY)?.raw, original);
  const reopened = library();
  assert.equal(await reopened.initialize(), true);
  assert.deepEqual(reopened.entries(), current.entries());
});

test('unreadable legacy originals survive replacement and later old-tab values never replay', async () => {
  localStorage.setItem(MANUAL_CLASH_GROUPS_KEY, '{broken');
  const current = library();
  assert.equal(await current.initialize(), true);
  assert.equal(await current.put(DEFAULT_GROUP_WORKSPACE, workspace()), true);
  const later = JSON.stringify({ schemaVersion: 2, groups: workspace('Older tab', 'other wall').groups });
  localStorage.setItem(MANUAL_CLASH_GROUPS_KEY, later);
  await preserveLegacyChange(MANUAL_CLASH_GROUPS_KEY, later);
  assert.equal(await current.refresh(), true);
  assert.equal(current.entries()[0].name, 'Coordination');
  const originals = await readContentRecovery();
  assert.equal(originals.find(row => row.key === MANUAL_CLASH_GROUPS_KEY)?.raw, '{broken');
  assert.ok(originals.some(row => row.key.startsWith(`${MANUAL_CLASH_GROUPS_KEY}:later:`) && row.raw === later));
  assert.equal(localStorage.getItem(MANUAL_CLASH_GROUPS_KEY), later);
});

test('whole-partition CAS refuses an older tab and keeps its draft for recovery', async () => {
  const first = library(); await first.initialize();
  assert.equal(await first.put(DEFAULT_GROUP_WORKSPACE, workspace()), true);
  const second = library(); await second.initialize();
  assert.equal(await first.put(DEFAULT_GROUP_WORKSPACE, workspace('Reviewed first', 'new first member')), true);
  assert.equal(await second.put(DEFAULT_GROUP_WORKSPACE, workspace('Second tab', 'new second member')), false);
  assert.equal(second.status().items[DEFAULT_GROUP_WORKSPACE], 'conflict');
  assert.equal(second.entries()[0].name, 'Second tab');
  const saved = decodeClashGroupWorkspace((await readContentRows('clashGroups'))[0].payload);
  assert.equal(saved?.name, 'Reviewed first');
  const backup = createContentBackup({ ...empty, clashGroups: second.entries() }, { clashGroups: second.status() });
  assert.equal(backup.libraries.clashGroups?.[0].name, 'Second tab');
  assert.equal(await second.restore(), true, 'explicit native restore discards only the acknowledged draft');
  assert.equal(second.entries()[0].name, 'Reviewed first');
});

test('quota refusal retains a portable draft and retry commits the full partition', async () => {
  const current = library(); await current.initialize();
  const refused = refuseContentWrites();
  try {
    assert.equal(await current.put(DEFAULT_GROUP_WORKSPACE, workspace()), false);
    assert.equal(current.status().items[DEFAULT_GROUP_WORKSPACE], 'quota');
    assert.equal((await readContentRows('clashGroups')).length, 0);
    assert.deepEqual(parseContentBackup(JSON.stringify(createContentBackup({ ...empty, clashGroups: current.entries() }))).libraries.clashGroups,
      [workspace()]);
  } finally { refused.mock.restore(); }
  assert.equal(await current.retry(), true);
  assert.deepEqual(decodeClashGroupWorkspace((await readContentRows('clashGroups'))[0].payload), workspace());
});

test('refused legacy migration keeps memberships visible and commits originals only when retry succeeds', async () => {
  const original = JSON.stringify({ schemaVersion: 2, groups: workspace().groups });
  localStorage.setItem(MANUAL_CLASH_GROUPS_KEY, original);
  const current = library(), refused = refuseContentWrites();
  try {
    assert.equal(await current.initialize(), false);
    assert.equal(current.status().phase, 'unavailable');
    assert.deepEqual(current.entries()[0].groups, workspace().groups);
    assert.equal((await readContentRows('clashGroups')).length, 0);
    assert.equal((await readContentRecovery()).some(row => row.key === MANUAL_CLASH_GROUPS_KEY), false);
    assert.equal(localStorage.getItem(MANUAL_CLASH_GROUPS_KEY), original);
  } finally { refused.mock.restore(); }
  assert.equal(await current.initialize(), true);
  assert.equal((await readContentRows('clashGroups')).length, 1);
  assert.equal((await readContentRecovery()).find(row => row.key === MANUAL_CLASH_GROUPS_KEY)?.raw, original);
});

test('backup conflicts fork independent workspaces and repeated import does not allocate another identity', async () => {
  const current = library(); await current.initialize(); await current.put(DEFAULT_GROUP_WORKSPACE, workspace());
  const backup = createContentBackup({ ...empty, clashGroups: [workspace('Incoming', 'other member')] });
  assert.equal(await importContentBackup(backup), 1);
  assert.equal(await importContentBackup(backup), 0);
  const rows = await readContentRows('clashGroups');
  assert.equal(rows.length, 2);
  assert.equal(decodeClashGroupWorkspace(rows.find(row => row.id === DEFAULT_GROUP_WORKSPACE)?.payload)?.name, 'Coordination');
  assert.equal(decodeClashGroupWorkspace(rows.find(row => row.id !== DEFAULT_GROUP_WORKSPACE)?.payload)?.name, 'Incoming');
  assert.equal(parseContentBackup(JSON.stringify(createContentBackup(empty))).libraries.clashGroups, undefined, 'older backups remain valid');
});

test('durable validators refuse duplicate groups and overlapping claims rather than silently dropping findings', () => {
  const original = workspace();
  assert.equal(decodeClashGroupWorkspace({ ...original, groups: [...original.groups, ...original.groups] }), null);
  assert.equal(decodeClashGroupWorkspace({ ...original, groups: [...original.groups,
    { ...original.groups[0], id: 'another', name: 'Other' }] }), null);
  assert.equal(decodeClashGroupWorkspace({ ...original, groups: [{ ...original.groups[0], members: [{ reviewKey: '', occurrenceKey: '' }] }] }), null);
});
