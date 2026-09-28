/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// A mocked commit service: the REST contract from this package's README,
// implemented over the commit-aware `@ifc-lite/source-fixture` provider.
//
// Backing it with the fixture rather than with hand-written JSON is what
// makes the round trip worth testing. The fixture is the conformance oracle,
// so a `runCommitConformanceSuite` run against THIS provider is measuring one
// thing only: whether the HTTP layer preserves what the oracle already
// satisfies. A mock that invented its own responses would be asserting
// nothing but that the mock and the client agree.
// ============================================================================

import { isCommitSourceError, type CommitPayloadFormat, type PluginContext } from '@ifc-lite/plugin-api';
import { createFixtureContext, createFixtureSourceProvider, type FixtureSourceProvider } from '@ifc-lite/source-fixture';

import { MEDIA_TYPES } from '../src/index.js';

export const BASE_URL = 'https://commits.example.com/api/v1';
export const ISSUER = 'https://id.example.com';
export const CLIENT_ID = 'ifc-lite-viewer';

const MEDIA_TO_FORMAT = new Map<string, CommitPayloadFormat>(
  Object.entries(MEDIA_TYPES).map(([format, media]) => [media, format as CommitPayloadFormat]),
);

const STATUS_FOR_CODE: Readonly<Record<string, number>> = {
  'not-found': 404,
  forbidden: 403,
  conflict: 409,
  'not-ready': 202,
  'unsupported-format': 415,
  invalid: 400,
  unavailable: 503,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function errorResponse(error: unknown): Response {
  if (isCommitSourceError(error)) {
    return json(
      {
        code: error.code,
        message: error.message,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
      STATUS_FOR_CODE[error.code] ?? 500,
    );
  }
  return json({ code: 'unavailable', message: error instanceof Error ? error.message : String(error) }, 503);
}

/** `undefined` for an absent param, so the fixture sees "not supplied" rather than `''`. */
function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

function numberParam(url: URL, name: string): number | undefined {
  const value = param(url, name);
  return value === undefined ? undefined : Number(value);
}

function page<T>(result: { items: readonly T[]; cursor?: string }): Response {
  return json({ items: result.items, ...(result.cursor !== undefined ? { cursor: result.cursor } : {}) });
}

export interface MockService {
  readonly fetch: typeof fetch;
  readonly fixture: FixtureSourceProvider;
  /** Requests seen, newest last — so a test can assert what the client actually sent. */
  readonly requests: { method: string; url: string; accept: string | null }[];
}

/**
 * Builds the mock. `world` is a fixture world spec; the provider it wraps is
 * built with every commit capability the caller asks for.
 */
export function createMockService(options: {
  readonly world: Parameters<typeof createFixtureSourceProvider>[0]['world'];
  readonly payloadFormats?: readonly CommitPayloadFormat[];
  readonly capabilities?: Parameters<typeof createFixtureSourceProvider>[0]['capabilities'];
}): MockService {
  const fixture = createFixtureSourceProvider({
    world: options.world,
    capabilities: options.capabilities ?? {
      commits: { payloadFormats: options.payloadFormats ?? ['ifc-step', 'ifcx'] },
    },
  });
  const fixtureCtx: PluginContext = createFixtureContext();
  const requests: MockService['requests'] = [];

  const doFetch: typeof fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);
    const method = (init?.method ?? 'GET').toUpperCase();
    const accept = new Headers(init?.headers).get('Accept');
    requests.push({ method, url: rawUrl, accept });

    if (url.origin === ISSUER && url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
      });
    }
    if (url.origin === ISSUER && url.pathname === '/userinfo') {
      return json({ sub: 'user-1', name: 'Conformance User', email: 'user@example.com' });
    }

    const base = new URL(BASE_URL);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      return json({ code: 'not-found', message: `No route for ${rawUrl}` }, 404);
    }
    const path = url.pathname.slice(base.pathname.length);

    try {
      return await route(path, method, url, init);
    } catch (error) {
      return errorResponse(error);
    }
  };

  async function route(path: string, method: string, url: URL, init: RequestInit | undefined): Promise<Response> {
    if (path === '/capabilities') {
      return json({ commits: fixture.manifest.capabilities.commits });
    }
    if (path === '/projects') {
      return page(await fixture.listProjects(fixtureCtx, {
        cursor: param(url, 'cursor'),
        limit: numberParam(url, 'limit'),
        query: param(url, 'query'),
      }));
    }

    const segments = path.split('/').filter((segment) => segment.length > 0).map(decodeURIComponent);
    // /projects/{projectId}/...
    if (segments[0] !== 'projects' || segments[1] === undefined) {
      return json({ code: 'not-found', message: `No route for ${path}` }, 404);
    }
    const projectId = segments[1];

    if (segments[2] === 'commit-events' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { modelIds?: string[]; cursor?: string };
      const models = (body.modelIds ?? []).map((modelId) => ({ projectId, modelId }));
      return json(await fixture.watchCommits!(fixtureCtx, models, body.cursor));
    }
    if (segments[2] !== 'models') {
      return json({ code: 'not-found', message: `No route for ${path}` }, 404);
    }

    if (segments[3] === undefined) {
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { name: string };
        return json(await fixture.createModel!(fixtureCtx, { projectId, name: body.name }));
      }
      return page(await fixture.listModels!(fixtureCtx, projectId, {
        cursor: param(url, 'cursor'),
        limit: numberParam(url, 'limit'),
        query: param(url, 'query'),
      }));
    }

    const ref = { projectId, modelId: segments[3] };
    if (segments[4] === undefined) return json(await fixture.getModel!(fixtureCtx, ref));

    if (segments[4] === 'diff') {
      return json(await fixture.getCommitDiff!(
        fixtureCtx,
        { ...ref, commitId: param(url, 'base')! },
        { ...ref, commitId: param(url, 'head')! },
        { keyProperty: param(url, 'keyProperty') },
      ));
    }
    if (segments[4] === 'identity') {
      const base = { ...ref, commitId: param(url, 'base')! };
      const head = { ...ref, commitId: param(url, 'head')! };
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { entries: [] };
        return json(await fixture.recordIdentity!(fixtureCtx, base, head, body.entries));
      }
      return json(await fixture.listIdentityRecords!(fixtureCtx, base, head));
    }
    if (segments[4] === 'elements' && segments[6] === 'history') {
      return page(await fixture.listElementHistory!(
        fixtureCtx,
        { ...ref, key: segments[5], atCommitId: param(url, 'atCommitId'), keyProperty: param(url, 'keyProperty') },
        { cursor: param(url, 'cursor'), limit: numberParam(url, 'limit') },
      ));
    }
    if (segments[4] !== 'commits') {
      return json({ code: 'not-found', message: `No route for ${path}` }, 404);
    }

    if (segments[5] === undefined) {
      if (method === 'POST') return createCommit(ref, init);
      return page(await fixture.listCommits!(fixtureCtx, ref, {
        cursor: param(url, 'cursor'),
        limit: numberParam(url, 'limit'),
        before: param(url, 'before'),
        after: param(url, 'after'),
        includeUnpublished: param(url, 'includeUnpublished') === 'true',
      }));
    }

    const commitRef = { ...ref, commitId: segments[5] };
    if (segments[6] === undefined) return json(await fixture.getCommit!(fixtureCtx, commitRef));
    if (segments[6] === 'fingerprints') {
      return json(await fixture.loadCommitFingerprints!(fixtureCtx, commitRef, {
        keyProperty: param(url, 'keyProperty'),
        maxEntries: numberParam(url, 'maxEntries'),
        dataOnly: param(url, 'dataOnly') === 'true',
      }));
    }
    if (segments[6] === 'payload') {
      const accepted = (new Headers(init?.headers).get('Accept') ?? '')
        .split(',')
        .map((media) => MEDIA_TO_FORMAT.get(media.trim()))
        .filter((format): format is CommitPayloadFormat => format !== undefined);
      const payload = await fixture.loadCommit!(fixtureCtx, commitRef, { accept: accepted });
      return new Response(payload.bytes, {
        status: 200,
        headers: {
          'Content-Type': MEDIA_TYPES[payload.format],
          'X-Artifact-Digest': payload.artifactDigest,
          'X-Artifact-Filename': payload.fileName,
        },
      });
    }
    return json({ code: 'not-found', message: `No route for ${path}` }, 404);
  }

  async function createCommit(ref: { projectId: string; modelId: string }, init: RequestInit | undefined): Promise<Response> {
    const form = init?.body;
    if (!(form instanceof FormData)) {
      return json({ code: 'invalid', message: 'createCommit expects multipart/form-data' }, 400);
    }
    const meta = JSON.parse(await (form.get('meta') as Blob).text()) as {
      expectedParentId: string | null;
      message?: string;
    };
    const file = form.get('file') as File;
    const idempotencyKey = new Headers(init?.headers).get('Idempotency-Key');
    if (!idempotencyKey) {
      return json({ code: 'invalid', message: 'createCommit requires an Idempotency-Key header' }, 400);
    }
    return json(await fixture.createCommit!(fixtureCtx, {
      ...ref,
      expectedParentId: meta.expectedParentId,
      fileName: file.name,
      bytes: await file.arrayBuffer(),
      ...(meta.message !== undefined ? { message: meta.message } : {}),
      idempotencyKey,
    }));
  }

  return { fetch: doFetch, fixture, requests };
}
