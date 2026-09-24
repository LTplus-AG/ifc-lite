/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5750: the server answers every error with one `{ error, code }` envelope,
 * and the client decodes it into an `IfcServerError` carrying the status and
 * the code. The bodies below are the ones the server actually sends (see the
 * `issue_5750_*` tests in `apps/server`), plus the shapes a non-envelope
 * answer can take.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IfcServerClient } from './client.js';
import { IfcServerError, serverErrorFromResponse } from './server-error.js';

const KEY = `${'0'.repeat(64)}-default`;

function client(): IfcServerClient {
  return new IfcServerClient({ baseUrl: 'https://example.invalid' });
}

function stubFetch(response: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('serverErrorFromResponse', () => {
  it('decodes the envelope into status, code and the message format callers already read', async () => {
    const error = await serverErrorFromResponse(
      json(401, { error: 'Unauthorized: missing or invalid bearer token', code: 'UNAUTHORIZED' })
    );
    expect(error).toBeInstanceOf(IfcServerError);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(401);
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toBe('Server error (UNAUTHORIZED): Unauthorized: missing or invalid bearer token');
  });

  it('falls back to the HTTP status for a non-JSON body', async () => {
    const error = await serverErrorFromResponse(
      new Response('Bad Gateway from a proxy', { status: 502, statusText: 'Bad Gateway' })
    );
    expect(error.status).toBe(502);
    expect(error.code).toBe('HTTP_502');
    expect(error.message).toBe('Server error: 502 Bad Gateway');
  });

  it('falls back for an empty body', async () => {
    const error = await serverErrorFromResponse(new Response(null, { status: 404, statusText: 'Not Found' }));
    expect(error.code).toBe('HTTP_404');
    expect(error.message).toBe('Server error: 404 Not Found');
  });

  it('does not read a JSON body that is not the envelope as one', async () => {
    // `/api/v1/ready`'s 503 is a probe document, and before this fix a JSON
    // body without `error`/`code` became "Server error (undefined): undefined".
    const error = await serverErrorFromResponse(json(503, { status: 'shedding', version: '1', service: 's' }));
    expect(error.code).toBe('HTTP_503');
    expect(error.message).not.toContain('undefined');
  });
});

describe('getCached', () => {
  it('returns null on a 404 envelope', async () => {
    stubFetch(() => json(404, { error: `Not found: Cache key not found: ${KEY}`, code: 'NOT_FOUND' }));
    await expect(client().getCached(KEY)).resolves.toBeNull();
  });

  it('throws an IfcServerError carrying the code for a key the server refuses', async () => {
    stubFetch(() =>
      json(400, {
        error: 'Bad request: expected the `cache_key` a parse response returned; got 64 character(s)',
        code: 'BAD_REQUEST',
      })
    );
    const failure = await client()
      .getCached('0'.repeat(64))
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(IfcServerError);
    expect((failure as IfcServerError).status).toBe(400);
    expect((failure as IfcServerError).code).toBe('BAD_REQUEST');
  });

  it('surfaces an overloaded cache read as OVERLOADED', async () => {
    stubFetch(() => json(503, { error: 'Server overloaded, retry after 5s', code: 'OVERLOADED' }));
    await expect(client().getCached(KEY)).rejects.toMatchObject({ status: 503, code: 'OVERLOADED' });
  });
});

describe('serverErrorFromResponse, malformed JSON', () => {
  it('falls back to the HTTP status for a truncated JSON body', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const error = await serverErrorFromResponse(
      new Response('{"error":"cut off', { status: 500, statusText: 'Internal Server Error' })
    );
    expect(error.code).toBe('HTTP_500');
    expect(error.message).toBe('Server error: 500 Internal Server Error');
    expect(debug).toHaveBeenCalledOnce();
    debug.mockRestore();
  });
});
