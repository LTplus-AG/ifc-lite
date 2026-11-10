/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A topic create that throws is reported to the user. On useSingleFlight the
 * throw rejected `run()` unhandled, and the only trace was the global "report
 * this error" invitation; useAsyncRun keeps it in its state, so the panel
 * must say it. Plain-value assertions only (no DOM nodes in assert.equal).
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBCFProject } from '@ifc-lite/bcf';
import { render, cleanup, click, type, waitFor } from '@/test/render.js';
import { installHeldCapture, type HeldCapture } from '@/test/bcf-held-capture.js';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store/index.js';
import { BCFPanel } from './BCFPanel.js';

installLayout();

let capture: HeldCapture;
const initialAddTopic = useViewerStore.getState().addTopic;

beforeEach(() => {
  capture = installHeldCapture();
  capture.releaseAll();
  useViewerStore.setState({
    bcfProject: createBCFProject({ name: 'Create failure' }), activeTopicId: null, models: new Map(),
    hiddenEntities: new Set(), isolatedEntities: null, selectedEntityId: null, selectedEntityIds: new Set(),
  });
});

afterEach(() => {
  cleanup(); capture.dispose(); mock.restoreAll(); document.body.innerHTML = '';
  useViewerStore.setState({ addTopic: initialAddTopic });
});

const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
const buttonNamed = (name: string) => [...document.body.querySelectorAll('button')].find(node => node.textContent?.trim() === name);

test('a create that throws shows an error toast, adds nothing, and leaves the form usable', async () => {
  const errors: string[] = [];
  mock.method(toast, 'error', (message: unknown) => { errors.push(String(message)); return ''; });
  mock.method(console, 'error', () => undefined);
  useViewerStore.setState({ addTopic: () => { throw new Error('The BCF project is read-only.'); } });
  render(<BCFPanel onClose={() => {}} />);
  const open = q<HTMLButtonElement>('[aria-label="New topic"]'); assert.ok(open, 'New topic button');
  click(open);
  const title = q<HTMLInputElement>('#title'); assert.ok(title, 'title input');
  type(title, 'Clash at grid C4');
  const form = q('form'); assert.ok(form, 'form');
  act(() => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  await waitFor(() => errors.length > 0, 'the failure is reported');
  assert.deepEqual([...errors], ['Could not create the topic. The BCF project is read-only.']);
  assert.equal(useViewerStore.getState().bcfProject?.topics.size, 0, 'no topic was added');
  assert.equal(q('#title') !== null, true, 'the form stays open with the user\'s input');
  await waitFor(() => buttonNamed('Create Topic')?.disabled === false, 'Create Topic is usable again');
});
