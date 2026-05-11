/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, setAttribute } from '../src/doc/entity.js';
import { createConflictDetector } from '../src/conflicts/detector.js';
import { createConflictUIBridge, type BridgeEvent } from '../src/conflicts/ui-bridge.js';

describe('conflict UI bridge', () => {
  it('opens, updates, and closes buckets in response to detector events', async () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    a.transact(() => createEntity(a, 'wall'));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const detector = createConflictDetector(a, { windowMs: 60_000 });
    const bridge = createConflictUIBridge(detector, { closeAfterMs: 50 });
    const events: BridgeEvent[] = [];
    bridge.on((e) => events.push(e));

    a.transact(() => setAttribute(a, 'wall', 'Name', 'A'));
    b.transact(() => setAttribute(b, 'wall', 'Name', 'B'));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));

    expect(bridge.active().length).toBe(1);
    const opened = events.filter((e) => e.type === 'open');
    expect(opened.length).toBe(1);
    expect(opened[0].bucket.kind).toBe('attribute');
    expect(opened[0].bucket.path).toBe('wall');
    expect(opened[0].bucket.field).toBe('Name');

    // Wait for the idle close.
    await new Promise((r) => setTimeout(r, 1100));
    expect(bridge.active().length).toBe(0);
    expect(events.some((e) => e.type === 'close')).toBe(true);

    bridge.destroy();
    detector.destroy();
  });

  it('resolve(key) closes a bucket immediately', async () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    a.transact(() => createEntity(a, 'wall'));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const detector = createConflictDetector(a, { windowMs: 60_000 });
    const bridge = createConflictUIBridge(detector, { closeAfterMs: 60_000 });
    const events: BridgeEvent[] = [];
    bridge.on((e) => events.push(e));

    a.transact(() => setAttribute(a, 'wall', 'Name', 'A'));
    b.transact(() => setAttribute(b, 'wall', 'Name', 'B'));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));

    const key = bridge.active()[0].key;
    expect(bridge.resolve(key)).toBe(true);
    expect(bridge.active().length).toBe(0);
    expect(events.find((e) => e.type === 'close')!.bucket.key).toBe(key);

    bridge.destroy();
    detector.destroy();
  });
});
