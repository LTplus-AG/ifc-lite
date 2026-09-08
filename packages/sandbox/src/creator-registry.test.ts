/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The session-scoped IfcCreator registry, which had no test of its own.
 * Cross-session isolation was covered (bridge-schema.test.ts); the handle
 * lifecycle inside one session was not:
 *
 *   - the per-session counter must ADVANCE, or a script that calls
 *     `bim.create.project()` twice gets handle 1 both times and the second
 *     creator silently replaces the first — the user's first model is gone
 *     with no error anywhere;
 *   - `removeSession` — the sandbox's own teardown path, via
 *     `disposeSchemaNamespaceSession` — must actually drop the creators, or a
 *     disposed sandbox keeps whole IfcCreator models alive for the life of the
 *     process.
 *
 * Both survived mutation with the package suite green.
 */

import { describe, expect, it } from 'vitest';
import { IfcCreator } from '@ifc-lite/sdk';
import { creatorRegistry } from './creator-registry.js';

/** A fresh session id per test — the registry is a module-level singleton. */
let nextSession = 0;
const session = (): string => `test-session-${++nextSession}`;

describe('creatorRegistry handle allocation', () => {
  it('gives every creator in a session a distinct handle', () => {
    const s = session();
    const first = new IfcCreator({ Name: 'First' });
    const second = new IfcCreator({ Name: 'Second' });
    const third = new IfcCreator({ Name: 'Third' });

    const h1 = creatorRegistry.registerForSession(s, first);
    const h2 = creatorRegistry.registerForSession(s, second);
    const h3 = creatorRegistry.registerForSession(s, third);

    expect(new Set([h1, h2, h3]).size).toBe(3);
    // Each handle still resolves to the creator it was issued for — a counter
    // that does not advance would make all three answer the last creator.
    expect(creatorRegistry.getForSession(s, h1)).toBe(first);
    expect(creatorRegistry.getForSession(s, h2)).toBe(second);
    expect(creatorRegistry.getForSession(s, h3)).toBe(third);

    creatorRegistry.removeSession(s);
  });

  it('keeps advancing while any creator in the session is still live', () => {
    const s = session();
    const keep = new IfcCreator({ Name: 'Keep' });
    const drop = new IfcCreator({ Name: 'Drop' });
    const hKeep = creatorRegistry.registerForSession(s, keep);
    const hDrop = creatorRegistry.registerForSession(s, drop);

    creatorRegistry.removeForSession(s, hDrop);
    const hNext = creatorRegistry.registerForSession(s, new IfcCreator({ Name: 'Next' }));

    // The session is not empty (hKeep is live), so the counter is intact and
    // the freed handle is NOT handed out again while a stale script reference
    // to it could still exist.
    expect(hNext).not.toBe(hKeep);
    expect(hNext).not.toBe(hDrop);
    expect(creatorRegistry.getForSession(s, hKeep)).toBe(keep);
    expect(() => creatorRegistry.getForSession(s, hDrop)).toThrow(/Invalid creator handle/);

    creatorRegistry.removeSession(s);
  });

  it('numbers each session from its own counter', () => {
    const a = session();
    const b = session();
    const creatorA1 = new IfcCreator({ Name: 'A1' });
    const creatorA2 = new IfcCreator({ Name: 'A2' });
    const creatorB1 = new IfcCreator({ Name: 'B1' });

    const ha1 = creatorRegistry.registerForSession(a, creatorA1);
    const ha2 = creatorRegistry.registerForSession(a, creatorA2);
    const hb1 = creatorRegistry.registerForSession(b, creatorB1);

    // Session b starts its own numbering rather than continuing a's, so a's
    // second handle and b's first are different numbers...
    expect(ha2).not.toBe(hb1);
    // ...and each session resolves its own handles to its own creators.
    expect(creatorRegistry.getForSession(a, ha1)).toBe(creatorA1);
    expect(creatorRegistry.getForSession(a, ha2)).toBe(creatorA2);
    expect(creatorRegistry.getForSession(b, hb1)).toBe(creatorB1);
    // Session a's second handle does not exist in b at all.
    expect(() => creatorRegistry.getForSession(b, ha2)).toThrow(/Invalid creator handle/);

    creatorRegistry.removeSession(a);
    creatorRegistry.removeSession(b);
  });
});

describe('creatorRegistry teardown', () => {
  it('removeSession drops every creator the session held', () => {
    const s = session();
    const handles = [
      creatorRegistry.registerForSession(s, new IfcCreator({ Name: 'One' })),
      creatorRegistry.registerForSession(s, new IfcCreator({ Name: 'Two' })),
    ];

    creatorRegistry.removeSession(s);

    // Not just "the counter was cleared": every handle must be gone, which is
    // the observable half of not leaking the creators.
    for (const handle of handles) {
      expect(() => creatorRegistry.getForSession(s, handle)).toThrow(/Invalid creator handle/);
    }
  });

  it('removeForSession drops only the handle asked for', () => {
    const s = session();
    const keep = new IfcCreator({ Name: 'Keep' });
    const drop = new IfcCreator({ Name: 'Drop' });
    const hKeep = creatorRegistry.registerForSession(s, keep);
    const hDrop = creatorRegistry.registerForSession(s, drop);

    creatorRegistry.removeForSession(s, hDrop);

    expect(creatorRegistry.getForSession(s, hKeep)).toBe(keep);
    expect(() => creatorRegistry.getForSession(s, hDrop)).toThrow(/Invalid creator handle/);

    creatorRegistry.removeSession(s);
  });

  it('restarts numbering once the session holds no creators at all', () => {
    // Documented rather than asserted as desirable: emptying a session drops
    // its counter along with its map, so the next handle starts over at 1.
    // Harmless today because the only way to empty a session is to remove
    // every creator in it, which invalidates every handle a script could hold.
    // Pinned so a change to that coupling is a deliberate one.
    const s = session();
    const first = creatorRegistry.registerForSession(s, new IfcCreator({ Name: 'First' }));
    creatorRegistry.removeForSession(s, first);
    const afterEmpty = creatorRegistry.registerForSession(s, new IfcCreator({ Name: 'Second' }));
    expect(afterEmpty).toBe(first);
    creatorRegistry.removeSession(s);
  });

  it('removeForSession on an unknown session is a no-op, not a throw', () => {
    expect(() => creatorRegistry.removeForSession('never-registered', 1)).not.toThrow();
    expect(() => creatorRegistry.removeSession('never-registered')).not.toThrow();
  });
});
