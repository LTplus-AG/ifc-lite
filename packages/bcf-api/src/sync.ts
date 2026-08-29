/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * High-level pull: fetch a whole BCF project (topics, comments, viewpoints,
 * components, snapshots) from a BCF server into an `@ifc-lite/bcf`
 * `BCFProject`, ready for `setBcfProject` in the viewer or `writeBCF` on any
 * host.
 */

import type { BCFExtensions, BCFProject, BCFTopic } from '@ifc-lite/bcf';
import type { BcfApiClient } from './client.js';
import { BcfApiError } from './errors.js';
import {
  componentsFromApi,
  commentFromApi,
  extensionsFromApi,
  topicFromApi,
  viewpointFromApi,
} from './mapping.js';
import type { BcfComponentsDto, BcfTopicDto, BcfViewpointDto } from './types.js';

export interface BcfSyncProgress {
  phase: 'topics' | 'details' | 'snapshots';
  /** Completed units in this phase (topic pages, topics, or snapshots). */
  loaded: number;
  /** Total units when known; topic paging cannot know it up front. */
  total?: number;
}

export interface FetchProjectOptions {
  /** Page size for the topics collection; defaults to 100. */
  pageSize?: number;
  /** Hard cap on fetched topics; defaults to 1000. */
  maxTopics?: number;
  /** Fetch viewpoint snapshot images as data URLs; defaults to true. */
  includeSnapshots?: boolean;
  /** OData `$filter` passed through to the topics collection. */
  filter?: string;
  /** OData `$orderby` passed through to the topics collection. */
  orderby?: string;
  /** Concurrent per-topic detail requests; defaults to 4. */
  concurrency?: number;
  onProgress?: (progress: BcfSyncProgress) => void;
}

export interface BcfProjectFetchResult {
  project: BCFProject;
  /**
   * Non-fatal failures (a viewpoint whose components endpoint errored, a
   * snapshot that would not load). The project is complete except for the
   * listed items; callers surface these instead of failing the whole pull.
   */
  warnings: string[];
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function fetchAllTopics(
  client: BcfApiClient,
  projectId: string,
  options: FetchProjectOptions,
  warnings: string[],
): Promise<BcfTopicDto[]> {
  if (
    options.maxTopics !== undefined &&
    (!Number.isInteger(options.maxTopics) || options.maxTopics < 0)
  ) {
    throw new RangeError('maxTopics must be a non-negative integer');
  }
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 100));
  const maxTopics = options.maxTopics ?? 1000;
  const topics: BcfTopicDto[] = [];
  const seen = new Set<string>();
  let skippedNoGuid = 0;
  let truncated = false;
  let skip = 0;
  let page = 0;
  for (;;) {
    const batch = await client.getTopics(projectId, {
      filter: options.filter,
      orderby: options.orderby,
      top: pageSize,
      skip,
    });
    page += 1;
    let fresh = 0;
    for (const topic of batch) {
      // A guid-less topic can't be keyed, deduped, or addressed by any later
      // request; deduping on `undefined` would silently collapse them all.
      if (typeof topic.guid !== 'string' || topic.guid.length === 0) {
        skippedNoGuid += 1;
        continue;
      }
      if (seen.has(topic.guid)) continue;
      seen.add(topic.guid);
      fresh += 1;
      if (topics.length < maxTopics) {
        topics.push(topic);
      } else {
        truncated = true;
      }
    }
    options.onProgress?.({ phase: 'topics', loaded: topics.length });
    if (truncated) {
      warnings.push(`Topic list truncated at ${maxTopics} topics (server has more)`);
      break;
    }
    // A server that ignores $top/$skip returns the same page forever; the
    // fresh-count guard turns that into a single-page fetch instead of a loop.
    if (batch.length < pageSize || fresh === 0) break;
    skip = page * pageSize;
  }
  if (skippedNoGuid > 0) {
    warnings.push(`Skipped ${skippedNoGuid} topic(s) the server sent without a guid`);
  }
  return topics;
}

async function fetchViewpointComponents(
  client: BcfApiClient,
  projectId: string,
  topicGuid: string,
  viewpoint: BcfViewpointDto,
  warnings: string[],
): Promise<BcfComponentsDto | undefined> {
  // The list form usually inlines nothing; 2.1 serves components through the
  // three subresources. Skip the extra round-trips when the DTO carries them.
  if (viewpoint.components && componentsFromApi(viewpoint.components)) {
    return viewpoint.components;
  }
  // allSettled rather than all: with all, a fast non-auth failure would be
  // the only rejection this code ever sees, masking a concurrent 401 — and
  // an expired session is fatal everywhere (matching fetchTopicDetails),
  // while only genuine per-item failures degrade to warnings.
  const [selectionResult, coloringResult, visibilityResult] = await Promise.allSettled([
    client.getViewpointSelection(projectId, topicGuid, viewpoint.guid),
    client.getViewpointColoring(projectId, topicGuid, viewpoint.guid),
    client.getViewpointVisibility(projectId, topicGuid, viewpoint.guid),
  ]);
  if (
    selectionResult.status === 'rejected' ||
    coloringResult.status === 'rejected' ||
    visibilityResult.status === 'rejected'
  ) {
    const reasons = [selectionResult, coloringResult, visibilityResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    const authFailure = reasons.find(
      (reason) => reason instanceof BcfApiError && reason.isAuthError,
    );
    if (authFailure) throw authFailure;
    const first = reasons[0];
    warnings.push(
      `Components unavailable for viewpoint ${viewpoint.guid}: ${first instanceof Error ? first.message : String(first)}`,
    );
    return undefined;
  }
  return {
    selection: selectionResult.value.selection,
    coloring: coloringResult.value.coloring,
    visibility: visibilityResult.value.visibility,
  };
}

async function fetchTopicDetails(
  client: BcfApiClient,
  projectId: string,
  dto: BcfTopicDto,
  includeSnapshots: boolean,
  warnings: string[],
): Promise<BCFTopic> {
  const topic = topicFromApi(dto);
  let comments;
  let viewpoints;
  try {
    [comments, viewpoints] = await Promise.all([
      client.getComments(projectId, dto.guid),
      client.getViewpoints(projectId, dto.guid),
    ]);
  } catch (error) {
    // An expired session fails every topic the same way — surface that once,
    // loudly. Anything else (topic deleted mid-pull, one flaky 500) keeps the
    // listed metadata and degrades to a warning.
    if (error instanceof BcfApiError && error.isAuthError) throw error;
    warnings.push(
      `Details unavailable for topic ${dto.guid}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return topic;
  }
  topic.comments = comments.map(commentFromApi);
  for (const viewpointDto of viewpoints) {
    const components = await fetchViewpointComponents(
      client,
      projectId,
      dto.guid,
      viewpointDto,
      warnings,
    );
    const viewpoint = viewpointFromApi(viewpointDto, components);
    if (includeSnapshots && viewpointDto.snapshot) {
      try {
        const blob = await client.getViewpointSnapshot(projectId, dto.guid, viewpointDto.guid);
        viewpoint.snapshot = await blobToDataUrl(blob);
      } catch (error) {
        if (error instanceof BcfApiError && error.isAuthError) throw error;
        warnings.push(
          `Snapshot unavailable for viewpoint ${viewpointDto.guid}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    topic.viewpoints.push(viewpoint);
  }
  return topic;
}

/**
 * Pull one project from a BCF server into a `BCFProject`. Fails fast when
 * the topics collection is unreachable or the session expires (401);
 * degrades per-item — with a warning — when an individual topic's details,
 * a viewpoint's components, or a snapshot cannot be fetched.
 */
export async function fetchProjectAsBCF(
  client: BcfApiClient,
  projectId: string,
  options: FetchProjectOptions = {},
): Promise<BcfProjectFetchResult> {
  const warnings: string[] = [];
  const includeSnapshots = options.includeSnapshots ?? true;

  let projectName: string | undefined;
  try {
    projectName = (await client.getProject(projectId)).name ?? undefined;
  } catch (error) {
    warnings.push(
      `Project metadata unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let extensions: BCFExtensions | undefined;
  try {
    extensions = extensionsFromApi(await client.getExtensions(projectId));
  } catch (error) {
    warnings.push(
      `Extensions unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const topicDtos = await fetchAllTopics(client, projectId, options, warnings);

  let detailed = 0;
  const topics = await mapWithConcurrency(
    topicDtos,
    options.concurrency ?? 4,
    async (dto) => {
      const topic = await fetchTopicDetails(client, projectId, dto, includeSnapshots, warnings);
      detailed += 1;
      options.onProgress?.({ phase: 'details', loaded: detailed, total: topicDtos.length });
      return topic;
    },
  );

  const project: BCFProject = {
    version: '2.1',
    projectId,
    name: projectName,
    topics: new Map(topics.map((topic) => [topic.guid, topic])),
    extensions,
  };
  return { project, warnings };
}
