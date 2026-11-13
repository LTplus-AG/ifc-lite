/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * C-2: the create-topic form's viewpoint capture and submit are async. A
 * double submit must capture and create once, a capture from an earlier
 * opening of the form must not land in (or clear the spinner of) a later
 * opening, and a create cancelled mid-capture must create nothing. The real
 * viewport capture path runs; only GPU completion is held.
 *
 * Assertions compare plain values, never DOM nodes: a failing assert.equal on
 * a happy-dom node deep-inspects the whole document graph (that OOM'd once).
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

beforeEach(() => {
  capture = installHeldCapture();
  useViewerStore.setState({
    bcfProject: createBCFProject({ name: 'Single flight' }), activeTopicId: null, models: new Map(),
    hiddenEntities: new Set(), isolatedEntities: null, selectedEntityId: null, selectedEntityIds: new Set(),
  });
});

afterEach(() => { cleanup(); capture.dispose(); mock.restoreAll(); document.body.innerHTML = ''; });

const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
const buttonNamed = (name: string) => [...document.body.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
const topicCount = () => useViewerStore.getState().bcfProject?.topics.size ?? 0;
const formOpen = () => q('#title') !== null;
const openForm = () => { const open = q<HTMLButtonElement>('[aria-label="New topic"]'); assert.ok(open, 'New topic button'); click(open); };
const fillTitle = () => { const title = q<HTMLInputElement>('#title'); assert.ok(title, 'title input'); type(title, 'Clash at grid C4'); };
const submitEvent = () => new window.Event('submit', { bubbles: true, cancelable: true });
const submitOnce = () => { const form = q('form'); assert.ok(form, 'form'); act(() => { form.dispatchEvent(submitEvent()); }); };
/** Enter + click: both submits land in one act(), before React re-renders Submit disabled. */
const submitTwice = () => {
  const form = q('form'); assert.ok(form, 'form');
  act(() => { form.dispatchEvent(submitEvent()); form.dispatchEvent(submitEvent()); });
};
const cancelForm = () => { const cancel = buttonNamed('Cancel'); assert.ok(cancel, 'Cancel'); click(cancel); };
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });

test('C-2 a double-submitted create form captures one viewpoint and adds one topic', async () => {
  render(<BCFPanel onClose={() => {}} />);
  openForm();
  fillTitle();
  submitTwice();
  assert.equal(buttonNamed('Create Topic')?.disabled, true, 'submit is disabled while the topic is being created');
  capture.releaseAll();
  await waitFor(() => topicCount() > 0, 'the topic is created');
  await settle();
  // One for the form opening, one for the single accepted submit.
  assert.equal(capture.frames(), 2, 'the refused second submit never captured a viewpoint');
  assert.equal(topicCount(), 1, 'one submit gesture burst creates one topic');
});

test('C-2 a capture from an earlier opening neither lands in nor stops the spinner of the reopened form', async () => {
  render(<BCFPanel onClose={() => {}} />);
  openForm();
  cancelForm();
  openForm();
  await capture.release(1);
  assert.equal(q('img[alt="Viewpoint snapshot"]') !== null, false, 'the earlier capture is not shown in the reopened form');
  assert.equal(buttonNamed('Recapture')?.disabled, true, 'the earlier capture does not end the reopened form\'s capture');
  await capture.release(2);
  await waitFor(() => q('img[alt="Viewpoint snapshot"]') !== null, 'the reopened form shows its own capture');
  assert.equal(q<HTMLImageElement>('img[alt="Viewpoint snapshot"]')?.getAttribute('src'), 'data:image/png;base64,frame-2');
  assert.equal(buttonNamed('Recapture')?.disabled, false);
});

test('C-2 a create cancelled while its viewpoint is capturing adds no topic and no project', async () => {
  useViewerStore.setState({ bcfProject: null });
  render(<BCFPanel onClose={() => {}} />);
  openForm();
  fillTitle();
  submitOnce();
  cancelForm();
  capture.releaseAll();
  await settle();
  assert.equal(formOpen(), false);
  assert.equal(useViewerStore.getState().bcfProject === null, true, 'a cancelled create adds no topic and no empty project');
});

test('C-2 a viewpoint that fails during Create reports the failure and keeps the form open', async () => {
  const errors = mock.method(toast, 'error', () => undefined);
  const logged = mock.method(console, 'error', () => undefined);
  render(<BCFPanel onClose={() => {}} />);
  openForm();
  fillTitle();
  submitOnce();
  await capture.release(1);
  capture.breakCamera();
  await capture.fail(2);
  await settle();
  assert.equal(errors.mock.callCount(), 1, 'the person is told the viewpoint could not be captured');
  assert.ok(logged.mock.calls.some(call => call.arguments.some(arg => String(arg).includes('camera unavailable'))), 'the failure is logged');
  assert.equal(topicCount(), 0);
  assert.equal(formOpen(), true, 'the form stays open so the person can retry');
});

test('C-2 a viewpoint that fails after the create was cancelled reports nothing', async () => {
  const errors = mock.method(toast, 'error', () => undefined);
  mock.method(console, 'error', () => undefined);
  render(<BCFPanel onClose={() => {}} />);
  openForm();
  fillTitle();
  submitOnce();
  cancelForm();
  await capture.release(1);
  capture.breakCamera();
  await capture.fail(2);
  await settle();
  assert.equal(errors.mock.callCount(), 0, 'a cancelled create raises no capture toast');
  assert.equal(topicCount(), 0);
});

test('C-2 a viewport lost while Create captures (capture resolves null) toasts once and creates nothing', async () => {
  const errors = mock.method(toast, 'error', () => undefined);
  mock.method(console, 'error', () => undefined);
  mock.method(console, 'warn', () => undefined);
  render(<BCFPanel onClose={() => {}} />);
  openForm();
  fillTitle();
  // The snapshot was offered (a viewport existed); it goes away before Create captures.
  capture.unplug();
  submitOnce();
  await settle();
  assert.equal(errors.mock.callCount(), 1, 'a null capture is reported like a thrown one');
  assert.equal(topicCount(), 0, 'no topic without the requested viewpoint');
  assert.equal(formOpen(), true);
});

test('C-2 with no model loaded (no viewport), Create offers no snapshot and adds the topic without a viewpoint', async () => {
  const errors = mock.method(toast, 'error', () => undefined);
  capture.unplug();
  render(<BCFPanel onClose={() => {}} />);
  openForm();
  assert.equal(buttonNamed('Recapture') !== undefined, false, 'no snapshot is offered without a viewport');
  fillTitle();
  submitOnce();
  await settle();
  assert.equal(errors.mock.callCount(), 0);
  assert.equal(topicCount(), 1, 'the topic is created');
  const topic = [...(useViewerStore.getState().bcfProject?.topics.values() ?? [])][0];
  assert.equal(topic?.viewpoints.length, 0, 'without a viewpoint');
  assert.equal(formOpen(), false);
});
