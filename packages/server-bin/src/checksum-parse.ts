// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Parse an expected SHA-256 hex digest for the given archive file name out of a
 * checksum body. Supports both the single-digest sidecar form ("<hex>" or
 * "<hex>  <name>") and the multi-line SHA256SUMS form ("<hex>  <name>" per
 * line). Returns the lowercased 64-char hex digest, or null if not found.
 */
export function parseExpectedSha256(body: string, archiveName: string): string | null {
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
