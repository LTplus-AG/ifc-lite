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
      headers?.getSetCookie()[0],
      `__vdpl=${DEPLOYMENT_ID}; Path=/; Secure; SameSite=Lax`,
    );
  });

  // #4886: Vercel serves every real navigation from the LATEST deployment, so
  // the Path=/ pin above is rewritten by any navigation in any tab. Verified
  // against production: an older tab's hashed worker then 404s. The pin scoped
  // to this build's asset directory is what keeps that tab's requests routed.
  test('also pins the asset directory of this build, which outranks the browser-wide pin', () => {
    const headers = deploymentPinHeaders(
      request({ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }),
      DEPLOYMENT_ID,
      '1',
    );

    assert.deepEqual(headers?.getSetCookie(), [
      `__vdpl=${DEPLOYMENT_ID}; Path=/; Secure; SameSite=Lax`,
      `__vdpl=${DEPLOYMENT_ID}; Path=/assets/${DEPLOYMENT_ID}/; Max-Age=604800; Secure; SameSite=Lax`,
    ]);
  });

  test('scopes the asset pin to exactly the directory the build writes', async () => {
    const { deploymentAssetsDir } = await import('./lib/deployment-assets-dir.mjs');
    const cookie = deploymentPinHeaders(request({ 'sec-fetch-dest': 'document' }), DEPLOYMENT_ID, '1')
      ?.getSetCookie()[1] ?? '';
    assert.ok(cookie.includes(`; Path=/${deploymentAssetsDir(DEPLOYMENT_ID, '1')}/;`), cookie);
  });

  test('sets no asset pin when the id cannot be a path segment', () => {
    const headers = deploymentPinHeaders(request({ 'sec-fetch-dest': 'document' }), 'not-a-deployment', '1');
    assert.equal(headers?.getSetCookie().length, 1);
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

    for (const cookie of headers?.getSetCookie() ?? []) {
      assert.match(cookie, new RegExp(`^__vdpl=${DEPLOYMENT_ID};`));
    }
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
    // Both pins must survive `next()`: Headers.set would silently keep one.
    const previous = { id: process.env.VERCEL_DEPLOYMENT_ID, skew: process.env.VERCEL_SKEW_PROTECTION_ENABLED };
    process.env.VERCEL_DEPLOYMENT_ID = DEPLOYMENT_ID;
    process.env.VERCEL_SKEW_PROTECTION_ENABLED = '1';
    try {
      const documentResponse = middleware(request({ 'sec-fetch-dest': 'document' }));
      assert.equal(documentResponse.headers.getSetCookie().length, 2);
    } finally {
      for (const [key, value] of [['VERCEL_DEPLOYMENT_ID', previous.id], ['VERCEL_SKEW_PROTECTION_ENABLED', previous.skew]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.equal(config.runtime, 'nodejs');
    assert.equal(middlewareMatches('/'), true);
    assert.equal(middlewareMatches('/model/42'), true);
    assert.equal(middlewareMatches('/index.html'), true);
    assert.equal(middlewareMatches('/assets/main.js'), false);
    assert.equal(middlewareMatches(`/assets/${DEPLOYMENT_ID}/main.js`), false);
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
