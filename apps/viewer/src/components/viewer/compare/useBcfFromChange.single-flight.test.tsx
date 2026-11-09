/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * C-2 (compare sibling): "raise a BCF topic from a change" has the same async
 * capture + create as the BCF panel. The real hook drives the real create
 * form; only GPU completion of the real viewport capture is held. Assertions
 * compare plain values, never DOM nodes.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { render, cleanup, click, waitFor } from '@/test/render.js';
import { installHeldCapture, type HeldCapture } from '@/test/bcf-held-capture.js';
import { useViewerStore } from '@/store/index.js';
import { toast } from '@/components/ui/toast';
import { BCFCreateTopicForm } from '../bcf/BCFCreateTopicForm';
import { useBcfFromChange } from './useBcfFromChange';

const MODELS = [{ name: 'Revision.ifc' }];

function Probe() {
  const [selectedKey, setSelectedKey] = useState('change-1');
  const bcf = useBcfFromChange(MODELS, selectedKey);
  return <>
    <button data-open onClick={() => bcf.setFormOpen(true)}>open</button>
    <button data-next-change onClick={() => setSelectedKey(key => `${key}+`)}>next</button>
    {bcf.formOpen && <BCFCreateTopicForm author="reviewer@example.invalid" initialTitle="Changed wall"
      onSubmit={bcf.submit} onCancel={() => bcf.setFormOpen(false)}
      snapshot={bcf.viewpoint?.snapshot ?? null} onCaptureSnapshot={() => void bcf.captureViewpoint()}
      capturingSnapshot={bcf.capturingSnapshot} submitting={bcf.submitting} />}
  </>;
}

let capture: HeldCapture;
beforeEach(() => {
  capture = installHeldCapture();
  useViewerStore.setState({
    bcfProject: null, models: new Map(), hiddenEntities: new Set(), isolatedEntities: null,
    selectedEntityId: null, selectedEntityIds: new Set(),
  });
});
afterEach(() => { cleanup(); capture.dispose(); mock.restoreAll(); document.body.innerHTML = ''; });

const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
const buttonNamed = (name: string) => [...document.body.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
const press = (selector: string) => { const node = q(selector); assert.ok(node, selector); click(node); };
const topicCount = () => useViewerStore.getState().bcfProject?.topics.size ?? 0;
const submitEvent = () => new window.Event('submit', { bubbles: true, cancelable: true });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
const snapshotShown = () => q('img[alt="Viewpoint snapshot"]') !== null;

for (const [how, close] of [
  ['Cancel', () => { const cancel = buttonNamed('Cancel'); assert.ok(cancel, 'Cancel'); click(cancel); }],
  ['focusing another change', () => press('[data-next-change]')],
] as const) {
  test(`C-2 compare: after ${how}, an earlier capture neither lands in nor stops the spinner of the reopened form`, async () => {
    render(<Probe />);
    press('[data-open]');
    close();
    press('[data-open]');
    await capture.release(1);
    assert.equal(snapshotShown(), false, 'the earlier capture is not shown in the reopened form');
    assert.equal(buttonNamed('Recapture')?.disabled, true, 'the earlier capture does not end the reopened form\'s capture');
    await capture.release(2);
    await waitFor(snapshotShown, 'the reopened form shows its own capture');
    assert.equal(q<HTMLImageElement>('img[alt="Viewpoint snapshot"]')?.getAttribute('src'), 'data:image/png;base64,frame-2');
  });
}

test('C-2 compare: a create cancelled while its viewpoint is capturing adds no topic and no project', async () => {
  render(<Probe />);
  press('[data-open]');
  const form = q('form'); assert.ok(form, 'form');
  act(() => { form.dispatchEvent(submitEvent()); });
  const cancel = buttonNamed('Cancel'); assert.ok(cancel, 'Cancel'); click(cancel);
  capture.releaseAll();
  await settle();
  assert.equal(useViewerStore.getState().bcfProject === null, true, 'a cancelled create adds no topic and no empty project');
});

test('C-2 compare: a double submit captures one viewpoint, adds one topic and disables Submit meanwhile', async () => {
  render(<Probe />);
  press('[data-open]');
  const form = q('form'); assert.ok(form, 'form');
  act(() => { form.dispatchEvent(submitEvent()); form.dispatchEvent(submitEvent()); });
  assert.equal(buttonNamed('Create Topic')?.disabled, true, 'submit is disabled while the topic is being created');
  capture.releaseAll();
  await waitFor(() => topicCount() > 0, 'the topic is created');
  await settle();
  assert.equal(capture.frames(), 2, 'one capture for the opening, one for the single accepted submit');
  assert.equal(topicCount(), 1);
});

for (const cancelled of [false, true]) {
  test(`C-2 compare: a viewpoint that fails during Create ${cancelled ? 'after Cancel reports nothing' : 'toasts once and creates nothing'}`, async () => {
    const errors = mock.method(toast, 'error', () => undefined);
    const logged = mock.method(console, 'error', () => undefined);
    render(<Probe />);
    press('[data-open]');
    const form = q('form'); assert.ok(form, 'form');
    act(() => { form.dispatchEvent(submitEvent()); });
    if (cancelled) { const cancel = buttonNamed('Cancel'); assert.ok(cancel, 'Cancel'); click(cancel); }
    await capture.release(1);
    capture.breakCamera();
    await capture.fail(2);
    await settle();
    assert.equal(errors.mock.callCount(), cancelled ? 0 : 1);
    assert.ok(logged.mock.calls.some(call => call.arguments.some(arg => String(arg).includes('camera unavailable'))), 'the failure is always logged');
    assert.equal(useViewerStore.getState().bcfProject === null, true, 'a failed capture creates no topic and no project');
    assert.equal(q('form') !== null, !cancelled, 'a current create keeps the form open to retry');
  });
}
