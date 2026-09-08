/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SpacePlateSession } from '@/lib/space-plate-session.js';
import { acquireSession } from './session-registry.js';

/**
 * A stand-in for `SpacePlateSession`. The real class only allocates its wasm
 * handle in `build*`, so identity is all these cases need — and constructing
 * the real one would drag `@ifc-lite/wasm` into a node test.
 */
function makeFake(tag: string): SpacePlateSession {
  return { tag } as unknown as SpacePlateSession;
}

describe('acquireSession', () => {
  it('creates and registers a session for a storey that has none', () => {
    const registry = new Map<number, SpacePlateSession>();
    let made = 0;
    const session = acquireSession(registry, 7, null, false, () => {
      made++;
      return makeFake('new');
    });
    assert.equal(made, 1, 'a storey with no session must get one built');
    assert.ok(session);
    assert.equal(registry.get(7), session, 'the new session is registered under its storey');
  });

  it('reuses the storey session instead of building a second one', () => {
    const existing = makeFake('existing');
    const registry = new Map<number, SpacePlateSession>([[7, existing]]);
    let made = 0;
    const session = acquireSession(registry, 7, null, false, () => {
      made++;
      return makeFake('new');
    });
    assert.equal(made, 0, 'an existing storey session must not be replaced');
    assert.equal(session, existing);
  });

  it('falls back to the active session when there is no storey', () => {
    const active = makeFake('active');
    const registry = new Map<number, SpacePlateSession>();
    let made = 0;
    const session = acquireSession(registry, null, active, false, () => {
      made++;
      return makeFake('new');
    });
    assert.equal(made, 0);
    assert.equal(session, active);
    assert.equal(registry.size, 0, 'the storey-less path never registers');
  });

  it('allocates nothing once the overlay is disposed', () => {
    // The leak this guard exists for: `buildFrom` suspends on
    // `ensureSpaceWasm()`, unmount disposes every session and clears the
    // registry, then the build resumes. Without the guard it constructs a
    // session, builds a wasm plate into it, and registers it into a map
    // nothing will ever walk again.
    const registry = new Map<number, SpacePlateSession>();
    let made = 0;
    const session = acquireSession(registry, 7, null, true, () => {
      made++;
      return makeFake('leaked');
    });
    assert.equal(session, null, 'a disposed overlay must not hand back a session');
    assert.equal(made, 0, 'a disposed overlay must not construct one either');
    assert.equal(registry.size, 0, 'and must not repopulate the cleared registry');
  });

  it('allocates nothing once disposed even on the storey-less path', () => {
    let made = 0;
    const session = acquireSession(new Map(), null, null, true, () => {
      made++;
      return makeFake('leaked');
    });
    assert.equal(session, null);
    assert.equal(made, 0);
  });
});
