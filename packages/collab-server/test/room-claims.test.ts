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

/** A `stat` that fails with `code`, as the file system would; no host file system involved. */
function failingStat(code: string): (file: string) => never {
  return (file) => {
    throw Object.assign(new Error(`${code}: stat '${file}'`), { code });
  };
}

describe('#6581 room-log check', () => {
  it('answers "has data" when it cannot tell: an I/O error, or an id with no encoded form', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(hasPersistedRoomLog('/data', 'room', failingStat('EACCES')), 'EACCES').toBe(true);
      expect(hasPersistedRoomLog('/data', 'room', failingStat('EIO')), 'EIO').toBe(true);
      expect(hasPersistedRoomLog('/data', '\ud800', failingStat('ENOENT')), 'no encoded form').toBe(true);
      expect(warned).toHaveBeenCalledTimes(3);
    } finally {
      warned.mockRestore();
    }
  });

  it('answers "no log" when no file can be at the path, on every platform', () => {
    // ENOTDIR: a component of the data dir is not a directory. Node's
    // `throwIfNoEntry: false` hides it on Linux and raises it on macOS, so it
    // is injected here rather than provoked.
    for (const code of ['ENOENT', 'ENOTDIR', 'ENAMETOOLONG']) {
      expect(hasPersistedRoomLog('/data', 'room', failingStat(code)), code).toBe(false);
    }
  });

  it('finds a log under its encoded name on the real file system', () => {
    const dir = freshDir();
    expect(hasPersistedRoomLog(dir, 'a/b'), 'no log').toBe(false);
    fs.writeFileSync(path.join(dir, `${encodeURIComponent('a/b')}.log`), 'x');
    expect(hasPersistedRoomLog(dir, 'a/b')).toBe(true);
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
