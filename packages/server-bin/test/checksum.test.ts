/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { verifyArchiveChecksum } from '../src/checksum.js';

const ASSET_URL =
  'https://github.com/LTplus-AG/ifc-lite/releases/download/v1.2.3/ifc-lite-server-linux-x64.tar.gz';
const ARCHIVE_NAME = 'ifc-lite-server-linux-x64.tar.gz';
const CONTENT = 'pretend this is a release archive';
const DIGEST = createHash('sha256').update(CONTENT).digest('hex');

let dir: string;
let archivePath: string;
let fetchMock: ReturnType<typeof vi.fn>;

/** Serve bodies keyed by URL; any URL not listed responds 404. */
function serve(routes: Record<string, string>) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url in routes) {
      return { ok: true, text: async () => routes[url] } as unknown as Response;
    }
    return { ok: false, status: 404, statusText: 'Not Found' } as unknown as Response;
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ifclite-checksum-'));
  archivePath = join(dir, ARCHIVE_NAME);
  writeFileSync(archivePath, CONTENT);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('verifyArchiveChecksum - matching digest', () => {
  it('accepts a bare single-digest sidecar and keeps the archive', async () => {
    serve({ [`${ASSET_URL}.sha256`]: `${DIGEST}\n` });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
    expect(existsSync(archivePath)).toBe(true);
  });

  it('accepts an uppercase digest (comparison is case-normalised)', async () => {
    serve({ [`${ASSET_URL}.sha256`]: DIGEST.toUpperCase() });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
  });

  it('accepts a "<hex>  <name>" sidecar line', async () => {
    serve({ [`${ASSET_URL}.sha256`]: `${DIGEST}  ${ARCHIVE_NAME}\n` });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
  });

  it('accepts the binary-mode "*name" marker', async () => {
    serve({ [`${ASSET_URL}.sha256`]: `${DIGEST} *${ARCHIVE_NAME}` });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
  });

  it('does not warn when a checksum was found and matched', async () => {
    serve({ [`${ASSET_URL}.sha256`]: DIGEST });
    await verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Checksum verified'));
  });
});

describe('verifyArchiveChecksum - mismatching digest fails closed', () => {
  const WRONG = 'a'.repeat(64);

  it('throws and names both digests', async () => {
    serve({ [`${ASSET_URL}.sha256`]: WRONG });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).rejects.toThrow(
      /Checksum verification failed/
    );
  });

  it('deletes the archive so a tampered artifact can never be extracted or executed', async () => {
    serve({ [`${ASSET_URL}.sha256`]: WRONG });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).rejects.toThrow();
    expect(existsSync(archivePath)).toBe(false);
  });

  it('reports the expected and the actual digest in the error', async () => {
    serve({ [`${ASSET_URL}.sha256`]: WRONG });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).rejects.toThrow(
      new RegExp(`Expected: ${WRONG}[\\s\\S]*Actual:\\s+${DIGEST}`)
    );
  });

  it('detects a one-byte change to the archive after the checksum was published', async () => {
    serve({ [`${ASSET_URL}.sha256`]: DIGEST });
    writeFileSync(archivePath, `${CONTENT}!`);
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).rejects.toThrow(
      /Checksum verification failed/
    );
  });
});

describe('verifyArchiveChecksum - missing checksum fails open', () => {
  it('warns and proceeds when neither the sidecar nor SHA256SUMS exists', async () => {
    serve({});
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no SHA-256 checksum published'));
    expect(existsSync(archivePath)).toBe(true);
  });

  it('names the archive in the fail-open warning', async () => {
    serve({});
    await verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(ARCHIVE_NAME));
  });
});

describe('verifyArchiveChecksum - checksum source resolution', () => {
  const SUMS_URL =
    'https://github.com/LTplus-AG/ifc-lite/releases/download/v1.2.3/SHA256SUMS';

  it('tries the per-asset sidecar before the release-wide SHA256SUMS', async () => {
    serve({ [`${ASSET_URL}.sha256`]: DIGEST, [SUMS_URL]: 'b'.repeat(64) });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe(`${ASSET_URL}.sha256`);
  });

  it('derives the SHA256SUMS url from the SAME release directory as the asset', async () => {
    serve({ [SUMS_URL]: `${DIGEST}  ${ARCHIVE_NAME}` });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${ASSET_URL}.sha256`, SUMS_URL]);
  });

  it('falls through to SHA256SUMS when the sidecar fetch rejects outright', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('.sha256')) throw new Error('ECONNRESET');
      return { ok: true, text: async () => `${DIGEST}  ${ARCHIVE_NAME}` } as unknown as Response;
    });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('failed to fetch checksum'));
  });

  it('picks the SHA256SUMS line for this archive, not another asset in the same release', async () => {
    const other = 'c'.repeat(64);
    serve({
      [SUMS_URL]: [
        `${other}  ifc-lite-server-darwin-arm64.tar.gz`,
        `${DIGEST}  ${ARCHIVE_NAME}`,
        `${other}  ifc-lite-server-win32-x64.zip`,
      ].join('\n'),
    });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
  });

  it('fails closed when SHA256SUMS lists only OTHER assets and the first line is a valid digest', async () => {
    const other = 'c'.repeat(64);
    serve({ [SUMS_URL]: `${other}  ifc-lite-server-darwin-arm64.tar.gz` });
    // The first line parses cleanly but names a different asset, so no checksum
    // applies to ours: fail open, never silently adopt another asset's digest.
    await verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no SHA-256 checksum published'));
  });

  it('accepts a path-qualified name ending in the archive name', async () => {
    serve({ [SUMS_URL]: `${DIGEST}  dist/artifacts/${ARCHIVE_NAME}` });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
  });

  it('rejects a name that merely ends with the archive name without a path separator', async () => {
    serve({ [SUMS_URL]: `${DIGEST}  evil-${ARCHIVE_NAME}` });
    await verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no SHA-256 checksum published'));
  });

  it('ignores lines whose digest is not exactly 64 hex chars', async () => {
    serve({ [SUMS_URL]: `${DIGEST.slice(0, 63)}  ${ARCHIVE_NAME}\n${DIGEST}xy  ${ARCHIVE_NAME}` });
    await verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no SHA-256 checksum published'));
  });

  it('ignores blank lines and comment noise before the real entry', async () => {
    serve({ [SUMS_URL]: `\n# generated by ci\n\n${DIGEST}  ${ARCHIVE_NAME}\n` });
    await expect(verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME)).resolves.toBeUndefined();
  });

  it('does not fetch a third url after SHA256SUMS misses', async () => {
    serve({});
    await verifyArchiveChecksum(archivePath, ASSET_URL, ARCHIVE_NAME);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
