/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { BCFTopic, BCFViewpoint } from '@ifc-lite/bcf';
import { topicFromApi, viewpointFromApi } from './mapping.js';
import { topicToApiWrite, viewpointToApi } from './write-mapping.js';

const viewpoint: BCFViewpoint = {
  guid: '6a1c4c32-6a54-4b47-9e64-3c1d1b4a9a10',
  perspectiveCamera: {
    cameraViewPoint: { x: 8, y: 5, z: 4 }, cameraDirection: { x: -1, y: 0, z: 0 },
    cameraUpVector: { x: 0, y: 0, z: 1 }, fieldOfView: 60,
  },
  clippingPlanes: [{ location: { x: 2, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }],
  components: {
    selection: [{ ifcGuid: '2O2Fr$t4X7Zf8NOew3FLOH', originatingSystem: 'SketchUp' }],
    coloring: [{ color: 'FFFF3333', components: [{ ifcGuid: '2O2Fr$t4X7Zf8NOew3FLOH' }] }],
    visibility: { defaultVisibility: true },
  },
};

describe('local -> BCF API write mapping (#6896)', () => {
  it('a viewpoint survives write -> read mapping with its caller GUID, components and planes', () => {
    const dto = viewpointToApi(viewpoint);
    expect(dto.guid).toBe(viewpoint.guid);
    expect(viewpointFromApi(dto)).toEqual(viewpoint);
  });

  it('always writes default_visibility: BCF API reads an omitted value as false (isolation)', () => {
    const dto = viewpointToApi({ guid: 'g', components: { selection: [{ ifcGuid: 'a' }] } });
    expect(dto.components?.visibility?.default_visibility).toBe(true);
    const isolation = viewpointToApi({ guid: 'g', components: { visibility: { defaultVisibility: false, exceptions: [{ ifcGuid: 'a' }] } } });
    expect(isolation.components?.visibility).toEqual({ default_visibility: false, exceptions: [{ ifc_guid: 'a' }] });
  });

  it('uploads snapshot bytes or data URLs and never a bare archive file name', () => {
    const png = viewpointToApi({ guid: 'g', snapshotData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
    expect(png.snapshot).toEqual({ snapshot_type: 'png', snapshot_data: 'iVBORw==' });
    const jpeg = viewpointToApi({ guid: 'g', snapshot: 'data:image/jpeg;base64,/9j/AA==' });
    expect(jpeg.snapshot).toEqual({ snapshot_type: 'jpg', snapshot_data: '/9j/AA==' });
    expect(viewpointToApi({ guid: 'g', snapshot: 'snapshot.png' }).snapshot).toBeUndefined();
  });

  it('topic writes carry only client-owned fields and read back unchanged', () => {
    const topic: BCFTopic = {
      guid: 'local-guid', title: 'Duct x beam', description: 'Two members', topicType: 'Clash', topicStatus: 'Open',
      priority: 'High', labels: ['MEP'], assignedTo: 'coordinator@example.test', creationDate: '2026-10-04T12:00:00Z',
      creationAuthor: 'someone', comments: [], viewpoints: [],
    };
    const write = topicToApiWrite(topic);
    expect(write).toEqual({ title: 'Duct x beam', description: 'Two members', topic_type: 'Clash', topic_status: 'Open',
      priority: 'High', labels: ['MEP'], assigned_to: 'coordinator@example.test' });
    const read = topicFromApi({ ...write, guid: 'server-guid' });
    expect({ ...read, guid: topic.guid, creationDate: topic.creationDate, creationAuthor: topic.creationAuthor }).toEqual(topic);
  });
});
