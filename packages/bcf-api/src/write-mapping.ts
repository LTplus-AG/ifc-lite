/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The write direction of `mapping.ts`: `@ifc-lite/bcf` in-memory topics and
 * viewpoints into BCF API request bodies, so a locally drafted topic is sent
 * with exactly the fields the archive writer would record.
 */

import type { BCFComponent, BCFPoint, BCFTopic, BCFViewpoint } from '@ifc-lite/bcf';
import type { BcfComponentDto, BcfPointDto, BcfTopicWriteDto, BcfViewpointDto } from './types.js';

/** Topic fields a client may write; server-owned fields (guid, dates, authors, index) are never sent. */
export function topicToApiWrite(topic: BCFTopic): BcfTopicWriteDto {
  const write: { -readonly [K in keyof BcfTopicWriteDto]: BcfTopicWriteDto[K] } = { title: topic.title };
  if (topic.description !== undefined) write.description = topic.description;
  if (topic.topicType !== undefined) write.topic_type = topic.topicType;
  if (topic.topicStatus !== undefined) write.topic_status = topic.topicStatus;
  if (topic.priority !== undefined) write.priority = topic.priority;
  if (topic.labels && topic.labels.length > 0) write.labels = [...topic.labels];
  if (topic.assignedTo !== undefined) write.assigned_to = topic.assignedTo;
  if (topic.stage !== undefined) write.stage = topic.stage;
  if (topic.dueDate !== undefined) write.due_date = topic.dueDate;
  return write;
}

function point(value: BCFPoint): BcfPointDto {
  return { x: value.x, y: value.y, z: value.z };
}

function component(value: BCFComponent): BcfComponentDto {
  const dto: BcfComponentDto = {};
  if (value.ifcGuid !== undefined) dto.ifc_guid = value.ifcGuid;
  if (value.originatingSystem !== undefined) dto.originating_system = value.originatingSystem;
  if (value.authoringToolId !== undefined) dto.authoring_tool_id = value.authoringToolId;
  return dto;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** `snapshot_type`/`snapshot_data` from raw bytes or a data URL; anything else is not uploadable. */
function snapshot(viewpoint: BCFViewpoint): BcfViewpointDto['snapshot'] {
  if (viewpoint.snapshotData && viewpoint.snapshotData.length > 0) {
    const jpeg = viewpoint.snapshotData[0] === 0xff && viewpoint.snapshotData[1] === 0xd8;
    return { snapshot_type: jpeg ? 'jpg' : 'png', snapshot_data: base64(viewpoint.snapshotData) };
  }
  const match = viewpoint.snapshot ? /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(viewpoint.snapshot) : null;
  if (!match) return undefined;
  return { snapshot_type: match[1].toLowerCase() === 'png' ? 'png' : 'jpg', snapshot_data: match[2] };
}

/**
 * Viewpoint request body with a caller-chosen GUID. `default_visibility` is
 * always written: BCF API defaults it to `false` while BCF-XML defaults it
 * to `true`, so omitting it would turn a "show everything" viewpoint into an
 * isolation on the server.
 */
export function viewpointToApi(viewpoint: BCFViewpoint): BcfViewpointDto {
  const dto: BcfViewpointDto = { guid: viewpoint.guid };
  const perspective = viewpoint.perspectiveCamera;
  if (perspective) {
    dto.perspective_camera = {
      camera_view_point: point(perspective.cameraViewPoint),
      camera_direction: point(perspective.cameraDirection),
      camera_up_vector: point(perspective.cameraUpVector),
      field_of_view: perspective.fieldOfView,
      ...(perspective.aspectRatio !== undefined ? { aspect_ratio: perspective.aspectRatio } : {}),
    };
  }
  const orthogonal = viewpoint.orthogonalCamera;
  if (orthogonal) {
    dto.orthogonal_camera = {
      camera_view_point: point(orthogonal.cameraViewPoint),
      camera_direction: point(orthogonal.cameraDirection),
      camera_up_vector: point(orthogonal.cameraUpVector),
      view_to_world_scale: orthogonal.viewToWorldScale,
      ...(orthogonal.aspectRatio !== undefined ? { aspect_ratio: orthogonal.aspectRatio } : {}),
    };
  }
  if (viewpoint.lines?.length) {
    dto.lines = viewpoint.lines.map((line) => ({ start_point: point(line.startPoint), end_point: point(line.endPoint) }));
  }
  if (viewpoint.clippingPlanes?.length) {
    dto.clipping_planes = viewpoint.clippingPlanes.map((plane) => ({
      location: point(plane.location),
      direction: point(plane.direction),
    }));
  }
  const components = viewpoint.components;
  if (components) {
    dto.components = {
      ...(components.selection?.length ? { selection: components.selection.map(component) } : {}),
      ...(components.coloring?.length
        ? { coloring: components.coloring.map((entry) => ({ color: entry.color, components: entry.components.map(component) })) }
        : {}),
      visibility: {
        default_visibility: components.visibility?.defaultVisibility ?? true,
        ...(components.visibility?.exceptions?.length
          ? { exceptions: components.visibility.exceptions.map(component) } : {}),
        ...(components.visibility?.viewSetupHints ? { view_setup_hints: {
          spaces_visible: components.visibility.viewSetupHints.spacesVisible,
          space_boundaries_visible: components.visibility.viewSetupHints.spaceBoundariesVisible,
          openings_visible: components.visibility.viewSetupHints.openingsVisible,
        } } : {}),
      },
    };
  }
  const image = snapshot(viewpoint);
  if (image) dto.snapshot = image;
  return dto;
}
