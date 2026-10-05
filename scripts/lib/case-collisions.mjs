/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure collision finder behind scripts/check-case-collisions.mjs.
 *
 * Two kinds of collision break a checkout on a case-insensitive filesystem
 * (macOS default, Windows):
 *
 *  1. Path collisions: two tracked paths that fold to the same name
 *     (`Docs/` and `docs/`, `a.PNG` and `a.png`, a file `Foo` and a
 *     directory `foo/`). Only one can exist on disk.
 *  2. Specifier collisions: two files whose extension-less stems differ only
 *     by case (`Foo.tsx` and `foo.ts`). Both can exist on a case-sensitive
 *     disk, but a module specifier omits the extension, so `./Foo` resolves
 *     to the wrong one. Same-case stems (`Foo.ts`, `Foo.tsx`) are fine.
 *
 * Folding is NFD + toLowerCase, because APFS is also
 * normalization-insensitive (`é` precomposed equals `é`).
 */

const fold = (value) => value.normalize('NFD').toLowerCase();

/** Drop the last extension, but never turn a dotfile (`.env`) into an empty stem. */
const stemOf = (file) => file.replace(/([^/])\.[^./]*$/, '$1');

export function findCollisions(files) {
  const unique = [...new Set(files)];
  const groups = [];

  // 1. Path collisions, over every directory prefix and every file.
  const byFoldedPath = new Map();
  const note = (path) => {
    const key = fold(path);
    if (!byFoldedPath.has(key)) byFoldedPath.set(key, new Set());
    byFoldedPath.get(key).add(path);
  };
  for (const file of unique) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) note(parts.slice(0, i).join('/'));
    note(file);
  }
  const reportedFolds = new Set();
  for (const [key, paths] of byFoldedPath) {
    if (paths.size > 1) {
      groups.push([...paths]);
      reportedFolds.add(key);
    }
  }

  // 2. Specifier collisions among files not already reported above.
  const byFoldedStem = new Map();
  for (const file of unique) {
    const stem = stemOf(file);
    const key = fold(stem);
    if (!byFoldedStem.has(key)) byFoldedStem.set(key, []);
    byFoldedStem.get(key).push({ file, stem });
  }
  for (const entries of byFoldedStem.values()) {
    if (new Set(entries.map((e) => e.stem)).size < 2) continue;
    if (entries.every((e) => reportedFolds.has(fold(e.file)))) continue;
    groups.push(entries.map((e) => e.file));
  }
  return groups;
}
