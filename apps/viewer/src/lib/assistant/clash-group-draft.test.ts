/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { captureEvidence } from './evidence';
import { prepareClashGroupPreview } from './clash-group-proposal';
import {
  draftAccounting, draftFromPreview, draftUnclassified, mergeDraftGroups, moveDraftFindings, renameDraftGroup, type ClashGroupDraft,
} from './clash-group-draft';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

function findings(count: number): Clash[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `f-${i}`, rule: 'coordination', status: 'hard', severity: i % 2 ? 'major' : 'minor', distance: -0.01,
    a: { key: `A${i}`, ref: i + 1, model: 'arch', tag: 'IfcWall' }, b: { key: `B${i}`, ref: 1000 + i, model: 'mep', tag: 'IfcPipeSegment' },
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  }));
}

/** A real preview over 120 native findings, 100 of them in the sample: groups of E1-E3, E4-E5. */
function draft(): ClashGroupDraft {
  const clashes = findings(120);
  const result = { clashes, summary: summarizeClashes(clashes), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ clashResult: result, clashRawResult: result });
  const answer = JSON.stringify({ version: 1, kind: 'clash.groups', groups: [
    { name: 'Walls vs pipes', explanation: 'Routing', citations: ['E1', 'E2', 'E3'] },
    { name: 'Riser', explanation: 'Penetrations', citations: ['E4', 'E5'] }] });
  return draftFromPreview(prepareClashGroupPreview(answer, captureEvidence('clash')));
}
const names = (value: ClashGroupDraft) => value.groups.map(group => [group.name, group.members.length]);
/** The partition invariant every edit must keep: each proposed finding in at most one group. */
function assertPartition(value: ClashGroupDraft) {
  const members = value.groups.flatMap(group => group.members);
  assert.equal(new Set(members).size, members.length, 'no finding in two groups');
  const counts = draftAccounting(value);
  assert.equal(counts.grouped, members.length, 'grouped counts the distinct group members');
  assert.ok(counts.unclassified >= 0 && counts.grouped + counts.unclassified === value.totalFindings, 'every native finding grouped or unclassified');
  assert.equal(counts.unclassifiedByReview, draftUnclassified(value).length);
}

// #6906: reviewed taxonomy edits recompute accounting from the draft, never from the AI answer.
test('moves, splits and merges keep a full partition with live accounting', () => {
  const start = draft();
  assert.deepEqual(draftAccounting(start), { groups: 2, grouped: 5, unclassified: 115, unclassifiedByReview: 0, failed: 0, notRun: 0 });
  assert.equal(start.origin.kind === 'sample' && start.origin.omittedFromEvidence, 20);
  const [walls, riser] = start.groups;

  const moved = moveDraftFindings(start, [walls.members[0]], { group: riser.key });
  assert.ok(moved.ok);
  assert.deepEqual(names(moved.draft), [['Walls vs pipes', 2], ['Riser', 3]]);
  assertPartition(moved.draft);

  const dropped = moveDraftFindings(moved.draft, [riser.members[0]], null);
  assert.ok(dropped.ok);
  assert.deepEqual(draftAccounting(dropped.draft).grouped, 4);
  assert.deepEqual(draftUnclassified(dropped.draft).map(finding => finding.citation), ['E4']);
  assertPartition(dropped.draft);
  // A finding sent back to unclassified can be placed again.
  const back = moveDraftFindings(dropped.draft, [riser.members[0]], { group: walls.key });
  assert.ok(back.ok);
  assert.equal(draftUnclassified(back.draft).length, 0);

  const split = moveDraftFindings(start, walls.members.slice(1), { newGroup: 'Walls vs pipes, level 2' });
  assert.ok(split.ok);
  assert.deepEqual(names(split.draft), [['Walls vs pipes', 1], ['Walls vs pipes, level 2', 2], ['Riser', 2]], 'a split lands beside its source');
  assert.equal(split.draft.groups[1].explanation, '', 'a reviewer-made group carries no AI rationale');
  assertPartition(split.draft);

  const merged = mergeDraftGroups(split.draft, split.draft.groups[1].key, walls.key);
  assert.ok(merged.ok);
  assert.deepEqual(names(merged.draft), [['Walls vs pipes', 3], ['Riser', 2]]);
  assertPartition(merged.draft);
  // Moving every member out of a group removes it.
  const emptied = moveDraftFindings(start, riser.members, { group: walls.key });
  assert.ok(emptied.ok);
  assert.deepEqual(names(emptied.draft), [['Walls vs pipes', 5]]);
  assert.equal(start.groups.length, 2, 'edits never mutate the previous draft');
});

test('renames and new groups refuse empty, oversized and duplicate names', () => {
  const start = draft();
  const [walls, riser] = start.groups;
  const renamed = renameDraftGroup(start, walls.key, '  Pipe routing  ');
  assert.ok(renamed.ok);
  assert.equal(renamed.draft.groups[0].name, 'Pipe routing');
  assert.deepEqual(renameDraftGroup(start, walls.key, ' '), { ok: false, reason: 'name-invalid' });
  assert.deepEqual(renameDraftGroup(start, walls.key, 'x'.repeat(101)), { ok: false, reason: 'name-invalid' });
  assert.deepEqual(renameDraftGroup(start, walls.key, 'RISER'), { ok: false, reason: 'name-taken' });
  assert.deepEqual(moveDraftFindings(start, [walls.members[0]], { newGroup: 'riser' }), { ok: false, reason: 'name-taken' });
  assert.deepEqual(moveDraftFindings(start, ['not-a-finding'], null), { ok: false, reason: 'no-findings' });
  assert.deepEqual(mergeDraftGroups(start, riser.key, riser.key), { ok: false, reason: 'unknown-group' });
  assert.ok(renameDraftGroup(start, walls.key, 'walls VS pipes').ok, 'a group may change its own capitalisation');
});
