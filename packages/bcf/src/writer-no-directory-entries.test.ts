/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3612: an archive written here was refused by Solibri while BIM+, BIMcollab
 * and usBIM accepted it, and the same topic re-exported by BIMcollab was
 * accepted by Solibri. Diffing the two containers, the one structural
 * difference was an explicit directory entry ("<topic guid>/") that JSZip's
 * folder() adds. The BCF spec never asks for one: each file path carries its
 * folder. This pins that the writer emits file entries only, for both
 * versions, with viewpoints and snapshots present so every entry kind is
 * covered.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { writeBCF } from './writer.js';
import type { BCFProject, BCFTopic } from './types.js';
import { generateUuid } from '@ifc-lite/encoding';

async function entries(version: '2.1' | '3.0'): Promise<{ name: string; dir: boolean }[]> {
  const topic: BCFTopic = {
    guid: generateUuid(),
    title: 'Directory entries',
    topicType: 'Issue',
    topicStatus: 'Open',
    creationDate: '2026-09-04T05:20:00.000Z',
    creationAuthor: 'test@example.com',
    comments: [],
    viewpoints: [
      {
        guid: generateUuid(),
        perspectiveCamera: {
          cameraViewPoint: { x: 0, y: 0, z: 10 },
          cameraDirection: { x: 0, y: 1, z: 0 },
          cameraUpVector: { x: 0, y: 0, z: 1 },
          fieldOfView: 45,
          aspectRatio: 16 / 9,
        },
        snapshotData: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    ],
  };
  const project: BCFProject = {
    version,
    projectId: generateUuid(),
    name: 'No directory entries',
    topics: new Map([[topic.guid, topic]]),
  };
  const blob = await writeBCF(project);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const out: { name: string; dir: boolean }[] = [];
  zip.forEach((path, file) => out.push({ name: path, dir: file.dir }));
  return out;
}

describe('writeBCF archive container', () => {
  for (const version of ['2.1', '3.0'] as const) {
    it(`emits no directory entries and keeps every topic file under its folder (${version})`, async () => {
      const list = await entries(version);
      expect(list.filter((e) => e.dir || e.name.endsWith('/'))).toEqual([]);
      const topicFiles = list.filter((e) => e.name.includes('/')).map((e) => e.name.split('/')[1]);
      expect(topicFiles).toContain('markup.bcf');
      expect(topicFiles.some((n) => n.endsWith('.bcfv'))).toBe(true);
      expect(topicFiles.some((n) => n.endsWith('.png'))).toBe(true);
    });
  }
});
