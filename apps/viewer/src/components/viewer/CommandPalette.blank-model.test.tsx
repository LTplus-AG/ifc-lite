/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { skip } from '@/test/blank-ifc-loader-harness';
import { useViewerStore } from '@/store';
import { setLocale } from '@/i18n';
import { createLocaleActivator } from '@/i18n/locale-activation';
import { advance, cleanup, click, render, waitFor } from '@/test/render';
import '@/lib/commands/modeling/builtin';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { CommandPalette } from './CommandPalette';
import { useFileCommands } from './toolbar/useFileCommands';
import { getMountedFileHost, registerMountedFileHost } from './toolbar/mounted-file-host';

const gpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
beforeEach(() => {
  setLocale('en');
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({}) } });
});
afterEach(() => {
  cleanup(); mock.restoreAll(); setLocale('en'); localStorage.clear();
  for (const [object, key, descriptor] of [[navigator, 'gpu', gpu], [window, 'isSecureContext', secure]] as const) {
    if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key);
  }
});
function Host() { return <>{useFileCommands().fileInputs}</>; }
function Harness() {
  const [hostKey, setHostKey] = useState(0);
  return <BimReactContext.Provider value={{} as BimContext}>
    <Host key={hostKey} /><button data-replace-file-host onClick={() => setHostKey(key => key + 1)}>Replace toolbar</button>
    <CommandPalette open onOpenChange={() => {}} />
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

for (const retire of [false, true]) test(`blank callback refresh survives real loading but retired owner cannot enter authoring: retire=${retire} (#8947)`, { skip }, async () => {
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
  const originalHost = getMountedFileHost(); assert.ok(originalHost?.owner);
  let replacementOwner: object | undefined;
  try {
    click(row()); await waitFor(() => held, 'real blank source read is pending');
    const locale = createLocaleActivator({ de: () => import('@/i18n/locales/de').then(module => module.default) });
    await act(async () => { await locale.activate(['de']); });
    const refreshedHost = getMountedFileHost();
    assert.notEqual(refreshedHost, originalHost, 'translated file callbacks actually refreshed');
    assert.equal(refreshedHost?.owner, originalHost.owner, 'toolbar lifetime survived callback refresh');
    assert.equal(useViewerStore.getState().session, null, 'pending real load cannot enter authoring');
    if (retire) {
      const replace = document.querySelector('[data-replace-file-host]'); assert.ok(replace);
      click(replace); // A real keyed React unmount/remount retires the original effect lifetime.
      replacementOwner = getMountedFileHost()?.owner;
      assert.ok(replacementOwner);
      assert.notEqual(replacementOwner, originalHost.owner);
    }
    release();
    await waitFor(() => {
      const state = useViewerStore.getState();
      return !state.loading && state.models.get(state.activeModelId ?? '')?.loadState === 'complete';
    }, 'actual blank model completes after source read');
    await settle();
    const state = useViewerStore.getState();
    assert.equal(state.models.size, 1);
    assert.equal([...state.models.values()][0].id, state.activeModelId);
    assert.ok(state.ifcDataStore?.entityIndex.byType.get('IFCPROJECT')?.length);
    if (retire) {
      assert.equal(getMountedFileHost()?.owner, replacementOwner, 'metadata cannot re-register an unmounted owner');
      assert.equal(state.session, null, 'retired host must not activate authoring after completion');
    } else {
      assert.equal(getMountedFileHost()?.owner, originalHost.owner, 'metadata publication keeps the same toolbar lifetime');
      assert.equal(state.session?.modelId, state.activeModelId);
      assert.equal(getCommandRuntime().command?.id, 'wall.place');
    }
  } finally { release(); await settle(); }
});
