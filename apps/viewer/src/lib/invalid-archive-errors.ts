/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Only the parser's four archive-content refusals belong here. Both anchors
 * matter: analytics downgrades this family, so quoting a refusal inside an
 * unrelated failure must not hide a bug. Entry names are arbitrary file data;
 * never classify on them. Accept the redacted archive token too, so stored
 * analytics messages retain their classification after filename scrubbing.
 */
export function isInvalidArchiveError(message: string): boolean {
  const prefix = /^This (?:\.ifcZIP|\[model\]|\[file\]) archive/;
  if (!prefix.test(message.trim())) return false;
  const body = message.trim().replace(prefix, 'This archive');
  return (
    /^This archive contains no \.ifc\/\.ifcxml entry — nothing to parse\.$/.test(body) ||
    /^This archive contains (?:[2-9]\d*|1\d+) model files \([\s\S]*\) — expected exactly one\.$/.test(body) ||
    /^This archive's model entry "[\s\S]*" declares an uncompressed size of \d+\.\d GiB, over the \d+\.\d GiB limit — refusing to decompress\.$/.test(body) ||
    /^This archive's extracted entry "[\s\S]*" exceeds the \d+ MiB limit\.$/.test(body)
  );
}
