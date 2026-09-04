/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Base-URL resolution against a BIMcollab Nexus space.
 *
 * The stub below answers as a real space does, captured from
 * https://playground.bimcollab.com on 2026-09-04:
 *
 *   GET /bcf/versions   -> 200 application/json {"versions":[{"version_id":"2.1"},…]}
 *   GET /bcf/2.1/auth   -> 200 application/json {"oauth2_auth_url":…,"oauth2_token_url":…}
 *   GET /2.1/auth       -> 404 text/html  (the space's web UI 404 page)
 *   GET /versions       -> 404 text/html
 *
 * BIMcollab, Solibri and the BCF managers all ask the user for the bare
 * space address (`https://myspace.bimcollab.com`), so that is what users
 * paste into the viewer's connect form.
 */

import { describe, expect, it } from 'vitest';
import {
  bcfBaseUrlCandidates,
  discoverBcfService,
  resolveBcfBaseUrl,
  resolveBcfServiceBaseUrl,
} from './discovery.js';
import { BcfApiError } from './errors.js';
import type { FetchLike } from './types.js';

const NEXUS_AUTH = {
  oauth2_auth_url: 'https://myspace.bimcollab.com/identity/connect/authorize',
  oauth2_token_url: 'https://myspace.bimcollab.com/identity/connect/token',
  http_basic_supported: false,
  supported_oauth2_flows: ['authorization_code_grant', 'resource_owner_password_credentials_grant'],
};

/** A space that serves the BCF API under /bcf and HTML 404s everywhere else. */
function nexusFetch(): { fetchFn: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const fetchFn: FetchLike = async (url) => {
    urls.push(url);
    const { pathname } = new URL(url);
    if (pathname === '/bcf/2.1/auth') return json(NEXUS_AUTH);
    if (pathname === '/bcf/versions') return json({ versions: [{ version_id: '2.1' }] });
    return new Response('<!DOCTYPE html><html><title>BIMcollab</title></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    });
  };
  return { fetchFn, urls };
}

describe('bcfBaseUrlCandidates', () => {
  it('offers the /bcf suffix for a bare space or instance host', () => {
    expect(bcfBaseUrlCandidates('https://myspace.bimcollab.com')).toEqual([
      'https://myspace.bimcollab.com',
      'https://myspace.bimcollab.com/bcf',
    ]);
    expect(bcfBaseUrlCandidates('https://myspace.bimcollab.com/')).toEqual([
      'https://myspace.bimcollab.com',
      'https://myspace.bimcollab.com/bcf',
    ]);
  });

  it('leaves a URL that already names a path alone', () => {
    expect(bcfBaseUrlCandidates('https://myspace.bimcollab.com/bcf/2.1')).toEqual([
      'https://myspace.bimcollab.com/bcf',
    ]);
    expect(bcfBaseUrlCandidates('https://project.example.com/api/bcf')).toEqual([
      'https://project.example.com/api/bcf',
    ]);
  });

  it('passes through an unparseable address so the caller reports it', () => {
    expect(bcfBaseUrlCandidates('not a url')).toEqual(['not a url']);
  });

  it('drops a query or fragment instead of appending the suffix to it', () => {
    // Appending to 'https://host?x=1' would parse as the query 'x=1/bcf' on
    // path '/', i.e. a candidate that is not the /bcf root at all. A URL
    // pasted out of the browser address bar is the realistic source.
    expect(bcfBaseUrlCandidates('https://myspace.bimcollab.com/#/projects')).toEqual([
      'https://myspace.bimcollab.com',
      'https://myspace.bimcollab.com/bcf',
    ]);
    expect(bcfBaseUrlCandidates('https://myspace.bimcollab.com?tenant=a')).toEqual([
      'https://myspace.bimcollab.com',
      'https://myspace.bimcollab.com/bcf',
    ]);
  });

  it('keeps a port, and leaves host case as typed', () => {
    expect(bcfBaseUrlCandidates('https://localhost:8443')).toEqual([
      'https://localhost:8443',
      'https://localhost:8443/bcf',
    ]);
    // Host case is not normalized (fetch lower-cases it on the wire), but
    // the suffix must still be appended rather than the address rejected.
    expect(bcfBaseUrlCandidates('https://MySpace.BimCollab.com')).toEqual([
      'https://MySpace.BimCollab.com',
      'https://MySpace.BimCollab.com/bcf',
    ]);
  });
});

describe('resolveBcfBaseUrl', () => {
  it('stops at the first candidate the probe accepts, probing no further', async () => {
    // A host that serves BCF at its root: the entered address wins, and the
    // /bcf guess must never be tried. This is what pins both the candidate
    // ORDER and the early exit — with two candidates and only the second
    // acceptable, any in-order implementation looks correct.
    const tried: string[] = [];
    const resolved = await resolveBcfBaseUrl('https://bcf.example.com', async (baseUrl) => {
      tried.push(baseUrl);
      return baseUrl;
    });
    expect(resolved).toBe('https://bcf.example.com');
    expect(tried).toEqual(['https://bcf.example.com']);
  });

  it('falls through to the /bcf candidate only after the entered one fails', async () => {
    const tried: string[] = [];
    const resolved = await resolveBcfBaseUrl('https://myspace.bimcollab.com', async (baseUrl) => {
      tried.push(baseUrl);
      if (!baseUrl.endsWith('/bcf')) throw new BcfApiError('nope', { status: 404, url: baseUrl });
      return baseUrl;
    });
    expect(resolved).toBe('https://myspace.bimcollab.com/bcf');
    expect(tried).toEqual([
      'https://myspace.bimcollab.com',
      'https://myspace.bimcollab.com/bcf',
    ]);
  });

  it('prefers an error naming a status and URL over an opaque CORS rejection', async () => {
    // Cross-origin, the wrong candidate's 404 page carries no CORS header,
    // so fetch rejects with a bare TypeError naming nothing. The other
    // candidate's BcfApiError is the only actionable message available.
    const error = await resolveBcfBaseUrl('https://myspace.bimcollab.com', async (baseUrl) => {
      throw baseUrl.endsWith('/bcf')
        ? new BcfApiError('BCF request failed (HTTP 500) at ' + baseUrl, {
            status: 500,
            url: baseUrl,
          })
        : new TypeError('Failed to fetch');
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BcfApiError);
    expect((error as BcfApiError).status).toBe(500);
  });

  it('rethrows the first error when no candidate produced a BcfApiError', async () => {
    const error = await resolveBcfBaseUrl('https://myspace.bimcollab.com', async (baseUrl) => {
      throw new TypeError(`Failed to fetch ${baseUrl}`);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe('Failed to fetch https://myspace.bimcollab.com');
  });

  it('prefers a rejected-credentials error over a wrong-address 404', async () => {
    // A bad token on the right address: the 404 from the other candidate
    // would tell the user to fix a URL that was never the problem.
    const error = await resolveBcfBaseUrl('https://myspace.bimcollab.com', async (baseUrl) => {
      throw baseUrl.endsWith('/bcf')
        ? new BcfApiError('Not authenticated', { status: 401, url: baseUrl })
        : new BcfApiError('BCF request failed (HTTP 404)', { status: 404, url: baseUrl });
    }).catch((e: unknown) => e);
    expect((error as BcfApiError).status).toBe(401);
    expect((error as BcfApiError).message).toBe('Not authenticated');
  });
});

describe('discoverBcfService', () => {
  it('finds the BCF root under /bcf when the user pastes the bare space URL', async () => {
    const { fetchFn, urls } = nexusFetch();
    const discovered = await discoverBcfService({
      baseUrl: 'https://myspace.bimcollab.com',
      fetchFn,
    });
    expect(discovered.baseUrl).toBe('https://myspace.bimcollab.com/bcf');
    expect(discovered.authInfo.oauth2_token_url).toBe(NEXUS_AUTH.oauth2_token_url);
    expect(urls).toEqual([
      'https://myspace.bimcollab.com/2.1/auth',
      'https://myspace.bimcollab.com/bcf/2.1/auth',
    ]);
  });

  it('probes nothing extra when the entered URL is already the BCF root', async () => {
    const { fetchFn, urls } = nexusFetch();
    const discovered = await discoverBcfService({
      baseUrl: 'https://myspace.bimcollab.com/bcf/2.1/',
      fetchFn,
    });
    expect(discovered.baseUrl).toBe('https://myspace.bimcollab.com/bcf');
    expect(urls).toEqual(['https://myspace.bimcollab.com/bcf/2.1/auth']);
  });

  it('reports the entered URL, not the guess, when no candidate answers', async () => {
    const fetchFn: FetchLike = async () =>
      new Response('<html>nope</html>', { status: 404, headers: { 'Content-Type': 'text/html' } });
    const error = await discoverBcfService({
      baseUrl: 'https://project.example.com',
      fetchFn,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BcfApiError);
    expect((error as BcfApiError).url).toBe('https://project.example.com/2.1/auth');
    expect((error as BcfApiError).message).toBe(
      'BCF request failed (HTTP 404) at https://project.example.com/2.1/auth',
    );
  });

  it('honours a non-default version segment', async () => {
    const { fetchFn, urls } = nexusFetch();
    await discoverBcfService({
      baseUrl: 'https://myspace.bimcollab.com/bcf',
      version: '3.0',
      fetchFn,
    }).catch(() => undefined);
    expect(urls).toEqual(['https://myspace.bimcollab.com/bcf/3.0/auth']);
  });
});

describe('resolveBcfServiceBaseUrl', () => {
  it('resolves an ambiguous address without sending any credentials', async () => {
    const { fetchFn, urls } = nexusFetch();
    const baseUrl = await resolveBcfServiceBaseUrl({
      baseUrl: 'https://myspace.bimcollab.com',
      fetchFn,
    });
    expect(baseUrl).toBe('https://myspace.bimcollab.com/bcf');
    // Anonymous discovery only: no Authorization header is ever built here,
    // and the caller sends its secret to the one resolved address.
    expect(urls).toEqual([
      'https://myspace.bimcollab.com/2.1/auth',
      'https://myspace.bimcollab.com/bcf/2.1/auth',
    ]);
  });

  it('makes no request at all for an address that already names a path', async () => {
    const { fetchFn, urls } = nexusFetch();
    const baseUrl = await resolveBcfServiceBaseUrl({
      baseUrl: 'https://myspace.bimcollab.com/bcf/2.1/',
      fetchFn,
    });
    expect(baseUrl).toBe('https://myspace.bimcollab.com/bcf');
    expect(urls).toEqual([]);
  });
});
