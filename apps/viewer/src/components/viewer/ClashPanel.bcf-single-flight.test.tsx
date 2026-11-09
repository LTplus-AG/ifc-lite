/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * C-2 (clash sibling): the Clash panel's "BCF topic" action and a manual
 * group's BCF action capture a viewpoint, then create a topic. They share one
 * flight: a same-tick double press captures and creates once, and a capture
 * that settles after the panel closed creates nothing and reports nothing.
 * The real viewport capture runs; only GPU completion is held. Assertions
 * compare plain values, never DOM nodes.
 */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { summarizeClashes, type Clash, type ClashResult } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { MANUAL_CLASH_GROUPS_KEY } from '@/lib/clash/manual-groups';
import { cleanup, render, waitFor } from '@/test/render.js';
import { installHeldCapture, type HeldCapture } from '@/test/bcf-held-capture.js';
import { toast } from '@/components/ui/toast';
import { ClashPanel } from './ClashPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });

function clash(id: string, a: number, b: number): Clash {
  return {
    id,
    a: { key: `${id}-wall`, ref: a, model: 'model', tag: 'IfcWall', name: `${id} wall` },
    b: { key: `${id}-pipe`, ref: b, model: 'model', tag: 'IfcPipeSegment', name: `${id} pipe` },
    rule: 'coordination', status: 'hard', distance: -0.1, point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] }, severity: 'major',
  };
}
function result(): ClashResult {
  const clashes = [clash('c1', 1, 2), clash('c2', 3, 4)];
  return {
    clashes, summary: summarizeClashes(clashes),
    rulesRun: [{ id: 'coordination', name: 'Coordination', a: 'IfcWall', b: 'IfcPipeSegment', mode: 'hard' }],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

let capture: HeldCapture;
beforeEach(() => {
  localStorage.removeItem(MANUAL_CLASH_GROUPS_KEY);
  capture = installHeldCapture();
  useViewerStore.setState({
    clashResult: result(), clashGroups: [], clashSelectedId: 'c1', clashSortBy: 'severity', clashHideTouching: false,
    clashReviews: new Map(), clashStatusFilter: new Set(['open', 'resolved', 'accepted']),
    bcfProject: null, bcfPanelVisible: false,
    // Group framing waits on the camera's frameSelection; this one lands at once.
    cameraCallbacks: { frameSelection: () => Promise.resolve() },
    fromGlobalId: (expressId: number) => ({ modelId: 'model', expressId }),
  });
});
afterEach(() => {
  cleanup();
  capture.dispose();
  mock.restoreAll();
  useViewerStore.getState().clearClashFocus();
  useViewerStore.setState({ clashResult: null, clashGroups: null, bcfProject: null });
  localStorage.removeItem(MANUAL_CLASH_GROUPS_KEY);
  document.body.innerHTML = '';
});

const buttonNamed = (text: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
const topicCount = () => useViewerStore.getState().bcfProject?.topics.size ?? 0;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
/** A double-click: both presses land in one act(), before React re-renders the action disabled. */
const pressTogether = (...nodes: Element[]) => act(() => {
  for (const node of nodes) node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});
const clashTopicButton = () => { const b = buttonNamed('BCF topic'); assert.ok(b, 'the Clash panel offers "BCF topic"'); return b; };

async function groupBothClashes(): Promise<HTMLButtonElement> {
  const boxes = [...document.body.querySelectorAll('input[type="checkbox"]')]
    .filter(input => input.getAttribute('aria-label')?.startsWith('Select clash '));
  assert.equal(boxes.length, 2, 'each pair row offers grouping selection');
  await act(async () => { for (const box of boxes) (box as HTMLInputElement).click(); });
  const group = buttonNamed('Group selected (2)'); assert.ok(group, 'Group selected');
  await act(async () => group.click());
  const input = document.body.querySelector('input[maxlength="100"]');
  assert.ok(input instanceof HTMLInputElement, 'group-name input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter, 'value setter');
  await act(async () => { setter.call(input, 'Riser'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  const create = buttonNamed('Create group'); assert.ok(create, 'Create group');
  await act(async () => create.click());
  const bcf = document.body.querySelector('button[title="Create one BCF topic from this group"]');
  assert.ok(bcf instanceof HTMLButtonElement, 'the group offers a BCF action');
  return bcf;
}

test('C-2 clash: a double-pressed "BCF topic" captures one viewpoint and creates one topic', async () => {
  render(<ClashPanel />);
  const button = clashTopicButton();
  pressTogether(button, button);
  capture.releaseAll();
  await waitFor(() => topicCount() > 0, 'the topic is created');
  await settle();
  assert.equal(capture.frames(), 1, 'the refused second press never captured a viewpoint');
  assert.equal(topicCount(), 1);
});

test('C-2 clash: a "BCF topic" capture that settles after the panel closed creates no topic and no project', async () => {
  render(<ClashPanel />);
  pressTogether(clashTopicButton());
  await waitFor(() => capture.frames() === 1, 'the viewpoint is capturing');
  cleanup();
  capture.releaseAll();
  await settle();
  assert.equal(useViewerStore.getState().bcfProject === null, true, 'a closed panel creates nothing');
});

test('C-2 clash: a double-pressed group BCF action captures one viewpoint and creates one topic', async () => {
  render(<ClashPanel />);
  const bcf = await groupBothClashes();
  pressTogether(bcf, bcf);
  capture.releaseAll();
  await waitFor(() => topicCount() > 0, 'the group topic is created');
  await settle();
  assert.equal(capture.frames(), 1, 'the refused second press never captured a viewpoint');
  assert.equal(topicCount(), 1);
});

test('C-2 clash: the clash and group BCF actions share one flight', async () => {
  render(<ClashPanel />);
  const bcf = await groupBothClashes();
  pressTogether(clashTopicButton(), bcf);
  capture.releaseAll();
  await waitFor(() => topicCount() > 0, 'a topic is created');
  await settle();
  assert.equal(capture.frames(), 1, 'the second action is refused while the first captures');
  assert.equal(topicCount(), 1);
});

test('C-2 clash: a group capture that fails after the panel closed creates and reports nothing', async () => {
  const errors = mock.method(toast, 'error', () => undefined);
  mock.method(console, 'error', () => undefined);
  render(<ClashPanel />);
  const bcf = await groupBothClashes();
  pressTogether(bcf);
  await waitFor(() => capture.frames() === 1, 'the group viewpoint is capturing');
  cleanup();
  capture.breakCamera();
  await capture.fail(1);
  await settle();
  assert.equal(errors.mock.callCount(), 0, 'a closed panel raises no failure toast');
  assert.equal(useViewerStore.getState().bcfProject === null, true);
});

test('C-2 clash: a group capture that settles after the panel closed creates no topic and no project', async () => {
  render(<ClashPanel />);
  const bcf = await groupBothClashes();
  pressTogether(bcf);
  await waitFor(() => capture.frames() === 1, 'the group viewpoint is capturing');
  cleanup();
  capture.releaseAll();
  await settle();
  assert.equal(useViewerStore.getState().bcfProject === null, true, 'a closed panel creates nothing');
});

test('C-2 clash: a group framing that lands after the panel closed reports nothing', async () => {
  const errors = mock.method(toast, 'error', () => undefined);
  let finishFraming = () => {};
  useViewerStore.setState({ cameraCallbacks: { frameSelection: () => new Promise<void>(resolve => { finishFraming = resolve; }) } });
  render(<ClashPanel />);
  const bcf = await groupBothClashes();
  pressTogether(bcf);
  await settle();
  cleanup();
  await act(async () => { finishFraming(); await new Promise(resolve => setTimeout(resolve, 100)); });
  await settle();
  assert.equal(capture.frames(), 0, 'nothing was captured');
  assert.equal(errors.mock.callCount(), 0, 'a closed panel raises no "models changed" toast');
  assert.equal(useViewerStore.getState().bcfProject === null, true);
});

for (const closed of [false, true]) {
  test(`C-2 clash: a "BCF topic" viewpoint that fails ${closed ? 'after the panel closed reports nothing' : 'toasts once and creates nothing'}`, async () => {
    const errors = mock.method(toast, 'error', () => undefined);
    const logged = mock.method(console, 'error', () => undefined);
    render(<ClashPanel />);
    pressTogether(clashTopicButton());
    await waitFor(() => capture.frames() === 1, 'the viewpoint is capturing');
    if (closed) cleanup();
    capture.breakCamera();
    await capture.fail(1);
    await settle();
    assert.equal(errors.mock.callCount(), closed ? 0 : 1);
    assert.ok(logged.mock.calls.some(call => call.arguments.some(arg => String(arg).includes('camera unavailable'))), 'the failure is always logged');
    assert.equal(useViewerStore.getState().bcfProject === null, true, 'a failed capture creates no topic and no project');
  });
}

test('C-2 clash: a "BCF topic" viewpoint capture that resolves null toasts once and creates nothing', async () => {
  const errors = mock.method(toast, 'error', () => undefined);
  mock.method(console, 'error', () => undefined);
  mock.method(console, 'warn', () => undefined);
  render(<ClashPanel />);
  capture.unplug();
  pressTogether(clashTopicButton());
  await settle();
  assert.equal(errors.mock.callCount(), 1, 'a null capture is reported like a thrown one');
  assert.equal(useViewerStore.getState().bcfProject === null, true);
});
