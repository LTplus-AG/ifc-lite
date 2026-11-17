/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * C-2 (BCF panel actions): Add Viewpoint (Capture 3D) and Export run once per
 * press burst, and Import lets the latest picked file win over an earlier,
 * slower read. The real capture, writer and reader run; only GPU completion
 * and one file read are held. Assertions compare plain values.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBCFProject, createBCFTopic, writeBCF } from '@ifc-lite/bcf';
import { render, cleanup, waitFor } from '@/test/render.js';
import { installHeldCapture, type HeldCapture } from '@/test/bcf-held-capture.js';
import { useViewerStore } from '@/store/index.js';
import { BCFPanel } from './BCFPanel.js';

installLayout();

let capture: HeldCapture;
let topicGuid = '';
beforeEach(() => {
  capture = installHeldCapture();
  const project = createBCFProject({ name: 'Actions' });
  const topic = createBCFTopic({ title: 'Existing topic', author: 'reviewer@example.invalid' });
  topicGuid = topic.guid;
  project.topics.set(topic.guid, topic);
  useViewerStore.setState({
    bcfProject: project, activeTopicId: null, bcfError: null, bcfLoading: false, models: new Map(),
    hiddenEntities: new Set(), isolatedEntities: null, selectedEntityId: null, selectedEntityIds: new Set(),
  });
});
afterEach(() => {
  cleanup(); capture.dispose(); mock.restoreAll(); document.body.innerHTML = '';
  useViewerStore.setState({ bcfProject: null, activeTopicId: null, bcfError: null, bcfLoading: false });
});

const buttonNamed = (name: string) => [...document.body.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
/** A double-click: both presses land in one act(), before React re-renders the button disabled. */
const pressTwice = (node: Element) => act(() => {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});

test('C-2 BCF panel: a double-pressed Capture 3D captures and appends one viewpoint', async () => {
  useViewerStore.setState({ activeTopicId: topicGuid });
  render(<BCFPanel onClose={() => {}} />);
  const capture3d = buttonNamed('Capture 3D'); assert.ok(capture3d, 'Capture 3D');
  pressTwice(capture3d);
  assert.equal(buttonNamed('Capture 3D')?.disabled, true, 'Capture 3D waits for the capture in flight');
  capture.releaseAll();
  await waitFor(() => (useViewerStore.getState().bcfProject?.topics.get(topicGuid)?.viewpoints.length ?? 0) > 0, 'the viewpoint lands');
  await settle();
  assert.equal(capture.frames(), 1, 'the refused second press never captured');
  assert.equal(useViewerStore.getState().bcfProject?.topics.get(topicGuid)?.viewpoints.length, 1);
  assert.equal(buttonNamed('Capture 3D')?.disabled, false);
});

test('C-2 BCF panel: a double-pressed Export writes one archive', async () => {
  const filenames: string[] = [];
  mock.method(URL, 'createObjectURL', () => 'blob:bcf-single-flight');
  mock.method(URL, 'revokeObjectURL', () => {});
  mock.method(window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { filenames.push(this.download); });
  render(<BCFPanel onClose={() => {}} />);
  const exportButton = document.body.querySelector('button[aria-label="Export BCF"]'); assert.ok(exportButton, 'Export BCF');
  pressTwice(exportButton);
  await waitFor(() => filenames.length > 0 && !useViewerStore.getState().bcfLoading, 'the export finishes');
  await settle();
  assert.equal(filenames.length, 1, 'one archive per press burst');
});

async function bcfFile(name: string): Promise<File> {
  const project = createBCFProject({ name });
  const topic = createBCFTopic({ title: `${name} topic`, author: 'a@example.invalid' });
  project.topics.set(topic.guid, topic);
  return new File([await writeBCF(project)], `${name}.bcfzip`, { type: 'application/octet-stream' });
}

test('C-2 BCF panel: the latest imported file wins over an earlier, slower read', async () => {
  const slow = await bcfFile('Slow earlier');
  const fast = await bcfFile('Fast later');
  const bytes = await slow.arrayBuffer();
  let releaseSlow = () => {};
  const held = new Promise<void>(resolve => { releaseSlow = resolve; });
  Object.defineProperty(slow, 'arrayBuffer', { value: () => held.then(() => bytes) });
  render(<BCFPanel onClose={() => {}} />);
  const input = document.body.querySelector('input[type="file"]'); assert.ok(input instanceof HTMLInputElement, 'file input');
  const pick = (file: File) => act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await pick(slow);
  await pick(fast);
  await waitFor(() => useViewerStore.getState().bcfProject?.name === 'Fast later', 'the later pick lands');
  await act(async () => { releaseSlow(); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().bcfProject?.name, 'Fast later', 'the earlier, slower read is discarded');
  assert.equal(useViewerStore.getState().bcfLoading, false, 'the discarded read does not leave the panel loading');
});
