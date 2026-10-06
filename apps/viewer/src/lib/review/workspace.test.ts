/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { clearContentDatabase } from '@/test/content-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentBackup, importContentBackup, parseContentBackup } from '../storage/content-backup';
import {
  DEFAULT_REVIEW_WORKSPACE, REVIEW_LIMITS, currentReviewWorkspace, decisionFor, decodeReviewWorkspace, reviewWorkspaceLibrary,
  saveCardDecision, useReviewWorkspaces, type ReviewWorkspace,
} from './workspace';

const base: ReviewWorkspace = { version: 1, id: DEFAULT_REVIEW_WORKSPACE, name: 'Coordination review', decisions: [
  { cardKey: 'arch.ifc\u001fW1', status: 'in-progress', comment: 'Waiting for MEP', updatedAt: '2026-01-01T00:00:00.000Z' }] };

test('decoding accepts a valid workspace and refuses every malformed or duplicated decision as a whole', () => {
  assert.deepEqual(decodeReviewWorkspace(base), base);
  const decision = base.decisions[0];
  for (const bad of [
    { ...base, version: 2 }, { ...base, decisions: [{ ...decision, status: 'fixed' }] }, { ...base, decisions: [{ ...decision, updatedAt: 'yesterday' }] },
    { ...base, decisions: [decision, decision] }, { ...base, decisions: [{ ...decision, comment: 'x'.repeat(REVIEW_LIMITS.comment + 1) }] },
    { ...base, decisions: [decision, null] }, null, [], { ...base, name: '' },
  ]) assert.equal(decodeReviewWorkspace(bad), null);
});

test('a decision is stored per card key; changing and clearing it never touches other cards', async () => {
  const when = new Date('2026-02-03T04:05:06.000Z');
  assert.equal(await saveCardDecision('k1', { status: 'accepted', comment: 'ok' }, when), true);
  assert.equal(await saveCardDecision('k2', { status: 'dismissed', comment: '' }, when), true);
  assert.equal(await saveCardDecision('k1', { status: 'resolved', comment: 'fixed in rev C' }, when), true);
  const workspace = currentReviewWorkspace(useReviewWorkspaces.getState().entries);
  assert.deepEqual(workspace.decisions.map(d => [d.cardKey, d.status]).sort(), [['k1', 'resolved'], ['k2', 'dismissed']]);
  assert.equal(decisionFor(workspace, 'k1')?.updatedAt, '2026-02-03T04:05:06.000Z');
  assert.equal(await saveCardDecision('k1', null), true);
  assert.equal(decisionFor(currentReviewWorkspace(useReviewWorkspaces.getState().entries), 'k1'), null);
  assert.equal(decisionFor(currentReviewWorkspace(useReviewWorkspaces.getState().entries), 'k2')?.status, 'dismissed');
});

test('an oversized comment is refused by the codec instead of silently stored; a reload restores decisions', async () => {
  assert.equal(await saveCardDecision('k1', { status: 'open', comment: 'y'.repeat(REVIEW_LIMITS.comment + 50) }), true, 'saved truncated to the limit');
  assert.equal(decisionFor(currentReviewWorkspace(useReviewWorkspaces.getState().entries), 'k1')?.comment.length, REVIEW_LIMITS.comment);
  assert.equal(await reviewWorkspaceLibrary.restore(), true);
  assert.equal(await reviewWorkspaceLibrary.initialize(), true);
  assert.equal(decisionFor(currentReviewWorkspace(useReviewWorkspaces.getState().entries), 'k1')?.status, 'open');
});

test('review decisions travel through the library backup and import like every other content kind', async () => {
  assert.equal(await saveCardDecision('k1', { status: 'accepted', comment: 'ok' }), true);
  const entries = useReviewWorkspaces.getState().entries;
  const backup = parseContentBackup(JSON.stringify(createContentBackup({ validation: [], comparison: [], document: [], reviewWorkspaces: entries })));
  assert.equal(backup.libraries.reviewWorkspaces?.[0].decisions[0].cardKey, 'k1');
  await clearContentDatabase();
  assert.equal(await reviewWorkspaceLibrary.restore(), true);
  assert.equal(useReviewWorkspaces.getState().entries.length, 0);
  let receipts: Parameters<typeof reviewWorkspaceLibrary.refresh>[0];
  assert.equal(await importContentBackup(backup, undefined, true, rows => { receipts = rows; }), 1);
  assert.equal(await reviewWorkspaceLibrary.refresh(receipts), true);
  assert.equal(decisionFor(currentReviewWorkspace(useReviewWorkspaces.getState().entries), 'k1')?.status, 'accepted');
});

test('an imported review that differs from the local one is folded in, never orphaned, and retired on the next save', async () => {
  await clearContentDatabase();
  assert.equal(await reviewWorkspaceLibrary.restore(), true);
  assert.equal(await saveCardDecision('local', { status: 'open', comment: '' }, new Date('2026-03-01T00:00:00.000Z')), true);
  assert.equal(await saveCardDecision('shared', { status: 'open', comment: 'local' }, new Date('2026-03-01T00:00:00.000Z')), true);
  const theirs: ReviewWorkspace = { ...base, decisions: [
    { cardKey: 'shared', status: 'resolved', comment: 'theirs', updatedAt: '2026-04-01T00:00:00.000Z' },
    { cardKey: 'stale', status: 'dismissed', comment: '', updatedAt: '2026-01-01T00:00:00.000Z' }] };
  const backup = parseContentBackup(JSON.stringify(createContentBackup({ validation: [], comparison: [], document: [], reviewWorkspaces: [theirs] })));
  let receipts: Parameters<typeof reviewWorkspaceLibrary.refresh>[0];
  assert.equal(await importContentBackup(backup, undefined, true, rows => { receipts = rows; }), 1);
  assert.equal(await reviewWorkspaceLibrary.refresh(receipts), true);
  assert.equal(useReviewWorkspaces.getState().entries.length, 2, 'the import kept the local review and stored a copy');
  const folded = currentReviewWorkspace(useReviewWorkspaces.getState().entries);
  assert.equal(folded.id, DEFAULT_REVIEW_WORKSPACE);
  assert.equal(decisionFor(folded, 'shared')?.comment, 'theirs', 'the newer imported decision wins');
  assert.equal(decisionFor(folded, 'local')?.status, 'open');
  assert.equal(decisionFor(folded, 'stale')?.status, 'dismissed');
  assert.equal(await saveCardDecision('stale', null), true);
  assert.deepEqual(useReviewWorkspaces.getState().entries.map(entry => entry.id), [DEFAULT_REVIEW_WORKSPACE]);
  const after = currentReviewWorkspace(useReviewWorkspaces.getState().entries);
  assert.equal(decisionFor(after, 'stale'), null, 'a cleared card does not reappear from the absorbed copy');
  assert.equal(decisionFor(after, 'shared')?.comment, 'theirs');
});
