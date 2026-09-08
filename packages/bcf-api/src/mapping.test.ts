/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  commentFromApi,
  componentsFromApi,
  extensionsFromApi,
  normalizeArgbColor,
  topicFromApi,
  viewpointFromApi,
} from './mapping.js';
import type { BcfTopicDto, BcfViewpointDto } from './types.js';

describe('topicFromApi', () => {
  it('maps every snake_case field onto the BCF-XML model shape', () => {
    const dto: BcfTopicDto = {
      guid: 'aaaa-bbbb',
      topic_type: 'Clash',
      topic_status: 'Open',
      title: 'Pipe collides with beam',
      priority: 'High',
      index: 3,
      labels: ['MEP', 'Structural'],
      creation_date: '2026-08-01T10:00:00Z',
      creation_author: 'alice@example.com',
      modified_date: '2026-08-02T11:00:00Z',
      modified_author: 'bob@example.com',
      assigned_to: 'carol@example.com',
      stage: 'Design',
      description: 'Reroute the pipe',
      due_date: '2026-09-01T00:00:00Z',
      bim_snippet: {
        snippet_type: 'clash',
        is_external: true,
        reference: 'https://example.com/clash.json',
        reference_schema: 'https://example.com/schema.json',
      },
    };
    const topic = topicFromApi(dto);
    expect(topic).toEqual({
      guid: 'aaaa-bbbb',
      title: 'Pipe collides with beam',
      description: 'Reroute the pipe',
      topicType: 'Clash',
      topicStatus: 'Open',
      priority: 'High',
      index: 3,
      creationDate: '2026-08-01T10:00:00Z',
      creationAuthor: 'alice@example.com',
      modifiedDate: '2026-08-02T11:00:00Z',
      modifiedAuthor: 'bob@example.com',
      dueDate: '2026-09-01T00:00:00Z',
      assignedTo: 'carol@example.com',
      stage: 'Design',
      labels: ['MEP', 'Structural'],
      bimSnippet: {
        snippetType: 'clash',
        isExternal: true,
        reference: 'https://example.com/clash.json',
        referenceSchema: 'https://example.com/schema.json',
      },
      comments: [],
      viewpoints: [],
    });
  });

  it('defaults a missing title rather than producing an untitled crash', () => {
    const topic = topicFromApi({ guid: 'g1' });
    expect(topic.title).toBe('Untitled topic');
    expect(topic.labels).toBeUndefined();
    expect(topic.bimSnippet).toBeUndefined();
  });

  it('normalizes explicit nulls to undefined (servers that null empty optionals)', () => {
    // Shape observed live: a spec-strict server sends null, not omission.
    const topic = topicFromApi({
      guid: 'g2',
      title: 'Topic',
      creation_date: '2026-08-25T07:12:27.467+00:00',
      creation_author: 'alice@example.com',
      labels: [],
      topic_type: 'Issue',
      topic_status: 'Resolved',
      priority: null,
      stage: null,
      description: null,
      assigned_to: null,
      due_date: null,
      index: 0,
      modified_date: null,
      modified_author: null,
      bim_snippet: null,
    });
    expect(topic.priority).toBeUndefined();
    expect(topic.stage).toBeUndefined();
    expect(topic.description).toBeUndefined();
    expect(topic.assignedTo).toBeUndefined();
    expect(topic.dueDate).toBeUndefined();
    expect(topic.modifiedDate).toBeUndefined();
    expect(topic.modifiedAuthor).toBeUndefined();
    expect(topic.bimSnippet).toBeUndefined();
    // No property of the mapped topic may hold null.
    expect(Object.values(topic).some((v) => v === null)).toBe(false);
  });
});

describe('commentFromApi', () => {
  it('normalizes explicit nulls to undefined', () => {
    const comment = commentFromApi({
      guid: 'c9',
      date: '2026-08-25T09:41:48.210+00:00',
      author: 'admin@example.com',
      comment: 'hi',
      viewpoint_guid: null,
      modified_date: null,
      modified_author: null,
    });
    expect(comment.viewpointGuid).toBeUndefined();
    expect(comment.modifiedDate).toBeUndefined();
    expect(Object.values(comment).some((v) => v === null)).toBe(false);
  });

  it('maps viewpoint binding and modification fields', () => {
    expect(
      commentFromApi({
        guid: 'c1',
        date: '2026-08-01T10:00:00Z',
        author: 'alice@example.com',
        comment: 'Please fix',
        viewpoint_guid: 'v1',
        modified_date: '2026-08-02T10:00:00Z',
        modified_author: 'bob@example.com',
      }),
    ).toEqual({
      guid: 'c1',
      date: '2026-08-01T10:00:00Z',
      author: 'alice@example.com',
      comment: 'Please fix',
      viewpointGuid: 'v1',
      modifiedDate: '2026-08-02T10:00:00Z',
      modifiedAuthor: 'bob@example.com',
    });
  });
});

describe('viewpointFromApi', () => {
  const perspectiveDto: BcfViewpointDto = {
    guid: 'v1',
    perspective_camera: {
      camera_view_point: { x: 1, y: 2, z: 3 },
      camera_direction: { x: 0, y: 1, z: 0 },
      camera_up_vector: { x: 0, y: 0, z: 1 },
      field_of_view: 60,
    },
    lines: [{ start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 1, y: 1, z: 1 } }],
    clipping_planes: [{ location: { x: 0, y: 0, z: 2 }, direction: { x: 0, y: 0, z: 1 } }],
  };

  it('maps cameras, lines and clipping planes to camelCase', () => {
    const viewpoint = viewpointFromApi(perspectiveDto);
    expect(viewpoint.guid).toBe('v1');
    expect(viewpoint.perspectiveCamera).toEqual({
      cameraViewPoint: { x: 1, y: 2, z: 3 },
      cameraDirection: { x: 0, y: 1, z: 0 },
      cameraUpVector: { x: 0, y: 0, z: 1 },
      fieldOfView: 60,
      aspectRatio: undefined,
    });
    expect(viewpoint.orthogonalCamera).toBeUndefined();
    expect(viewpoint.lines).toEqual([
      { startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 1, y: 1, z: 1 } },
    ]);
    expect(viewpoint.clippingPlanes).toEqual([
      { location: { x: 0, y: 0, z: 2 }, direction: { x: 0, y: 0, z: 1 } },
    ]);
  });

  it('drops a camera with non-finite or missing fields instead of fabricating one', () => {
    const broken = viewpointFromApi({
      guid: 'v2',
      perspective_camera: {
        camera_view_point: { x: Number.NaN, y: 0, z: 0 },
        camera_direction: { x: 0, y: 1, z: 0 },
        camera_up_vector: { x: 0, y: 0, z: 1 },
        field_of_view: 60,
      },
    });
    expect(broken.perspectiveCamera).toBeUndefined();
  });

  it('prefers explicitly fetched components over inline ones', () => {
    const viewpoint = viewpointFromApi(
      { ...perspectiveDto, components: { selection: [{ ifc_guid: 'inline_guid_000000000A' }] } },
      { selection: [{ ifc_guid: 'fetched_guid_00000000A' }] },
    );
    expect(viewpoint.components?.selection?.[0].ifcGuid).toBe('fetched_guid_00000000A');
  });

  it('maps orthogonal cameras with view_to_world_scale', () => {
    const viewpoint = viewpointFromApi({
      guid: 'v3',
      orthogonal_camera: {
        camera_view_point: { x: 0, y: 0, z: 10 },
        camera_direction: { x: 0, y: 0, z: -1 },
        camera_up_vector: { x: 0, y: 1, z: 0 },
        view_to_world_scale: 5,
      },
    });
    expect(viewpoint.orthogonalCamera?.viewToWorldScale).toBe(5);
  });
});

describe('componentsFromApi', () => {
  it('assembles selection, visibility and coloring with IFC GlobalIds passed through', () => {
    const components = componentsFromApi({
      selection: [{ ifc_guid: '0Bv2mAq6X4qfmHc0_Vw$aA', originating_system: 'ifc-lite' }],
      visibility: {
        default_visibility: false,
        exceptions: [{ ifc_guid: '1Cv2mAq6X4qfmHc0_Vw$aB' }],
        view_setup_hints: { spaces_visible: true, openings_visible: false },
      },
      coloring: [{ color: 'ff0000', components: [{ ifc_guid: '2Dv2mAq6X4qfmHc0_Vw$aC' }] }],
    });
    expect(components).toEqual({
      selection: [
        {
          ifcGuid: '0Bv2mAq6X4qfmHc0_Vw$aA',
          originatingSystem: 'ifc-lite',
          authoringToolId: undefined,
        },
      ],
      visibility: {
        defaultVisibility: false,
        exceptions: [
          { ifcGuid: '1Cv2mAq6X4qfmHc0_Vw$aB', originatingSystem: undefined, authoringToolId: undefined },
        ],
        viewSetupHints: {
          spacesVisible: true,
          spaceBoundariesVisible: undefined,
          openingsVisible: false,
        },
      },
      coloring: [
        {
          color: 'FFFF0000',
          components: [
            { ifcGuid: '2Dv2mAq6X4qfmHc0_Vw$aC', originatingSystem: undefined, authoringToolId: undefined },
          ],
        },
      ],
    });
  });

  it('returns undefined when every channel is empty', () => {
    expect(componentsFromApi({})).toBeUndefined();
    expect(componentsFromApi({ selection: [], coloring: [] })).toBeUndefined();
  });

  it('reads an omitted default_visibility as false (BCF API 2.1 wire default)', () => {
    // Servers encode isolation viewpoints as exceptions-only visibility with
    // default_visibility omitted; the spec default is false, so this must
    // isolate the listed components — `?? true` would hide them instead.
    const components = componentsFromApi({
      visibility: { exceptions: [{ ifc_guid: '1Cv2mAq6X4qfmHc0_Vw$aB' }] },
    });
    expect(components?.visibility?.defaultVisibility).toBe(false);
  });
});

describe('normalizeArgbColor', () => {
  it('expands 6-hex RGB to ARGB with full alpha', () => {
    expect(normalizeArgbColor('ff0000')).toBe('FFFF0000');
    expect(normalizeArgbColor('#00ff00')).toBe('FF00FF00');
  });
  it('keeps 8-hex ARGB unchanged apart from casing', () => {
    expect(normalizeArgbColor('80ff0000')).toBe('80FF0000');
  });
});

describe('extensionsFromApi', () => {
  it('maps the extension vocabularies', () => {
    expect(
      extensionsFromApi({
        topic_type: ['Clash'],
        topic_status: ['Open', 'Closed'],
        priority: ['High'],
        topic_label: ['MEP'],
        user_id_type: ['alice@example.com'],
        stage: ['Design'],
      }),
    ).toEqual({
      topicTypes: ['Clash'],
      topicStatuses: ['Open', 'Closed'],
      priorities: ['High'],
      topicLabels: ['MEP'],
      users: ['alice@example.com'],
      stages: ['Design'],
    });
  });

  it('returns undefined for an empty extensions document', () => {
    expect(extensionsFromApi({})).toBeUndefined();
    expect(extensionsFromApi({ topic_type: [] })).toBeUndefined();
  });
});
