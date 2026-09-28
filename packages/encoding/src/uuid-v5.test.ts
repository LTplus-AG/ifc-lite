/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { uuidV5 } from './uuid-v5.js';
import { isValidUuid, uuidToIfcGuid } from './guid.js';

const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const URL_NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

describe('uuidV5 (RFC 9562 §5.5)', () => {
  it('matches the RFC test vector', () => {
    // RFC 9562 Appendix A.4: v5 of "www.example.com" in the DNS namespace.
    expect(uuidV5(DNS, 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('matches the reference `uuid` package on multi-block and non-ASCII names', () => {
    // Expected values computed with `uuid@11`'s `v5(name, URL)`: 200 × "x"
    // spans four SHA-1 blocks, and "Wand – Süd" needs UTF-8 name encoding.
    expect(uuidV5(URL_NS, 'x'.repeat(200))).toBe('cd3580b9-d244-586a-8077-74317319b48d');
    expect(uuidV5(URL_NS, 'Wand – Süd')).toBe('8de8a94f-6b4f-515d-a8f9-67ffb02f518a');
  });

  it('is a version-5, RFC-variant UUID that encodes to a valid IFC GlobalId', () => {
    const id = uuidV5(URL_NS, '3wdauVJT5Fx9drrREiDqA$/split/0');
    expect(isValidUuid(id)).toBe(true);
    expect(id[14]).toBe('5');
    expect('89ab').toContain(id[19]);
    expect(uuidToIfcGuid(id)).toHaveLength(22);
  });

  it('separates names and namespaces', () => {
    expect(uuidV5(URL_NS, 'a')).not.toBe(uuidV5(URL_NS, 'b'));
    expect(uuidV5(URL_NS, 'a')).not.toBe(uuidV5(DNS, 'a'));
  });

  it('rejects a malformed namespace', () => {
    expect(() => uuidV5('not-a-uuid', 'a')).toThrow(/namespace/);
  });
});
