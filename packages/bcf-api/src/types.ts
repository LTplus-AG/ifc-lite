/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wire types for the buildingSMART BCF API (OpenCDE) REST services.
 * Field names are snake_case exactly as they appear in the JSON payloads of
 * BCF API 2.1 (https://github.com/buildingSMART/BCF-API); BCF API 3.0 uses
 * the same shapes for everything this client touches.
 */

/** Entry of `GET {base}/versions`. */
export interface BcfApiVersion {
  version_id: string;
  detailed_version?: string | null;
}

/** Response of `GET {base}/{version}/auth`. */
export interface BcfAuthInfo {
  oauth2_auth_url?: string;
  oauth2_token_url?: string;
  oauth2_dynamic_client_reg_url?: string;
  http_basic_supported?: boolean | null;
  supported_oauth2_flows?: string[];
}

/** Response of `GET {base}/{version}/current-user`. */
export interface BcfCurrentUser {
  id: string;
  name?: string | null;
}

/** Entry of `GET {base}/{version}/projects`. */
export interface BcfProjectDto {
  project_id: string;
  name?: string | null;
  authorization?: {
    project_actions?: string[] | null;
  } | null;
}

/** Response of `GET .../projects/{id}/extensions`. */
export interface BcfExtensionsDto {
  topic_type?: string[] | null;
  topic_status?: string[] | null;
  topic_label?: string[] | null;
  snippet_type?: string[] | null;
  priority?: string[] | null;
  user_id_type?: string[] | null;
  stage?: string[] | null;
  project_actions?: string[] | null;
  topic_actions?: string[] | null;
  comment_actions?: string[] | null;
}

export interface BcfBimSnippetDto {
  snippet_type: string;
  is_external?: boolean | null;
  reference: string;
  reference_schema?: string | null;
}

/** Entry of `GET .../projects/{id}/topics`. */
export interface BcfTopicDto {
  guid: string;
  topic_type?: string | null;
  topic_status?: string | null;
  reference_links?: string[] | null;
  title?: string | null;
  priority?: string | null;
  index?: number | null;
  labels?: string[] | null;
  creation_date?: string | null;
  creation_author?: string | null;
  modified_date?: string | null;
  modified_author?: string | null;
  assigned_to?: string | null;
  stage?: string | null;
  description?: string | null;
  due_date?: string | null;
  bim_snippet?: BcfBimSnippetDto | null;
  authorization?: {
    topic_actions?: string[] | null;
  } | null;
}

/** Body of `POST .../topics` / `PUT .../topics/{guid}`. */
export interface BcfTopicWriteDto {
  topic_type?: string | null;
  topic_status?: string | null;
  title: string;
  priority?: string | null;
  labels?: string[] | null;
  assigned_to?: string | null;
  stage?: string | null;
  description?: string | null;
  due_date?: string | null;
}

/** Entry of `GET .../topics/{guid}/comments`. */
export interface BcfCommentDto {
  guid: string;
  date?: string | null;
  author?: string | null;
  comment?: string | null;
  topic_guid?: string | null;
  viewpoint_guid?: string | null;
  reply_to_comment_guid?: string | null;
  modified_date?: string | null;
  modified_author?: string | null;
}

/** Body of `POST .../topics/{guid}/comments`. */
export interface BcfCommentWriteDto {
  comment: string;
  viewpoint_guid?: string | null;
  reply_to_comment_guid?: string | null;
}

export interface BcfPointDto {
  x: number;
  y: number;
  z: number;
}

export interface BcfPerspectiveCameraDto {
  camera_view_point: BcfPointDto;
  camera_direction: BcfPointDto;
  camera_up_vector: BcfPointDto;
  field_of_view: number;
  aspect_ratio?: number | null;
}

export interface BcfOrthogonalCameraDto {
  camera_view_point: BcfPointDto;
  camera_direction: BcfPointDto;
  camera_up_vector: BcfPointDto;
  view_to_world_scale: number;
  aspect_ratio?: number | null;
}

export interface BcfLineDto {
  start_point: BcfPointDto;
  end_point: BcfPointDto;
}

export interface BcfClippingPlaneDto {
  location: BcfPointDto;
  direction: BcfPointDto;
}

export interface BcfComponentDto {
  ifc_guid?: string | null;
  originating_system?: string | null;
  authoring_tool_id?: string | null;
}

export interface BcfViewSetupHintsDto {
  spaces_visible?: boolean | null;
  space_boundaries_visible?: boolean | null;
  openings_visible?: boolean | null;
}

export interface BcfVisibilityDto {
  default_visibility?: boolean | null;
  exceptions?: BcfComponentDto[] | null;
  view_setup_hints?: BcfViewSetupHintsDto | null;
}

export interface BcfColoringDto {
  color: string;
  components?: BcfComponentDto[] | null;
}

export interface BcfComponentsDto {
  selection?: BcfComponentDto[] | null;
  coloring?: BcfColoringDto[] | null;
  visibility?: BcfVisibilityDto | null;
}

/**
 * Entry of `GET .../topics/{guid}/viewpoints`. The list form usually omits
 * `components`; BCF API 2.1 serves those via the per-viewpoint
 * `/selection`, `/coloring` and `/visibility` subresources instead.
 */
export interface BcfViewpointDto {
  guid: string;
  index?: number | null;
  perspective_camera?: BcfPerspectiveCameraDto | null;
  orthogonal_camera?: BcfOrthogonalCameraDto | null;
  lines?: BcfLineDto[] | null;
  clipping_planes?: BcfClippingPlaneDto[] | null;
  snapshot?: null | {
    snapshot_type?: string | null;
    /** Base64 payload; only present in POST bodies, never in GET responses. */
    snapshot_data?: string | null;
  };
  components?: BcfComponentsDto | null;
}

/** Response of `GET .../viewpoints/{guid}/selection`. */
export interface BcfSelectionResponse {
  selection?: BcfComponentDto[] | null;
}

/** Response of `GET .../viewpoints/{guid}/coloring`. */
export interface BcfColoringResponse {
  coloring?: BcfColoringDto[] | null;
}

/** Response of `GET .../viewpoints/{guid}/visibility`. */
export interface BcfVisibilityResponse {
  visibility?: BcfVisibilityDto | null;
}

/**
 * OAuth2 token response of `POST {oauth2_token_url}`. Unlike the wire DTOs
 * above, this is what the auth helpers RETURN after field-by-field
 * validation (`postTokenRequest`), so absent fields are always `undefined`,
 * never `null`.
 */
export interface BcfTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

/** Minimal fetch signature the client depends on (injectable in tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Supplies the current access token; return undefined for anonymous calls. */
export type BcfTokenProvider = () => string | undefined | Promise<string | undefined>;
