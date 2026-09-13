/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import middleware, { config, deploymentPinHeaders } from '../middleware.js';

const DEPLOYMENT_ID = 'dpl_7G9RYA3a3jB3mPJKjGTqtVZUhyB4';

function request(headers = {}, method = 'GET') {
  return new Request('https://www.ifclite.com/model/42', { headers, method });
}

function middlewareMatches(pathname) {
  const matcher = config.matcher[0];
  assert.ok(matcher?.startsWith('/'), 'middleware matcher must be rooted');
  return new RegExp(`^${matcher.slice(1)}$`).test(pathname.replace(/^\//, ''));
}

describe('Vercel Skew Protection document pin (#4649)', () => {
  test('sets the serving deployment before browser subresource discovery', () => {
    const headers = deploymentPinHeaders(
      request({ 'sec-fetch-dest': 'document' }),
      DEPLOYMENT_ID,
      '1',
    );

    assert.equal(
      headers?.get('set-cookie'),
      `__vdpl=${DEPLOYMENT_ID}; Path=/; Secure; SameSite=Lax`,
    );
  });

  test('overwrites a mismatched legacy pin instead of trusting it', () => {
    const headers = deploymentPinHeaders(
      request({
        accept: 'text/html,application/xhtml+xml',
        cookie: '__vdpl=dpl_stale',
      }),
      DEPLOYMENT_ID,
      '1',
    );

    assert.match(headers?.get('set-cookie') ?? '', new RegExp(`^__vdpl=${DEPLOYMENT_ID};`));
  });

  test('recognizes document requests without Sec-Fetch-Dest', () => {
    const headers = deploymentPinHeaders(
      request({ accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }),
      DEPLOYMENT_ID,
      '1',
    );

    assert.ok(headers?.has('set-cookie'));
  });

  test('does not pin assets, mutations, disabled projects, or missing ids', () => {
    assert.equal(deploymentPinHeaders(request({ accept: '*/*' }), DEPLOYMENT_ID, '1'), undefined);
    assert.equal(
      deploymentPinHeaders(request({ 'sec-fetch-dest': 'document' }, 'POST'), DEPLOYMENT_ID, '1'),
      undefined,
    );
    assert.equal(
      deploymentPinHeaders(request({ 'sec-fetch-dest': 'document' }), DEPLOYMENT_ID, undefined),
      undefined,
    );
    assert.equal(
      deploymentPinHeaders(request({ 'sec-fetch-dest': 'document' }), undefined, '1'),
      undefined,
    );
  });

  test('returns Vercel next responses while keeping dotted documents eligible', () => {
    const response = middleware(request({ accept: '*/*' }));
    assert.equal(response.headers.get('x-middleware-next'), '1');
    assert.equal(config.runtime, 'nodejs');
    assert.equal(middlewareMatches('/'), true);
    assert.equal(middlewareMatches('/model/42'), true);
    assert.equal(middlewareMatches('/index.html'), true);
    assert.equal(middlewareMatches('/assets/main.js'), false);
    assert.equal(middlewareMatches('/api/epsg/2056'), false);
    assert.ok(deploymentPinHeaders(
      new Request('https://www.ifclite.com/index.html', {
        headers: { 'sec-fetch-dest': 'document' },
      }),
      DEPLOYMENT_ID,
      '1',
    )?.has('set-cookie'));
  });
});
