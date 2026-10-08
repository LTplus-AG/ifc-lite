/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { buildCards } from '@/lib/review/cards';
import { pinReviewCard } from '@/lib/review/assistant';
import { useReviewAssistantCard } from '@/lib/review/assistant-state';
import { element, fakeModel, finding, run } from '@/lib/review/test-support';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { adapterFor } from './registry';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial, true); useReviewAssistantCard.setState({ card: null, project: null }); });

const models = [fakeModel('m1', 'arch.ifc', ['W1'])];
const historical = run('clash:baseline', 'clash', { temporal: 'historical', complete: false, incomplete: [{ code: 'truncated', detail: 'cap' }] });
const cards = () => buildCards([
  finding('v1', 'validation', [element('W1', 'arch.ifc', 'm1')], { nativeStatus: 'failed' }),
  finding('h1', 'clash', [element('W1', 'arch.ifc', 'm1')], { run: historical, lifecycle: 'not-evaluated', nativeStatus: 'hard' }),
], models).cards;

test('with no pinned card the source is unavailable and not offered', () => {
  assert.equal(adapterFor('review').readiness(useViewerStore.getState()).ready, false);
  const payload = JSON.parse(captureEvidence('review').payload);
  assert.equal(payload.sourceAvailability, 'unavailable');
});

// Invariant: the assistant sees the card's native statuses, run temporality and gaps, and the person's decision apart from them.
test('a pinned card projects one cited row per finding with run temporality, gaps and the separate human decision', () => {
  const [card] = cards();
  pinReviewCard(card, { cardKey: card.key, status: 'dismissed', comment: 'by design', updatedAt: '2026-01-01T00:00:00.000Z' });
  const snapshot = captureEvidence('review');
  assert.equal(snapshot.totalRows, 2);
  const payload = JSON.parse(snapshot.payload);
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(payload.evidence.summary.humanDecision.status, 'dismissed');
  assert.match(payload.evidence.summary.limitations, /never a resolution/);
  const rows = payload.evidence.rows.map((row: { data: Record<string, unknown> }) => row.data);
  const old = rows.find((row: { source: string }) => row.source === 'clash');
  assert.deepEqual([old.run.temporal, old.run.complete, old.run.incomplete, old.lifecycle, old.status], ['historical', false, ['truncated: cap'], 'not-evaluated', 'hard']);
  assert.equal(old.globalId, 'W1');
});

test('pinning another card makes earlier evidence stale; an edit does too', () => {
  const all = cards();
  pinReviewCard(all[0], null);
  const snapshot = captureEvidence('review');
  assert.equal(evidenceIsCurrent(snapshot), true);
  pinReviewCard({ ...all[0] }, null);
  assert.equal(evidenceIsCurrent(snapshot), false);
});
