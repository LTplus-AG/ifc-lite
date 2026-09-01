/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BcfApiError, extractErrorDetail } from './errors.js';
import type {
  BcfApiVersion,
  BcfAuthInfo,
  BcfColoringResponse,
  BcfCommentDto,
  BcfCommentWriteDto,
  BcfCurrentUser,
  BcfExtensionsDto,
  BcfProjectDto,
  BcfSelectionResponse,
  BcfTokenProvider,
  BcfTopicDto,
  BcfTopicWriteDto,
  BcfViewpointDto,
  BcfVisibilityResponse,
  FetchLike,
} from './types.js';

export interface BcfApiClientOptions {
  /**
   * Server base URL up to but excluding the version segment, e.g.
   * `https://example.com/bcf`. Run user input through
   * {@link normalizeBcfBaseUrl} first to tolerate trailing slashes and
   * pasted version suffixes.
   */
  baseUrl: string;
  /** BCF API version segment; defaults to '2.1'. */
  version?: string;
  /** Supplies the Bearer token per request; omit for anonymous servers. */
  getAccessToken?: BcfTokenProvider;
  /** Injectable fetch, for tests and non-browser hosts. */
  fetchFn?: FetchLike;
}

/** OData-style query options of the BCF API topics collection. */
export interface TopicQueryOptions {
  filter?: string;
  orderby?: string;
  top?: number;
  skip?: number;
}

/**
 * Strip whitespace, trailing slashes, and an accidentally pasted version
 * segment ('/2.1', '/3.0') from a user-entered BCF server URL, so
 * `https://host/bcf/2.1/` and `https://host/bcf` configure the same client.
 */
export function normalizeBcfBaseUrl(input: string): string {
  let url = input.trim();
  while (url.endsWith('/')) url = url.slice(0, -1);
  const versionSuffix = /\/(\d+\.\d+)$/.exec(url);
  if (versionSuffix) url = url.slice(0, -versionSuffix[0].length);
  return url;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/**
 * Typed client for the buildingSMART BCF API (OpenCDE) REST services.
 * Implements the BCF API 2.1 routes; the `version` option exists because
 * 3.0 servers share these shapes and paths for everything the client uses.
 */
export class BcfApiClient {
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly getAccessToken?: BcfTokenProvider;
  private readonly fetchFn: FetchLike;

  constructor(options: BcfApiClientOptions) {
    this.baseUrl = normalizeBcfBaseUrl(options.baseUrl);
    this.version = options.version ?? '2.1';
    this.getAccessToken = options.getAccessToken;
    if (options.fetchFn) {
      this.fetchFn = options.fetchFn;
    } else if (typeof fetch === 'function') {
      // Browsers throw "Illegal invocation" when fetch is called unbound.
      this.fetchFn = (input, init) => fetch(input, init);
    } else {
      throw new Error('No fetch implementation available; pass fetchFn explicitly.');
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    // `/versions` sits beside the version segment, not under it (BCF API §2.1).
    const prefix = path === '/versions' ? this.baseUrl : `${this.baseUrl}/${this.version}`;
    const url = new URL(`${prefix}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = await this.getAccessToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await this.fetchFn(url, {
      method: options.method ?? 'GET',
      headers,
      body,
    });
    if (!response.ok) {
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        // Non-JSON error body; the status line is all we can report.
        parsed = undefined;
      }
      const detail = extractErrorDetail(parsed);
      throw new BcfApiError(detail ?? `BCF request failed (HTTP ${response.status})`, {
        status: response.status,
        url,
        detail,
      });
    }
    return response;
  }

  private async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options);
    return (await response.json()) as T;
  }

  // -- Discovery & identity --------------------------------------------------

  async getVersions(): Promise<BcfApiVersion[]> {
    const result = await this.requestJson<{ versions?: BcfApiVersion[] }>('/versions');
    return result.versions ?? [];
  }

  getAuthInfo(): Promise<BcfAuthInfo> {
    return this.requestJson<BcfAuthInfo>('/auth');
  }

  getCurrentUser(): Promise<BcfCurrentUser> {
    return this.requestJson<BcfCurrentUser>('/current-user');
  }

  // -- Projects --------------------------------------------------------------

  getProjects(): Promise<BcfProjectDto[]> {
    return this.requestJson<BcfProjectDto[]>('/projects');
  }

  getProject(projectId: string): Promise<BcfProjectDto> {
    return this.requestJson<BcfProjectDto>(`/projects/${encodeURIComponent(projectId)}`);
  }

  getExtensions(projectId: string): Promise<BcfExtensionsDto> {
    return this.requestJson<BcfExtensionsDto>(
      `/projects/${encodeURIComponent(projectId)}/extensions`,
    );
  }

  // -- Topics ----------------------------------------------------------------

  getTopics(projectId: string, options: TopicQueryOptions = {}): Promise<BcfTopicDto[]> {
    return this.requestJson<BcfTopicDto[]>(`/projects/${encodeURIComponent(projectId)}/topics`, {
      query: {
        $filter: options.filter,
        $orderby: options.orderby,
        $top: options.top,
        $skip: options.skip,
      },
    });
  }

  getTopic(projectId: string, topicGuid: string): Promise<BcfTopicDto> {
    return this.requestJson<BcfTopicDto>(this.topicPath(projectId, topicGuid));
  }

  createTopic(projectId: string, topic: BcfTopicWriteDto): Promise<BcfTopicDto> {
    return this.requestJson<BcfTopicDto>(`/projects/${encodeURIComponent(projectId)}/topics`, {
      method: 'POST',
      body: topic,
    });
  }

  updateTopic(
    projectId: string,
    topicGuid: string,
    topic: BcfTopicWriteDto,
  ): Promise<BcfTopicDto> {
    return this.requestJson<BcfTopicDto>(this.topicPath(projectId, topicGuid), {
      method: 'PUT',
      body: topic,
    });
  }

  // -- Comments --------------------------------------------------------------

  getComments(projectId: string, topicGuid: string): Promise<BcfCommentDto[]> {
    return this.requestJson<BcfCommentDto[]>(`${this.topicPath(projectId, topicGuid)}/comments`);
  }

  createComment(
    projectId: string,
    topicGuid: string,
    comment: BcfCommentWriteDto,
  ): Promise<BcfCommentDto> {
    return this.requestJson<BcfCommentDto>(`${this.topicPath(projectId, topicGuid)}/comments`, {
      method: 'POST',
      body: comment,
    });
  }

  // -- Viewpoints ------------------------------------------------------------

  getViewpoints(projectId: string, topicGuid: string): Promise<BcfViewpointDto[]> {
    return this.requestJson<BcfViewpointDto[]>(
      `${this.topicPath(projectId, topicGuid)}/viewpoints`,
    );
  }

  getViewpoint(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string,
  ): Promise<BcfViewpointDto> {
    return this.requestJson<BcfViewpointDto>(
      this.viewpointPath(projectId, topicGuid, viewpointGuid),
    );
  }

  createViewpoint(
    projectId: string,
    topicGuid: string,
    viewpoint: BcfViewpointDto,
  ): Promise<BcfViewpointDto> {
    return this.requestJson<BcfViewpointDto>(
      `${this.topicPath(projectId, topicGuid)}/viewpoints`,
      { method: 'POST', body: viewpoint },
    );
  }

  getViewpointSelection(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string,
  ): Promise<BcfSelectionResponse> {
    return this.requestJson<BcfSelectionResponse>(
      `${this.viewpointPath(projectId, topicGuid, viewpointGuid)}/selection`,
    );
  }

  getViewpointColoring(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string,
  ): Promise<BcfColoringResponse> {
    return this.requestJson<BcfColoringResponse>(
      `${this.viewpointPath(projectId, topicGuid, viewpointGuid)}/coloring`,
    );
  }

  getViewpointVisibility(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string,
  ): Promise<BcfVisibilityResponse> {
    return this.requestJson<BcfVisibilityResponse>(
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
