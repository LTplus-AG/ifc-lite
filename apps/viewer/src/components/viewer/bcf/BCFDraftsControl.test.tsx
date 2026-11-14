/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drafts dialog is loaded on demand (kept off the eager bundle): nothing
 * is mounted until the header action opens it, the opened dialog appears,
 * and after closing it stays mounted (closed) rather than being torn down.
 * Plain-value assertions only.
 */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render, waitFor } from '@/test/render.js';
import { useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { useBcfDraftsAction } from './BCFDraftsControl';

afterEach(() => { cleanup(); useBcfDraftLibrary.setState({ dialogOpen: false }); });

function Host() {
  const { action, dialog } = useBcfDraftsAction();
  return <><button type="button" onClick={action.onSelect}>{action.label}</button>{dialog}</>;
}

const dialogShown = () => [...document.body.querySelectorAll('[role="dialog"]')].some(node => node.textContent?.includes('BCF drafts & publication'));

test('the drafts dialog mounts on first open and opens from the header action', async () => {
  const ui = render(<Host />);
  assert.equal(dialogShown(), false, 'nothing rendered before the first opening');
  const open = [...ui.querySelectorAll('button')].find(node => node.textContent === 'BCF drafts & publication');
  assert.ok(open, 'the header action');
  act(() => { open.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await waitFor(() => dialogShown(), 'the lazily loaded dialog opens');
  act(() => { useBcfDraftLibrary.setState({ dialogOpen: false }); });
  await waitFor(() => !dialogShown(), 'the dialog closes');
  act(() => { useBcfDraftLibrary.setState({ dialogOpen: true }); });
  await waitFor(() => dialogShown(), 'and reopens');
});
