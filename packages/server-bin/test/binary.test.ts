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
const execFileSyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn((_path: string) => true));
const chmodSyncMock = vi.hoisted(() => vi.fn());
const unlinkSyncMock = vi.hoisted(() => vi.fn());
const mkdirSyncMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
const verifyChecksumMock = vi.hoisted(() =>
  vi.fn(async (_archivePath: string, _assetUrl: string, _archiveName: string) => undefined)
);
const tarExtractMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
}));

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: existsSyncMock,
  chmodSync: chmodSyncMock,
  unlinkSync: unlinkSyncMock,
  mkdirSync: mkdirSyncMock,
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  readFile: readFileMock,
  writeFile: writeFileMock,
}));

vi.mock('../src/checksum.js', () => ({ verifyArchiveChecksum: verifyChecksumMock }));
vi.mock('tar', () => ({ extract: tarExtractMock }));

import { runBinary, downloadBinary, getBinaryPath, getBinaryInfo, isBinaryCached } from '../src/binary.js';

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
  execFileSyncMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  chmodSyncMock.mockReset();
  unlinkSyncMock.mockReset();
  mkdirSyncMock.mockReset();
  writeFileMock.mockReset();
  writeFileMock.mockImplementation(async () => undefined);
  verifyChecksumMock.mockReset();
  verifyChecksumMock.mockImplementation(async () => undefined);
  tarExtractMock.mockReset();
  tarExtractMock.mockImplementation(async () => undefined);
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

/**
 * The checksum gate exists so that unverified bytes are never extracted,
 * chmod'd or executed - but until these tests, nothing pinned that ORDER:
 * deleting the verifyArchiveChecksum call, or moving it after extraction,
 * kept every test green while reinstating exactly the fail-open defect the
 * gate replaced. Download, verification and extraction are all observable
 * seams here (fetch, checksum.js, tar/execFileSync are mocked), so the
 * assertions bind the sequence, not just the presence of a call.
 */
describe('downloadBinary - checksum verification gates extraction (PR #2650)', () => {
  /** Minimal fetch response whose body streams one chunk. */
  function fakeDownloadResponse() {
    const bytes = new TextEncoder().encode('archive-bytes');
    let drained = false;
    return {
      ok: true,
      headers: { get: () => String(bytes.length) },
      body: {
        getReader: () => ({
          read: async () =>
            drained ? { done: true, value: undefined } : ((drained = true), { done: false, value: bytes }),
        }),
      },
    };
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeDownloadResponse()));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Extraction is platform-forked: tar for tar.gz, execFileSync for zip. */
  function extractionCallOrders(): number[] {
    return [
      ...tarExtractMock.mock.invocationCallOrder,
      ...execFileSyncMock.mock.invocationCallOrder,
    ];
  }

  it('verifies the downloaded archive before extracting or chmodding it', async () => {
    await downloadBinary();

    expect(verifyChecksumMock).toHaveBeenCalledTimes(1);
    const [archivePath, assetUrl, archiveName] = verifyChecksumMock.mock.calls[0];
    const { platform } = getBinaryInfo();
    expect(archiveName).toBe(platform.archiveName);
    expect(String(archivePath).endsWith(platform.archiveName)).toBe(true);
    expect(String(assetUrl).endsWith(`/v${PKG_VERSION}/${platform.archiveName}`)).toBe(true);

    // Extraction must actually have been observed, or the ordering claim
    // below would be vacuously true.
    const extractions = extractionCallOrders();
    expect(extractions.length).toBeGreaterThan(0);

    const verifiedAt = verifyChecksumMock.mock.invocationCallOrder[0];
    for (const extractedAt of extractions) {
      expect(verifiedAt).toBeLessThan(extractedAt);
    }
    for (const chmoddedAt of chmodSyncMock.mock.invocationCallOrder) {
      expect(verifiedAt).toBeLessThan(chmoddedAt);
    }
  });

  it('verifies against the ALTERNATE URL that actually succeeded, not the primary one that failed', async () => {
    // The primary v${version} URL 404s; the server-v${version} alternate
    // succeeds. `resolvedAssetUrl` exists specifically so the checksum
    // sidecar is fetched from the release that produced the bytes on disk -
    // fetching it from the primary (failed) URL would 404 the sidecar too
    // and fail the whole install closed on an otherwise-good binary.
    const { platform } = getBinaryInfo();
    const primaryUrl = `https://github.com/LTplus-AG/ifc-lite/releases/download/v${PKG_VERSION}/${platform.archiveName}`;
    const altUrl = `https://github.com/LTplus-AG/ifc-lite/releases/download/server-v${PKG_VERSION}/${platform.archiveName}`;

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === primaryUrl) throw new Error('ENOTFOUND (primary)');
      return fakeDownloadResponse();
    }));

    await downloadBinary();

    expect(verifyChecksumMock).toHaveBeenCalledTimes(1);
    const [, assetUrl] = verifyChecksumMock.mock.calls[0];
    expect(assetUrl).toBe(altUrl);
    expect(assetUrl).not.toBe(primaryUrl);
  });

  it('extracts, chmods and persists NOTHING when verification fails', async () => {
    verifyChecksumMock.mockRejectedValueOnce(new Error('checksum mismatch (test)'));

    await expect(downloadBinary()).rejects.toThrow(/checksum mismatch \(test\)/);

    expect(extractionCallOrders()).toHaveLength(0);
    expect(chmodSyncMock).not.toHaveBeenCalled();
    const versionWrites = writeFileMock.mock.calls.filter(([p]) => String(p).endsWith('version.txt'));
    expect(versionWrites).toHaveLength(0);
  });
});

/**
 * #5525: server-bin 1.20.0 and 1.21.0 reached npm with no `v<version>` GitHub
 * release, so every platform 404'd. A clean 404 on every version-derived URL
 * now falls back to the newest OLDER release that carries this platform's
 * archive and a checksum, resolved through the GitHub releases API - and the
 * fallback is checksum-verified exactly like the primary download.
 */
describe('downloadBinary - fallback when the version has no release (#5525)', () => {
  const RELEASES = 'https://github.com/LTplus-AG/ifc-lite/releases/download';
  const API = 'https://api.github.com/repos/LTplus-AG/ifc-lite/releases';

  function archiveName(): string {
    return getBinaryInfo().platform.archiveName;
  }

  function okDownload() {
    const bytes = new TextEncoder().encode('fallback-archive-bytes');
    let drained = false;
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.length) },
      body: {
        getReader: () => ({
          read: async () =>
            drained ? { done: true, value: undefined } : ((drained = true), { done: false, value: bytes }),
        }),
      },
    };
  }

  function status(code: number, statusText: string, headers: Record<string, string> = {}) {
    return { ok: false, status: code, statusText, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } };
  }

  function json(body: unknown) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  }

  /** A `v<version>` release; `assets` lists asset names (the archive's own name via `$`). */
  function release(version: string, assets: string[], extra: Record<string, unknown> = {}) {
    return {
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      assets: assets.map((a) => {
        const name = a.replace('$', archiveName());
        return { name, state: 'uploaded', browser_download_url: `${RELEASES}/v${version}/${name}` };
      }),
      ...extra,
    };
  }

  let fetchMock: ReturnType<typeof vi.fn>;
  let apiBody: unknown;
  /** Body of each release's SHA256SUMS, by version; absent = 404. */
  let sums: Record<string, string>;
  const DIGEST = 'a'.repeat(64);

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiBody = [];
    sums = {};
    fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(API)) return json(apiBody);
      const sumsFor = /\/v([^/]+)\/SHA256SUMS$/.exec(url)?.[1];
      if (sumsFor !== undefined) {
        const body = sums[sumsFor];
        return body === undefined ? status(404, 'Not Found') : { ok: true, status: 200, text: async () => body };
      }
      // Every version-derived URL for the package version 404s.
      if (url.includes(`/v${PKG_VERSION}/`) || url.includes(`/server-v${PKG_VERSION}/`) || url.includes(`/${PKG_VERSION}/`)) {
        return status(404, 'Not Found');
      }
      return okDownload();
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the newest OLDER release carrying the archive plus a checksum, and verifies it', async () => {
    apiBody = [
      // Package-level releases share the listing and never carry archives.
      { tag_name: '@ifc-lite/wasm@10.0.0', draft: false, prerelease: false, assets: [] },
      // Newer than the requested version: never a fallback target.
      release('1.17.0', ['$', '$.sha256']),
      // Root-version release without server archives.
      release('9.2.0', []),
      release('1.16.5', ['$', '$.sha256'], { draft: true }),
      // Archive but no checksum: would fail closed, so skipped.
      release('1.16.4', ['$']),
      release('1.16.2', ['$', '$.sha256']),
      release('1.16.3', ['$', 'SHA256SUMS']),
    ];
    sums['1.16.3'] = `${DIGEST}  ${archiveName()}\n`;

    await downloadBinary();

    const expectedUrl = `${RELEASES}/v1.16.3/${archiveName()}`;
    expect(fetchMock.mock.calls.map(([u]) => u)).toContain(expectedUrl);
    expect(verifyChecksumMock).toHaveBeenCalledTimes(1);
    expect(verifyChecksumMock.mock.calls[0][1]).toBe(expectedUrl);
    expect(tarExtractMock.mock.calls.length + execFileSyncMock.mock.calls.length).toBeGreaterThan(0);

    const warning = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join('\n');
    expect(warning).toContain(PKG_VERSION);
    expect(warning).toContain('v1.16.3');
  });

  it('skips a release whose SHA256SUMS does not list this archive', async () => {
    // Newest candidate's shared SHA256SUMS covers another platform only: it
    // would download, then fail closed. The older release with a sidecar works.
    apiBody = [release('1.16.3', ['$', 'SHA256SUMS']), release('1.16.2', ['$', '$.sha256'])];
    sums['1.16.3'] = `${DIGEST}  ifc-lite-server-some-other-target.tar.gz\n`;

    await downloadBinary();

    const expectedUrl = `${RELEASES}/v1.16.2/${archiveName()}`;
    expect(verifyChecksumMock).toHaveBeenCalledTimes(1);
    expect(verifyChecksumMock.mock.calls[0][1]).toBe(expectedUrl);
    expect(fetchMock.mock.calls.map(([u]) => u)).not.toContain(`${RELEASES}/v1.16.3/${archiveName()}`);
  });

  it('extracts nothing when the fallback archive fails checksum verification', async () => {
    apiBody = [release('1.16.2', ['$', '$.sha256'])];
    verifyChecksumMock.mockRejectedValueOnce(new Error('checksum mismatch (fallback)'));

    await expect(downloadBinary()).rejects.toThrow(/checksum mismatch \(fallback\)/);

    expect(verifyChecksumMock.mock.calls[0][1]).toBe(`${RELEASES}/v1.16.2/${archiveName()}`);
    expect(tarExtractMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(chmodSyncMock).not.toHaveBeenCalled();
  });

  it('names the concrete npm fix, not Docker, when no release carries the archive', async () => {
    apiBody = [release('1.16.2', ['ifc-lite-server-some-other-target.tar.gz'])];

    const error = await downloadBinary().then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(error?.message).toMatch(/npm i @ifc-lite\/server-bin@X\.Y\.Z/);
    expect(error?.message).toContain(archiveName());
    expect(error?.message).not.toMatch(/Docker/);
    expect(verifyChecksumMock).not.toHaveBeenCalled();
  });

  it('reports an exhausted API rate limit instead of throwing from the lookup', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith(API)
        ? status(403, 'Forbidden', { 'x-ratelimit-remaining': '0' })
        : status(404, 'Not Found')
    );

    await expect(downloadBinary()).rejects.toThrow(/rate limit[\s\S]*npm i @ifc-lite\/server-bin@/);
    expect(verifyChecksumMock).not.toHaveBeenCalled();
  });

  it('does not swap in another version when the primary failed for a reason other than 404', async () => {
    apiBody = [release('1.16.2', ['$', '$.sha256'])];
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith(API) ? json(apiBody) : status(503, 'Service Unavailable')
    );

    await expect(downloadBinary()).rejects.toThrow(/No fallback release was used: .*503/);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith(API))).toBe(false);
    expect(verifyChecksumMock).not.toHaveBeenCalled();
  });

  it('records the fallback in the version sidecar, and every cached run warns about it', async () => {
    apiBody = [release('1.16.3', ['$', '$.sha256'])];
    await downloadBinary();

    const sidecarWrite = writeFileMock.mock.calls.find(([p]) => String(p).endsWith('version.txt'));
    const sidecar = String(sidecarWrite?.[1]);
    expect(sidecar).toMatch(/^1\.16\.6\nfallback 1\.16\.3/);

    // A later run reuses the install (same package version) but says so.
    vi.mocked(console.warn).mockClear();
    readFileMock.mockImplementation(async (path: string) =>
      String(path).endsWith('package.json') ? JSON.stringify({ version: PKG_VERSION }) : sidecar
    );
    await expect(isBinaryCached()).resolves.toBe(true);
    const warning = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join('\n');
    expect(warning).toContain('release v1.16.3');
    expect(warning).toContain('npx @ifc-lite/server-bin download');
  });

  it('never falls back for a version that is not a plain X.Y.Z (e.g. a prerelease)', async () => {
    readFileMock.mockImplementation(async () => JSON.stringify({ version: '1.17.0-next.0' }));
    apiBody = [release('1.18.0', ['$', '$.sha256']), release('1.16.2', ['$', '$.sha256'])];
    fetchMock.mockImplementation(async (url: string) => (url.startsWith(API) ? json(apiBody) : status(404, 'Not Found')));

    await expect(downloadBinary()).rejects.toThrow(/not a plain X\.Y\.Z version/);
    expect(verifyChecksumMock).not.toHaveBeenCalled();
  });

  it('skips a release whose asset URL is not that release on github.com', async () => {
    const foreign = release('1.16.3', ['$', '$.sha256']);
    foreign.assets[0].browser_download_url = `https://example.invalid/v1.16.3/${archiveName()}`;
    apiBody = [foreign, release('1.16.2', ['$', '$.sha256'])];

    await downloadBinary();
    expect(verifyChecksumMock.mock.calls[0][1]).toBe(`${RELEASES}/v1.16.2/${archiveName()}`);
  });

  it('authenticates the releases lookup with GITHUB_TOKEN when it is set', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    apiBody = [release('1.16.2', ['$', '$.sha256'])];
    await downloadBinary();
    vi.unstubAllEnvs();

    const apiCall = fetchMock.mock.calls.find(([u]) => String(u).startsWith(API));
    expect(apiCall).toBeDefined();
    expect((apiCall![1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer test-token');
  });
});
