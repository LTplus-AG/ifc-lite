// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integrity verification for downloaded release archives.
 *
 * Fail-closed SHA-256 check: the per-asset checksum sidecar ("<asset>.sha256",
 * with a release-wide "SHA256SUMS" accepted as a fallback shape) is fetched
 * from the SAME release as the archive and compared before the archive is
 * extracted / chmod'd / executed. Both a MISMATCH and a MISSING/unfetchable
 * checksum fail closed: the artifact is unlinked and an error thrown.
 *
 * Failing closed on a missing sidecar cannot break a supported install:
 * binary.ts derives the release tag from this package's own version, and
 * every release cut at or after the version that ships this code publishes
 * one sidecar per archive (.github/workflows/server-binaries.yml, "Create
 * Checksum Sidecar" - enforced by scripts/check-server-bin-targets.mjs).
 * When that release is missing, binary.ts falls back to an older release
 * (release-fallback.ts), and only to one whose asset list carries a checksum,
 * which is then verified here exactly like the primary download.
 */

import { existsSync, unlinkSync, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';
import { parseExpectedSha256 } from './checksum-parse.js';

/**
 * Compute the SHA-256 of a file, streamed so large archives are not buffered
 * entirely in memory.
 */
async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Fetch the expected SHA-256 for the resolved asset from the SAME release.
 * Tries the per-asset sidecar ("<assetUrl>.sha256") first, then a release-wide
 * "SHA256SUMS" asset. Returns null when no checksum could be retrieved; the
 * caller fails closed on that.
 */
async function fetchExpectedSha256(
  assetUrl: string,
  archiveName: string
): Promise<string | null> {
  const sumsUrl = assetUrl.replace(/[^/]+$/, 'SHA256SUMS');
  const candidates = [`${assetUrl}.sha256`, sumsUrl];

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'ifc-lite-server-bin' },
        redirect: 'follow',
      });
      if (!response.ok) continue;
      const body = await response.text();
      const expected = parseExpectedSha256(body, archiveName);
      if (expected) return expected;
    } catch (error) {
      // Network/checksum-fetch failure for one candidate; log and try the next.
      console.warn(
        `Warning: failed to fetch checksum from ${url}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
  }

  return null;
}

/**
 * Verify the downloaded archive against its published SHA-256 checksum.
 *
 * Fail-closed in both failure modes: a MISMATCH and a checksum that could not
 * be retrieved at all each unlink the artifact and throw, so an unverified
 * archive is never extracted or executed. See the module header for why a
 * missing sidecar cannot be a legitimate state for this package version.
 */
export async function verifyArchiveChecksum(
  archivePath: string,
  assetUrl: string,
  archiveName: string
): Promise<void> {
  const expected = await fetchExpectedSha256(assetUrl, archiveName);

  if (!expected) {
    if (existsSync(archivePath)) {
      unlinkSync(archivePath);
    }
    throw new Error(
      `No SHA-256 checksum is available for ${archiveName}; refusing to use the unverified download.\n` +
      `Expected "${archiveName}.sha256" (or a SHA256SUMS entry) alongside the archive in the same release.\n` +
      `Likely causes:\n` +
      `  1. The release assets are still uploading - retry in a few minutes\n` +
      `  2. A network problem blocked the checksum fetch\n` +
      `  3. The release is incomplete - report at https://github.com/LTplus-AG/ifc-lite/issues\n` +
      `Alternatives:\n` +
      `  - Pin a version whose release carries verified binaries: npm i @ifc-lite/server-bin@X.Y.Z\n` +
      `  - Build from source: cargo build --release -p ifc-lite-server`
    );
  }

  const actual = await computeFileSha256(archivePath);
  if (actual !== expected) {
    // Integrity failure: remove the tampered/corrupt artifact and fail closed.
    if (existsSync(archivePath)) {
      unlinkSync(archivePath);
    }
    throw new Error(
      `Checksum verification failed for ${archiveName}.\n` +
      `  Expected: ${expected}\n` +
      `  Actual:   ${actual}\n` +
      `The downloaded archive does not match the published SHA-256 and will not be used.`
    );
  }

  console.log(`Checksum verified (SHA-256): ${expected}`);
}
