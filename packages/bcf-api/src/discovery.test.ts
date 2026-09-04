/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Base-URL resolution against a BIMcollab Nexus space.
 *
 * The stub below mirrors what a real space answers, captured from
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
import { bcfBaseUrlCandidates, discoverBcfService, resolveBcfBaseUrl } from './discovery.js';
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
  const fetchFn: FetchLike = async (url) => {
    urls.push(url);
    if (new URL(url).pathname === '/bcf/2.1/auth') {
      return new Response(JSON.stringify(NEXUS_AUTH), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
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
});

describe('resolveBcfBaseUrl', () => {
  it('stops at the first candidate the probe accepts', async () => {
    const tried: string[] = [];
    const resolved = await resolveBcfBaseUrl('https://myspace.bimcollab.com', async (baseUrl) => {
      tried.push(baseUrl);
      if (!baseUrl.endsWith('/bcf')) throw new BcfApiError('nope', { status: 404, url: baseUrl });
      return baseUrl;
    });
    expect(resolved).toBe('https://myspace.bimcollab.com/bcf');
    expect(tried).toHaveLength(2);
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
