/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5600: BCFPanel's import/export handlers stored `bcfError` / `bcfLoading`
 * in the BCF slice, but nothing rendered either, so a corrupt `.bcfzip` looked
 * like nothing happened and a large import showed no busy state. A failed
 * "capture viewpoint" only reached `console.warn`. These drive the real panel
 * over the real store and assert each failure is now on screen.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import { cleanup, render } from '@/test/render.js';
import { resolve } from '@/i18n/registry.js';
import { useViewerStore } from '@/store/index.js';
import { toast } from '@/components/ui/toast';
import { BCFPanel } from './BCFPanel.js';

function alertText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('[role="alert"]'))
    .map((el) => el.textContent ?? '')
    .join(' ');
}

async function importFile(container: HTMLElement, file: File): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(input, 'the hidden BCF file input must render');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  for (let i = 0; i < 200 && useViewerStore.getState().bcfLoading; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

beforeEach(() => {
  useViewerStore.setState({
    models: new Map([['m1', { id: 'm1', name: 'model.ifc' } as never]]),
    bcfProject: null,
    activeTopicId: null,
    bcfError: null,
    bcfLoading: false,
  });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState({ bcfProject: null, activeTopicId: null, bcfError: null, bcfLoading: false });
});

describe('BCFPanel shows BCF failures to the user (#5600)', () => {
  it('renders a rejected import as an inline error that can be dismissed', async () => {
    const errorLog = mock.method(console, 'error', () => {});
    try {
      const container = render(<BCFPanel onClose={() => {}} />);
      await importFile(container, new File(['not a zip archive'], 'corrupt.bcfzip'));

      const message = useViewerStore.getState().bcfError;
      assert.ok(message, 'precondition: the corrupt archive was rejected into bcfError');
      assert.match(alertText(container), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const dismiss = container.querySelector<HTMLButtonElement>(
        `[aria-label="${resolve('bcf.panel.dismissError')}"]`,
      );
      assert.ok(dismiss, 'the error banner offers a dismiss button');
      act(() => dismiss.click());
      assert.equal(useViewerStore.getState().bcfError, null);
      assert.equal(alertText(container).trim(), '', 'the banner is gone once dismissed');
    } finally {
      errorLog.mock.restore();
    }
  });

  it('shows a busy state while an import or export is in flight', () => {
    const container = render(<BCFPanel onClose={() => {}} />);
    assert.doesNotMatch(container.textContent ?? '', /Processing BCF file/);
    act(() => useViewerStore.setState({ bcfLoading: true }));
    const status = container.querySelector('[role="status"]');
    assert.ok(status, 'a status region renders while bcfLoading');
    assert.equal(status.textContent?.trim(), resolve('bcf.panel.busy'));
  });

  it('tells the user when a viewpoint could not be captured', async () => {
    const project = createBCFProject({ name: 'P' });
    const topic = createBCFTopic({ title: 'Topic', author: 'a@b.com' });
    project.topics.set(topic.guid, topic);
    // No renderer is mounted, so there is no camera to capture from.
    useViewerStore.setState({ bcfProject: project, activeTopicId: topic.guid });
    const errorMock = mock.method(toast, 'error', () => {});
    const warnMock = mock.method(console, 'warn', () => {});
    try {
      const container = render(<BCFPanel onClose={() => {}} />);
      const capture = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === resolve('bcf.viewpointCapture.capture3d'),
      );
      assert.ok(capture, 'the topic detail renders its capture button');
      await act(async () => {
        capture.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      assert.equal(errorMock.mock.callCount(), 1, 'a failed capture raises one error toast');
      assert.equal(errorMock.mock.calls[0].arguments[0], resolve('bcf.panel.captureViewpointFailed'));
      assert.equal(project.topics.get(topic.guid)?.viewpoints.length ?? 0, 0, 'no viewpoint was added');
    } finally {
      warnMock.mock.restore();
      errorMock.mock.restore();
    }
  });
});
