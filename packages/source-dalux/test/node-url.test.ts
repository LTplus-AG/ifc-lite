/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parsing the user-entered Dalux base URL (#2792).
 *
 * Dalux prints a per-customer base URL next to the API key, so users paste the
 * whole thing. Only the node NAME survives: the relay assembles the origin
 * itself, because forwarding a user-supplied host would point a relay that
 * carries the caller's API key at anywhere they name.
 */

import { describe, expect, it } from 'vitest';
import { parseDaluxNode } from '../src/provider.js';

describe('parseDaluxNode', () => {
  it('keeps the node from a pasted base URL', () => {
    expect(parseDaluxNode('https://node2.field.dalux.com/service/api')).toBe('node2');
    expect(parseDaluxNode('https://node10.field.dalux.com/service/api')).toBe('node10');
    // Trailing whitespace and a missing scheme are ordinary paste damage.
    expect(parseDaluxNode('  https://node3.field.dalux.com/service/api  ')).toBe('node3');
    expect(parseDaluxNode('node4.field.dalux.com/service/api')).toBe('node4');
  });

  it('sends nothing for blank input or the default node', () => {
    // The common case must add no parameter at all, so the node1 majority is
    // byte-for-byte unaffected by this change.
    for (const blank of [undefined, null, '', '   ']) {
      expect(parseDaluxNode(blank)).toBeUndefined();
    }
    expect(parseDaluxNode('https://node1.field.dalux.com/service/api')).toBeUndefined();
  });

  it('rejects anything that is not a Dalux field node', () => {
    const hostile = [
      'https://evil.com/service/api',
      'https://node2.field.dalux.com.evil.com/service/api',
      'https://node2.evil.com',
      'https://field.dalux.com',
      'https://node0.field.dalux.com',
      'https://node.field.dalux.com',
      'https://node01.field.dalux.com',
      'https://user@evil.com',
      'not a url at all',
    ];
    for (const raw of hostile) {
      expect(() => parseDaluxNode(raw), `${raw} was accepted`).toThrow(/Not a (valid )?Dalux/);
    }
  });

  it('ignores the scheme, because only the node name is kept', () => {
    // The relay always builds https:// from the node name, so a pasted http://
    // URL cannot downgrade anything: the scheme never leaves this function.
    expect(parseDaluxNode('http://node2.field.dalux.com/service/api')).toBe('node2');
  });

  it('fails loudly on a wrong URL instead of silently using node1', () => {
    // Falling back would present as "my API key does not work", which is what
    // sent the original reporter looking in the wrong place.
    expect(() => parseDaluxNode('https://nodeX.field.dalux.com')).toThrow(/Not a Dalux node URL/);
  });
});
