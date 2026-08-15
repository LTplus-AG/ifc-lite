/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RelayDeclaration } from '@ifc-lite/plugin-api';
import { applyRelay, isAllowedHost, parseRetryAfterMs } from './host-fetch.js';

const relay: RelayDeclaration = {
  path: '/api/dalux',
  upstream: 'https://node1.field.dalux.com/service/api',
};

describe('applyRelay', () => {
  it('rewrites a url that targets the declared upstream exactly', () => {
    const url = 'https://node1.field.dalux.com/service/api/projects/1';
    assert.equal(
      applyRelay(url, relay, 'https://app.example.com'),
      'https://app.example.com/api/dalux/projects/1',
    );
  });

  it('rewrites when the upstream is matched with no trailing path at all', () => {
    const url = 'https://node1.field.dalux.com/service/api';
    assert.equal(applyRelay(url, relay, 'https://app.example.com'), 'https://app.example.com/api/dalux');
  });

  it('returns the url unchanged when there is no relay declared', () => {
    const url = 'https://node1.field.dalux.com/service/api/projects/1';
    assert.equal(applyRelay(url, undefined, 'https://app.example.com'), url);
  });

  it('does NOT match a same-prefix path segment that continues past a boundary (bypass shape 1)', () => {
    // `/service/apixyz` shares every character of `/service/api` but is a
    // different endpoint entirely; a plain `startsWith` would wrongly treat
    // it as the same upstream and relay it.
    const url = 'https://node1.field.dalux.com/service/apixyz/projects/1';
    assert.equal(applyRelay(url, relay, 'https://app.example.com'), url);
  });

  it('does NOT match a same-prefix hostname/path suffix glued directly onto the upstream (bypass shape 2)', () => {
    const url = 'https://node1.field.dalux.com/service/api.evil.example/steal';
    assert.equal(applyRelay(url, relay, 'https://app.example.com'), url);
  });

  it('does not let ".." segments in the caller string reach the rewritten same-origin path', () => {
    // The raw string carries a traversal segment; the normalized URL the
    // rewrite is built from must have already resolved it away.
    const url = 'https://node1.field.dalux.com/service/api/../api/projects/1';
    assert.equal(
      applyRelay(url, relay, 'https://app.example.com'),
      'https://app.example.com/api/dalux/projects/1',
    );
  });

  it('matches a query string boundary right after the upstream', () => {
    const url = 'https://node1.field.dalux.com/service/api?x=1';
    assert.equal(applyRelay(url, relay, 'https://app.example.com'), 'https://app.example.com/api/dalux?x=1');
  });

  it('tolerates a trailing slash on the declared upstream', () => {
    const trailingSlashRelay: RelayDeclaration = { path: '/api/dalux', upstream: `${relay.upstream}/` };
    const url = 'https://node1.field.dalux.com/service/api/projects/1';
    assert.equal(
      applyRelay(url, trailingSlashRelay, 'https://app.example.com'),
      'https://app.example.com/api/dalux/projects/1',
    );
  });
});

describe('isAllowedHost (unchanged behaviour, guards the surrounding fix)', () => {
  it('matches an exact host', () => {
    assert.equal(isAllowedHost(['example.com'], 'example.com'), true);
    assert.equal(isAllowedHost(['example.com'], 'evil.example.com'), false);
  });

  it('matches a wildcard subdomain pattern and its apex', () => {
    assert.equal(isAllowedHost(['*.example.com'], 'api.example.com'), true);
    assert.equal(isAllowedHost(['*.example.com'], 'example.com'), true);
    assert.equal(isAllowedHost(['*.example.com'], 'example.com.evil.test'), false);
  });
});

describe('parseRetryAfterMs (sanity, untouched by this change)', () => {
  it('parses a seconds value', () => {
    assert.equal(parseRetryAfterMs('2'), 2000);
  });

  it('returns undefined for an absent header', () => {
    assert.equal(parseRetryAfterMs(null), undefined);
  });
});
