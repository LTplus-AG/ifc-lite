/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * With no models loaded, a multi-file drop and a cloud-source batch start a
 * fresh federation by resetting and clearing the scene. While a workflow holds
 * the lease (a flow run, or a Re-align that briefly empties the federation),
 * their own loads are refused, so clearing first would wipe the scene for
 * nothing. They must refuse up front and leave the store alone.
 */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, render } from '@/test/render.js';
import { latestToast } from '@/test/toasts.js';
import { useViewerStore } from '@/store';
import { startWorkflowRun, type WorkflowRun } from '@/lib/flow/run-session';
import { dispatchSourceDownload, type SourceDownloadItem } from '@/services/sources/source-host';
import { fieldTelemetry } from '@/lib/perf/fieldTelemetryLoader.js';
import { ViewportContainer } from './ViewportContainer.js';

const BUSY = 'A workflow is running; wait or cancel it first';

function fileTransfer(...files: File[]): DataTransfer {
  return {
    types: ['Files'],
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer;
}

function drag(target: EventTarget, type: string, dataTransfer: DataTransfer): void {
  const event = new window.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  act(() => { target.dispatchEvent(event); });
}

let restoreGpu: (() => void) | null = null;
function stubWebGpu(): void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: async () => ({ features: new Set(), limits: {} }) },
  });
  restoreGpu = () => {
    if (original) Object.defineProperty(navigator, 'gpu', original);
    else Reflect.deleteProperty(navigator, 'gpu');
  };
}

let run: WorkflowRun | null = null;
let clears = 0;
let resets = 0;
const original = useViewerStore.getState();

beforeEach(() => {
  useViewerStore.setState({
    ifcDataStore: null,
    geometryResult: null,
    models: new Map(),
    clearAllModels: () => { clears++; },
    resetViewerState: () => { resets++; },
  });
  stubWebGpu();
});

after(() => fieldTelemetry?.resetFieldEventsForTests());

afterEach(() => {
  run?.release();
  run = null;
  cleanup();
  restoreGpu?.();
  restoreGpu = null;
  useViewerStore.setState({ clearAllModels: original.clearAllModels, resetViewerState: original.resetViewerState });
});

async function mountWithLease(): Promise<Map<string, unknown>> {
  render(<ViewportContainer />);
  await advance(0);
  clears = 0;
  resets = 0;
  run = startWorkflowRun('realign');
  return useViewerStore.getState().models;
}

describe('fresh-federation opens refuse to clear the scene while a workflow holds the lease', () => {
  it('a multi-file drop on an empty viewer leaves the store untouched and says why', async () => {
    const before = await mountWithLease();
    const files = [new File(['x'], 'one.ifc'), new File(['x'], 'two.ifc')];
    drag(document.body, 'dragenter', fileTransfer(...files));
    drag(document.body, 'dragover', fileTransfer(...files));
    drag(document.body, 'drop', fileTransfer(...files));
    await advance(0);
    await advance(0);

    assert.equal(resets, 0, 'viewer state was not reset');
    assert.equal(clears, 0, 'models were not cleared');
    assert.equal(useViewerStore.getState().models, before, 'the models map is untouched');
    assert.match(latestToast(), new RegExp(BUSY));
  });

  it('a cloud-source batch on an empty viewer leaves the store untouched and says why', async () => {
    const before = await mountWithLease();
    const item = {
      name: 'remote.ifc',
      buffer: new ArrayBuffer(1),
      sourceFile: {},
      tag: { provider: 'test' },
    } as unknown as SourceDownloadItem;
    act(() => { dispatchSourceDownload([item]); });
    await advance(0);
    await advance(0);

    assert.equal(resets, 0, 'viewer state was not reset');
    assert.equal(clears, 0, 'models were not cleared');
    assert.equal(useViewerStore.getState().models, before, 'the models map is untouched');
    assert.match(latestToast(), new RegExp(BUSY));
  });
});
