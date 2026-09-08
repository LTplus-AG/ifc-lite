/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #4099: a BCF's topics/viewpoints reference GlobalIds in the model
 * they were captured from. `readBCF` succeeds regardless of what — if
 * anything — is loaded in the viewport, so importing a BCF with no model
 * loaded used to give no feedback at all: the topics list would populate,
 * but every viewpoint would silently fail to resolve later with nothing to
 * explain why. This test drives `BCFPanel`'s real import path (a real
 * `readBCF`/`writeBCF` round trip, not a mock) against an EMPTY store and
 * asserts the panel now says, in the moment, to load the model first.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBCFProject, createBCFTopic, writeBCF } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store/index.js';
import { toast } from '@/components/ui/toast';
import { BCFPanel } from './BCFPanel.js';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderPanel(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<BCFPanel onClose={() => {}} />);
  });
  mounted.push({ root, container });
  return container;
}

/** A minimal but real BCF archive: one topic, no viewpoint. */
async function makeBcfFile(): Promise<File> {
  const project = createBCFProject({ name: 'Imported' });
  const topic = createBCFTopic({ title: 'A topic', author: 'a@b.com' });
  project.topics.set(topic.guid, topic);
  const blob = await writeBCF(project);
  return new File([blob], 'imported.bcfzip', { type: 'application/octet-stream' });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  assert.ok(input, 'the hidden BCF file input must render');
  return input as HTMLInputElement;
}

async function selectFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // readBCF (unzip + XML parse) is async and its completion isn't observable
  // from here except by polling the store it eventually writes to.
  for (let i = 0; i < 200 && useViewerStore.getState().bcfLoading; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

describe('BCFPanel import — load-order guidance (#4099)', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    useViewerStore.setState({
      models: new Map(),
      bcfProject: null,
      bcfError: null,
      bcfLoading: false,
    });
  });

  it('tells the user to load the model when a BCF is imported with none loaded', async () => {
    const infoMock = mock.method(toast, 'info', () => {});
    try {
      const container = renderPanel();
      const file = await makeBcfFile();
      await selectFile(fileInput(container), file);

      assert.equal(
        useViewerStore.getState().bcfProject?.topics.size,
        1,
        'the import itself must still succeed',
      );
      assert.equal(infoMock.mock.callCount(), 1, 'exactly one load-order guidance toast fires');
      assert.match(
        String(infoMock.mock.calls[0].arguments[0]),
        /load the model/i,
        'the toast must name the fix, not just that something is off',
      );
    } finally {
      infoMock.mock.restore();
    }
  });

  it('does not nag once a model is already loaded (no regression on the normal path)', async () => {
    useViewerStore.setState({
      models: new Map([
        ['m1', { id: 'm1', name: 'model.ifc' } as never],
      ]),
    });
    const infoMock = mock.method(toast, 'info', () => {});
    try {
      const container = renderPanel();
      const file = await makeBcfFile();
      await selectFile(fileInput(container), file);

      assert.equal(
        useViewerStore.getState().bcfProject?.topics.size,
        1,
        'the import itself must still succeed',
      );
      assert.equal(infoMock.mock.callCount(), 0, 'no guidance toast when a model is already loaded');
    } finally {
      infoMock.mock.restore();
    }
  });
});
