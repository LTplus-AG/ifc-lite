/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * C-2: the create-topic form's viewpoint capture and submit are async. A
 * double submit must create one topic, and a capture from an earlier opening
 * of the form must not land in (or clear the spinner of) a later opening.
 * The real viewport capture path runs; only GPU completion is held.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { createBCFProject } from '@ifc-lite/bcf';
import { render, cleanup, click, type, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import { clearGlobalRefs, setGlobalCanvasRef, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { registerViewportCapture } from '@/lib/viewport-capture';
import { BCFPanel } from './BCFPanel.js';

installLayout();

let gpuGates: Array<() => void> = [];
let holdGpu = true;
let frames = 0;
let unregister = () => {};

beforeEach(() => {
  gpuGates = [];
  holdGpu = true;
  frames = 0;
  const renderer = {
    renderWithResult: () => true,
    requestRender: () => {},
    getGPUDevice: () => ({ queue: { onSubmittedWorkDone: () => holdGpu ? new Promise<void>(resolve => { gpuGates.push(resolve); }) : Promise.resolve() } }),
    getCamera: () => ({
      getPosition: () => ({ x: 10, y: 5, z: 20 }), getTarget: () => ({ x: 1, y: 2, z: 3 }), getUp: () => ({ x: 0, y: 1, z: 0 }),
      getFOV: () => Math.PI / 4, getProjectionMode: () => 'perspective', getOrthoSize: () => 10, getAspect: () => 16 / 9,
    }),
  } as unknown as Renderer;
  const canvas = document.createElement('canvas');
  canvas.toDataURL = () => `data:image/png;base64,frame-${++frames}`;
  document.body.appendChild(canvas);
  setGlobalRendererRef({ current: renderer });
  setGlobalCanvasRef({ current: canvas });
  unregister = registerViewportCapture(renderer, canvas, () => ({}));
  useViewerStore.setState({
    bcfProject: createBCFProject({ name: 'Single flight' }), activeTopicId: null, models: new Map(),
    hiddenEntities: new Set(), isolatedEntities: null, selectedEntityId: null, selectedEntityIds: new Set(),
  });
});

afterEach(() => { cleanup(); unregister(); clearGlobalRefs(); mock.restoreAll(); document.body.innerHTML = ''; });

const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
const buttonNamed = (name: string) => [...document.body.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
const openForm = () => { const open = q<HTMLButtonElement>('[aria-label="New topic"]'); assert.ok(open, document.body.textContent?.slice(0, 400)); click(open); };
const releaseGpu = async (count: number) => {
  await waitFor(() => gpuGates.length >= count, `capture ${count} reached GPU completion`);
  await act(async () => { gpuGates[count - 1](); await new Promise(resolve => setTimeout(resolve, 50)); });
};

test('C-2 a double-submitted create form adds one topic while its viewpoint is still capturing', async () => {
  render(<BCFPanel onClose={() => {}} />);
  openForm();
  const title = q<HTMLInputElement>('#title'); assert.ok(title);
  type(title, 'Clash at grid C4');
  const form = q<HTMLFormElement>('form'); assert.ok(form);
  // Enter + click: two submits before the awaited viewpoint resolves.
  act(() => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  act(() => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  assert.equal(buttonNamed('Create Topic')?.disabled, true, 'submit is disabled while the topic is being created');
  // Let every queued capture complete, then give any refused second submit time to land.
  holdGpu = false;
  for (const gate of gpuGates) gate();
  await waitFor(() => (useViewerStore.getState().bcfProject?.topics.size ?? 0) > 0, 'the topic is created');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  assert.equal(useViewerStore.getState().bcfProject?.topics.size, 1, 'one submit gesture burst creates one topic');
});

test('C-2 a capture from an earlier opening neither lands in nor stops the spinner of the reopened form', async () => {
  render(<BCFPanel onClose={() => {}} />);
  openForm();
  await waitFor(() => gpuGates.length === 1, 'the first opening is capturing');
  const cancel = buttonNamed('Cancel'); assert.ok(cancel); click(cancel);
  openForm();
  await releaseGpu(1);
  // Compare a boolean, never a DOM node: a failing assert.equal deep-inspects happy-dom's node graph (OOM).
  assert.equal(q('img[alt="Viewpoint snapshot"]') !== null, false, 'the earlier capture is not shown in the reopened form');
  assert.equal(buttonNamed('Recapture')?.disabled, true, 'the earlier capture does not end the reopened form\'s capture');
  await releaseGpu(2);
  await waitFor(() => q('img[alt="Viewpoint snapshot"]') !== null, 'the reopened form shows its own capture');
  assert.equal(q<HTMLImageElement>('img[alt="Viewpoint snapshot"]')?.getAttribute('src'), 'data:image/png;base64,frame-2');
  assert.equal(buttonNamed('Recapture')?.disabled, false);
});
