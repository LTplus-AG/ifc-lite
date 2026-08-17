/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  BROWSER_ACCESS_BLOCKED,
  attachTileSuccessRetraction,
  buildCreditHtml,
  classifyTileProviderError,
  decodeCustomBasemap,
  encodeCustomBasemap,
  probeTileAccess,
  TILE_PROBE_TIMEOUT_MS,
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

  it('rejects {s}: the editor has no subdomains field, so it would 404 silently', () => {
    // Cesium DOES substitute {s}, from a `subdomains` option defaulting to
    // a/b/c. Accepting the token without collecting that option lets a server
    // sharding over 1,2,3,4 validate, save, and then 404 every tile at render
    // with no banner — a 404 carries a statusCode, so the runtime classifier
    // correctly stays quiet. Reject at input time instead, and say why.
    const result = err({ ...VALID, url: 'https://{s}.tiles.example.org/{z}/{x}/{y}.png' });
    assert.strictEqual(result.field, 'url');
    assert.match(result.message, /\{s\}/);
    assert.match(result.message, /subdomain/i);
  });

  it('does not advertise {s} in the supported-placeholder list', () => {
    const result = err({ ...VALID, url: 'https://t.example.org/{z}/{x}/{y}/{apiKey}.png' });
    assert.doesNotMatch(result.message, /\{s\}/);
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

  it('hands Cesium the ESCAPED credit markup, not the raw field', () => {
    // buildCreditHtml is tested directly above, but that leaves the escaping
    // untested at the point where it matters: the object handed to
    // `new UrlTemplateImageryProvider(...)`. Assert the integration, so
    // replacing `buildCreditHtml(basemap)` with `basemap.credit` fails here.
    const options = toUrlTemplateProviderOptions(ok({
      ...VALID,
      credit: '<img src=x onerror=alert(1)> Example NMA',
    }));
    assert.ok(options.credit.startsWith('<a href='), `expected an anchor, got: ${options.credit}`);
    assert.match(options.credit, /&lt;img/);
    assert.doesNotMatch(options.credit, /<img/);
  });

  it('escapes the credit even with no link, so the raw field never reaches the provider', () => {
    const options = toUrlTemplateProviderOptions(ok({
      ...VALID,
      creditUrl: undefined,
      credit: '<b>Example</b>',
    }));
    assert.strictEqual(options.credit, '&lt;b&gt;Example&lt;/b&gt;');
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
    // `typeof null === 'object'`, so the explicit null check is load-bearing.
    assert.strictEqual(decodeCustomBasemap('null'), null);
    assert.strictEqual(decodeCustomBasemap('42'), null);
    assert.strictEqual(decodeCustomBasemap('"a string"'), null);
  });

  // localStorage is hand-editable, and the decoded value feeds the store's
  // *initial state* — a throw here is a white screen with no in-app recovery.
  // `??` only rescues null/undefined, so every field a validator calls a string
  // method on has to be type-checked, not defaulted.
  describe('a stored field of the wrong TYPE returns null instead of throwing', () => {
    const NON_STRINGS: [string, unknown][] = [
      ['number', 123],
      ['zero', 0],
      ['boolean true', true],
      ['boolean false', false],
      ['array', []],
      ['object', {}],
    ];
    for (const [label, value] of NON_STRINGS) {
      for (const field of ['url', 'credit', 'creditUrl'] as const) {
        it(`${field} as ${label}`, () => {
          const raw = JSON.stringify({ ...VALID, [field]: value });
          assert.strictEqual(decodeCustomBasemap(raw), null);
        });
      }
    }

    it('protocol as a number', () => {
      assert.strictEqual(decodeCustomBasemap(JSON.stringify({ ...VALID, protocol: 7 })), null);
    });

    it('maximumLevel as a numeric string', () => {
      assert.strictEqual(decodeCustomBasemap(JSON.stringify({ ...VALID, maximumLevel: '20' })), null);
    });

    it('every field wrong at once', () => {
      const raw = JSON.stringify({ protocol: {}, url: [], credit: 1, creditUrl: true, maximumLevel: 'x' });
      assert.strictEqual(decodeCustomBasemap(raw), null);
    });

    it('an empty object, which supplies nothing at all', () => {
      assert.strictEqual(decodeCustomBasemap('{}'), null);
    });
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
  const basemap = ok({ ...VALID, url: 'https://t.example.org/{z}/{x}/{reverseY}.png' });

  it('substitutes a concrete zero tile, leaving no placeholder behind', async () => {
    let seen = '';
    await probeTileAccess(basemap, async (url) => {
      seen = String(url);
      return new Response('', { status: 200 });
    });
    assert.strictEqual(seen, 'https://t.example.org/0/0/0.png');
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

  it('calls a 404 normal for a deeper-starting pyramid, and does not flag it', async () => {
    const result = await probeTileAccess(basemap, async () => new Response('', { status: 404 }));
    assert.match(result.message ?? '', /normal for a service whose tiles start at a deeper zoom/);
    assert.ok(!result.concerning);
  });

  for (const status of [401, 403]) {
    it(`does NOT call a ${status} normal — an auth refusal applies at every zoom`, async () => {
      const result = await probeTileAccess(basemap, async () => new Response('', { status }));
      // CORS itself is fine: the response reached JavaScript.
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(result.httpStatus, status);
      // But the reassuring 404 wording would be a lie here.
      assert.doesNotMatch(result.message ?? '', /normal/i);
      assert.match(result.message ?? '', /authorisation failure/i);
      assert.match(result.message ?? '', /API key/i);
      assert.strictEqual(result.concerning, true, 'an auth refusal must not render as calm status text');
    });
  }

  it('reports a blocked server when fetch rejects, and says so in the user-facing message', async () => {
    const result = await probeTileAccess(basemap, async () => {
      throw new TypeError('Failed to fetch');
    });
    assert.strictEqual(result.status, 'blocked');
    assert.match(result.message ?? '', /does not allow browser access/i);
  });

  /**
   * A host that completes the TCP handshake and then never answers is not a
   * `fetch` rejection — the promise simply stays pending. The probe is on the
   * user's Save path, so an unbounded wait is a Save button that spins with no
   * verdict and no way to tell whether the check is slow or hung.
   */
  /**
   * The stand-in host answers eventually (`after` ms) and honours an abort, so
   * an unbounded probe returns `ok` rather than hanging the suite — the failure
   * is an assertion, not a timeout.
   */
  const slowHost = (after: number) => (_url: unknown, init?: RequestInit) => new Promise<Response>(
    (resolve, reject) => {
      const t = setTimeout(() => resolve(new Response('', { status: 200 })), after);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(init.signal!.reason);
      });
    },
  );

  it('bounds the wait — a host that does not answer must not leave Save spinning', async () => {
    let signal: AbortSignal | null | undefined;
    const result = await probeTileAccess(basemap, (url, init) => {
      signal = init?.signal;
      return slowHost(400)(url, init);
    }, 5);
    assert.ok(signal, 'the probe must pass an abort signal, or nothing can bound the wait');
    assert.strictEqual(result.status, 'blocked',
      'the probe must give a verdict on its own clock, not on the server\'s');
  });

  // The bound above is exercised at 5 ms so the suite does not wait on it; this
  // pins that the SHIPPED default is a real, finite bound rather than the
  // parameter having been added and left off.
  it('ships a finite default bound', () => {
    assert.ok(Number.isFinite(TILE_PROBE_TIMEOUT_MS) && TILE_PROBE_TIMEOUT_MS > 0);
    assert.ok(TILE_PROBE_TIMEOUT_MS <= 30_000, 'a bound the user will not sit through is not a bound');
  });

  /**
   * ...and it must not be reported as a CORS refusal. "This server does not
   * allow browser access" is a specific, actionable claim; a host that is
   * merely slow may serve tiles perfectly once the globe is up, and telling the
   * user their server is misconfigured would send them to fix the wrong thing.
   */
  it('names a timeout as a timeout, not as a CORS refusal', async () => {
    const result = await probeTileAccess(basemap, slowHost(400), 5);
    assert.doesNotMatch(result.message ?? '', /does not allow browser access/i);
    assert.match(result.message ?? '', /did not respond|timed out/i);
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

  /**
   * The `'statusCode' in inner` boundary is deliberate, and this states it as a
   * decision rather than leaving it to be read as an oversight.
   *
   * Review raised the opposite reading: an `<img>` error event carries no
   * `statusCode` PROPERTY at all, so it is rejected here instead of being
   * reported as blocked — and an image-element failure is one of the ways a
   * CORS refusal surfaces. The absence is kept refused because the two absences
   * are not the same evidence. `{ statusCode: undefined }` is a
   * `RequestErrorEvent` that ran and got no response: Cesium built that object
   * BECAUSE a request failed, and the missing status is the finding. An object
   * with no such key is some other event entirely, and "no response reached JS"
   * cannot be inferred from "this is not a request error" — a DOM `Event`, a
   * decode failure, or any future Cesium shape would all land in it and each
   * would raise a confident, specific, wrong message over a basemap that may be
   * fine. `attachTileSuccessRetraction` only retracts a banner this function
   * raised, so a wrong raise is not self-correcting.
   */
  it('refuses to classify an error with no statusCode KEY — absence of the key is not absence of a response', () => {
    // What an <img> error event looks like: no `statusCode` key anywhere.
    assert.strictEqual(classifyTileProviderError({ error: { type: 'error', target: {} } }), null);
    assert.strictEqual(classifyTileProviderError({ error: {} }), null);
    // Whereas the key present and undefined IS the CORS finding, above.
    assert.ok(classifyTileProviderError({ error: { statusCode: undefined } }));
  });
});

describe('custom basemap — the browser-access banner can come back down', () => {
  // One failed tile raises the banner; one ad-blocker rule or DNS blip is
  // enough to produce one. Without a retraction the warning then sits
  // permanently over a basemap that is drawing perfectly.
  function fakeProvider(behaviour: () => unknown) {
    return { requestImage: (() => behaviour()) as (...args: never[]) => unknown };
  }

  function tracker() {
    let warning: string | null = null;
    return {
      get value() { return warning; },
      set(next: string | null) { warning = next; },
      update(fn: (current: string | null) => string | null) { warning = fn(warning); },
    };
  }

  it('clears the CORS warning once a tile request resolves', async () => {
    const warn = tracker();
    warn.set(BROWSER_ACCESS_BLOCKED);
    const provider = fakeProvider(() => Promise.resolve({ width: 256 }));
    attachTileSuccessRetraction(provider, warn.update.bind(warn));

    await (provider.requestImage as () => Promise<unknown>)();
    await Promise.resolve();
    assert.strictEqual(warn.value, null, 'a readable tile disproves "no browser access"');
  });

  it('leaves the warning up while requests keep failing', async () => {
    const warn = tracker();
    warn.set(BROWSER_ACCESS_BLOCKED);
    const provider = fakeProvider(() => Promise.reject(new Error('blocked')));
    attachTileSuccessRetraction(provider, warn.update.bind(warn));

    await assert.rejects(() => (provider.requestImage as () => Promise<unknown>)());
    await Promise.resolve();
    assert.strictEqual(warn.value, BROWSER_ACCESS_BLOCKED);
  });

  it('retracts ONLY the CORS message — a tile proves nothing about other warnings', async () => {
    const warn = tracker();
    warn.set('No custom basemap is configured. Add a tile URL in Sun & Sky → Base map.');
    const provider = fakeProvider(() => Promise.resolve({ width: 256 }));
    attachTileSuccessRetraction(provider, warn.update.bind(warn));

    await (provider.requestImage as () => Promise<unknown>)();
    await Promise.resolve();
    assert.match(warn.value ?? '', /No custom basemap is configured/);
  });

  it('passes a throttled (undefined) request straight through', () => {
    const warn = tracker();
    const provider = fakeProvider(() => undefined);
    attachTileSuccessRetraction(provider, warn.update.bind(warn));
    assert.strictEqual((provider.requestImage as () => unknown)(), undefined);
  });

  it('still forwards arguments and the return value to the wrapped provider', async () => {
    const warn = tracker();
    let seen: unknown[] = [];
    const promised = Promise.resolve('image');
    const provider = {
      requestImage: ((...args: unknown[]) => { seen = args; return promised; }) as (...a: never[]) => unknown,
    };
    attachTileSuccessRetraction(provider, warn.update.bind(warn));
    const returned = (provider.requestImage as (...a: unknown[]) => unknown)(1, 2, 3);
    assert.deepStrictEqual(seen, [1, 2, 3]);
    assert.strictEqual(returned, promised);
    await promised;
  });
});
