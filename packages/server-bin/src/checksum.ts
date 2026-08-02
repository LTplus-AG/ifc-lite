// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integrity verification for downloaded release archives.
 *
 * Implements a non-breaking SHA-256 check: the per-asset checksum sidecar is
 * fetched from the SAME release as the archive and compared before the archive
 * is extracted / chmod'd / executed. A mismatch fails closed (the artifact is
 * unlinked and an error thrown); a missing checksum asset fails open (warn and
 * proceed) for backward compatibility with older releases.
 *
 * NOTE: The release pipeline SHOULD publish "<asset>.sha256" alongside every
 * archive so this verification becomes fail-closed everywhere.
 */

import { existsSync, unlinkSync, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';

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
 * Parse an expected SHA-256 hex digest for the given archive file name out of a
 * checksum body. Supports both the single-digest sidecar form ("<hex>" or
 * "<hex>  <name>") and the multi-line SHA256SUMS form ("<hex>  <name>" per
 * line). Returns the lowercased 64-char hex digest, or null if not found.
 */
function parseExpectedSha256(body: string, archiveName: string): string | null {
  const lines = body.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Each line is "<hex>" or "<hex>  <filename>" (filename may have a leading '*').
    const match = line.match(/^([0-9a-fA-F]{64})(?:[ \t]+\*?(.+))?$/);
    if (!match) continue;
    const [, digest, name] = match;
    // A bare single-digest sidecar (no filename) always applies to this asset.
    if (!name) return digest.toLowerCase();
    // SHA256SUMS lists many files; only accept the line for this archive.
    const fileName = name.trim();
    if (fileName === archiveName || fileName.endsWith(`/${archiveName}`)) {
      return digest.toLowerCase();
    }
  }
  return null;
}

/**
 * Fetch the expected SHA-256 for the resolved asset from the SAME release.
 * Tries the per-asset sidecar ("<assetUrl>.sha256") first, then a release-wide
 * "SHA256SUMS" asset. Returns null if no checksum asset is published (older
 * releases) so callers can fail open for backward compatibility.
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
 * Fail-closed when a checksum is found and MISMATCHES (the artifact is unlinked
 * and an error thrown). Fail-open when NO checksum asset exists (older releases
 * predating the checksum pipeline) by logging a warning and proceeding.
 */
export async function verifyArchiveChecksum(
  archivePath: string,
  assetUrl: string,
  archiveName: string
): Promise<void> {
  const expected = await fetchExpectedSha256(assetUrl, archiveName);

  if (!expected) {
    console.warn(
      `Warning: no SHA-256 checksum published for ${archiveName}; ` +
      `skipping integrity verification. The release pipeline should publish ` +
      `"${archiveName}.sha256" so this becomes a hard requirement.`
    );
    return;
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
