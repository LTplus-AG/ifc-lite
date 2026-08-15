/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

/**
 * `runBinary` shells out to a downloaded native server. These tests never
 * download and never start a server: `child_process.spawn` is replaced with a
 * fake child, and the cache probe is satisfied by stubbing the two `fs`
 * predicates `isBinaryCached` consults, so nothing is written outside memory.
 */

const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn((_path: string) => true));
const readFileMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: spawnMock,
}));

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: existsSyncMock,
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  readFile: readFileMock,
}));

import { runBinary, getBinaryPath, getBinaryInfo, isBinaryCached } from '../src/binary.js';

const PKG_VERSION = '1.16.6';

class FakeChild extends EventEmitter {
  kill = vi.fn();
}

let child: FakeChild;

/**
 * `runBinary` awaits the cache probe before it spawns, so tests must wait for
 * the spawn to actually happen before emitting child events - otherwise the
 * event fires before any listener is attached and the assertion is vacuous.
 */
async function waitForSpawn(expectedCalls = 1): Promise<void> {
  for (let i = 0; i < 100 && spawnMock.mock.calls.length < expectedCalls; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (spawnMock.mock.calls.length < expectedCalls) {
    throw new Error(`spawn was not called ${expectedCalls} time(s)`);
  }
}

beforeEach(() => {
  child = new FakeChild();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(child);
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  readFileMock.mockReset();
  readFileMock.mockImplementation(async (path: string) =>
    String(path).endsWith('package.json')
      ? JSON.stringify({ version: PKG_VERSION })
      : PKG_VERSION
  );
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isBinaryCached', () => {
  it('is true only when the binary, the version sidecar and a matching version all line up', async () => {
    await expect(isBinaryCached()).resolves.toBe(true);
  });

  it('is false when the binary file is missing', async () => {
    existsSyncMock.mockImplementation((p: string) => !String(p).includes('ifc-lite-server'));
    await expect(isBinaryCached()).resolves.toBe(false);
  });

  it('is false when the version sidecar is missing', async () => {
    existsSyncMock.mockImplementation((p: string) => !String(p).endsWith('version.txt'));
    await expect(isBinaryCached()).resolves.toBe(false);
  });

  it('is false when the cached version differs from the package version', async () => {
    readFileMock.mockImplementation(async (path: string) =>
      String(path).endsWith('package.json') ? JSON.stringify({ version: PKG_VERSION }) : '0.0.1'
    );
    await expect(isBinaryCached()).resolves.toBe(false);
  });

  it('tolerates surrounding whitespace in the version sidecar', async () => {
    readFileMock.mockImplementation(async (path: string) =>
      String(path).endsWith('package.json') ? JSON.stringify({ version: PKG_VERSION }) : `  ${PKG_VERSION}\n`
    );
    await expect(isBinaryCached()).resolves.toBe(true);
  });

  it('is false (not a crash) when the version sidecar cannot be read', async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (String(path).endsWith('package.json')) return JSON.stringify({ version: PKG_VERSION });
      throw new Error('EACCES');
    });
    await expect(isBinaryCached()).resolves.toBe(false);
  });
});

describe('getBinaryPath / getBinaryInfo', () => {
  it('places the binary inside the package cache directory', () => {
    const info = getBinaryInfo();
    expect(getBinaryPath()).toBe(join(info.cacheDir, info.platform.binaryName));
    expect(info.cacheDir.endsWith('.cache')).toBe(true);
    expect(info.binaryPath.startsWith(info.cacheDir)).toBe(true);
  });

  it('reports cached only when BOTH the binary and the version sidecar exist', () => {
    expect(getBinaryInfo().isCached).toBe(true);

    existsSyncMock.mockImplementation((p: string) => !String(p).endsWith('version.txt'));
    expect(getBinaryInfo().isCached).toBe(false);

    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('version.txt'));
    expect(getBinaryInfo().isCached).toBe(false);
  });
});

describe('runBinary - exit code propagation', () => {
  it('resolves with the child exit code', async () => {
    const promise = runBinary([]);
    await waitForSpawn();
    child.emit('exit', 3, null);
    await expect(promise).resolves.toBe(3);
  });

  it('maps a clean exit to 0', async () => {
    const promise = runBinary([]);
    await waitForSpawn();
    child.emit('exit', 0, null);
    await expect(promise).resolves.toBe(0);
  });

  it('maps a null exit code to 0', async () => {
    const promise = runBinary([]);
    await waitForSpawn();
    child.emit('exit', null, null);
    await expect(promise).resolves.toBe(0);
  });

  it('maps SIGINT to 130, SIGTERM to 143 and anything else to 129', async () => {
    const cases = [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
      ['SIGKILL', 129],
    ] as const;
    for (const [index, [signal, expected]] of cases.entries()) {
      const local = new FakeChild();
      spawnMock.mockReturnValueOnce(local);
      const promise = runBinary([]);
      await waitForSpawn(index + 1);
      local.emit('exit', null, signal);
      await expect(promise).resolves.toBe(expected);
    }
  });

  it('prefers the signal mapping over the numeric code when both are present', async () => {
    const promise = runBinary([]);
    await waitForSpawn();
    child.emit('exit', 0, 'SIGTERM');
    await expect(promise).resolves.toBe(143);
  });

  it('rejects with a spawn failure message when the child cannot start', async () => {
    const promise = runBinary([]);
    await waitForSpawn();
    child.emit('error', new Error('ENOENT'));
    await expect(promise).rejects.toThrow(/Failed to start server: ENOENT/);
  });
});

describe('runBinary - argument and signal plumbing', () => {
  it('passes the caller args straight through to the binary with inherited stdio', async () => {
    const promise = runBinary(['--flag', 'value']);
    await waitForSpawn();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binaryPath, args, options] = spawnMock.mock.calls[0];
    expect(binaryPath).toBe(getBinaryPath());
    expect(args).toEqual(['--flag', 'value']);
    expect(options.stdio).toBe('inherit');
    expect(options.env).toBe(process.env);
    child.emit('exit', 0, null);
    await promise;
  });

  it('defaults to an empty argument list', async () => {
    const promise = runBinary();
    await waitForSpawn();
    expect(spawnMock.mock.calls[0][1]).toEqual([]);
    child.emit('exit', 0, null);
    await promise;
  });

  it('forwards SIGINT, SIGTERM and SIGHUP to the child while it runs', async () => {
    const promise = runBinary([]);
    await waitForSpawn();
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.emit(sig as NodeJS.Signals);
      expect(child.kill).toHaveBeenCalledWith(sig);
    }
    child.emit('exit', 0, null);
    await promise;
  });

  it('removes its signal listeners once the child exits, so a later signal is not forwarded', async () => {
    const before = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => process.listenerCount(s));
    const promise = runBinary([]);
    await waitForSpawn();
    child.emit('exit', 0, null);
    await promise;

    const after = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => process.listenerCount(s));
    expect(after).toEqual(before);

    child.kill.mockClear();
    process.emit('SIGINT');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('removes its signal listeners when the child fails to start', async () => {
    const before = process.listenerCount('SIGTERM');
    const promise = runBinary([]);
    await waitForSpawn();
    child.emit('error', new Error('boom'));
    await expect(promise).rejects.toThrow();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('does not accumulate listeners across repeated runs', async () => {
    const before = process.listenerCount('SIGINT');
    for (let i = 0; i < 5; i++) {
      const local = new FakeChild();
      spawnMock.mockReturnValueOnce(local);
      const promise = runBinary([]);
      await waitForSpawn(i + 1);
      local.emit('exit', 0, null);
      await promise;
    }
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
