/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { columnGraph, openFlowSample, sampleColumns } from '@/test/flow-sample-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, cancelAssistant } from '@/lib/assistant/conversation';
import { prepareFlowCreateProposal, applyFlowCreateProposal } from '@/lib/assistant/flow-create';
import { openAssistant, useAssistantPlacement } from '@/lib/assistant/placement';
import { SidebarPanelHost } from '@/components/viewer/sidebar/SidebarPanelHost';
import { useFlowCreateReview } from './FlowCreateReview';

const initial = useViewerStore.getState();
const placement = useAssistantPlacement.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistantPlacement.setState(placement, true);
  useFlowCreateReview.setState({ proposal: null, receipt: null, approved: false, error: null });
  localStorage.clear();
});

// #7075: a real sidebar slot transition must not discard the native preflight result.
test('split Assistant keeps the successful preflight visible when Edit mode enters the Model workspace', async () => {
  const model = await openFlowSample();
  const evidence = captureEvidence('flow');
  const proposal = prepareFlowCreateProposal(JSON.stringify({ version: 1, kind: 'flow.create', ...columnGraph([0, 4, 8]) }), evidence);
  const receipt = applyFlowCreateProposal(proposal, proposal.digest);
  useFlowCreateReview.setState({ receipt });
  replaceEvidence(evidence);
  useViewerStore.getState().setEditEnabled(false);
  useViewerStore.getState().showWorkspacePanel('loadReport');
  useAssistantPlacement.setState({ placement: 'split' });
  openAssistant('flow');
  const ui = render(<SidebarPanelHost />);
  const review = () => ui.querySelector('section[aria-label="Review new Flow graph"]');
  const button = (name: string) => [...(review()?.querySelectorAll('button') ?? [])].find(b => b.textContent === name);
  await waitFor(() => !!button('Preflight'), 'created Flow review mounts in the sidebar');
  click(button('Preflight')!);
  await waitFor(() => !!button('Turn on Edit mode'), 'native preflight reports edit denial');
  await act(async () => button('Turn on Edit mode')!.click());
  await waitFor(() => !!review()?.textContent?.includes('Preflight passed for “Columns along X”'), 'successful native preflight remains visible after workspace entry');
  assert.equal(useViewerStore.getState().editEnabled, true);
  assert.equal(useViewerStore.getState().sidebarSecondaryPanel, 'assistant');
  assert.equal(useViewerStore.getState().flowLastRun, null, 'preflight never executes the graph');
  assert.deepEqual(sampleColumns(model), [], 'preflight never creates columns');
});
