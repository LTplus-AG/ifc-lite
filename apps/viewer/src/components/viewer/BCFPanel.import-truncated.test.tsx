/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5213: `readBCF` never throws for a malformed piece of an otherwise-valid
 * archive -- e.g. two topic folders whose `markup.bcf` declare the same
 * `Topic Guid` (#3960) -- it reports the drop through `onWarning` and keeps
 * going, so the returned project reads as a plain success with fewer topics
 * than the archive held. BCFPanel's import success path used to call
 * `setBcfProject` and stop there: a truncated import and a complete one
 * produced the identical success toast, with the only signal sitting in
 * devtools. This drives the panel's real import path (a real `readBCF`
 * against a hand-built archive, not a mock) and asserts the truncation now
 * surfaces as a toast the user actually sees.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import JSZip from 'jszip';
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
  for (let i = 0; i < 200 && useViewerStore.getState().bcfLoading; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function markupFile(guid: string, title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Topic Guid="${guid}" TopicType="Issue" TopicStatus="Open">
    <Title>${title}</Title>
  </Topic>
</Markup>`;
}

/** An archive with two topic folders whose markup.bcf collide on Topic Guid
 * (#3960): readBCF keeps the first, drops the second, and warns. */
async function makeTruncatingBcfFile(): Promise<File> {
  const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
  const zip = new JSZip();
  zip.file(
    'bcf.version',
    '<?xml version="1.0" encoding="UTF-8"?><Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>',
  );
  zip.file('folder-one/markup.bcf', markupFile(guid, 'Topic in folder-one'));
  zip.file('folder-two/markup.bcf', markupFile(guid, 'Topic in folder-two'));
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  return new File([buf], 'truncated.bcfzip', { type: 'application/octet-stream' });
}

/** A plain, complete archive with a single, uncontested topic. */
async function makeCleanBcfFile(): Promise<File> {
  const project = createBCFProject({ name: 'Imported' });
  const topic = createBCFTopic({ title: 'A topic', author: 'a@b.com' });
  project.topics.set(topic.guid, topic);
  const blob = await writeBCF(project);
  return new File([blob], 'clean.bcfzip', { type: 'application/octet-stream' });
}

async function makeUnsupportedVersionBcfFile(): Promise<File> {
  const zip = new JSZip();
  zip.file('bcf.version', '<Version VersionId="4.0"/>');
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  return new File([buf], 'future.bcfzip', { type: 'application/octet-stream' });
}

describe('BCFPanel import — truncation guidance (#5213)', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    useViewerStore.setState({
      models: new Map([['m1', { id: 'm1', name: 'model.ifc' } as never]]),
      bcfProject: null,
      bcfError: null,
      bcfLoading: false,
    });
  });

  it('surfaces a toast when readBCF silently dropped a topic, instead of a plain success', async () => {
    const errorMock = mock.method(toast, 'error', () => {});
    const warnMock = mock.method(console, 'warn', () => {});
    try {
      const container = renderPanel();
      const file = await makeTruncatingBcfFile();
      await selectFile(fileInput(container), file);

      assert.equal(
        useViewerStore.getState().bcfProject?.topics.size,
        1,
        'the collision guard still keeps exactly one topic',
      );
      assert.equal(
        useViewerStore.getState().bcfError,
        null,
        'a truncated-but-successful import is not the catch-path bcfError',
      );
      assert.equal(errorMock.mock.callCount(), 1, 'exactly one truncation toast fires');
      assert.match(
        String(errorMock.mock.calls[0].arguments[0]),
        /skipped|could not be read/i,
        'the toast must name that something was dropped, not just show a generic error',
      );
    } finally {
      warnMock.mock.restore();
      errorMock.mock.restore();
    }
  });

  it('does not nag on a plain, complete import (no regression on the normal path)', async () => {
    const errorMock = mock.method(toast, 'error', () => {});
    try {
      const container = renderPanel();
      const file = await makeCleanBcfFile();
      await selectFile(fileInput(container), file);

      assert.equal(useViewerStore.getState().bcfProject?.topics.size, 1);
      assert.equal(errorMock.mock.callCount(), 0, 'no truncation toast on a clean import');
    } finally {
      errorMock.mock.restore();
    }
  });

  it('shows a version-specific warning without claiming that items were skipped', async () => {
    const errorMock = mock.method(toast, 'error', () => {});
    const warnMock = mock.method(console, 'warn', () => {});
    try {
      const container = renderPanel();
      await selectFile(fileInput(container), await makeUnsupportedVersionBcfFile());

      assert.equal(useViewerStore.getState().bcfProject?.version, '2.1');
      assert.equal(errorMock.mock.callCount(), 1);
      assert.match(String(errorMock.mock.calls[0].arguments[0]), /Unsupported BCF version: 4\.0/);
      assert.doesNotMatch(String(errorMock.mock.calls[0].arguments[0]), /skipped/i);
    } finally {
      warnMock.mock.restore();
      errorMock.mock.restore();
    }
  });
});
