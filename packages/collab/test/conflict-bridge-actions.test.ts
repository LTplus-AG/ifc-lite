/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, setAttribute, getAttribute } from '../src/doc/entity.js';
import { createConflictDetector } from '../src/conflicts/detector.js';
import { createConflictUIBridge } from '../src/conflicts/ui-bridge.js';

describe('conflict bridge: keepMine / acceptTheirs', () => {
  it('runs the registered keepMine handler and closes the bucket', async () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    a.transact(() => createEntity(a, 'wall'));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const detector = createConflictDetector(a, { windowMs: 60_000 });
    const bridge = createConflictUIBridge(detector, { closeAfterMs: 60_000 });

    const keepMine = vi.fn();
    bridge.onKeepMine('attribute', keepMine);

    a.transact(() => setAttribute(a, 'wall', 'Name', 'A-version'));
    b.transact(() => setAttribute(b, 'wall', 'Name', 'B-version'));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));

    const key = bridge.active()[0].key;
    const ok = await bridge.keepMine(key);
    expect(ok).toBe(true);
    expect(keepMine).toHaveBeenCalledOnce();
    expect(keepMine.mock.calls[0][0].bucket.kind).toBe('attribute');
    expect(bridge.active()).toEqual([]);

    bridge.destroy();
    detector.destroy();
  });

  it('acceptTheirs runs its handler', async () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    a.transact(() => createEntity(a, 'wall'));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const detector = createConflictDetector(a, { windowMs: 60_000 });
    const bridge = createConflictUIBridge(detector, { closeAfterMs: 60_000 });
    const acceptTheirs = vi.fn();
    bridge.onAcceptTheirs('attribute', acceptTheirs);

    a.transact(() => setAttribute(a, 'wall', 'Name', 'A'));
    b.transact(() => setAttribute(b, 'wall', 'Name', 'B'));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));

    const key = bridge.active()[0].key;
    const ok = await bridge.acceptTheirs(key);
    expect(ok).toBe(true);
    expect(acceptTheirs).toHaveBeenCalledOnce();

    bridge.destroy();
    detector.destroy();
  });

  it('keepMine handler can dispatch a follow-up CRDT edit', async () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    a.transact(() => createEntity(a, 'wall'));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const detector = createConflictDetector(a, { windowMs: 60_000 });
    const bridge = createConflictUIBridge(detector, { closeAfterMs: 60_000 });

    bridge.onKeepMine('attribute', ({ bucket }) => {
      // Re-assert "my" value.
      a.transact(() => setAttribute(a, bucket.path, bucket.field!, 'A-WINS'));
    });

    a.transact(() => setAttribute(a, 'wall', 'Name', 'A'));
    b.transact(() => setAttribute(b, 'wall', 'Name', 'B'));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));

    const key = bridge.active()[0].key;
    await bridge.keepMine(key);
    expect(getAttribute(a, 'wall', 'Name')).toBe('A-WINS');

    bridge.destroy();
    detector.destroy();
  });
});
