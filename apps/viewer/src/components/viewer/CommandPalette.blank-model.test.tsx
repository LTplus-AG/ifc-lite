/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { skip } from '@/test/blank-ifc-loader-harness';
import { useViewerStore } from '@/store';
import { advance, cleanup, click, render, waitFor } from '@/test/render';
import '@/lib/commands/modeling/builtin';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { CommandPalette } from './CommandPalette';
import { useFileCommands } from './toolbar/useFileCommands';
import { getMountedFileHost, registerMountedFileHost } from './toolbar/mounted-file-host';

const gpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
beforeEach(() => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({}) } });
});
afterEach(() => {
  cleanup(); mock.restoreAll(); localStorage.clear();
  for (const [object, key, descriptor] of [[navigator, 'gpu', gpu], [window, 'isSecureContext', secure]] as const) {
    if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key);
  }
});
function Host() { return <>{useFileCommands().fileInputs}</>; }
function Harness() {
  return <BimReactContext.Provider value={{} as BimContext}>
    <Host /><CommandPalette open onOpenChange={() => {}} />
  </BimReactContext.Provider>;
}
function row() {
  const node = document.querySelector('[data-command-id="file:new-blank"]');
  assert.ok(node); return node;
}
async function settle() { await act(async () => { await advance(30); }); }

test('mounted blank route parses canonical IFC and enters the actual wall command only after completion (#8947)', { skip }, async () => {
  render(<Harness />); await settle();
  assert.notEqual(row().getAttribute('aria-disabled'), 'true');
  click(row()); await settle();
  await waitFor(() => useViewerStore.getState().session?.activeCommandId === 'wall.place', 'blank canonical load opens wall tool');
  const state = useViewerStore.getState();
  assert.equal(state.models.size, 1);
  const model = state.models.get(state.activeModelId!);
  assert.equal(model?.loadState, 'complete');
  assert.ok(model?.ifcDataStore?.entityIndex.byType.get('IFCPROJECT')?.length);
  assert.ok(model?.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.length);
  assert.equal(state.session?.modelId, model?.id);
  assert.equal(getCommandRuntime().command?.id, 'wall.place');
  assert.equal(row().getAttribute('aria-disabled'), 'true', 'loaded session cannot be replaced');
  getMountedFileHost()?.startBlank?.(); await settle();
  assert.equal(useViewerStore.getState().models.get(model!.id), model);
});

test('blank refuses loading, read-only role and retired host before its deferred frame (#8947)', { skip }, async () => {
  render(<Harness />); await settle();
  act(() => useViewerStore.setState({ loading: true }));
  assert.equal(row().getAttribute('aria-disabled'), 'true');
  act(() => useViewerStore.setState({ loading: false, collabRole: 'viewer' }));
  assert.equal(row().getAttribute('aria-disabled'), 'true');
  act(() => useViewerStore.setState({ collabRole: null }));
  const frames: FrameRequestCallback[] = [];
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
  let retire = () => {};
  try {
    click(row());
    act(() => { retire = registerMountedFileHost({ openFiles() {}, addModel() {}, async refreshModels() {} }); });
    act(() => frames.forEach(cb => cb(0)));
    assert.equal(useViewerStore.getState().models.size, 0);
    assert.equal(useViewerStore.getState().session, null);
  } finally { globalThis.requestAnimationFrame = original; act(retire); }
});


test('unsupported WebGPU explains why blank creation is unavailable (#8947)', { skip }, async () => {
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  render(<Harness />); await settle();
  assert.equal(row().getAttribute('aria-disabled'), 'true');
  assert.match(row().textContent ?? '', /WebGPU/);
  click(row()); await settle();
  assert.equal(useViewerStore.getState().models.size, 0);
  assert.equal(useViewerStore.getState().session, null);
});


test('held real blank load cannot enter workspace before completion or after cancellation (#8947)', { skip }, async () => {
  const nativeSlice = File.prototype.slice;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  mock.method(File.prototype, 'slice', function (this: File, ...args: Parameters<File['slice']>) {
    const blob = nativeSlice.apply(this, args);
    if (this.name === 'Untitled_Project.ifc') {
      const read = blob.arrayBuffer.bind(blob);
      Object.defineProperty(blob, 'arrayBuffer', { value: async () => { held = true; await gate; return read(); } });
    }
    return blob;
  });
  render(<Harness />); await settle();
  try {
    click(row()); await settle();
    await waitFor(() => held, 'canonical blank loader held at actual source read');
    assert.equal(useViewerStore.getState().session, null);
    assert.equal(useViewerStore.getState().loading, true);
    const cancel = document.querySelector('[data-command-id="file:cancel-load"]');
    assert.ok(cancel); click(cancel); await settle();
    assert.equal(useViewerStore.getState().loading, false);
    assert.equal(useViewerStore.getState().models.size, 0);
  } finally { release(); await settle(); }
  assert.equal(useViewerStore.getState().session, null);
  assert.equal(useViewerStore.getState().models.size, 0, 'late read cannot publish cancelled blank');
});
