/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { ClashGroupReview } from './ClashGroupReview';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); });

// #6847: mount the actual reviewer and prove model output cannot modify native coordination state.
test('mounted group preview shows full accounting, escapes output and refuses stale review', () => {
  const clash: Clash = { id: 'coordination-1', rule: 'coordination', status: 'hard', severity: 'critical', distance: -0.01,
    a: { model: 'a', key: 'wall', ref: 1, tag: 'IfcWall' }, b: { model: 'b', key: 'pipe', ref: 1, tag: 'IfcPipeSegment' },
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
  const result = { clashes: [clash], summary: summarizeClashes([clash]), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ clashResult: result, clashRawResult: result });
  replaceEvidence(captureEvidence('clash'));
  useAssistant.setState({ messages: [{ role: 'user', content: 'Group findings' }, { role: 'assistant', model: 'test-provider',
    content: JSON.stringify({ version: 1, kind: 'clash.groups', groups: [{ name: '<script>bad()</script>',
      explanation: '<img src=x onerror=bad()>', citations: ['E1'] }] }) }] });
  const native = useViewerStore.getState();
  const ui = render(<ClashGroupReview />);
  const preview = ui.querySelector('button')!;
  click(preview);
  const stats = ui.querySelector('dl')!;
  assert.match(stats.getAttribute('aria-label') ?? '', /Native findings: 1\. Proposed: 1\. Unclassified: 0/);
  assert.deepEqual([...stats.querySelectorAll('dd')].map(value => value.textContent), ['1', '1', '0', '0']);
  assert.match(ui.textContent ?? '', /Preview only/);
  assert.match(ui.textContent ?? '', /<script>bad/);
  assert.equal(ui.querySelector('script, img'), null);
  assert.ok(ui.querySelector('section[aria-label="Captured evidence context"]'));
  assert.equal(useViewerStore.getState(), native);
  // Beyond Preview, the only controls show native occurrences in the model: no apply/BCF action.
  const focus = [...ui.querySelectorAll('button')].filter(button => button !== preview);
  assert.deepEqual(focus.map(button => button.getAttribute('aria-label') ?? button.title),
    ['Show <script>bad()</script> in the model', 'Show this clash in the model']);
  assert.ok(focus.every(button => !button.disabled), 'cited occurrences resolve against the live native report');
  focus.forEach(button => click(button));
  const focused = useViewerStore.getState();
  assert.equal(focused.clashReviews, native.clashReviews, 'focusing never records a review decision');
  assert.equal(focused.clashResult, native.clashResult);
  act(() => useViewerStore.setState({ mutationVersion: native.mutationVersion + 1 }));
  assert.equal(preview.disabled, true);
  assert.ok(focus.every(button => button.disabled), 'a stale preview cannot drive the scene');
  assert.ok(ui.querySelector('[role="alert"]'));
});
