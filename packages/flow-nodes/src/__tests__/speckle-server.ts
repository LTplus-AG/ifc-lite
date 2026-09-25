/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Replays the hand-authored Speckle corpus (`../__fixtures__/speckle/`)
 * through an injected `FetchTransport`, answering the three requests a
 * Speckle server answers for an object loader: `POST /graphql`,
 * `GET /objects/<project>/<object>/single` and `POST /api/getobjects/<project>`
 * (one `id\tjson` line per object). Every request is recorded so tests can
 * assert what was — and was not — fetched.
 */

import { readFileSync } from 'node:fs';
import type { FetchTransport } from '@ifc-lite/sandbox';

const FIXTURES = new URL('../__fixtures__/speckle/', import.meta.url);

export type CorpusObject = Record<string, unknown> & { id: string; speckle_type: string };

export function corpusObjects(): CorpusObject[] {
  return JSON.parse(readFileSync(new URL('objects.json', FIXTURES), 'utf-8')) as CorpusObject[];
}

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf-8');
}

export const CORPUS_PROJECT = 'p5634corpus';
export const CORPUS_HOST = 'speckle.example.com';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface SpeckleServer {
  readonly transport: FetchTransport;
  readonly requests: RecordedRequest[];
  /** Every object id served by `getobjects`, in order. */
  readonly served: string[];
  readonly rootId: string;
}

export function speckleServer(options: { status?: number; extraWallFirst?: boolean } = {}): SpeckleServer {
  const objects = new Map(corpusObjects().map((o) => [o.id, o]));
  const rootId = corpusObjects()[0].id;
  if (options.extraWallFirst) {
    // A wall no earlier receive wrote, inlined ahead of everything else in the root.
    const wall = corpusObjects().find((o) => o.speckle_type.endsWith('RevitWall'));
    const root = objects.get(rootId);
    if (!wall || !root) throw new Error('corpus has no wall or root');
    const extra = { ...wall, id: 'extra0000000000000000000000000000', applicationId: 'extra-wall-5925' };
    objects.set(rootId, { ...root, elements: [extra, ...(root.elements as unknown[])] });
  }
  const requests: RecordedRequest[] = [];
  const served: string[] = [];
  const transport: FetchTransport = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init.body === 'string' ? init.body : undefined;
    requests.push({ method: init.method ?? 'GET', url: url.toString(), headers, body });
    if (options.status !== undefined) return new Response('denied', { status: options.status });
    const path = url.pathname;
    if (path === '/graphql') {
      const query = (JSON.parse(body ?? '{}') as { query?: string }).query ?? '';
      return new Response(fixture(query.includes('versions(') ? 'graphql-latest.json' : 'graphql-version.json'), { status: 200 });
    }
    const single = new RegExp(`^/objects/${CORPUS_PROJECT}/([0-9a-f]+)/single$`).exec(path);
    if (single) {
      const obj = objects.get(single[1]);
      return obj ? new Response(JSON.stringify(obj), { status: 200 }) : new Response('not found', { status: 404 });
    }
    if (path === `/api/getobjects/${CORPUS_PROJECT}`) {
      const ids = JSON.parse((JSON.parse(body ?? '{}') as { objects: string }).objects) as string[];
      const lines = ids.filter((id) => objects.has(id)).map((id) => {
        served.push(id);
        return `${id}\t${JSON.stringify(objects.get(id))}`;
      });
      return new Response(lines.join('\n'), { status: 200 });
    }
    return new Response('no route', { status: 404 });
  };
  return { transport, requests, served, rootId };
}
