/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { BcfApiClient } from './client.js';
import { fetchProjectAsBCF } from './sync.js';
import type { BcfTopicDto, FetchLike } from './types.js';

interface FakeServerOptions {
  topics: BcfTopicDto[];
  /** When true the server returns the full topic list regardless of paging. */
  ignorePaging?: boolean;
  /** Viewpoint guids whose snapshot endpoint should fail. */
  brokenSnapshots?: string[];
  /** HTTP status for broken snapshots; defaults to 404. */
  brokenSnapshotStatus?: number;
  /** Topic guids whose /comments endpoint fails with this HTTP status. */
  brokenComments?: { guids: string[]; status: number };
  /** When set, every /selection subresource fails with this HTTP status. */
  brokenSelectionStatus?: number;
  /** When set, every /coloring subresource fails with this HTTP status. */
  brokenColoringStatus?: number;
}

/** Minimal in-memory BCF 2.1 server: one project, one viewpoint per topic. */
function fakeBcfServer(options: FakeServerOptions): FetchLike {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  return async (rawUrl) => {
    const url = new URL(rawUrl);
    const path = url.pathname;
    if (path.endsWith('/projects/p1')) return json({ project_id: 'p1', name: 'Fake project' });
    if (path.endsWith('/extensions')) return json({ topic_status: ['Open', 'Closed'] });
    if (path.endsWith('/topics')) {
      if (options.ignorePaging) return json(options.topics);
      const top = Number(url.searchParams.get('$top') ?? options.topics.length);
      const skip = Number(url.searchParams.get('$skip') ?? 0);
      return json(options.topics.slice(skip, skip + top));
    }
    if (path.endsWith('/comments')) {
      const topicGuid = /topics\/([^/]+)\/comments$/.exec(path)?.[1];
      if (topicGuid && options.brokenComments?.guids.includes(topicGuid)) {
        return json({ message: 'comments broken' }, options.brokenComments.status);
      }
      return json([
        { guid: `comment-${topicGuid}`, author: 'alice@example.com', comment: `on ${topicGuid}` },
      ]);
    }
    if (path.endsWith('/viewpoints')) {
      const topicGuid = /topics\/([^/]+)\/viewpoints$/.exec(path)?.[1];
      return json([
        {
          guid: `vp-${topicGuid}`,
          snapshot: { snapshot_type: 'png' },
          perspective_camera: {
            camera_view_point: { x: 1, y: 2, z: 3 },
            camera_direction: { x: 0, y: 1, z: 0 },
            camera_up_vector: { x: 0, y: 0, z: 1 },
            field_of_view: 60,
          },
        },
      ]);
    }
    if (path.endsWith('/selection')) {
      if (options.brokenSelectionStatus) {
        return json({ message: 'selection broken' }, options.brokenSelectionStatus);
      }
      return json({ selection: [{ ifc_guid: 'guid_selection_000000A' }] });
    }
    if (path.endsWith('/coloring')) {
      if (options.brokenColoringStatus) {
        return json({ message: 'coloring broken' }, options.brokenColoringStatus);
      }
      return json({ coloring: [] });
    }
    if (path.endsWith('/visibility')) return json({ visibility: { default_visibility: true } });
    if (path.endsWith('/snapshot')) {
      const viewpointGuid = /viewpoints\/([^/]+)\/snapshot$/.exec(path)?.[1];
      if (viewpointGuid && options.brokenSnapshots?.includes(viewpointGuid)) {
        return json({ message: 'snapshot missing' }, options.brokenSnapshotStatus ?? 404);
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }
    return json({ message: `unhandled path ${path}` }, 500);
  };
}

function makeTopics(count: number): BcfTopicDto[] {
  return Array.from({ length: count }, (_, i) => ({
    guid: `topic-${i}`,
    title: `Topic ${i}`,
    topic_status: 'Open',
    creation_date: '2026-08-01T10:00:00Z',
    creation_author: 'alice@example.com',
  }));
}

function makeClient(fetchFn: FetchLike): BcfApiClient {
  return new BcfApiClient({ baseUrl: 'https://host/bcf', fetchFn });
}

describe('fetchProjectAsBCF', () => {
  it('assembles a complete BCFProject: metadata, extensions, topics, comments, viewpoints, snapshots', async () => {
    const client = makeClient(fakeBcfServer({ topics: makeTopics(3) }));
    const { project, warnings } = await fetchProjectAsBCF(client, 'p1');
    expect(warnings).toEqual([]);
    expect(project.version).toBe('2.1');
    expect(project.projectId).toBe('p1');
    expect(project.name).toBe('Fake project');
    expect(project.extensions?.topicStatuses).toEqual(['Open', 'Closed']);
    expect(project.topics.size).toBe(3);
    const topic = project.topics.get('topic-1');
    expect(topic?.title).toBe('Topic 1');
    expect(topic?.comments).toHaveLength(1);
    expect(topic?.comments[0].comment).toBe('on topic-1');
    expect(topic?.viewpoints).toHaveLength(1);
    const viewpoint = topic?.viewpoints[0];
    expect(viewpoint?.perspectiveCamera?.fieldOfView).toBe(60);
    expect(viewpoint?.components?.selection?.[0].ifcGuid).toBe('guid_selection_000000A');
    expect(viewpoint?.snapshot).toMatch(/^data:image\/png;base64,/);
  });

  it('pages through the topics collection with $top/$skip', async () => {
    const requests: string[] = [];
    const server = fakeBcfServer({ topics: makeTopics(5) });
    const client = makeClient(async (url, init) => {
      if (url.includes('/topics?')) requests.push(url);
      return server(url, init);
    });
    const { project } = await fetchProjectAsBCF(client, 'p1', {
      pageSize: 2,
      includeSnapshots: false,
    });
    expect(project.topics.size).toBe(5);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain('%24skip=2');
    expect(requests[2]).toContain('%24skip=4');
  });

  it('terminates against a server that ignores paging parameters', async () => {
    // 2 topics with pageSize 2 look like a full page; without the fresh-guid
    // guard the second identical page would loop forever.
    const client = makeClient(fakeBcfServer({ topics: makeTopics(2), ignorePaging: true }));
    const { project } = await fetchProjectAsBCF(client, 'p1', {
      pageSize: 2,
      includeSnapshots: false,
    });
    expect(project.topics.size).toBe(2);
  });

  it('truncates at maxTopics with a warning instead of pulling unbounded', async () => {
    const client = makeClient(fakeBcfServer({ topics: makeTopics(10) }));
    const { project, warnings } = await fetchProjectAsBCF(client, 'p1', {
      pageSize: 2,
      maxTopics: 4,
      includeSnapshots: false,
    });
    expect(project.topics.size).toBe(4);
    expect(warnings.some((w) => w.includes('truncated at 4'))).toBe(true);
  });

  it('enforces maxTopics even when a single page exceeds it', async () => {
    const client = makeClient(fakeBcfServer({ topics: makeTopics(10) }));
    const { project, warnings } = await fetchProjectAsBCF(client, 'p1', {
      pageSize: 10,
      maxTopics: 3,
      includeSnapshots: false,
    });
    expect(project.topics.size).toBe(3);
    expect(warnings.some((w) => w.includes('truncated at 3'))).toBe(true);
  });

  it('does not warn about truncation when the server has exactly maxTopics topics', async () => {
    const client = makeClient(fakeBcfServer({ topics: makeTopics(4) }));
    const { project, warnings } = await fetchProjectAsBCF(client, 'p1', {
      pageSize: 2,
      maxTopics: 4,
      includeSnapshots: false,
    });
    expect(project.topics.size).toBe(4);
    expect(warnings).toEqual([]);
  });

  it('skips guid-less topics with a warning instead of collapsing them', async () => {
    const topics = makeTopics(2);
    const noGuid: BcfTopicDto = { guid: '', title: 'broken A' };
    const noGuid2: BcfTopicDto = { guid: '', title: 'broken B' };
    const client = makeClient(fakeBcfServer({ topics: [topics[0], noGuid, noGuid2, topics[1]] }));
    const { project, warnings } = await fetchProjectAsBCF(client, 'p1', {
      includeSnapshots: false,
    });
    expect(project.topics.size).toBe(2);
    expect([...project.topics.keys()]).toEqual(['topic-0', 'topic-1']);
    expect(warnings.some((w) => w.includes('Skipped 2 topic(s)'))).toBe(true);
  });

  it('degrades one topic\'s failed details to a warning and keeps the rest of the pull', async () => {
    const client = makeClient(
      fakeBcfServer({ topics: makeTopics(3), brokenComments: { guids: ['topic-1'], status: 500 } }),
    );
    const { project, warnings } = await fetchProjectAsBCF(client, 'p1', {
      includeSnapshots: false,
    });
    expect(project.topics.size).toBe(3);
    // The broken topic keeps its listed metadata, just without details.
    expect(project.topics.get('topic-1')?.comments).toEqual([]);
    expect(project.topics.get('topic-0')?.comments).toHaveLength(1);
    expect(warnings.some((w) => w.includes('Details unavailable for topic topic-1'))).toBe(true);
  });

  it('still fails the whole pull when topic details fail with 401 (expired session)', async () => {
    const client = makeClient(
      fakeBcfServer({ topics: makeTopics(3), brokenComments: { guids: ['topic-1'], status: 401 } }),
    );
    await expect(
      fetchProjectAsBCF(client, 'p1', { includeSnapshots: false }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('fails the whole pull when viewpoint components fail with 401, but warns on a 500', async () => {
    // 401 anywhere means the session died; only genuine per-item failures warn.
    await expect(
      fetchProjectAsBCF(
        makeClient(fakeBcfServer({ topics: makeTopics(1), brokenSelectionStatus: 401 })),
        'p1',
        { includeSnapshots: false },
      ),
    ).rejects.toMatchObject({ status: 401 });
    const { warnings } = await fetchProjectAsBCF(
      makeClient(fakeBcfServer({ topics: makeTopics(1), brokenSelectionStatus: 500 })),
      'p1',
      { includeSnapshots: false },
    );
    expect(warnings).toHaveLength(1);
  });

  it('does not let a concurrent 500 mask a 401 among the component subresources', async () => {
    // With Promise.all, whichever rejection settles first would be the only
    // one seen; a fast 500 could bury the session-expiry 401.
    await expect(
      fetchProjectAsBCF(
        makeClient(
          fakeBcfServer({
            topics: makeTopics(1),
            brokenSelectionStatus: 500,
            brokenColoringStatus: 401,
          }),
        ),
        'p1',
        { includeSnapshots: false },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('fails the whole pull when a snapshot fails with 401 (unlike a missing snapshot)', async () => {
    await expect(
      fetchProjectAsBCF(
        makeClient(
          fakeBcfServer({
            topics: makeTopics(1),
            brokenSnapshots: ['vp-topic-0'],
            brokenSnapshotStatus: 401,
          }),
        ),
        'p1',
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects maxTopics values that are fractional or negative', async () => {
    const client = makeClient(fakeBcfServer({ topics: makeTopics(5) }));
    await expect(
      fetchProjectAsBCF(client, 'p1', { maxTopics: 1.5, includeSnapshots: false }),
    ).rejects.toThrow('maxTopics must be a non-negative integer');
    await expect(
      fetchProjectAsBCF(client, 'p1', { maxTopics: -1, includeSnapshots: false }),
    ).rejects.toThrow('maxTopics must be a non-negative integer');
  });

  it('degrades a failed snapshot to a warning and keeps the viewpoint', async () => {
    const client = makeClient(
      fakeBcfServer({ topics: makeTopics(1), brokenSnapshots: ['vp-topic-0'] }),
    );
    const { project, warnings } = await fetchProjectAsBCF(client, 'p1');
    const viewpoint = project.topics.get('topic-0')?.viewpoints[0];
    expect(viewpoint).toBeDefined();
    expect(viewpoint?.snapshot).toBeUndefined();
    expect(viewpoint?.perspectiveCamera).toBeDefined();
    expect(warnings.some((w) => w.includes('Snapshot unavailable'))).toBe(true);
  });

  it('fails fast when the topics collection itself is unreachable', async () => {
    const client = makeClient(async () =>
      new Response(JSON.stringify({ message: 'Not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(fetchProjectAsBCF(client, 'p1')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('reports progress for topic pages and per-topic details', async () => {
    const phases: string[] = [];
    const client = makeClient(fakeBcfServer({ topics: makeTopics(3) }));
    await fetchProjectAsBCF(client, 'p1', {
      includeSnapshots: false,
      onProgress: (p) => phases.push(`${p.phase}:${p.loaded}${p.total ? `/${p.total}` : ''}`),
    });
    expect(phases).toContain('topics:3');
    expect(phases).toContain('details:3/3');
  });
});
