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
import { useViewerStore } from '@/store';
import { setLocale } from '@/i18n';
import { posthog } from '@/lib/analytics';
import { advance, cleanup, click, press, render, type as typeInto } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { CommandPalette } from './CommandPalette';
import { useFileCommands } from './toolbar/useFileCommands';
import { getMountedFileHost, registerMountedFileHost } from './toolbar/mounted-file-host';
import { ActivityTrayDialog } from './activity/ActivityTray';
import { RECENT_KEY } from './commandPaletteSearch';

const originalState = useViewerStore.getState();
const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalPicker = Object.getOwnPropertyDescriptor(window, 'showOpenFilePicker');
beforeEach(() => {
  setLocale('en');
  localStorage.clear();
  useViewerStore.setState({ ...fixtureModels(), loading: false, collabRole: null });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({}) } });
  Reflect.deleteProperty(window, 'showOpenFilePicker');
});
afterEach(() => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState(originalState);
  localStorage.clear();
  for (const [object, key, descriptor] of [
    [navigator, 'gpu', originalGpu], [window, 'isSecureContext', originalSecure],
    [window, 'showOpenFilePicker', originalPicker],
  ] as const) {
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  }
});

function FileHost() { return <>{useFileCommands().fileInputs}</>; }
function Harness({ withFiles = true }: { withFiles?: boolean }) {
  const [open, setOpen] = useState(true);
  const [activity, setActivity] = useState(false);
  return <BimReactContext.Provider value={{} as BimContext}>
    {withFiles && <FileHost />}
    <CommandPalette open={open} onOpenChange={setOpen} surfaceContext={{ openActivity: () => setActivity(true) }} />
    <ActivityTrayDialog open={activity} onOpenChange={setActivity} />
  </BimReactContext.Provider>;
}
function row(id: string) {
  const option = document.querySelector<HTMLButtonElement>(`[data-command-id="${id}"]`);
  assert.ok(option, id);
  return option;
}
async function settle() { await act(async () => { await advance(30); }); }

test('real file host routes Open and Add to distinct canonical inputs in the trusted stack (#8947)', async () => {
  for (const [id, inputId, keyboard] of [
    ['file:open', 'file-input-open', true], ['file:add-model', 'file-input-add', false],
  ] as const) {
    render(<Harness />);
    await settle();
    const inputs: string[] = [];
    const nativeClick = HTMLInputElement.prototype.click;
    mock.method(HTMLInputElement.prototype, 'click', function (this: HTMLInputElement) {
      if (this.type === 'file') inputs.push(this.id);
      else nativeClick.call(this);
    });
    if (keyboard) {
      const search = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
      typeInto(search, 'open file');
      // Hover resolves the intended row even when other aliases match.
      act(() => row(id).dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true })));
      press(search, 'Enter');
    } else click(row(id));
    assert.deepEqual(inputs, [inputId], 'picker called before event returns');
    assert.equal(document.querySelector('input[role="combobox"]'), null, 'palette closed');
    assert.equal(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')[0], id);
    cleanup();
    mock.restoreAll();
  }
});

test('existing Open event still reaches the single mounted file hook (#8947)', () => {
  render(<Harness />);
  const inputs: string[] = [];
  mock.method(HTMLInputElement.prototype, 'click', function (this: HTMLInputElement) { inputs.push(this.id); });
  act(() => window.dispatchEvent(new CustomEvent('ifc-lite:open-files')));
  assert.deepEqual(inputs, ['file-input-open']);
  assert.equal(document.querySelectorAll('#file-input-open').length, 1);
  assert.equal(document.querySelectorAll('#file-input-add').length, 1);
});

test('loading, mixed refresh handles and host loss refuse pointer/Enter without history or telemetry (#8947)', async () => {
  const executions: string[] = [];
  mock.method(posthog, 'capture', (event: string) => { if (event === 'command_executed') executions.push(event); });
  const a = fixtureModel('a');
  a.sourceHandle = { getFile: async () => { throw new Error('must not read a partial federation'); } } as FileSystemFileHandle;
  useViewerStore.setState({ ...fixtureModels(a, fixtureModel('b')), loading: false });
  render(<Harness />);
  await settle();
  assert.equal(row('file:refresh').getAttribute('aria-disabled'), 'true');
  act(() => useViewerStore.setState(fixtureModels(a)));
  assert.notEqual(row('file:refresh').getAttribute('aria-disabled'), 'true', 'one live handle is refreshable');
  act(() => useViewerStore.setState(fixtureModels(a, fixtureModel('b'))));
  assert.equal(row('file:refresh').getAttribute('aria-disabled'), 'true', 'mixed federation refuses again');
  click(row('file:refresh'));
  act(() => useViewerStore.setState({ loading: true }));
  assert.equal(row('file:add-model').getAttribute('aria-disabled'), 'true');
  typeInto(document.querySelector<HTMLInputElement>('[role="combobox"]')!, 'add model');
  press(document.querySelector('input[role="combobox"]')!, 'Enter');
  assert.equal(localStorage.getItem(RECENT_KEY), null);
  assert.deepEqual(executions, []);
  assert.equal(useViewerStore.getState().models.size, 2);
  cleanup();
  render(<Harness withFiles={false} />);
  await settle();
  assert.equal(getMountedFileHost(), null);
  assert.equal(row('file:open').getAttribute('aria-disabled'), 'true');
  click(row('file:open'));
  assert.equal(localStorage.getItem(RECENT_KEY), null);
});

test('deferred Share refuses a replaced host, without history or telemetry (#8947)', async () => {
  localStorage.setItem('ifc-lite:collab:enabled', 'true');
  useViewerStore.setState(fixtureModels(fixtureModel('a')));
  render(<Harness />);
  await settle();
  const executions: string[] = [];
  mock.method(posthog, 'capture', (event: string) => { if (event === 'command_executed') executions.push(event); });
  const frames: FrameRequestCallback[] = [];
  const originalFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  try {
    click(row('file:share'));
    let retire = () => {};
    act(() => { retire = registerMountedFileHost({ openFiles() {}, addModel() {}, async refreshModels() {} }); });
    try {
      act(() => frames.forEach(frame => frame(0)));
      assert.equal(localStorage.getItem(RECENT_KEY), null);
      assert.deepEqual(executions, []);
      assert.equal(document.querySelector('[role="dialog"]'), null);
    } finally { act(retire); }
  } finally { globalThis.requestAnimationFrame = originalFrame; }
});

test('real Share dialog survives palette closure and never uploads on entry (#8947)', async () => {
  localStorage.setItem('ifc-lite:collab:enabled', 'true');
  useViewerStore.setState(fixtureModels(fixtureModel('a')));
  render(<Harness />);
  await settle();
  click(row('file:share'));
  await settle();
  assert.equal(document.querySelector('input[role="combobox"]'), null);
  assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Create link/);
  assert.equal(useViewerStore.getState().collabRoomId, null);
});

test('Share disabled when collaboration is off; Activity opens real empty list without GPU/model (#8947)', async () => {
  localStorage.setItem('ifc-lite:collab:enabled', 'false');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  render(<Harness />);
  await settle();
  assert.equal(row('file:share').getAttribute('aria-disabled'), 'true');
  assert.equal(row('file:open').getAttribute('aria-disabled'), 'true');
  assert.match(row('file:open').textContent ?? '', /WebGPU/);
  assert.notEqual(row('ui:activity').getAttribute('aria-disabled'), 'true');
  click(row('ui:activity'));
  await settle();
  assert.equal(document.querySelector('input[role="combobox"]'), null);
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent ?? '', /Activity/);
  assert.match(dialog.textContent ?? '', /No jobs in this session yet/);
});

test('retiring an old file registration cannot remove its replacement (#8947)', () => {
  const old = registerMountedFileHost({ openFiles() {}, addModel() {}, async refreshModels() {} });
  const replacement = { openFiles() {}, addModel() {}, async refreshModels() {} };
  const retire = registerMountedFileHost(replacement);
  try { old(); assert.equal(getMountedFileHost(), replacement); }
  finally { retire(); }
});


test('native OS picker is invoked before Enter returns, without consuming the ingest Add event (#8947)', async () => {
  let pickerCalls = 0;
  let ingests = 0;
  Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: () => {
    pickerCalls++;
    return Promise.resolve([]);
  } });
  const onIngest = () => { ingests++; };
  window.addEventListener('ifc-lite:add-model', onIngest);
  try {
    render(<Harness />);
    await settle();
    const search = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    typeInto(search, 'add model');
    act(() => row('file:add-model').dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true })));
    press(search, 'Enter');
    assert.equal(pickerCalls, 1);
    assert.equal(ingests, 0, 'supplied-File event remains distinct from picker');
    await settle();
  } finally { window.removeEventListener('ifc-lite:add-model', onIngest); }
});
