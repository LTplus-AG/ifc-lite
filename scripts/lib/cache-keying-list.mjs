/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/ci-cache-keying-files.txt: the workflow and action files that can
 * change a Test cache key. Read by the push-replay probe (no dependencies, its
 * job has no install) and kept exact by lib/cache-keying-files.test.mjs.
 */

export const KEYING_LIST_PATH = 'scripts/ci-cache-keying-files.txt';

/** The list's entries: one path per line, `#` comments, directories end in `/`. */
export function parseKeyingList(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
}

/**
 * The list if it is well formed for this tree: it names test.yml, and every entry names
 * a file of `treeFiles` (a directory entry, a file below it). Otherwise null, and the
 * caller trusts none of it: a malformed list must not let a file it misses replay.
 */
export function validKeyingList(entries, treeFiles, root = '.github/workflows/test.yml') {
  if (!Array.isArray(entries) || !entries.includes(root)) return null;
  const exists = (e) => (e.endsWith('/') ? treeFiles.some((f) => f.startsWith(e)) : treeFiles.includes(e));
  return entries.every(exists) ? entries : null;
}

/** Whether `path` is a listed file or lies under a listed directory. */
export function isListed(path, entries) {
  return entries.some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e));
}
