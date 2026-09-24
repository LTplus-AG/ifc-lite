/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  FoundationApiClient,
  type FoundationApiClientOptions,
} from '@ifc-lite/opencde-foundation';
import type {
  BcfColoringResponse,
  BcfCommentDto,
  BcfCommentWriteDto,
  BcfExtensionsDto,
  BcfProjectDto,
  BcfSelectionResponse,
  BcfTopicDto,
  BcfTopicWriteDto,
  BcfViewpointDto,
  BcfVisibilityResponse,
} from './types.js';

/**
 * `normalizeApiBaseUrl` under its historical BCF name: base-URL cleanup
 * (trailing slash, pasted version segment, query/fragment) is Foundation
 * API-generic, not BCF-specific — see `@ifc-lite/opencde-foundation`.
 */
export { normalizeApiBaseUrl as normalizeBcfBaseUrl } from '@ifc-lite/opencde-foundation';

export interface BcfApiClientOptions extends FoundationApiClientOptions {
  /** Server base URL up to but excluding the version segment, e.g. `https://example.com/bcf`. */
  baseUrl: string;
  /** BCF API version segment; defaults to '2.1'. */
  version?: string;
}

/** OData-style query options of the BCF API topics collection. */
export interface TopicQueryOptions {
  filter?: string;
  orderby?: string;
  top?: number;
  skip?: number;
}

/**
 * Typed client for the buildingSMART BCF API (OpenCDE) REST services.
 * Implements the BCF API 2.1 routes; the `version` option exists because
 * 3.0 servers share these shapes and paths for everything the client uses.
 *
 * Extends `FoundationApiClient`: URL building, Bearer token injection, and
 * error mapping, plus `getVersions`/`getAuthInfo`/`getCurrentUser`, are the
 * Foundation API's own and are inherited rather than reimplemented here.
 */
export class BcfApiClient extends FoundationApiClient {
  constructor(options: BcfApiClientOptions) {
    super({ ...options, version: options.version ?? '2.1', errorLabel: 'BCF', errorNamespace: 'Bcf' });
  }

  // -- Projects --------------------------------------------------------------

  getProjects(): Promise<BcfProjectDto[]> {
    return this.requestJsonAt<BcfProjectDto[]>('/projects');
  }

  getProject(projectId: string): Promise<BcfProjectDto> {
    return this.requestJsonAt<BcfProjectDto>(`/projects/${encodeURIComponent(projectId)}`);
  }

  getExtensions(projectId: string): Promise<BcfExtensionsDto> {
    return this.requestJsonAt<BcfExtensionsDto>(
      `/projects/${encodeURIComponent(projectId)}/extensions`,
    );
  }

  // -- Topics ----------------------------------------------------------------

  getTopics(projectId: string, options: TopicQueryOptions = {}): Promise<BcfTopicDto[]> {
    return this.requestJsonAt<BcfTopicDto[]>(`/projects/${encodeURIComponent(projectId)}/topics`, {
      query: {
        $filter: options.filter,
        $orderby: options.orderby,
        $top: options.top,
        $skip: options.skip,
      },
    });
  }

  getTopic(projectId: string, topicGuid: string): Promise<BcfTopicDto> {
    return this.requestJsonAt<BcfTopicDto>(this.topicPath(projectId, topicGuid));
  }

  createTopic(projectId: string, topic: BcfTopicWriteDto): Promise<BcfTopicDto> {
    return this.requestJsonAt<BcfTopicDto>(`/projects/${encodeURIComponent(projectId)}/topics`, {
      method: 'POST',
      body: topic,
    });
  }

  updateTopic(
    projectId: string,
    topicGuid: string,
    topic: BcfTopicWriteDto,
  ): Promise<BcfTopicDto> {
    return this.requestJsonAt<BcfTopicDto>(this.topicPath(projectId, topicGuid), {
      method: 'PUT',
      body: topic,
    });
  }

  // -- Comments --------------------------------------------------------------

  getComments(projectId: string, topicGuid: string): Promise<BcfCommentDto[]> {
    return this.requestJsonAt<BcfCommentDto[]>(`${this.topicPath(projectId, topicGuid)}/comments`);
  }

  createComment(
    projectId: string,
    topicGuid: string,
    comment: BcfCommentWriteDto,
  ): Promise<BcfCommentDto> {
    return this.requestJsonAt<BcfCommentDto>(`${this.topicPath(projectId, topicGuid)}/comments`, {
      method: 'POST',
      body: comment,
    });
  }

  // -- Viewpoints ------------------------------------------------------------

  getViewpoints(projectId: string, topicGuid: string): Promise<BcfViewpointDto[]> {
    return this.requestJsonAt<BcfViewpointDto[]>(
      `${this.topicPath(projectId, topicGuid)}/viewpoints`,
    );
  }

  getViewpoint(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string,
  ): Promise<BcfViewpointDto> {
    return this.requestJsonAt<BcfViewpointDto>(
      this.viewpointPath(projectId, topicGuid, viewpointGuid),
    );
  }

  createViewpoint(
    projectId: string,
    topicGuid: string,
    viewpoint: BcfViewpointDto,
  ): Promise<BcfViewpointDto> {
    return this.requestJsonAt<BcfViewpointDto>(
      `${this.topicPath(projectId, topicGuid)}/viewpoints`,
      { method: 'POST', body: viewpoint },
    );
  }

  getViewpointSelection(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string,
  ): Promise<BcfSelectionResponse> {
    return this.requestJsonAt<BcfSelectionResponse>(
      `${this.viewpointPath(projectId, topicGuid, viewpointGuid)}/selection`,
    );
  }

  getViewpointColoring(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string,
  ): Promise<BcfColoringResponse> {
    return this.requestJsonAt<BcfColoringResponse>(
      `${this.viewpointPath(projectId, topicGuid, viewpointGuid)}/coloring`,
    );
  }

  getViewpointVisibility(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string,
  ): Promise<BcfVisibilityResponse> {
    return this.requestJsonAt<BcfVisibilityResponse>(
      `${this.viewpointPath(projectId, topicGuid, viewpointGuid)}/visibility`,
    );
  }

  /** Snapshot image (PNG/JPEG) of a viewpoint, as served by the server. */
  async getViewpointSnapshot(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string,
  ): Promise<Blob> {
    const response = await this.send(
      `${this.viewpointPath(projectId, topicGuid, viewpointGuid)}/snapshot`,
      {},
    );
    return response.blob();
  }

  private topicPath(projectId: string, topicGuid: string): string {
    return `/projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(topicGuid)}`;
  }

  private viewpointPath(projectId: string, topicGuid: string, viewpointGuid: string): string {
    return `${this.topicPath(projectId, topicGuid)}/viewpoints/${encodeURIComponent(viewpointGuid)}`;
  }
}
