/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { useAssistant } from '@/lib/assistant/conversation';
import { assistantLibrary } from '@/lib/assistant/library';
import { captureEvidence } from '@/lib/assistant/evidence';
import type { SavedConversation } from '@/lib/assistant/persistence';
import { useArtifactDeepLink } from './useArtifactDeepLink';

const initial = useViewerStore.getState();
const assistant = useAssistant.getState();
afterEach(() => {
  cleanup(); useViewerStore.setState(initial, true); useAssistant.setState(assistant, true);
  window.history.replaceState(null, '', '/');
});
function Entry() {
  useArtifactDeepLink();
  const archive = useAssistant(s => s.archived);
  return <output>{archive?.messages.map(message => message.content).join(' ') ?? 'No archive open'}</output>;
}

test('#6927 a cold native deep link lazily opens its saved archive and consumes only owned URL parameters', async () => {
  const id = crypto.randomUUID();
  const entry: SavedConversation = { version: 1, id, name: 'Recorded archive', savedAt: new Date().toISOString(), model: 'recorded-provider',
    evidence: captureEvidence('selection'), messages: [{ role: 'user', content: 'Recorded question' },
      { role: 'assistant', content: 'Recorded archive answer', model: 'recorded-provider' }] };
  assert.equal(await assistantLibrary.put(id, entry), true);
  useAssistant.setState({ status: 'idle', messages: [], snapshot: null, archived: null });
  window.history.replaceState(null, '', `/?conversation=${id}&model=sample.ifc`);
  const ui = render(<Entry />);
  await waitFor(() => ui.textContent?.includes('Recorded archive answer') === true, 'native archive opens through the lazy URL entry');
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'assistant');
  assert.equal(useAssistant.getState().snapshot, null, 'an archive grants no current request authority');
  const search = new URLSearchParams(window.location.search);
  assert.equal(search.get('model'), 'sample.ifc');
  assert.equal(search.has('conversation'), false);
});
