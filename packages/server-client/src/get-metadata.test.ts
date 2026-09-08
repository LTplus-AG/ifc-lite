/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getMetadata`'s scan diagnostics (#3791) are OPTIONAL on the wire, and the
 * difference between absent and zero is the whole point of the field: a
 * server too old to run the check reports nothing, and reading that as
 * "nothing was wrong" is exactly the silent-truncation this fixed.
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { IfcServerClient } from './client.js';
import type { MetadataResponse } from './types.js';

function stubFetch(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
  );
}

function client(): IfcServerClient {
  return new IfcServerClient({ baseUrl: 'https://example.invalid' });
}

/** What a server predating #3791 sends: the four original fields, nothing else. */
const OLDER_SERVER_BODY = {
  entity_count: 16,
  geometry_count: 1,
  schema_version: 'IFC4',
  file_size: 1234,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getMetadata scan diagnostics', () => {
  it('types both fields as possibly absent', () => {
    // The compile-time half of the runtime assertions below, and the half
    // that actually constrains callers: a required `number` would let a
    // consumer write `if (meta.oversized_id_count > 0)` and read an older
    // server's silence as a clean file. Fails typecheck if either field
    // goes back to being required.
    expectTypeOf<MetadataResponse['oversized_id_count']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<MetadataResponse['malformed_record_found']>().toEqualTypeOf<boolean | undefined>();
  });

  it('leaves both fields undefined when the server did not send them', async () => {
    stubFetch(OLDER_SERVER_BODY);

    const meta = await client().getMetadata(new ArrayBuffer(8));

    // `undefined`, not `0` / `false`: absence means the scan was never
    // reported on, which a caller must not round down to "clean".
    expect(meta.oversized_id_count).toBeUndefined();
    expect(meta.malformed_record_found).toBeUndefined();
    // And it is genuinely absent rather than present-and-falsy, so a
    // `'oversized_id_count' in meta` guard tells the two apart.
    expect('oversized_id_count' in meta).toBe(false);
    expect('malformed_record_found' in meta).toBe(false);
    expect(meta.entity_count).toBe(16);
  });

  it('passes both through when the server does send them', async () => {
    stubFetch({
      ...OLDER_SERVER_BODY,
      oversized_id_count: 1,
      malformed_record_found: true,
    });

    const meta = await client().getMetadata(new ArrayBuffer(8));

    expect(meta.oversized_id_count).toBe(1);
    expect(meta.malformed_record_found).toBe(true);
  });

  it('distinguishes a scanned-and-clean response from an unscanned one', async () => {
    stubFetch({
      ...OLDER_SERVER_BODY,
      oversized_id_count: 0,
      malformed_record_found: false,
    });

    const meta = await client().getMetadata(new ArrayBuffer(8));

    // The other direction of the first test: a current server that found
    // nothing sends explicit zeroes, which must NOT read as absent.
    expect(meta.oversized_id_count).toBe(0);
    expect(meta.malformed_record_found).toBe(false);
    expect('oversized_id_count' in meta).toBe(true);
  });
});
