/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, vi } from 'vitest';

import type { CallbackProbe } from './__tests__/bcf-record-callback-hooks.js';
const probe = vi.hoisted(() => ({ reads: 0, closes: 0 } as CallbackProbe));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { forwardingFs } = await import('./__tests__/bcf-record-callback-hooks.js');
  return forwardingFs(actual, probe);
});

import { appendFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readPublicationRecord } from './bcf-publication-record.js';
import { MAX_RECORD_BYTES } from './bcf-publication-codec.js';
const directories: string[] = [];
afterEach(async () => {
  probe.afterStat = undefined; probe.afterClose = undefined; probe.readError = undefined; probe.closeError = undefined;
  probe.reads = 0; probe.closes = 0;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function file(bytes: string | Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'bcf-callback-record-')); directories.push(directory);
  const path = join(directory, 'receipt.json'); await writeFile(path, bytes); return path;
}
function deferred() {
  let resolve: () => void = () => { throw new Error('Uninitialized gate'); };
  const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve };
}

it('does not acknowledge actual record bytes until its real fd is closed (#7637)', async () => {
  const path = await file('{"receipt":"actual disk"}'), closed = deferred(), released = deferred();
  let status = 'pending', actualFd = -1;
  probe.afterClose = (fd, deliver) => {
    actualFd = fd; closed.resolve(); void released.promise.then(deliver);
  };
  const result = readPublicationRecord(path).then(value => { status = 'fulfilled'; return value; }, error => {
    status = 'rejected'; throw error;
  });
  try {
    await closed.promise; expect(status).toBe('pending');
    expect(() => fstatSync(actualFd)).toThrow(/EBADF/);
    released.resolve(); expect(await result).toEqual({ receipt: 'actual disk' }); expect(probe.closes).toBe(1);
  } finally { released.resolve(); await result; }
});

it('refuses same-inode valid-JSON growth after real fstat and recovers on a fresh read (#7637)', async () => {
  const path = await file('{"receipt":"unchanged"}'); let realFd = -1;
  probe.afterStat = (fd, stat, deliver) => {
    realFd = fd; const real = fstatSync(fd); expect([real.dev, real.ino]).toEqual([stat.dev, stat.ino]);
    void appendFile(path, ' ').then(() => { deliver(); }, (error: unknown) => {
      deliver(error instanceof Error ? error : new Error(String(error)));
    });
  };
  let repairs = 0;
  await expect(readPublicationRecord(path, async () => { repairs += 1; })).rejects.toThrow(/grew while reading/);
  expect(repairs).toBe(0); expect(probe.closes).toBe(1); expect(() => fstatSync(realFd)).toThrow(/EBADF/);
  probe.afterStat = undefined;
  expect(await readPublicationRecord(path)).toEqual({ receipt: 'unchanged' }); expect(probe.closes).toBe(2);
});

it('repairs the directory before parsing malformed JSON and closes before refusal (#7637)', async () => {
  const path = await file('{broken'); let repairs = 0, actualFd = -1;
  probe.afterStat = (fd, _stat, deliver) => { actualFd = fd; deliver(); };
  await expect(readPublicationRecord(path, async () => { repairs += 1; })).rejects.toBeInstanceOf(SyntaxError);
  expect(repairs).toBe(1); expect(probe.closes).toBe(1); expect(() => fstatSync(actualFd)).toThrow(/EBADF/);
});

it('closes actual descriptors on read or directory-sync failure before recovery (#7637)', async () => {
  const path = await file('{"retained":true}'); let actualFd = -1;
  probe.afterStat = (fd, _stat, deliver) => { actualFd = fd; deliver(); };
  probe.readError = Object.assign(new Error('Read EIO'), { code: 'EIO' });
  await expect(readPublicationRecord(path)).rejects.toThrow('Read EIO'); expect(probe.closes).toBe(1);
  expect(() => fstatSync(actualFd)).toThrow(/EBADF/); probe.readError = undefined;
  await expect(readPublicationRecord(path, async () => { throw new Error('Directory EIO'); })).rejects.toThrow('Directory EIO');
  expect(probe.closes).toBe(2); expect(() => fstatSync(actualFd)).toThrow(/EBADF/);
  expect(await readPublicationRecord(path)).toEqual({ retained: true }); expect(probe.closes).toBe(3);
});

it('reports close failure over an earlier parse failure after actually closing the fd (#7637)', async () => {
  const path = await file('{broken'); let actualFd = -1;
  probe.afterStat = (fd, _stat, deliver) => { actualFd = fd; deliver(); };
  probe.closeError = Object.assign(new Error('Close EIO'), { code: 'EIO' });
  await expect(readPublicationRecord(path)).rejects.toThrow('Close EIO'); expect(probe.closes).toBe(1);
  expect(() => fstatSync(actualFd)).toThrow(/EBADF/);
});

it('refuses a real oversized file before reading and closes its descriptor (#7637)', async () => {
  const path = await file(Buffer.alloc(MAX_RECORD_BYTES + 1, 32));
  await expect(readPublicationRecord(path)).rejects.toThrow(/oversized/);
  expect(probe.reads).toBe(0); expect(probe.closes).toBe(1);
});

it.skipIf(process.platform !== 'linux')('refuses an actual symlink without opening its target (#7637)', async () => {
  const path = await file('{"private":true}'), alias = `${path}.link`; await symlink(path, alias);
  await expect(readPublicationRecord(alias)).rejects.toThrow(); expect(probe.reads).toBe(0); expect(probe.closes).toBe(0);
});

it.skipIf(process.platform !== 'linux')('refuses an actual FIFO without blocking or reading it (#7637)', async () => {
  const path = await file('replace me with a FIFO'); await rm(path); execFileSync('mkfifo', [path]);
  await expect(readPublicationRecord(path)).rejects.toThrow(/invalid/);
  expect(probe.reads).toBe(0); expect(probe.closes).toBe(1);
});
