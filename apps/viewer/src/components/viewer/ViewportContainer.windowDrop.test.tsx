/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5845: the whole window is the file drop target. The empty state says
 * "drag & drop anywhere", but only the viewport root listened, so a file
 * dropped on the ribbon, sidebar, status bar or a panel was ignored and, over
 * non-viewport chrome, the browser navigated away to the file.
 *
 * Every drop here lands on an element OUTSIDE the viewport. The observable
 * proof that a drop reached the drop routing is the unsupported-format toast
 * that routing raises for a `.blend` file (the same routing that loads an
 * IFC through `useIfcLoader.loadFile`, without spinning up the wasm parser).
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, render } from '@/test/render.js';
import { latestToast } from '@/test/toasts.js';
import { getRecentFiles } from '@/lib/recent-files';
import { useViewerStore } from '@/store';
import { ViewportContainer } from './ViewportContainer.js';
import { CustomizeSidebar } from './sidebar/CustomizeSidebar';

// happy-dom's DataTransfer reports an empty type for an added file and
// DragEvent ignores `dataTransfer` in its init, so hand the event the parts a
// browser gives it: `types` with 'Files', the file list, and `items`.
function fileTransfer(...files: File[]): DataTransfer {
  return {
    types: ['Files'],
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer;
}

function textTransfer(text: string): DataTransfer {
  return { types: ['text/plain'], files: [], items: [], getData: () => text, dropEffect: 'none' } as unknown as DataTransfer;
}

function drag(target: EventTarget, type: string, dataTransfer: DataTransfer): DragEvent {
  const event = new window.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  act(() => { target.dispatchEvent(event); });
  return event;
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

/** Chrome outside the viewport, e.g. the toolbar or a sidebar. */
let chrome: HTMLElement;

beforeEach(() => {
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null, models: new Map() });
  chrome = document.createElement('div');
  chrome.textContent = 'sidebar';
  document.body.appendChild(chrome);
});

afterEach(() => {
  cleanup();
  chrome.remove();
  restoreGpu?.();
  restoreGpu = null;
});

const DROP_TITLE = 'Drop File to Load';

describe('window-level file drop (#5845)', () => {
  it('a file dropped outside the viewport reaches the drop routing, with one full-window overlay', async () => {
    stubWebGpu();
    render(<ViewportContainer />);
    await advance(0);
    assert.ok(!document.body.textContent?.includes(DROP_TITLE), 'no overlay before a drag');

    const file = new File(['x'], 'house.blend');
    drag(chrome, 'dragenter', fileTransfer(file));
    const over = drag(chrome, 'dragover', fileTransfer(file));
    assert.ok(document.body.textContent?.includes(DROP_TITLE), 'dragging a file over the sidebar shows the drop overlay');
    assert.equal(over.defaultPrevented, true, 'the window accepts the drag, so the drop is not the browser default');

    const drop = drag(chrome, 'drop', fileTransfer(file));
    assert.equal(drop.defaultPrevented, true, 'the browser never navigates to the dropped file');
    assert.ok(!document.body.textContent?.includes(DROP_TITLE), 'the overlay closes on drop');
    assert.match(latestToast(), /house\.blend/, 'the drop went through the drop routing');
  });

  it('a zone that stops propagation keeps its drop, and the overlay does not stick', async () => {
    stubWebGpu();
    render(<ViewportContainer />);
    await advance(0);
    // The Data Connector's CSV zone: stops dragover / dragleave / drop, but
    // lets dragenter bubble.
    const zone = document.createElement('div');
    chrome.appendChild(zone);
    for (const type of ['dragover', 'dragleave', 'drop']) {
      zone.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); });
    }
    const before = latestToast();
    const file = new File(['x'], 'zone-owned.blend');
    drag(chrome, 'dragenter', fileTransfer(file));
    drag(zone, 'dragenter', fileTransfer(file));
    drag(zone, 'dragover', fileTransfer(file));
    assert.ok(!document.body.textContent?.includes(DROP_TITLE), 'the overlay steps aside over the zone');
    drag(zone, 'drop', fileTransfer(file));
    assert.ok(!document.body.textContent?.includes(DROP_TITLE), 'the overlay is gone after the zone took the drop');
    assert.equal(latestToast(), before, 'the window did not also route the drop');

    // The next drag starts from a clean state.
    drag(chrome, 'dragenter', fileTransfer(file));
    drag(chrome, 'dragover', fileTransfer(file));
    assert.ok(document.body.textContent?.includes(DROP_TITLE), 'a later drag over chrome shows the overlay');
    drag(chrome, 'dragleave', fileTransfer(file));
    assert.ok(!document.body.textContent?.includes(DROP_TITLE), 'and leaving the window hides it');
  });

  it('ignores a drag that started inside the page (an image Chromium reports as Files)', async () => {
    stubWebGpu();
    render(<ViewportContainer />);
    await advance(0);
    const img = document.createElement('img');
    chrome.appendChild(img);
    act(() => { img.dispatchEvent(new window.Event('dragstart', { bubbles: true })); });
    const before = latestToast();
    const file = new File(['x'], 'logo.blend');
    drag(chrome, 'dragenter', fileTransfer(file));
    assert.ok(!document.body.textContent?.includes(DROP_TITLE), 'no drop overlay for an in-page drag');
    const drop = drag(chrome, 'drop', fileTransfer(file));
    assert.equal(drop.defaultPrevented, false, 'the window leaves it alone');
    assert.equal(latestToast(), before, 'nothing is routed');

    // No dragend (the source unmounted): the window drop itself cleared the
    // flag, so the next OS file drop is handled.
    const next = new File(['x'], 'from-the-os.blend');
    drag(chrome, 'dragenter', fileTransfer(next));
    drag(chrome, 'dragover', fileTransfer(next));
    const osDrop = drag(chrome, 'drop', fileTransfer(next));
    assert.equal(osDrop.defaultPrevented, true, 'a later OS drop is not navigated to');
    assert.match(latestToast(), /from-the-os\.blend/, 'and is routed');
  });

  it('a drag a component cancelled in dragstart does not disable later file drops', async () => {
    stubWebGpu();
    render(<ViewportContainer />);
    await advance(0);
    // SpaceSketch cancels its own dragstart on every vertex drag; no dragend follows.
    const handle = document.createElement('div');
    chrome.appendChild(handle);
    handle.addEventListener('dragstart', (e) => e.preventDefault());
    act(() => { handle.dispatchEvent(new window.Event('dragstart', { bubbles: true, cancelable: true })); });

    const file = new File(['x'], 'after-cancel.blend');
    drag(chrome, 'dragenter', fileTransfer(file));
    drag(chrome, 'dragover', fileTransfer(file));
    const drop = drag(chrome, 'drop', fileTransfer(file));
    assert.equal(drop.defaultPrevented, true, 'the browser does not open the file');
    assert.match(latestToast(), /after-cancel\.blend/, 'the drop is still routed');
  });

  it('ignores a non-file drag (text or a link)', async () => {
    stubWebGpu();
    render(<ViewportContainer />);
    await advance(0);

    drag(chrome, 'dragenter', textTransfer('https://example.com'));
    assert.ok(!document.body.textContent?.includes(DROP_TITLE), 'no overlay for a text drag');
    const drop = drag(chrome, 'drop', textTransfer('https://example.com'));
    assert.equal(drop.defaultPrevented, false, 'a text drop keeps its default (e.g. into an input)');
  });

  it('leaves a drop a child drop zone already handled alone', async () => {
    stubWebGpu();
    render(<ViewportContainer />);
    await advance(0);
    const zone = document.createElement('div');
    chrome.appendChild(zone);
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('drop', (e) => e.preventDefault());

    const before = latestToast();
    const file = new File(['x'], 'panel-owned.blend');
    drag(zone, 'dragenter', fileTransfer(file));
    drag(zone, 'dragover', fileTransfer(file));
    assert.ok(!document.body.textContent?.includes(DROP_TITLE), 'the overlay steps aside over a zone that accepts the drop');
    drag(zone, 'drop', fileTransfer(file));
    assert.equal(latestToast(), before, 'the window did not route the drop the zone took');
  });

  it('without WebGPU a file drop is refused but still never navigates', async () => {
    render(<ViewportContainer />); // happy-dom has no navigator.gpu
    await advance(0);
    const before = latestToast();
    const file = new File(['x'], 'nogpu.blend');
    drag(chrome, 'dragenter', fileTransfer(file));
    assert.ok(!document.body.textContent?.includes(DROP_TITLE), 'no drop overlay without WebGPU');
    const drop = drag(chrome, 'drop', fileTransfer(file));
    assert.equal(drop.defaultPrevented, true, 'the browser does not open the file');
    assert.equal(latestToast(), before, 'nothing is loaded');
    assert.match(document.body.textContent ?? '', /WebGPU/, 'the rejected drop explains why it was not loaded');
    assert.equal(typeof useViewerStore.getState().lastLoadRetry, 'function', 'Retry retains the dropped File');
    stubWebGpu();
    await act(async () => {
      useViewerStore.getState().lastLoadRetry?.();
      await advance(0);
    });
    assert.match(latestToast(), /nogpu\.blend/, 'Retry routes the same dropped File after WebGPU recovers');
  });

  it('explains a file drop while the WebGPU adapter check is still pending', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'gpu');
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: () => new Promise(() => {}) },
    });
    restoreGpu = () => {
      if (original) Object.defineProperty(navigator, 'gpu', original);
      else Reflect.deleteProperty(navigator, 'gpu');
    };
    render(<ViewportContainer />);
    await advance(0);
    const file = new File(['x'], 'pending.blend');
    const drop = drag(chrome, 'drop', fileTransfer(file));
    assert.equal(drop.defaultPrevented, true);
    assert.match(document.body.textContent ?? '', /WebGPU support is still being checked/);
  });

  it('a reorder list does not swallow a file dragged over it (Customize sidebar rows)', async () => {
    stubWebGpu();
    render(
      <>
        <ViewportContainer />
        <CustomizeSidebar onClose={() => {}} />
      </>,
    );
    await advance(0);
    const row = document.querySelector('[draggable="true"]');
    assert.ok(row, 'a reorderable row renders');
    const file = new File(['x'], 'over-a-row.blend');
    drag(row, 'dragenter', fileTransfer(file));
    drag(row, 'dragover', fileTransfer(file));
    assert.ok(document.body.textContent?.includes(DROP_TITLE), 'the row does not claim a file drag');
    drag(row, 'drop', fileTransfer(file));
    assert.match(latestToast(), /over-a-row\.blend/, 'the file reached the window drop');
  });

  // Last: the real loader starts (and fails without wasm) and leaves the
  // store mid-load, which would change what the tests after it mount.
  it('a supported model dropped outside the viewport reaches the model load path', async () => {
    stubWebGpu();
    render(<ViewportContainer />);
    await advance(0);
    const file = new File(['ISO-10303-21;'], 'dropped-on-sidebar.ifc');
    drag(chrome, 'dragenter', fileTransfer(file));
    drag(chrome, 'dragover', fileTransfer(file));
    drag(chrome, 'drop', fileTransfer(file));
    await advance(0);
    // prepareModelFiles records the file right before handing it to the
    // loader route (useIfcLoader.loadFile).
    assert.ok(
      getRecentFiles().some((entry) => entry.name === 'dropped-on-sidebar.ifc'),
      'the dropped model was handed to the load path',
    );
  });
});
