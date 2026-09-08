/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Converts BCF API wire DTOs (snake_case JSON) into the `@ifc-lite/bcf`
 * in-memory model (the shapes `readBCF` produces), so server-fetched topics
 * flow through the same viewer code paths as imported .bcfzip files.
 */

import type {
  BCFColoring,
  BCFComment,
  BCFComponent,
  BCFComponents,
  BCFExtensions,
  BCFOrthogonalCamera,
  BCFPerspectiveCamera,
  BCFPoint,
  BCFTopic,
  BCFViewpoint,
  BCFVisibility,
} from '@ifc-lite/bcf';
import type {
  BcfColoringDto,
  BcfCommentDto,
  BcfComponentDto,
  BcfComponentsDto,
  BcfExtensionsDto,
  BcfOrthogonalCameraDto,
  BcfPerspectiveCameraDto,
  BcfPointDto,
  BcfTopicDto,
  BcfViewpointDto,
  BcfVisibilityDto,
} from './types.js';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Some servers send explicit `null` for empty optional fields instead of
 * omitting them; the in-memory model uses `undefined` throughout, so nulls
 * are normalized at this boundary.
 */
function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function pointFromDto(dto: BcfPointDto | null | undefined): BCFPoint | undefined {
  if (!dto) return undefined;
  if (!isFiniteNumber(dto.x) || !isFiniteNumber(dto.y) || !isFiniteNumber(dto.z)) {
    return undefined;
  }
  return { x: dto.x, y: dto.y, z: dto.z };
}

function perspectiveCameraFromDto(
  dto: BcfPerspectiveCameraDto | null | undefined,
): BCFPerspectiveCamera | undefined {
  if (!dto) return undefined;
  const viewPoint = pointFromDto(dto.camera_view_point);
  const direction = pointFromDto(dto.camera_direction);
  const up = pointFromDto(dto.camera_up_vector);
  if (!viewPoint || !direction || !up || !isFiniteNumber(dto.field_of_view)) return undefined;
  return {
    cameraViewPoint: viewPoint,
    cameraDirection: direction,
    cameraUpVector: up,
    fieldOfView: dto.field_of_view,
    aspectRatio: isFiniteNumber(dto.aspect_ratio) ? dto.aspect_ratio : undefined,
  };
}

function orthogonalCameraFromDto(
  dto: BcfOrthogonalCameraDto | null | undefined,
): BCFOrthogonalCamera | undefined {
  if (!dto) return undefined;
  const viewPoint = pointFromDto(dto.camera_view_point);
  const direction = pointFromDto(dto.camera_direction);
  const up = pointFromDto(dto.camera_up_vector);
  if (!viewPoint || !direction || !up || !isFiniteNumber(dto.view_to_world_scale)) {
    return undefined;
  }
  return {
    cameraViewPoint: viewPoint,
    cameraDirection: direction,
    cameraUpVector: up,
    viewToWorldScale: dto.view_to_world_scale,
    aspectRatio: isFiniteNumber(dto.aspect_ratio) ? dto.aspect_ratio : undefined,
  };
}

function componentFromDto(dto: BcfComponentDto): BCFComponent {
  return {
    ifcGuid: orUndefined(dto.ifc_guid),
    originatingSystem: orUndefined(dto.originating_system),
    authoringToolId: orUndefined(dto.authoring_tool_id),
  };
}

/**
 * Normalize a BCF API coloring color to the ARGB 8-hex form the BCF-XML
 * model uses ('FFFF0000'). Servers send 6-hex RGB or 8-hex ARGB, with or
 * without a leading '#'. Anything else is returned uppercased as-is rather
 * than guessed at.
 */
export function normalizeArgbColor(color: string): string {
  const hex = (color.startsWith('#') ? color.slice(1) : color).toUpperCase();
  if (/^[0-9A-F]{6}$/.test(hex)) return `FF${hex}`;
  return hex;
}

function coloringFromDto(dtos: BcfColoringDto[] | null | undefined): BCFColoring[] | undefined {
  if (!dtos || dtos.length === 0) return undefined;
  const result: BCFColoring[] = [];
  for (const dto of dtos) {
    if (typeof dto.color !== 'string' || dto.color.length === 0) continue;
    result.push({
      color: normalizeArgbColor(dto.color),
      components: (dto.components ?? []).map(componentFromDto),
    });
  }
  return result.length > 0 ? result : undefined;
}

function visibilityFromDto(dto: BcfVisibilityDto | null | undefined): BCFVisibility | undefined {
  if (!dto) return undefined;
  const hints = dto.view_setup_hints;
  return {
    // BCF API 2.1 defines default_visibility as "optional, default false" on
    // the wire (unlike BCF-XML, where a missing attribute reads as true), and
    // servers encode isolation viewpoints by omitting it. `?? true` here would
    // invert isolation into hiding the isolated components.
    defaultVisibility: dto.default_visibility ?? false,
    exceptions:
      dto.exceptions && dto.exceptions.length > 0
        ? dto.exceptions.map(componentFromDto)
        : undefined,
    viewSetupHints: hints
      ? {
          spacesVisible: orUndefined(hints.spaces_visible),
          spaceBoundariesVisible: orUndefined(hints.space_boundaries_visible),
          openingsVisible: orUndefined(hints.openings_visible),
        }
      : undefined,
  };
}

/** Map a components payload (inline or assembled from subresources). */
export function componentsFromApi(dto: BcfComponentsDto): BCFComponents | undefined {
  const selection =
    dto.selection && dto.selection.length > 0 ? dto.selection.map(componentFromDto) : undefined;
  const visibility = visibilityFromDto(dto.visibility);
  const coloring = coloringFromDto(dto.coloring);
  if (!selection && !visibility && !coloring) return undefined;
  return { selection, visibility, coloring };
}

/**
 * Map a viewpoint DTO. Malformed cameras (missing or non-finite fields) are
 * dropped rather than fabricated, so a broken server viewpoint degrades to
 * "no camera" instead of teleporting the user to the origin. The snapshot
 * image is not part of the DTO; fetch it separately and set
 * `viewpoint.snapshot` to a data URL.
 */
export function viewpointFromApi(
  dto: BcfViewpointDto,
  components?: BcfComponentsDto,
): BCFViewpoint {
  const lines = (dto.lines ?? [])
    .map((line) => {
      const start = pointFromDto(line.start_point);
      const end = pointFromDto(line.end_point);
      return start && end ? { startPoint: start, endPoint: end } : undefined;
    })
    .filter((line) => line !== undefined);
  const clippingPlanes = (dto.clipping_planes ?? [])
    .map((plane) => {
      const location = pointFromDto(plane.location);
      const direction = pointFromDto(plane.direction);
      return location && direction ? { location, direction } : undefined;
    })
    .filter((plane) => plane !== undefined);

  const componentsSource = components ?? dto.components;
  return {
    guid: dto.guid,
    perspectiveCamera: perspectiveCameraFromDto(dto.perspective_camera),
    orthogonalCamera: orthogonalCameraFromDto(dto.orthogonal_camera),
    lines: lines.length > 0 ? lines : undefined,
    clippingPlanes: clippingPlanes.length > 0 ? clippingPlanes : undefined,
    components: componentsSource ? componentsFromApi(componentsSource) : undefined,
  };
}

export function commentFromApi(dto: BcfCommentDto): BCFComment {
  return {
    guid: dto.guid,
    date: dto.date ?? '',
    author: dto.author ?? '',
    comment: dto.comment ?? '',
    viewpointGuid: orUndefined(dto.viewpoint_guid),
    modifiedDate: orUndefined(dto.modified_date),
    modifiedAuthor: orUndefined(dto.modified_author),
  };
}

/**
 * Map a topic DTO. Comments and viewpoints ship as empty arrays; the sync
 * layer fills them from the per-topic collection endpoints.
 */
export function topicFromApi(dto: BcfTopicDto): BCFTopic {
  return {
    guid: dto.guid,
    title: dto.title ?? 'Untitled topic',
    description: orUndefined(dto.description),
    topicType: orUndefined(dto.topic_type),
    topicStatus: orUndefined(dto.topic_status),
    priority: orUndefined(dto.priority),
    index: isFiniteNumber(dto.index) ? dto.index : undefined,
    creationDate: dto.creation_date ?? '',
    creationAuthor: dto.creation_author ?? '',
    modifiedDate: orUndefined(dto.modified_date),
    modifiedAuthor: orUndefined(dto.modified_author),
    dueDate: orUndefined(dto.due_date),
    assignedTo: orUndefined(dto.assigned_to),
    stage: orUndefined(dto.stage),
    labels: dto.labels && dto.labels.length > 0 ? [...dto.labels] : undefined,
    bimSnippet: dto.bim_snippet
      ? {
          snippetType: dto.bim_snippet.snippet_type,
          isExternal: dto.bim_snippet.is_external ?? false,
          reference: dto.bim_snippet.reference,
          referenceSchema: orUndefined(dto.bim_snippet.reference_schema),
        }
      : undefined,
    comments: [],
    viewpoints: [],
  };
}

export function extensionsFromApi(dto: BcfExtensionsDto): BCFExtensions | undefined {
  const extensions: BCFExtensions = {
    topicTypes: orUndefined(dto.topic_type),
    topicStatuses: orUndefined(dto.topic_status),
    priorities: orUndefined(dto.priority),
    topicLabels: orUndefined(dto.topic_label),
    users: orUndefined(dto.user_id_type),
    stages: orUndefined(dto.stage),
  };
  // Array.isArray, not a truthiness check: each value is string[] | undefined,
  // and truthiness does not narrow it, so .length is read off {} and the
  // Typecheck lane fails. This shipped in #3288 because a fork PR's workflows
  // need maintainer approval, so that lane never ran on it.
  const hasAny = Object.values(extensions).some((list) => Array.isArray(list) && list.length > 0);
  return hasAny ? extensions : undefined;
}
