/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  buildCreditHtml,
  classifyTileProviderError,
  decodeCustomBasemap,
  encodeCustomBasemap,
  probeTileAccess,
  toUrlTemplateProviderOptions,
  validateCustomBasemap,
  type CustomBasemap,
} from './custom-basemap.js';

const VALID = {
  protocol: 'xyz' as const,
  url: 'https://tiles.example.org/aerial/{z}/{x}/{y}.png',
  credit: 'Imagery © Example National Mapping Agency, CC BY 4.0',
  creditUrl: 'https://example.org/licence',
  maximumLevel: 20,
};

function ok(draft: Parameters<typeof validateCustomBasemap>[0]): CustomBasemap {
  const result = validateCustomBasemap(draft);
  assert.ok(result.ok, `expected valid, got: ${result.ok ? '' : result.message}`);
  return result.basemap;
}

function err(draft: Parameters<typeof validateCustomBasemap>[0]) {
  const result = validateCustomBasemap(draft);
  assert.ok(!result.ok, 'expected the draft to be rejected');
  return result;
}

describe('custom basemap — URL template validation', () => {
  it('accepts a well-formed XYZ template', () => {
    const basemap = ok(VALID);
    assert.strictEqual(basemap.protocol, 'xyz');
    assert.strictEqual(basemap.url, VALID.url);
    assert.strictEqual(basemap.maximumLevel, 20);
  });

  it('rejects an empty URL', () => {
    assert.strictEqual(err({ ...VALID, url: '   ' }).field, 'url');
  });

  it('rejects a URL that is not http(s) — a tile request is a browser fetch', () => {
    const result = err({ ...VALID, url: 'ftp://tiles.example.org/{z}/{x}/{y}.png' });
    assert.strictEqual(result.field, 'url');
    assert.match(result.message, /https?/i);
  });

  it('rejects a URL with no {z}/{x}/{y} placeholders — a fixed URL is not a tile template', () => {
    const result = err({ ...VALID, url: 'https://tiles.example.org/aerial.png' });
    assert.strictEqual(result.field, 'url');
    assert.match(result.message, /\{z\}/);
  });

  it('rejects a template missing only {x}', () => {
    assert.strictEqual(err({ ...VALID, url: 'https://t.example.org/{z}/{y}.png' }).field, 'url');
  });

  it('accepts {reverseY} in place of {y} (TMS-ordered servers)', () => {
    const basemap = ok({ ...VALID, url: 'https://t.example.org/{z}/{x}/{reverseY}.png' });
    assert.match(basemap.url, /\{reverseY\}/);
  });

  it('accepts the {s} subdomain placeholder', () => {
    ok({ ...VALID, url: 'https://{s}.tiles.example.org/{z}/{x}/{y}.png' });
  });

  it('rejects an unsupported placeholder rather than passing it to Cesium verbatim', () => {
    const result = err({ ...VALID, url: 'https://t.example.org/{z}/{x}/{y}/{apiKey}.png' });
    assert.strictEqual(result.field, 'url');
    assert.match(result.message, /apiKey/);
  });

  it('rejects credentials embedded in the URL — they would be persisted in cleartext', () => {
    const result = err({ ...VALID, url: 'https://user:secret@t.example.org/{z}/{x}/{y}.png' });
    assert.strictEqual(result.field, 'url');
    assert.doesNotMatch(result.message, /secret/);
  });

  it('rejects a maximumLevel outside the tile-pyramid range', () => {
    assert.strictEqual(err({ ...VALID, maximumLevel: 0 }).field, 'maximumLevel');
    assert.strictEqual(err({ ...VALID, maximumLevel: 40 }).field, 'maximumLevel');
    assert.strictEqual(err({ ...VALID, maximumLevel: 12.5 }).field, 'maximumLevel');
  });

  it('leaves maximumLevel undefined when not supplied', () => {
    const basemap = ok({ ...VALID, maximumLevel: undefined });
    assert.strictEqual(basemap.maximumLevel, undefined);
  });
});

describe('custom basemap — attribution is required', () => {
  it('rejects a blank credit', () => {
    const result = err({ ...VALID, credit: '   ' });
    assert.strictEqual(result.field, 'credit');
    assert.match(result.message, /attribution|credit/i);
  });

  it('rejects a missing credit', () => {
    assert.strictEqual(err({ ...VALID, credit: undefined }).field, 'credit');
  });

  it('accepts a credit with no link', () => {
    const basemap = ok({ ...VALID, creditUrl: undefined });
    assert.strictEqual(basemap.creditUrl, undefined);
  });

  it('rejects a non-http credit link (javascript: would become an on-canvas anchor)', () => {
    const result = err({ ...VALID, creditUrl: 'javascript:alert(1)' });
    assert.strictEqual(result.field, 'creditUrl');
  });

  it('escapes the credit text rather than passing markup through', () => {
    const html = buildCreditHtml({ credit: '<img src=x onerror=alert(1)> & co', creditUrl: undefined });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
    assert.match(html, /&amp; co/);
  });

  it('wraps the escaped credit in a safe anchor when a link is supplied', () => {
    const html = buildCreditHtml({ credit: 'Example NMA', creditUrl: 'https://example.org/licence' });
    assert.match(html, /<a href="https:\/\/example\.org\/licence"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, />Example NMA<\/a>/);
  });

  it('escapes quotes in the credit link so it cannot break out of the href attribute', () => {
    const html = buildCreditHtml({ credit: 'x', creditUrl: 'https://example.org/?a="onmouseover="alert(1)' });
    // The payload stays inside the href value as escaped text; what matters is
    // that no raw quote closes the attribute early and turns the rest into a
    // second attribute on the anchor.
    assert.match(html, /href="https:\/\/example\.org\/\?a=&quot;onmouseover=&quot;alert\(1\)"/);
    assert.strictEqual(html.match(/="/g)?.length, 3); // href, target, rel — no smuggled fourth
  });
});

describe('custom basemap — Cesium provider options', () => {
  it('carries url, credit html and maximumLevel', () => {
    const options = toUrlTemplateProviderOptions(ok(VALID));
    assert.strictEqual(options.url, VALID.url);
    assert.strictEqual(options.maximumLevel, 20);
    assert.match(options.credit, /Example National Mapping Agency/);
  });

  it('omits maximumLevel entirely when unset, rather than sending undefined-as-limit', () => {
    const options = toUrlTemplateProviderOptions(ok({ ...VALID, maximumLevel: undefined }));
    assert.ok(!('maximumLevel' in options));
  });
});

describe('custom basemap — persistence codec', () => {
  it('round-trips through the stored string form', () => {
    const basemap = ok(VALID);
    const decoded = decodeCustomBasemap(encodeCustomBasemap(basemap));
    assert.deepStrictEqual(decoded, basemap);
  });

  it('returns null for absent or malformed storage', () => {
    assert.strictEqual(decodeCustomBasemap(null), null);
    assert.strictEqual(decodeCustomBasemap('not json'), null);
    assert.strictEqual(decodeCustomBasemap('[]'), null);
  });

  it('re-validates on read, so a hand-edited entry cannot inject an unchecked value', () => {
    const poisoned = JSON.stringify({ ...VALID, creditUrl: 'javascript:alert(1)' });
    assert.strictEqual(decodeCustomBasemap(poisoned), null);
  });

  it('rejects a stored entry whose protocol is not one this build understands', () => {
    const future = JSON.stringify({ ...VALID, protocol: 'wmts' });
    assert.strictEqual(decodeCustomBasemap(future), null);
  });
});

describe('custom basemap — browser access (CORS) probe', () => {
  const basemap = ok({ ...VALID, url: 'https://{s}.t.example.org/{z}/{x}/{reverseY}.png' });

  it('substitutes a concrete zero tile, including the subdomain placeholder', async () => {
    let seen = '';
    await probeTileAccess(basemap, async (url) => {
      seen = String(url);
      return new Response('', { status: 200 });
    });
    assert.strictEqual(seen, 'https://a.t.example.org/0/0/0.png');
    assert.doesNotMatch(seen, /[{}]/);
  });

  it('requests in cors mode — a no-cors probe succeeds opaquely and proves nothing', async () => {
    let init: RequestInit | undefined;
    await probeTileAccess(basemap, async (_url, requestInit) => {
      init = requestInit;
      return new Response('', { status: 200 });
    });
    assert.strictEqual(init?.mode, 'cors');
  });

  it('reports ok when the tile loads', async () => {
    const result = await probeTileAccess(basemap, async () => new Response('', { status: 200 }));
    assert.strictEqual(result.status, 'ok');
  });

  it('treats ANY readable response as browser-accessible — reaching JS proves CORS headers', async () => {
    const result = await probeTileAccess(basemap, async () => new Response('', { status: 404 }));
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.httpStatus, 404);
    assert.match(result.message ?? '', /404/);
  });

  it('reports a blocked server when fetch rejects, and says so in the user-facing message', async () => {
    const result = await probeTileAccess(basemap, async () => {
      throw new TypeError('Failed to fetch');
    });
    assert.strictEqual(result.status, 'blocked');
    assert.match(result.message ?? '', /does not allow browser access/i);
  });
});

describe('custom basemap — runtime tile failures', () => {
  it('reads a Cesium RequestErrorEvent with no statusCode as blocked, not as a tile gap', () => {
    // Cesium raises `imageryProvider.errorEvent` with a TileProviderError whose
    // `.error` is a RequestErrorEvent. A CORS rejection never produces a
    // response, so `statusCode` is undefined — the signal that separates
    // "the browser was refused" from "that tile is missing".
    const message = classifyTileProviderError({ error: { statusCode: undefined } });
    assert.ok(message);
    assert.match(message, /does not allow browser access/i);
  });

  it('does not claim a CORS failure for a server that answered with a status', () => {
    assert.strictEqual(classifyTileProviderError({ error: { statusCode: 404 } }), null);
    assert.strictEqual(classifyTileProviderError({ error: { statusCode: 500 } }), null);
  });

  it('ignores an error shape it cannot classify rather than guessing', () => {
    assert.strictEqual(classifyTileProviderError({}), null);
    assert.strictEqual(classifyTileProviderError({ error: new Error('boom') }), null);
  });
});
