/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `dispatchToBackend` takes `namespace` and `method` straight off the wire, so
 * its own doc comment requires own-property lookups: an attacker must not be
 * able to reach `__proto__`, `constructor`, `toString` or anything inherited
 * from a host class.
 *
 * Nothing exercised that. Replacing both `Object.prototype.hasOwnProperty.call`
 * guards with plain `in` — which walks the prototype chain, exactly the reach
 * the comment warns about — left the suite green at 51/51.
 *
 * This is a PUBLISHED surface, not internal wiring: `dispatchToBackend` and
 * `BimHost` both appear in `scripts/api-surface.json`, so third-party code
 * calls it directly.
 *
 * The assertions check the specific rejection message rather than "it threw".
 * A dispatcher that rejected everything would satisfy a bare `throws`, so each
 * case is paired with a positive control proving a legitimate call on the same
 * backend still dispatches.
 */

import { describe, it, expect, vi } from 'vitest';
import { dispatchToBackend } from './types.js';
import type { BimBackend } from './types.js';

function backendWithOneNamespace() {
  return {
    model: {
      list: vi.fn(() => ['ok']),
    },
  } as unknown as BimBackend;
}

describe('dispatchToBackend — prototype-chain reach', () => {
  it('dispatches a legitimate own-property namespace and method (positive control)', () => {
    const backend = backendWithOneNamespace();
    expect(dispatchToBackend(backend, 'model', 'list', [])).toEqual(['ok']);
  });

  it.each([['__proto__'], ['constructor'], ['toString']])(
    'refuses %s as a namespace',
    (namespace) => {
      const backend = backendWithOneNamespace();
      expect(() => dispatchToBackend(backend, namespace, 'list', [])).toThrow(
        /Unknown namespace/
      );
    }
  );

  it.each([['__proto__'], ['constructor'], ['toString'], ['hasOwnProperty']])(
    'refuses %s as a method on a real namespace',
    (method) => {
      const backend = backendWithOneNamespace();
      expect(() => dispatchToBackend(backend, 'model', method, [])).toThrow(
        /Unknown method/
      );
    }
  );

  it('refuses a method inherited from a host class rather than declared on the namespace', () => {
    // The other half of the doc comment: a namespace implemented as a class
    // instance exposes its methods on the PROTOTYPE, not as own properties.
    // An `in` lookup would happily dispatch to them.
    class HostNamespace {
      allowed(): string {
        return 'allowed';
      }
    }
    const backend = { model: new HostNamespace() } as unknown as BimBackend;

    expect(() => dispatchToBackend(backend, 'model', 'allowed', [])).toThrow(
      /Unknown method/
    );
  });
});
