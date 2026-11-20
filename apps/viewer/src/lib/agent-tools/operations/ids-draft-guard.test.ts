/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { wallFixture } from '@/test/ids-studio-fixture';
import { seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { setSpecTextOp } from '@/lib/ids-studio/ops';
import { loadIdsStudioRuntime } from '@/lib/ids-studio/runtime-loader';
import { idsStudioDraftLibrary } from '@/lib/ids-studio/draft-library';
import { startIdsDraftAutosave, useIdsDraftFeedback } from '@/lib/ids-studio/draft-viewer';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';

// Separate file: the draft autosave subscription is module-wide once installed.
test('#10585 an agent document candidate does not replace an open draft whose save failed', async context => {
  await seedAuthoringSample();
  const fixture = await wallFixture();
  await loadIdsStudioRuntime();
  useViewerStore.setState({ idsStudioState: fixture.state, idsStudioContexts: fixture.contexts, idsStudioRevision: 0, idsStudioRejection: null, idsStudioDraftId: 'draft-unsaved' });
  const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  const put = context.mock.method(idsStudioDraftLibrary, 'put', async () => false);
  startIdsDraftAutosave();

  useViewerStore.getState().idsStudioDispatch([setSpecTextOp(fixture.specId, 'name', 'Unsaved edit')]);
  const revision = useViewerStore.getState().idsStudioRevision;
  const prepared = await dispatchMainViewerTool(host, 'viewer_operation_inspect', { operation_id: 'ids.document.prepare',
    input: { format: 'new', content: 'Replacement', document_revision: revision } });
  assert.equal(prepared.isError, false, prepared.text);
  const { token } = (prepared.structured as { result: { token: string } }).result;

  const applied = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'ids.candidate.apply', input: { token } }, { canEdit: () => true });
  const detail = `${applied.text} / feedback ${JSON.stringify(useIdsDraftFeedback.getState())}`;
  assert.equal(applied.isError, true, detail);
  assert.match(applied.text, /open IDS draft could not be saved/, detail);
  assert.equal(put.mock.callCount(), 1, `the open draft was saved before replacing it: ${detail}`);
  const live = useViewerStore.getState();
  assert.equal(live.idsStudioDraftId, 'draft-unsaved');
  assert.equal(live.idsStudioState!.doc.ids.specifications[0].name, 'Unsaved edit');
});
