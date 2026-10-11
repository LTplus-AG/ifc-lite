/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recorded-response CI harness (#6928). Every `tests/ai-eval/recordings/*.json`
 * is one provider answer replayed through the real Assistant path against its
 * real-model scene, then reviewed by the same native code a coordinator would
 * hit. This tests IFClite orchestration on a fixed answer, never LLM quality.
 * The invariant detectors over the same files run in
 * `scripts/ai-eval/check-ai-eval-invariants.test.mjs`.
 */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { cancelAssistant } from './conversation';
import { loadRecordings, replayRecording, type ProposalKind } from '@/test/ai-eval-replay';
import { reviewReplay } from '@/test/ai-eval-review';
import { comparableEvidence, seedScene } from '@/test/ai-eval-scenes';

const initial = useViewerStore.getState();
afterEach(() => { cancelAssistant(); useViewerStore.setState(initial, true); });

/** The typed proposal kinds the recorded corpus must cover. */
const RECORDED_KINDS: readonly ProposalKind[] = ['clash.groups', 'flow.patch', 'model.changes', 'model.authoring'];
/** Every proposal kind the conversation classifies, by its declared \`kind\` (recordings may name any of them). */
const KIND: Record<string, string> = { clash: 'clash.groups', flow: 'flow.patch', changes: 'model.changes', authoring: 'model.authoring',
  scene: 'scene.actions', mapping: 'table.mapping', filter: 'filter.proposal', list: 'list.proposal', lens: 'lens.proposal',
  chart: 'chart.proposal', ids: 'ids.specifications', rules: 'rules.proposal', document: 'document.outline' } satisfies Record<string, string>;
const recordings = loadRecordings();

/** Every field named in `expected` must equal the same field of `actual` (subset comparison). */
function assertSubset(actual: unknown, expected: Record<string, unknown>, at: string): void {
  const record = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) assertSubset(record[key], value as Record<string, unknown>, `${at}.${key}`);
    else assert.deepEqual(record[key], value, `${at}.${key}`);
  }
}

test('the recorded corpus is not empty and covers every typed proposal kind', () => {
  assert.ok(recordings.length >= 20, `only ${recordings.length} recordings`);
  const kinds = new Set(recordings.map(recording => recording.expect.proposal?.kind));
  for (const kind of RECORDED_KINDS) assert.ok(kinds.has(kind), `no recording exercises ${kind}`);
  assert.ok(recordings.some(recording => recording.expect.outcome === 'error'));
  assert.ok(recordings.some(recording => recording.expect.outcome === 'truncated'));
  for (const route of ['proxy', 'anthropic', 'openai']) assert.ok(recordings.some(recording => recording.route.kind === route), `no ${route} route`);
});

for (const recording of recordings) {
  test(`recording ${recording.id} replays through the Assistant path and is reviewed natively`, async () => {
    const replay = await replayRecording(recording);
    if ('missing' in replay) { console.log(`skipped ${recording.id}: ${replay.missing}`); return; }

    // The frozen evidence is exactly what the scene captures today (no drift between corpus and native adapters).
    assert.deepEqual(recording.evidence, comparableEvidence(replay.evidence), 'evidence drifted; run pnpm ai-eval refresh --recordings tests/ai-eval/recordings and review the diff');

    // Exactly one provider request left the viewer, with the frozen evidence in the system prompt and the prompt as the user turn.
    assert.equal(replay.sent.length, 1);
    const url = replay.sent[0].url;
    assert.ok(recording.route.kind === 'proxy' ? url === '/api/chat' : url.includes(recording.route.kind), `request routed to ${url}, not the ${recording.route.kind} route`);
    const body = replay.sent[0].body;
    const wire = JSON.stringify(body);
    assert.ok(wire.includes('\\"citation\\":\\"E1\\"') || wire.includes('"citation":"E1"'), 'frozen evidence rows are in the request');
    assert.ok(wire.includes(recording.prompt));
    // Each provider names its output ceiling differently; every route must send one.
    const ceiling = body.maxOutputTokens ?? body.max_tokens ?? body.max_completion_tokens;
    assert.equal(typeof ceiling, 'number', 'every request carries an output ceiling');

    const expected = recording.expect;
    if (expected.outcome === 'error') {
      assert.equal(replay.completed, false);
      assert.ok(replay.error, 'an error outcome has a user-visible error');
      assert.equal(replay.answer, null);
      return;
    }
    if (expected.outcome === 'truncated') {
      // The partial text is kept for the coordinator but flagged; it is never presented as a complete answer.
      assert.equal(replay.error, 'truncated-output');
      assert.equal(replay.receipt?.outcome, 'truncated');
      assert.ok(replay.completed, 'the request itself completed');
      assert.ok(replay.answer, 'the partial text is kept');
      assert.equal(replay.proposal, null, 'a truncated answer never becomes a reviewable proposal');
      return;
    }
    assert.ok(replay.completed, replay.error ?? 'answer did not complete');
    assert.equal(replay.error, null);
    if (expected.usage) {
      assert.equal(replay.receipt?.usageReported, expected.usage.reported);
      if (replay.receipt?.usageReported) assert.deepEqual({ inputTokens: replay.receipt.inputTokens, outputTokens: replay.receipt.outputTokens },
        { inputTokens: expected.usage.inputTokens, outputTokens: expected.usage.outputTokens });
    }
    if (expected.proposal === null) {
      assert.equal(replay.proposal, null);
    } else {
      assert.ok(replay.proposal, 'a typed proposal was classified');
      const invalid = replay.proposal.kind === 'invalid';
      const kind = replay.proposal.kind === 'invalid' || replay.proposal.kind === 'checks' ? replay.proposal.declared : replay.proposal.kind;
      assert.equal(KIND[kind], expected.proposal.kind);
      assert.equal(!invalid, expected.proposal.valid);
    }
    if (expected.review) assertSubset(reviewReplay(replay), expected.review, 'review');
  });
}

test('the same scene seeded twice yields identical evidence and scenes do not leak into each other', async () => {
  const first = await seedScene('clash-rev-b');
  await seedScene('flow-empty');
  const second = await seedScene('clash-rev-b');
  assert.ok(first.kind === 'ready' && second.kind === 'ready');
  assert.deepEqual(comparableEvidence(first.evidence), comparableEvidence(second.evidence));
});
