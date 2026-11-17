/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Paging through a project's topics collection. Two strategies:
 *
 * - `skip` (default): OData `$top` + `$skip` offset paging, per the BCF API.
 * - `modified-date`: keyset paging on `modified_date`, for servers that
 *   ignore `$skip` but honour `$filter`/`$orderby` on that field (buildagil's
 *   openCDE API). Timestamps there have second precision, so the boundary
 *   filter is inclusive (`ge`) and ties that come back again are deduped.
 */

import type { BcfApiClient } from './client.js';
import type { FetchProjectOptions } from './sync.js';
import type { BcfTopicDto } from './types.js';

/** ISO 8601 date-time with an explicit offset, e.g. `2026-11-02T06:43:37Z`. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Accumulates topics across pages: dedupe by guid, enforce maxTopics. */
class TopicCollector {
  readonly topics: BcfTopicDto[] = [];
  private readonly seen = new Set<string>();
  skippedNoGuid = 0;
  truncated = false;

  constructor(private readonly maxTopics: number) {}

  /** Adds one page; returns how many topics in it were not seen before. */
  addPage(batch: readonly BcfTopicDto[]): number {
    let fresh = 0;
    for (const topic of batch) {
      // A guid-less topic can't be keyed, deduped, or addressed by any later
      // request; deduping on `undefined` would silently collapse them all.
      if (typeof topic.guid !== 'string' || topic.guid.length === 0) {
        this.skippedNoGuid += 1;
        continue;
      }
      if (this.seen.has(topic.guid)) continue;
      this.seen.add(topic.guid);
      fresh += 1;
      if (this.topics.length < this.maxTopics) {
        this.topics.push(topic);
      } else {
        this.truncated = true;
      }
    }
    return fresh;
  }
}

interface PagingContext {
  client: BcfApiClient;
  projectId: string;
  options: FetchProjectOptions;
  pageSize: number;
  collector: TopicCollector;
  warnings: string[];
}

/** Shared per-page bookkeeping; returns true when paging must stop. */
function finishPage(context: PagingContext, maxTopics: number): boolean {
  context.options.onProgress?.({ phase: 'topics', loaded: context.collector.topics.length });
  if (context.collector.truncated) {
    context.warnings.push(`Topic list truncated at ${maxTopics} topics (server has more)`);
    return true;
  }
  return false;
}

async function pageBySkip(context: PagingContext, maxTopics: number): Promise<void> {
  const { client, projectId, options, pageSize, collector } = context;
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
    const fresh = collector.addPage(batch);
    if (finishPage(context, maxTopics)) return;
    // A server that ignores $top/$skip returns the same page forever; the
    // fresh-count guard turns that into a single-page fetch instead of a loop.
    if (batch.length < pageSize || fresh === 0) return;
    skip = page * pageSize;
  }
}

function keysetFilter(callerFilter: string | undefined, cursor: string | undefined): string | undefined {
  if (cursor === undefined) return callerFilter;
  const boundary = `modified_date ge ${cursor}`;
  return callerFilter ? `(${callerFilter}) and ${boundary}` : boundary;
}

/** The cursor a full page hands to the next one, or undefined when unusable. */
function nextCursor(batch: readonly BcfTopicDto[]): string | undefined {
  const last = batch[batch.length - 1]?.modified_date;
  if (typeof last !== 'string' || !ISO_TIMESTAMP.test(last)) return undefined;
  return Number.isFinite(Date.parse(last)) ? last : undefined;
}

async function pageByModifiedDate(context: PagingContext, maxTopics: number): Promise<void> {
  const { client, projectId, options, pageSize, collector, warnings } = context;
  let cursor: string | undefined;
  for (;;) {
    const batch = await client.getTopics(projectId, {
      filter: keysetFilter(options.filter, cursor),
      orderby: 'modified_date asc',
      top: pageSize,
    });
    const fresh = collector.addPage(batch);
    if (finishPage(context, maxTopics)) return;
    if (batch.length < pageSize) return;
    if (fresh === 0) {
      warnings.push(
        `Topic list may be incomplete: a full page of ${pageSize} topics at modified_date ` +
          `${cursor ?? '(first page)'} brought nothing new (more topics share one timestamp ` +
          'than fit a page, or the server ignores the filter); raise pageSize to page past it',
      );
      return;
    }
    const next = nextCursor(batch);
    if (next === undefined) {
      const guid = batch[batch.length - 1]?.guid ?? '(unknown)';
      warnings.push(
        `Topic list may be incomplete: topic ${guid} has no parseable modified_date, ` +
          'so modified-date paging cannot continue past it',
      );
      return;
    }
    cursor = next;
  }
}

/**
 * Fetch every topic of a project (up to `maxTopics`) with the paging strategy
 * selected by `options.topicPaging`, deduped by guid.
 */
export async function fetchAllTopics(
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
  const paging = options.topicPaging ?? 'skip';
  if (paging !== 'skip' && paging !== 'modified-date') {
    throw new RangeError(`Unknown topicPaging '${String(paging)}'`);
  }
  if (paging === 'modified-date' && options.orderby !== undefined) {
    throw new RangeError(
      "orderby cannot be combined with topicPaging 'modified-date' (it orders by modified_date asc)",
    );
  }
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 100));
  const maxTopics = options.maxTopics ?? 1000;
  const collector = new TopicCollector(maxTopics);
  const context: PagingContext = { client, projectId, options, pageSize, collector, warnings };
  if (paging === 'modified-date') {
    await pageByModifiedDate(context, maxTopics);
  } else {
    await pageBySkip(context, maxTopics);
  }
  if (collector.skippedNoGuid > 0) {
    warnings.push(`Skipped ${collector.skippedNoGuid} topic(s) the server sent without a guid`);
  }
  return collector.topics;
}
