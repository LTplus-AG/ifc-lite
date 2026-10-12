/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBCFProject, createBCFTopic, createBCFComment, readBCF } from '@ifc-lite/bcf';
import { cleanup, render } from '@/test/render.js';
import { resolve } from '@/i18n/registry.js';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';
import { useViewerStore } from '@/store/index.js';
import { BCFPanel } from './BCFPanel.js';

afterEach(() => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState({ bcfProject: null, activeTopicId: null, bcfError: null, bcfLoading: false });
});

describe('BCF export filename interoperability (#6459)', () => {
  for (const version of ['2.1', '3.0'] as const) {
    it(`downloads real BCF ${version} as .bcf without losing topics or comments`, async () => {
      const project = createBCFProject({ name: 'Building-Architecture.bcfzip', version });
      const topic = createBCFTopic({ title: 'Inspect roof', author: 'coordinator@example.test' });
      topic.comments.push(createBCFComment({ author: 'coordinator@example.test', comment: 'Retain this note' }));
      project.topics.set(topic.guid, topic);
      useViewerStore.setState({
        models: new Map(), bcfProject: project, activeTopicId: null,
        bcfError: null, bcfLoading: false, selectedEntityId: null,
        selectedEntityIds: new Set(), isolatedEntities: null, hiddenEntities: new Set(),
      });
      let archive: Blob | undefined;
      const filenames: string[] = [];
      const eventKinds: string[] = [];
      mock.method(URL, 'createObjectURL', (blob: Blob | MediaSource) => {
        assert.ok('arrayBuffer' in blob, 'the actual writer hands the browser a Blob');
        archive = blob;
        return 'blob:bcf-6459';
      });
      mock.method(URL, 'revokeObjectURL', () => {});
      mock.method(window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) {
        filenames.push(this.download);
      });
      const listener = (event: Event): void => {
        eventKinds.push((event as CustomEvent<{ kind: string }>).detail.kind);
      };
      window.addEventListener(EVENT_FILE_DOWNLOADED, listener);
      let unsubscribe: (() => void) | undefined;
      try {
        const panel = render(<BCFPanel onClose={() => {}} />);
        const button = panel.querySelector<HTMLButtonElement>(`button[aria-label="${resolve('bcf.panel.exportTitle')}"]`);
        assert.ok(button, 'the real panel exposes its export action');
        const completed = new Promise<void>((done) => {
          let started = false;
          unsubscribe = useViewerStore.subscribe((state) => {
            if (state.bcfLoading) started = true;
            else if (started) {
              unsubscribe?.();
              done();
            }
          });
        });
        // The node test runner supplies the timeout. A stuck exporter cannot
        // pass just because it handed the browser a filename before settling.
        await act(async () => {
          button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await completed;
        });
        assert.equal(useViewerStore.getState().bcfLoading, false);
        assert.equal(useViewerStore.getState().bcfError, null);
        assert.deepEqual(filenames, ['Building-Architecture.bcf']);
        assert.deepEqual(eventKinds, ['bcfzip'], 'existing export-tour format contract still completes');
        assert.ok(archive, 'a real ZIP was produced');
        const restored = await readBCF(new Uint8Array(await archive.arrayBuffer()));
        assert.equal(restored.version, version);
        assert.equal(restored.topics.size, 1);
        const restoredTopic = restored.topics.get(topic.guid);
        assert.ok(restoredTopic);
        assert.equal(restoredTopic.title, 'Inspect roof');
        assert.equal(restoredTopic.comments[0]?.comment, 'Retain this note');
      } finally {
        unsubscribe?.();
        window.removeEventListener(EVENT_FILE_DOWNLOADED, listener);
      }
    });
  }
});
