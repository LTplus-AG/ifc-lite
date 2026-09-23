/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type JSZip from 'jszip';
import type { ReportWarning } from './reader-warning.js';

export function isMacOsxShadowPath(path: string): boolean {
  return /(?:^|\/)__MACOSX(?:\/|$)/i.test(path);
}

/**
 * Rewrite backslash-separated entry names to `/`, in place, before anything
 * reads the archive (#5188). The ZIP spec mandates `/`, but Windows-originated
 * writers have emitted `\`, and JSZip keeps such a name verbatim (it strips a
 * leading `./`, not this). Every lookup in the reader (`zip.file()`, the
 * archive-root and topic-folder matches, the viewpoint and snapshot scans)
 * then misses the entry, and the archive reads as an empty project. Fixing the
 * names once fixes every lookup, instead of teaching each call site about both
 * separators. The writer stays strict: it only ever emits `/`.
 */
export function normalizeEntrySeparators(zip: JSZip, warn: ReportWarning): JSZip {
  for (const name of Object.keys(zip.files)) {
    if (!name.includes('\\')) continue;
    const entry = zip.files[name];
    const normalized = name.replace(/\\/g, '/');
    delete zip.files[name];
    if (zip.files[normalized]) {
      warn(`Archive entry "${name}" duplicates "${normalized}" once its backslashes are read as folder separators; keeping "${normalized}"`);
      continue;
    }
    entry.name = normalized;
    zip.files[normalized] = entry;
  }
  return zip;
}

/**
 * Look up an archive entry, accepting a case variant when the exact name is
 * absent. Topic markup is matched case-insensitively, so the archive metadata
 * (`bcf.version`, `project.bcfp`) must be too: JSZip's `file(name)` is
 * case-sensitive, and a root accepted by a case-insensitive match would
 * otherwise be read back under a name that does not exist.
 */
export function findArchiveEntry(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const exact = zip.file(path);
  if (exact) return exact;
  const wanted = path.toLowerCase();
  let match = null as JSZip.JSZipObject | null;
  zip.forEach((entryPath, entry) => {
    if (!match && !entry.dir && entryPath.toLowerCase() === wanted) match = entry;
  });
  return match;
}

/** Resolve the common folder added when a project directory is zipped whole. */
export function resolveArchiveRoot(zip: JSZip): string {
  if (findArchiveEntry(zip, 'bcf.version')) return '';

  const candidates: string[] = [];
  zip.forEach((path) => {
    const match = path.match(/^(.+\/)bcf\.version$/i);
    if (match && !isMacOsxShadowPath(match[1])) candidates.push(match[1]);
  });
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0
      ? 'Invalid BCF file: missing bcf.version'
      : 'Invalid BCF file: ambiguous bcf.version files');
  }
  return candidates[0];
}

/** Map each topic folder to the exact markup entry that matched it. */
export function discoverTopicMarkupPaths(zip: JSZip, root: string, warn: ReportWarning): Map<string, string> {
  const topicFolders = new Map<string, string>();
  zip.forEach((relativePath) => {
    const match = relativePath.match(/^(.+)\/markup\.bcf$/i);
    if (match && match[1].startsWith(root) && !isMacOsxShadowPath(match[1])) {
      if (topicFolders.has(match[1])) {
        warn(`Multiple markup.bcf entries in ${match[1]}: keeping the first one read`);
      } else {
        topicFolders.set(match[1], relativePath);
      }
    } else if (/(?:^|\/)markup\.bcf$/i.test(relativePath) && !isMacOsxShadowPath(relativePath)) {
      // A markup.bcf no topic folder can claim (at the archive root, or beside
      // bcf.version rather than in a topic folder under it). Its topic is not
      // read, and that must be reported, not look like an empty project (#5188).
      warn(`markup.bcf entry "${relativePath}" is not inside a topic folder under the archive root "${root || '/'}"; its topic was not read`);
    }
  });
  return topicFolders;
}
