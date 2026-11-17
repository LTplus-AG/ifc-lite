/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { BcfApiClient } from './client.js';
import { fetchProjectAsBCF } from './sync.js';
import type { BcfTopicDto, FetchLike } from './types.js';

/**
 * Fake of buildagil's topics collection as measured live: `$skip` is ignored;
 * `$top`, `$orderby=modified_date asc|desc` and a `$filter` of
 * `modified_date ge <ts>` (optionally ANDed with `topic_status eq '<s>'`) are
 * honoured. Every other route answers with an empty collection or object.
 */
function skipIgnoringServer(topics: BcfTopicDto[], topicRequests: URL[] = []): FetchLike {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/projects/p1')) return json({ project_id: 'p1', name: 'Fake' });
    if (url.pathname.endsWith('/extensions')) return json({});
    if (!url.pathname.endsWith('/topics')) return json([]);
    topicRequests.push(url);
    const filter = url.searchParams.get('$filter') ?? '';
    const since = /modified_date ge (\S+)/.exec(filter)?.[1];
    const status = /topic_status eq '([^']*)'/.exec(filter)?.[1];
    let result = topics.filter(
      (t) =>
        (since === undefined || Date.parse(t.modified_date ?? '') >= Date.parse(since)) &&
        (status === undefined || t.topic_status === status),
    );
    const orderby = url.searchParams.get('$orderby');
    if (orderby?.startsWith('modified_date')) {
      const sign = orderby.endsWith('desc') ? -1 : 1;
      // Ties come back in an arbitrary but stable order (guid as a string).
      result = [...result].sort(
        (a, b) =>
          sign * (Date.parse(a.modified_date ?? '') - Date.parse(b.modified_date ?? '')) ||
          a.guid.localeCompare(b.guid),
      );
    }
    const top = url.searchParams.get('$top');
    return json(top === null ? result : result.slice(0, Number(top)));
  };
}

/** `count` topics; every three share one second-precision modified_date. */
function makeTopics(count: number, status = (_i: number) => 'Open'): BcfTopicDto[] {
  const base = Date.parse('2026-11-02T06:00:00Z');
  const topics = Array.from({ length: count }, (_, i) => ({
    guid: `topic-${i}`,
    title: `Topic ${i}`,
    topic_status: status(i),
    modified_date: new Date(base + Math.floor(i / 3) * 1000).toISOString().replace('.000Z', 'Z'),
  }));
  // Store order is not modified order, so only $orderby can make it sorted.
  return topics.reverse();
}

function client(fetchFn: FetchLike): BcfApiClient {
  return new BcfApiClient({ baseUrl: 'https://host/bcf', fetchFn });
}

const pull = { includeSnapshots: false, pageSize: 100 } as const;

describe("fetchProjectAsBCF topicPaging 'modified-date'", () => {
  it('returns every topic exactly once when $skip is ignored and ties straddle page boundaries', async () => {
    const topics = makeTopics(250);
    // Indices 99..101 share a timestamp, so the 100-topic page boundary splits a tie.
    expect(new Set(topics.filter((t) => /^topic-(99|100|101)$/.test(t.guid)).map((t) => t.modified_date)).size).toBe(1);
    const requests: URL[] = [];
    const { project, warnings } = await fetchProjectAsBCF(client(skipIgnoringServer(topics, requests)), 'p1', {
      ...pull,
      topicPaging: 'modified-date',
    });
    expect(warnings).toEqual([]);
    expect(project.topics.size).toBe(250);
    expect([...project.topics.keys()].sort()).toEqual(topics.map((t) => t.guid).sort());
    expect(requests.length).toBe(3);
    expect(requests.every((r) => r.searchParams.get('$orderby') === 'modified_date asc')).toBe(true);
    expect(requests.every((r) => !r.searchParams.has('$skip'))).toBe(true);
    expect(requests[0].searchParams.has('$filter')).toBe(false);
    // Page 1 ends at topic-99 (06:00:33Z); the inclusive cursor re-fetches its tie.
    expect(requests[1].searchParams.get('$filter')).toBe('modified_date ge 2026-11-02T06:00:33Z');
  });

  it('combines a caller filter with the keyset boundary instead of dropping it', async () => {
    const topics = makeTopics(250, (i) => (i % 5 === 0 ? 'Closed' : 'Open'));
    const requests: URL[] = [];
    const { project, warnings } = await fetchProjectAsBCF(client(skipIgnoringServer(topics, requests)), 'p1', {
      ...pull,
      pageSize: 50,
      topicPaging: 'modified-date',
      filter: "topic_status eq 'Open'",
    });
    expect(warnings).toEqual([]);
    expect(project.topics.size).toBe(200);
    expect([...project.topics.values()].every((t) => t.topicStatus === 'Open')).toBe(true);
    expect(requests[0].searchParams.get('$filter')).toBe("topic_status eq 'Open'");
    expect(requests[1].searchParams.get('$filter')).toMatch(
      /^\(topic_status eq 'Open'\) and modified_date ge 2026-11-02T06:00:\d\dZ$/,
    );
  });

  it('warns and stops when more topics share one timestamp than fit a page', async () => {
    const topics = Array.from({ length: 5 }, (_, i) => ({
      guid: `same-${i}`,
      modified_date: '2026-11-02T06:43:37Z',
    }));
    const requests: URL[] = [];
    const { project, warnings } = await fetchProjectAsBCF(client(skipIgnoringServer(topics, requests)), 'p1', {
      ...pull,
      pageSize: 2,
      topicPaging: 'modified-date',
    });
    expect(project.topics.size).toBe(2);
    expect(requests.length).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('brought nothing new');
    expect(warnings[0]).toContain('2026-11-02T06:43:37Z');
  });

  it('warns and stops when a full page ends on a topic without a parseable modified_date', async () => {
    const topics: BcfTopicDto[] = [
      { guid: 'dated', modified_date: '2026-11-02T06:43:37Z' },
      { guid: 'undated', modified_date: null },
      { guid: 'later', modified_date: '2026-11-02T07:00:00Z' },
    ];
    // Without $orderby support the store order stands: 'undated' ends page 1.
    const unordered: FetchLike = async (rawUrl, init) => {
      const url = new URL(rawUrl);
      url.searchParams.delete('$orderby');
      return skipIgnoringServer(topics)(url.toString(), init);
    };
    const { project, warnings } = await fetchProjectAsBCF(client(unordered), 'p1', {
      ...pull,
      pageSize: 2,
      topicPaging: 'modified-date',
    });
    expect([...project.topics.keys()]).toEqual(['dated', 'undated']);
    expect(warnings).toEqual([
      'Topic list may be incomplete: topic undated has no parseable modified_date, so modified-date paging cannot continue past it',
    ]);
  });

  it('still truncates at maxTopics with the existing warning', async () => {
    const { project, warnings } = await fetchProjectAsBCF(client(skipIgnoringServer(makeTopics(250))), 'p1', {
      ...pull,
      maxTopics: 150,
      topicPaging: 'modified-date',
    });
    expect(project.topics.size).toBe(150);
    expect(warnings).toEqual(['Topic list truncated at 150 topics (server has more)']);
  });

  it('reports topic progress once per page', async () => {
    const loaded: number[] = [];
    await fetchProjectAsBCF(client(skipIgnoringServer(makeTopics(250))), 'p1', {
      ...pull,
      topicPaging: 'modified-date',
      onProgress: (p) => {
        if (p.phase === 'topics') loaded.push(p.loaded);
      },
    });
    // Page 2 starts at the boundary tie (topic-99 again), so it adds 99 new topics.
    expect(loaded).toEqual([100, 199, 250]);
  });

  it('rejects a caller orderby it could not honour', async () => {
    await expect(
      fetchProjectAsBCF(client(skipIgnoringServer(makeTopics(3))), 'p1', {
        ...pull,
        topicPaging: 'modified-date',
        orderby: 'creation_date desc',
      }),
    ).rejects.toThrow("orderby cannot be combined with topicPaging 'modified-date'");
  });
});

describe("fetchProjectAsBCF topicPaging 'skip' (default)", () => {
  it('keeps today\'s behaviour against a $skip-ignoring server: first page only, no error', async () => {
    const requests: URL[] = [];
    const { project, warnings } = await fetchProjectAsBCF(
      client(skipIgnoringServer(makeTopics(250), requests)),
      'p1',
      pull,
    );
    expect(project.topics.size).toBe(100);
    expect(warnings).toEqual([]);
    expect(requests.length).toBe(2);
    expect(requests[1].searchParams.get('$skip')).toBe('100');
  });
});
