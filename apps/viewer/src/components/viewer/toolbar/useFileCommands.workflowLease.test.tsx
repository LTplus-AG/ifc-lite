/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A multi-file Open and a multi-model Refresh both clear the scene before
 * loading. While a workflow holds the lease, their own loads are refused, so
 * clearing first would leave an empty scene. They must refuse up front and
 * leave the models alone.
 */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, render } from '@/test/render.js';
import { latestToast } from '@/test/toasts.js';
import { Toaster } from '@/components/ui/toast';
import { useViewerStore, type FederatedModel } from '@/store';
import { startWorkflowRun, type WorkflowRun } from '@/lib/flow/run-session';
import { useFileCommands, type FileCommands } from './useFileCommands.js';

const BUSY = 'A workflow is running; wait or cancel it first';

let commands: FileCommands | null = null;
function Host() {
  commands = useFileCommands();
  return <>{commands.fileInputs}<Toaster /></>;
}

/** Runs inside each handle read, to start a workflow while Refresh awaits its reads. */
let onRead: (() => void) | null = null;
function handle(name: string): FileSystemFileHandle {
  return { kind: 'file', name, getFile: async () => { onRead?.(); return new File(['x'], name); } } as unknown as FileSystemFileHandle;
}

function model(id: string, loadedAt: number): FederatedModel {
  return { id, name: `${id}.ifc`, loadedAt, visible: true, collapsed: false, sourceHandle: handle(`${id}.ifc`) } as unknown as FederatedModel;
}

let run: WorkflowRun | null = null;
let clears = 0;
let resets = 0;
const original = useViewerStore.getState();

beforeEach(() => {
  clears = 0;
  resets = 0;
  useViewerStore.setState({
    loading: false,
    models: new Map([['a', model('a', 1)], ['b', model('b', 2)]]),
    clearAllModels: () => { clears++; },
    resetViewerState: () => { resets++; },
  });
  run = startWorkflowRun();
});

afterEach(() => {
  run?.release();
  run = null;
  onRead = null;
  cleanup();
  useViewerStore.setState({ clearAllModels: original.clearAllModels, resetViewerState: original.resetViewerState, models: new Map() });
});

describe('file commands refuse to clear the scene while a workflow holds the lease', () => {
  it('a multi-file Open leaves the models untouched and says why', async () => {
    const container = render(<Host />);
    const input = container.querySelector<HTMLInputElement>('#file-input-open');
    assert.ok(input, 'the hidden Open input is mounted');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'one.ifc'), new File(['x'], 'two.ifc')] });
    act(() => { input.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await advance(0);
    await advance(0);

    assert.equal(resets, 0, 'viewer state was not reset');
    assert.equal(clears, 0, 'the models map was not cleared');
    assert.match(latestToast(), new RegExp(BUSY));
  });

  it('a multi-model Refresh leaves the models untouched and says why', async () => {
    render(<Host />);
    await act(async () => { await commands!.handleRefresh(); });

    assert.equal(clears, 0, 'the models map was not cleared');
    assert.match(latestToast(), new RegExp(BUSY));
  });

  it('a single-model Refresh is refused with the busy message instead of throwing', async () => {
    useViewerStore.setState({ models: new Map([['a', model('a', 1)]]) });
    render(<Host />);
    await act(async () => { await commands!.handleRefresh(); });

    assert.equal(resets, 0, 'viewer state was not reset');
    assert.equal(clears, 0, 'the models map was not cleared');
    assert.match(latestToast(), new RegExp(BUSY));
  });

  it('a Refresh whose reads outlast the start of a workflow still leaves the models untouched', async () => {
    run?.release();
    run = null;
    onRead = () => { run ??= startWorkflowRun(); };
    render(<Host />);
    await act(async () => { await commands!.handleRefresh(); });

    assert.ok(run, 'the workflow started during the reads');
    assert.equal(clears, 0, 'the models map was not cleared');
    assert.match(latestToast(), new RegExp(BUSY));
  });

  it('a single-file Open is refused with the busy message', async () => {
    const container = render(<Host />);
    const input = container.querySelector<HTMLInputElement>('#file-input-open')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'solo.ifc')] });
    act(() => { input.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await advance(0);
    await advance(0);

    assert.equal(resets, 0, 'viewer state was not reset');
    assert.match(latestToast(), new RegExp(BUSY));
  });
});
