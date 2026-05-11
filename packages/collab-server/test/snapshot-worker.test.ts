/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollabDoc } from '@ifc-lite/collab';
import { MemoryPersistence } from '../src/persistence.js';
import { RoomManager } from '../src/room-manager.js';
import { SnapshotWorker } from '../src/snapshot-worker.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-snap-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SnapshotWorker', () => {
  it('writes one .ifcx file per active room and skips idle rooms', async () => {
    const mgr = new RoomManager({ persistence: new MemoryPersistence() });
    const active = await mgr.getOrCreate('room-active');
    // Force at least one peer count > 0 by inserting a stub conn so
    // includeIdle=false picks this room.
    active.addConnection({
      ws: {
        readyState: 1,
        OPEN: 1,
        send: () => {},
        close: () => {},
        terminate: () => {},
      } as unknown as import('ws').WebSocket,
      principal: { userId: 'u', role: 'editor' },
      awarenessClients: new Set<number>(),
    });
    await mgr.getOrCreate('room-idle');

    // Seed something tangible into the active room's doc.
    const ents = active.doc.getMap('entities');
    active.doc.transact(() => {
      const seedDoc = createCollabDoc();
      // We just want a non-empty entities map on the actual room doc.
      ents.set('wall', new (active.doc.getMap('entities').constructor as new () => unknown)() as never);
      void seedDoc;
    });
    // Easier: directly set a primitive value to make the doc non-empty.
    const meta = active.doc.getMap('meta');
    active.doc.transact(() => meta.set('seed', 1));

    const worker = new SnapshotWorker({
      roomManager: mgr,
      outputDir: tmpDir,
      intervalMs: 60_000,
    });
    const results = await worker.runOnce();
    expect(results.length).toBe(1);
    expect(results[0].roomId).toBe('room-active');
    expect(fs.existsSync(results[0].filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(results[0].filePath, 'utf-8'));
    expect(content.header.ifcxVersion).toBeDefined();

    await mgr.unloadAll();
  });

  it('runs idle rooms when includeIdle is set', async () => {
    const mgr = new RoomManager({ persistence: new MemoryPersistence() });
    await mgr.getOrCreate('room-x');
    const worker = new SnapshotWorker({
      roomManager: mgr,
      outputDir: tmpDir,
      intervalMs: 60_000,
      includeIdle: true,
    });
    const results = await worker.runOnce();
    expect(results.length).toBe(1);
    await mgr.unloadAll();
  });
});
