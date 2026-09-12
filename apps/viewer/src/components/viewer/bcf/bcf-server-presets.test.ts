/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Data invariants of the server-preset catalogue. Every fixed URL must be a
 * normalized https base (the form feeds it to normalizeBcfBaseUrl-consuming
 * sign-in paths verbatim), ids must be unique (they key the dropdown), and
 * each preset needs at least one auth method (the form defaults to the
 * first).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BCF_SERVER_PRESETS,
  CUSTOM_PRESET_ID,
  findBcfServerPreset,
  presetForServerUrl,
  vendorAppEnvPrefix,
  vendorAppForPreset,
} from './bcf-server-presets.js';

/**
 * `vite-module-hooks-impl.mjs` binds `import.meta.env` to the ONE object at
 * `globalThis.__VITE_ENV__`; mutate its properties, never replace it (see
 * share-link.test.ts).
 */
function setEnv(name: string, value: string | undefined): void {
  const g = globalThis as unknown as { __VITE_ENV__?: Record<string, string | boolean> };
  // Seed the shim's own defaults when this test is the first to touch the
  // env: a bare `{}` would hand every later `import.meta.env` reader an env
  // with no MODE/DEV/PROD.
  g.__VITE_ENV__ ??= { MODE: 'test', DEV: false, PROD: false };
  if (value === undefined) delete g.__VITE_ENV__[name];
  else g.__VITE_ENV__[name] = value;
}

describe('BCF_SERVER_PRESETS invariants', () => {
  it('has unique ids and the custom entry first', () => {
    const ids = BCF_SERVER_PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'preset ids must be unique');
    assert.equal(BCF_SERVER_PRESETS[0].id, CUSTOM_PRESET_ID, 'custom is the fallback default');
  });

  it('every fixed URL is a normalized https base (no trailing slash, no version segment)', () => {
    for (const preset of BCF_SERVER_PRESETS) {
      if (preset.baseUrl === '') continue;
      assert.match(preset.baseUrl, /^https:\/\//, `${preset.id} must be https`);
      assert.ok(!preset.baseUrl.endsWith('/'), `${preset.id} must not end with a slash`);
      assert.ok(!/\/\d+\.\d+$/.test(preset.baseUrl), `${preset.id} must not embed a version`);
    }
  });

  it('every preset offers at least one auth method', () => {
    for (const preset of BCF_SERVER_PRESETS) {
      assert.ok(preset.authMethods.length > 0, `${preset.id} needs an auth method`);
    }
  });

  it('BIMcollab carries the scope its IdentityServer requires', () => {
    // createAuthorizationRequest writes `scope` only `if (config.scope)`, so a
    // missing field and an empty string both send no scope at all, and
    // BIMcollab answers a scope-less authorize request with `invalid_request`.
    // Both halves are asserted because both are silent failures.
    const bimcollab = findBcfServerPreset('bimcollab');
    assert.ok(
      bimcollab.oauthScope,
      'bimcollab needs a truthy oauthScope; a missing or empty one omits the parameter',
    );
    assert.equal(bimcollab.oauthScope, 'openid offline_access bcf');
  });

  it('resolves saved connections back to their preset, and unknown ones to custom', () => {
    assert.equal(presetForServerUrl('https://app.streambim.com/bcf').id, 'streambim');
    assert.equal(presetForServerUrl('https://my-own-server.example/bcf').id, CUSTOM_PRESET_ID);
    assert.equal(findBcfServerPreset('does-not-exist').id, CUSTOM_PRESET_ID);
  });
});

describe('vendorAppForPreset', () => {
  const vars = ['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI'].map(
    (suffix) => `VITE_BCF_APP_BIMCOLLAB_${suffix}`,
  );
  afterEach(() => {
    for (const name of vars) setEnv(name, undefined);
  });

  it('derives the env prefix from the preset id', () => {
    assert.equal(vendorAppEnvPrefix('bimcollab'), 'VITE_BCF_APP_BIMCOLLAB');
    assert.equal(vendorAppEnvPrefix('aconex-europe'), 'VITE_BCF_APP_ACONEX_EUROPE');
  });

  it('is absent until the deployment configures a client id', () => {
    assert.equal(vendorAppForPreset('bimcollab'), null);
    setEnv('VITE_BCF_APP_BIMCOLLAB_CLIENT_ID', '   ');
    assert.equal(vendorAppForPreset('bimcollab'), null, 'blank is not configured');
    setEnv('VITE_BCF_APP_BIMCOLLAB_CLIENT_SECRET', 'secret-without-id');
    assert.equal(vendorAppForPreset('bimcollab'), null, 'a secret alone is not an app');
  });

  it('reads the id, secret and redirect override, trimmed', () => {
    setEnv('VITE_BCF_APP_BIMCOLLAB_CLIENT_ID', ' PlayGround_Client ');
    setEnv('VITE_BCF_APP_BIMCOLLAB_CLIENT_SECRET', 'k!x ');
    setEnv('VITE_BCF_APP_BIMCOLLAB_REDIRECT_URI', 'http://localhost:5000/Callback');
    assert.deepEqual(vendorAppForPreset('bimcollab'), {
      clientId: 'PlayGround_Client',
      clientSecret: 'k!x',
      redirectUri: 'http://localhost:5000/Callback',
    });
  });

  it('never applies to the custom preset', () => {
    setEnv('VITE_BCF_APP_CUSTOM_CLIENT_ID', 'x');
    assert.equal(vendorAppForPreset(CUSTOM_PRESET_ID), null);
    setEnv('VITE_BCF_APP_CUSTOM_CLIENT_ID', undefined);
  });

  it('BIMcollab is flagged as issuing client ids to vendors only', () => {
    // Without this flag the form would tell a space user to "register an
    // OAuth application with the vendor", which BIMcollab does not offer
    // them (#3900).
    assert.equal(findBcfServerPreset('bimcollab').vendorIssuedClientsOnly, true);
  });
});
