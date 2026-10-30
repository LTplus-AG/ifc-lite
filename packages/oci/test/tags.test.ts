/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { OciClient, OciError, parseReference } from '../src/index.js';
import { closeAll, registry, startServer, type FakeServer } from './fake-registry.js';

afterEach(closeAll);

const insecure = ['127.0.0.1'];

function repo(server: FakeServer) {
  return parseReference(`${server.host}/team/model`, { insecureHosts: insecure });
}

async function failure(promise: Promise<unknown>): Promise<OciError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OciError);
    return err as OciError;
  }
  throw new Error('expected the call to reject');
}

/** Three pages linked GHCR-style with relative `Link` URLs. */
const PAGED = {
  '/v2/team/model/tags/list': {
    headers: { link: '</v2/team/model/tags/list?last=b&n=2>; rel="next"' },
    body: JSON.stringify({ name: 'team/model', tags: ['a', 'b'] }),
  },
  '/v2/team/model/tags/list?last=b&n=2': {
    headers: { link: '</v2/team/model/tags/list?last=d&n=2>; rel="next"' },
    body: JSON.stringify({ name: 'team/model', tags: ['c', 'd'] }),
  },
  '/v2/team/model/tags/list?last=d&n=2': { body: JSON.stringify({ name: 'team/model', tags: ['e'] }) },
};

describe('tags', () => {
  it('follows relative Link pagination to the end', async () => {
    const reg = await startServer(registry({ routes: PAGED }));
    const tags = await new OciClient({ insecureHosts: insecure }).tags(repo(reg));
    expect(tags).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(reg.requests.map((r) => r.url)).toEqual([
      '/v2/team/model/tags/list',
      '/v2/team/model/tags/list?last=b&n=2',
      '/v2/team/model/tags/list?last=d&n=2',
    ]);
  });

  it('stops with PROTOCOL past maxPages', async () => {
    const reg = await startServer(registry({ routes: PAGED }));
    const err = await failure(new OciClient({ insecureHosts: insecure }).tags(repo(reg), { maxPages: 2 }));
    expect(err.code).toBe('PROTOCOL');
    expect(err.message).toMatch(/more than 2 pages/);
    expect(reg.requests).toHaveLength(2);
  });

  it('rejects a Link next pointing at another origin without requesting it', async () => {
    const other = await startServer(registry({ routes: PAGED }));
    const reg = await startServer(
      registry({
        routes: {
          '/v2/team/model/tags/list': {
            headers: { link: `<${other.origin}/v2/team/model/tags/list?last=b>; rel="next"` },
            body: JSON.stringify({ tags: ['a'] }),
          },
        },
      }),
    );
    const err = await failure(new OciClient({ insecureHosts: insecure }).tags(repo(reg)));
    expect(err.code).toBe('PROTOCOL');
    expect(err.message).toMatch(/another origin/);
    expect(other.requests).toHaveLength(0);
  });

  it('rejects a Link loop', async () => {
    const reg = await startServer(
      registry({
        routes: {
          '/v2/team/model/tags/list': {
            headers: { link: '</v2/team/model/tags/list>; rel="next"' },
            body: JSON.stringify({ tags: ['a'] }),
          },
        },
      }),
    );
    expect((await failure(new OciClient({ insecureHosts: insecure }).tags(repo(reg)))).message).toMatch(/revisits/);
  });

  it('treats "tags": null as no tags', async () => {
    const reg = await startServer(registry({ routes: { '/v2/team/model/tags/list': { body: '{"name":"team/model","tags":null}' } } }));
    expect(await new OciClient({ insecureHosts: insecure }).tags(repo(reg))).toEqual([]);
  });

  it('maps 404 to NOT_FOUND', async () => {
    const reg = await startServer(registry({ routes: {} }));
    const err = await failure(new OciClient({ insecureHosts: insecure }).tags(repo(reg)));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.status).toBe(404);
  });

  it('refuses an http origin unless its host is insecure, before any request', async () => {
    const reg = await startServer(registry({ routes: PAGED }));
    const err = await failure(new OciClient().tags(repo(reg)));
    expect(err.code).toBe('INVALID_REFERENCE');
    expect(err.message).toMatch(/plain http/);
    expect(reg.requests).toHaveLength(0);
  });

  it('reports a refused connection as NETWORK with the CORS hint', async () => {
    const reg = await startServer(registry({ routes: PAGED }));
    const target = repo(reg);
    await reg.close();
    const err = await failure(new OciClient({ insecureHosts: insecure }).tags(target));
    expect(err.code).toBe('NETWORK');
    expect(err.message).toMatch(/CORS/);
  });

  it('passes a caller abort through untouched', async () => {
    const reg = await startServer(registry({ routes: PAGED }));
    const controller = new AbortController();
    controller.abort();
    await expect(new OciClient({ insecureHosts: insecure }).tags(repo(reg), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
