/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Operational probe: creates only its own unsigned session; never invokes APS.
import assert from 'node:assert/strict';

const [rawOrigin, ...expected] = process.argv.slice(2);
if (!rawOrigin || expected.some((kind) => !['proposal', 'exchange'].includes(kind))) {
  throw new Error('Usage: node deploy/autodesk/smoke.mjs https://viewer.example [proposal] [exchange]');
}
const origin = new URL(rawOrigin);
assert.equal(origin.origin, rawOrigin, 'Pass an exact HTTPS origin without a path.');
assert.equal(origin.protocol, 'https:', 'Production smoke checks require HTTPS.');
const request = (path, init) => fetch(new URL(path, origin), {
  ...init, redirect: 'error', signal: AbortSignal.timeout(30_000),
});
const session = await request('/api/autodesk/session');
assert.equal(session.status, 200, 'Session route must reach the Autodesk service.');
assert.match(session.headers.get('content-type') ?? '', /application\/json/, 'Session route reached HTML instead of the backend.');
assert.match(session.headers.get('cache-control') ?? '', /no-store/, 'Session responses must not be cached.');
const cookie = session.headers.get('set-cookie') ?? '';
assert.match(cookie, /^__Host-ifclite-autodesk=[^;]+;/, 'Use the production host-only session cookie.');
assert.match(cookie, /;\s*Secure(?:;|$)/i);
assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
assert.match(cookie, /;\s*SameSite=Lax(?:;|$)/i);
assert.doesNotMatch(cookie, /;\s*Domain=/i);
const body = await session.json();
assert.equal(body.identity, null, 'The probe must create its own unsigned session.');
assert.equal(typeof body.csrf, 'string');
assert.ok(body.csrf.length >= 32);
assert.ok(Array.isArray(body.imports));
for (const kind of expected) assert.ok(body.imports.includes(kind), `Missing installed ${kind} importer.`);
assert.equal('accessToken' in body || 'refreshToken' in body, false);
const headers = { cookie: cookie.split(';')[0], origin: origin.origin };
const csrf = await request('/api/autodesk/signout', { method: 'POST', headers });
assert.equal(csrf.status, 403, 'A mutation without CSRF must be rejected.');
const mutationHeaders = { ...headers, 'x-ifclite-csrf': body.csrf };
const authorized = await request('/api/autodesk/authorize', { method: 'POST', headers: mutationHeaders });
assert.equal(authorized.status, 200, 'An unsigned session must be able to start vendor sign-in.');
const transaction = await authorized.json();
const vendor = new URL(transaction.url);
assert.equal(vendor.origin, 'https://developer.api.autodesk.com');
assert.equal(vendor.pathname, '/authentication/v2/authorize');
assert.equal(vendor.searchParams.get('redirect_uri'), `${origin.origin}/api/autodesk/callback`);
assert.equal(vendor.searchParams.get('state'), transaction.state);
assert.equal(vendor.searchParams.get('code_challenge_method'), 'S256');
assert.ok(vendor.searchParams.get('code_challenge'));
const cancelled = await request('/api/autodesk/cancel-signin', { method: 'POST', headers: mutationHeaders });
assert.equal(cancelled.status, 200, 'The probe must cancel its own unsigned transaction.');
const denied = await request('/api/autodesk/request?path=%2Fproject%2Fv1%2Fhubs&region=US', { headers });
assert.equal(denied.status, 401, 'Unsigned sessions must not proxy APS requests.');
const callback = await request('/oauth/autodesk/callback');
assert.equal(callback.status, 200);
assert.match(callback.headers.get('content-type') ?? '', /text\/html/);
assert.match(callback.headers.get('cache-control') ?? '', /no-store/);
assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
assert.equal(callback.headers.get('cross-origin-opener-policy'), 'same-origin');
assert.equal(callback.headers.get('cross-origin-embedder-policy'), 'credentialless');
const signedOut = await request('/api/autodesk/signout', {
  method: 'POST', headers: { ...headers, 'x-ifclite-csrf': body.csrf },
});
assert.equal(signedOut.status, 200, 'The probe must be able to discard its own session.');
console.log(`PASS ${origin.origin}: API routing, unsigned authorization, CSRF, cookie protection, callback headers; importers: ${body.imports.join(', ') || 'none'}. No Autodesk calls made.`);
