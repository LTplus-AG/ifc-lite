/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js'; // the page is http://localhost/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isServerReachable } from './serverAvailability.js';

const remotePage = { href: 'https://models.example.org/viewer/', hostname: 'models.example.org' };

describe('isServerReachable', () => {
  it('accepts a same-origin path, the form a reverse proxy in front of the server gives', () => {
    // `new URL('/ifc')` throws without a base, so this used to read as "no server" and every
    // server load silently fell back.
    assert.equal(isServerReachable('/ifc'), true);
    assert.equal(isServerReachable('/ifc', remotePage), true);
  });

  it('accepts an absolute server URL', () => {
    assert.equal(isServerReachable('https://server.example.org'), true);
    assert.equal(isServerReachable('http://localhost:8080'), true);
  });

  it('skips a localhost server from a page that is not on localhost', () => {
    assert.equal(isServerReachable('http://localhost:8080', remotePage), false);
    assert.equal(isServerReachable('http://127.0.0.1:8080', remotePage), false);
    assert.equal(isServerReachable('https://server.example.org', remotePage), true);
  });

  it('has no server to ask when none is configured or the value is not a URL', () => {
    assert.equal(isServerReachable(''), false);
    assert.equal(isServerReachable('http://'), false);
  });
});
