/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6581, unit level: the claim ledger and the room-log check behind
 * `createAccessControl`, for failures the HTTP routes cannot provoke. Through
 * the routes, the room-log check answers before the ledger's own guard can
 * see a throw, so each guard is pinned here on its own.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoomClaims } from '../src/room-claims.js';
import { hasPersistedRoomLog } from '../src/access-control-state.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-room-claims-'));
  tmpDirs.push(dir);
  return dir;
}

describe('#6581 room-log check', () => {
  it('answers "has data" when it cannot tell, and only then', () => {
    const dir = freshDir();
    const notADir = path.join(dir, 'plain-file');
    fs.writeFileSync(notADir, 'x');
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(hasPersistedRoomLog(notADir, 'room'), 'ENOTDIR: cannot tell').toBe(true);
      expect(hasPersistedRoomLog(dir, '\ud800'), 'no encoded form: cannot tell').toBe(true);
      expect(warned).toHaveBeenCalledTimes(2);
    } finally {
      warned.mockRestore();
    }
    expect(hasPersistedRoomLog(dir, 'room'), 'no log').toBe(false);
    expect(hasPersistedRoomLog(dir, 'x'.repeat(400)), 'a name too long to exist').toBe(false);
    fs.writeFileSync(path.join(dir, 'room.log'), 'x');
    expect(hasPersistedRoomLog(dir, 'room')).toBe(true);
  });
});

describe('#6581 claim ledger', () => {
  it('a content check that throws keeps that one claim and lets the pass finish', () => {
    const now = Math.floor(Date.now() / 1000);
    const past = now - 3600;
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ledger = createRoomClaims({
        maxClaimedRooms: 10,
        claimedRooms: [],
        pendingClaims: new Map([
          ['throws', { at: past, tokens: new Map([['a', past]]) }],
          ['plain', { at: past, tokens: new Map([['b', past]]) }],
        ]),
        hasContent: (room) => {
          if (room === 'throws') throw new Error('cannot check');
          return false;
        },
      });
      expect(() => ledger.expire(now)).not.toThrow();
      expect(ledger.has('plain'), 'the other claim still expired').toBe(false);
      expect(ledger.has('throws')).toBe(true);
      expect(ledger.isPending('throws'), 'kept as in use, never evaluated again').toBe(false);
    } finally {
      warned.mockRestore();
    }
  });
});
