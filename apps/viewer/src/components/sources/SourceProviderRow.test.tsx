/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `safeIconUrl` — the provider-manifest icon is third-party data landing in an
 * `img src`, so the host decides what it is allowed to point at.
 *
 * Two properties are pinned here, both of which the pre-fix string-prefix
 * implementation got wrong:
 *
 * 1. **The `/\` bypass.** `/\evil.example/beacon.gif` passes a
 *    `raw.startsWith('/')` "same-origin relative" check, but the WHATWG URL
 *    parser (and therefore every browser) treats `\` as `/` for special
 *    schemes, so the byte stream the browser actually requests is
 *    `//evil.example/beacon.gif` — a cross-origin beacon. Resolution has to go
 *    through `new URL()` and the check has to be on the RESOLVED origin.
 *
 * 2. **The allowlist gate.** An absolute icon URL is allowed only when its host
 *    is in `permissions.network` — the same allowlist the host's fetch wrapper
 *    already enforces, so a plugin can point its icon exactly where it has
 *    already declared it talks. A same-origin relative icon (`/icons/acme.svg`)
 *    stays allowed independently of that list, so a provider with no network
 *    permissions at all can still ship an icon.
 *
 * The empty-allowlist case is tested in BOTH directions on purpose: "empty"
 * reads as "allow nothing" or "allow everything" depending on how the check is
 * written, and only asserting one side leaves the other free.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeIconUrl } from './SourceProviderRow.js';

/** The origin `setup-dom` registers happy-dom with. */
const ORIGIN = 'http://localhost';

describe('safeIconUrl — same-origin relative icons', () => {
  it('allows a same-origin absolute path even when permissions.network is empty', () => {
    assert.equal(safeIconUrl('/icons/acme.svg', []), `${ORIGIN}/icons/acme.svg`);
  });

  it('allows a same-origin ./ relative icon when permissions.network is empty', () => {
    assert.equal(safeIconUrl('./icons/acme.svg', []), `${ORIGIN}/icons/acme.svg`);
  });

  it('allows a same-origin absolute URL spelled out in full', () => {
    assert.equal(
      safeIconUrl(`${ORIGIN}/icons/acme.svg`, []),
      `${ORIGIN}/icons/acme.svg`,
    );
  });
});

describe('safeIconUrl — the backslash bypass', () => {
  // Every one of these starts with `/`, so a `raw.startsWith('/')` check reads
  // them as same-origin. The URL parser resolves each to `//evil.example`.
  for (const raw of [
    '/\\evil.example/beacon.gif',
    '/\\/evil.example',
    '/\\\\evil.example/beacon.gif',
    '\\\\evil.example/beacon.gif',
  ]) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      // Guard the premise: if the parser ever stopped folding `\` into `/`,
      // these inputs would be harmless and the test would be vacuous.
      const resolvedOrigin = new URL(raw, `${ORIGIN}/`).origin;
      assert.equal(
        resolvedOrigin,
        'http://evil.example',
        'premise: the URL parser must resolve this off-origin',
      );
      assert.equal(safeIconUrl(raw, []), undefined);
      assert.equal(
        safeIconUrl(raw, ['evil.example']),
        undefined,
        'plain http stays rejected even for an allowlisted host',
      );
    });
  }
});

describe('safeIconUrl — schemes that are never icons', () => {
  it('rejects a protocol-relative URL', () => {
    assert.equal(safeIconUrl('//evil.example/x.png', []), undefined);
  });

  it('rejects data:', () => {
    assert.equal(safeIconUrl('data:image/svg+xml,<svg/>', []), undefined);
  });

  it('rejects javascript:', () => {
    assert.equal(safeIconUrl('javascript:alert(1)', []), undefined);
  });

  it('rejects plain http even for an allowlisted host', () => {
    assert.equal(safeIconUrl('http://icons.example/i.png', ['icons.example']), undefined);
  });

  it('rejects an unparseable value', () => {
    assert.equal(safeIconUrl('https://', []), undefined);
  });

  it('passes an absent iconUrl through', () => {
    assert.equal(safeIconUrl(undefined, ['icons.example']), undefined);
    assert.equal(safeIconUrl('', ['icons.example']), undefined);
  });
});

describe('safeIconUrl — the permissions.network gate', () => {
  it('allows an https icon on an allowlisted host', () => {
    assert.equal(
      safeIconUrl('https://icons.example/i.png', ['icons.example']),
      'https://icons.example/i.png',
    );
  });

  it('rejects an https icon on a host that is NOT allowlisted', () => {
    assert.equal(safeIconUrl('https://other.example/i.png', ['icons.example']), undefined);
  });

  // Both directions of the empty-allowlist case. "Empty" must mean "no
  // cross-origin icon", not "every cross-origin icon".
  it('rejects EVERY cross-origin https icon when permissions.network is empty', () => {
    assert.equal(safeIconUrl('https://icons.example/i.png', []), undefined);
    assert.equal(safeIconUrl('https://cdn.example/i.png', []), undefined);
  });

  it('still allows a same-origin relative icon when permissions.network is empty', () => {
    assert.notEqual(safeIconUrl('/icons/acme.svg', []), undefined);
  });

  it('honours the wildcard form the host fetch wrapper uses', () => {
    assert.equal(
      safeIconUrl('https://cdn.icons.example/i.png', ['*.icons.example']),
      'https://cdn.icons.example/i.png',
    );
    assert.equal(
      safeIconUrl('https://cdn.icons.example.evil/i.png', ['*.icons.example']),
      undefined,
    );
  });
});
