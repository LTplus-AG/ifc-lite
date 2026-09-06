/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3962: the writer used to decide whether to emit a viewpoint's
 * `<Snapshot>` markup reference based purely on whether
 * `viewpoint.snapshot`/`snapshotData` was truthy, then separately -- a few
 * dozen lines later, in `writeViewpointFiles` -- attempt to actually decode
 * and write the file. A malformed `data:` URL threw inside `atob()`, was
 * caught, and only `console.warn`ed: the markup reference was already
 * written by that point, so the archive ended up schema-valid but naming a
 * snapshot file that was never added to the zip.
 *
 * The fix resolves each viewpoint's snapshot ONCE, before either the markup
 * or the file is written, so the two can never disagree.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import JSZip from 'jszip';
import { generateUuid } from '@ifc-lite/encoding';
import { writeBCF } from './writer.js';
import { readBCF } from './reader.js';
import type { BCFProject, BCFTopic } from './types.js';

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

function projectWithSnapshot(snapshot: string | undefined): { project: BCFProject; topicGuid: string; viewpointGuid: string } {
  const topicGuid = generateUuid();
  const viewpointGuid = generateUuid();
  const topic: BCFTopic = {
    guid: topicGuid,
    title: 'Topic with snapshot',
    creationDate: new Date().toISOString(),
    creationAuthor: 'test@example.com',
    comments: [],
    viewpoints: [
      {
        guid: viewpointGuid,
        snapshot,
        perspectiveCamera: {
          cameraViewPoint: { x: 0, y: 0, z: 0 },
          cameraDirection: { x: 1, y: 0, z: 0 },
          cameraUpVector: { x: 0, y: 1, z: 0 },
          fieldOfView: 60,
        },
      },
    ],
  };
  const project: BCFProject = {
    version: '2.1',
    projectId: generateUuid(),
    topics: new Map([[topicGuid, topic]]),
  };
  return { project, topicGuid, viewpointGuid };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#3962: dangling snapshot reference', () => {
  it('a malformed snapshot data URL is neither referenced in markup.bcf nor left dangling', async () => {
    const { project, topicGuid } = projectWithSnapshot('data:image/png;base64,!!!not-valid-base64!!!');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    const markupContent = await zip.file(`${topicGuid}/markup.bcf`)?.async('string');
    expect(markupContent).toBeDefined();
    // The reference must be gone, not merely the file: this is the whole bug.
    expect(markupContent).not.toContain('<Snapshot>');

    const snapshotEntries = Object.keys(zip.files).filter((name) => name.includes('Snapshot_'));
    expect(snapshotEntries).toHaveLength(0);

    expect(warn).toHaveBeenCalled();
  });

  it('control: a normal export with a valid snapshot writes both the reference and the file', async () => {
    // A minimal but valid base64 payload (does not need to be a real PNG for
    // atob() to succeed -- only the malformed case needs to fail decoding).
    const validDataUrl = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;
    const { project, topicGuid, viewpointGuid } = projectWithSnapshot(validDataUrl);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    const markupContent = await zip.file(`${topicGuid}/markup.bcf`)?.async('string');
    expect(markupContent).toContain('<Snapshot>');
    const snapshotMatch = markupContent?.match(/<Snapshot>([^<]+)<\/Snapshot>/);
    expect(snapshotMatch).toBeTruthy();
    const snapshotFilename = snapshotMatch![1];

    expect(zip.file(`${topicGuid}/${snapshotFilename}`)).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    void viewpointGuid;
  });

  it('round trip: write then read an archive with a valid snapshot and it survives', async () => {
    const validDataUrl = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;
    const { project, topicGuid } = projectWithSnapshot(validDataUrl);

    const blob = await writeBCF(project);
    const buf = new Uint8Array(await blobToArrayBuffer(blob));
    const readBack = await readBCF(buf);

    const topic = readBack.topics.get(topicGuid);
    expect(topic).toBeDefined();
    expect(topic!.viewpoints).toHaveLength(1);
    expect(topic!.viewpoints[0].snapshot).toBe(validDataUrl);
  });
});
