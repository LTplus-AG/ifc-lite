/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * C-2 (BCF drafts from clashes): drafting builds and saves a batch
 * asynchronously, so a same-tick double press must draft once. An empty
 * selection makes each accepted draft observable as one "nothing to draft"
 * report. Plain-value assertions.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { summarizeClashes, type ClashResult } from '@ifc-lite/clash';
import { cleanup, render } from '@/test/render.js';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { useBcfDraftActions } from './useBcfDraftActions';

function Probe() {
  const { drafting, draftFromSelection } = useBcfDraftActions();
  return <button data-draft disabled={drafting} onClick={() => void draftFromSelection([])}>draft</button>;
}

const RESULT: ClashResult = {
  clashes: [], summary: summarizeClashes([]),
  rulesRun: [{ id: 'coordination', name: 'Coordination', a: 'IfcWall', b: 'IfcPipeSegment', mode: 'hard' }],
  settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
};

beforeEach(() => { useViewerStore.setState({ clashResult: RESULT }); });
afterEach(() => { cleanup(); mock.restoreAll(); useViewerStore.setState({ clashResult: null }); });

test('C-2 drafts: a double-pressed draft action drafts once', async () => {
  const errors = mock.method(toast, 'error', () => undefined);
  render(<Probe />);
  const button = document.body.querySelector('[data-draft]'); assert.ok(button, 'draft button');
  act(() => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  assert.equal(errors.mock.callCount(), 1, 'the refused second press drafted nothing');
});
