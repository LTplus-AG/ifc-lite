/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { act } from 'react';
import { render, cleanup, click, press, type, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '@/lib/assistant/conversation';
import { setAssistantDraft } from '@/lib/assistant/composer-draft';
import { openAssistant, useAssistantPlacement } from '@/lib/assistant/placement';
import { MobilePanelSheet } from '../MobilePanelSheet';
import { TransientSurface } from './TransientSurface';

const initial = useViewerStore.getState();
const placement = useAssistantPlacement.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); setAssistantDraft('');
  useViewerStore.setState(initial, true); useAssistantPlacement.setState(placement, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

test('#6926 Escape closes the focused transient surface and returns focus without cancelling a request', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open sources</button>
      {open && <TransientSurface label="Sources" onClose={() => setOpen(false)}><input aria-label="Source search" /></TransientSurface>}</>;
  }
  const ui = render(<Harness />);
  const opener = ui.querySelector('button')!;
  opener.focus(); click(opener);
  const surface = ui.querySelector('fieldset')!;
  assert.equal(document.activeElement, surface, 'opening announces and focuses the labelled region');
  assert.equal(surface.getAttribute('aria-label'), 'Sources');
  const field = ui.querySelector('input')!;
  field.focus();
  act(() => useAssistant.setState({ status: 'streaming' }));
  press(field, 'Escape');
  assert.equal(ui.querySelector('fieldset'), null);
  assert.equal(document.activeElement, opener);
  assert.equal(useAssistant.getState().status, 'streaming', 'Escape closes the surface, not the request');
});

test('#6926 transient cleanup never pulls focus back after the user moves elsewhere', () => {
  let close!: () => void;
  function Harness() {
    const [open, setOpen] = useState(false);
    close = () => setOpen(false);
    return <><button onClick={() => setOpen(true)}>Open sources</button><button>Elsewhere</button>
      {open && <TransientSurface label="Sources" onClose={close}><input /></TransientSurface>}</>;
  }
  const ui = render(<Harness />);
  const [opener, elsewhere] = [...ui.querySelectorAll('button')];
  opener.focus(); click(opener); elsewhere.focus();
  act(() => close());
  assert.equal(document.activeElement, elsewhere);
});

test('#6926 the narrow Assistant sheet returns to its source and preserves evidence, selection and unsent draft', async () => {
  useViewerStore.setState({ isMobile: true, sidebarActivePanel: 'properties', rightPanelCollapsed: false,
    selectedEntityId: 42, selectedEntityIds: new Set([42]) });
  replaceEvidence(captureEvidence('clash'));
  const snapshot = useAssistant.getState().snapshot;
  openAssistant('properties');
  const ui = render(<MobilePanelSheet bottomInset={0} analysisExtension={null} />);
  await waitFor(() => !!ui.querySelector('textarea'), 'Assistant lazy body mounted');
  type(ui.querySelector('textarea')!, 'Explain the captured conflicts');
  const back = [...ui.querySelectorAll('button')].find(button => /Back to Properties/.test(button.textContent ?? ''));
  assert.ok(back, 'the narrow sheet exposes its actual source return target');
  click(back);
  assert.equal(ui.querySelector('textarea'), null, 'returning unmounts the Assistant body');
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'properties');
  act(() => openAssistant('properties'));
  await waitFor(() => !!ui.querySelector('textarea'), 'Assistant returns');
  assert.equal(ui.querySelector('textarea')!.value, 'Explain the captured conflicts');
  assert.equal(useAssistant.getState().snapshot, snapshot);
  assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [42]);
});
