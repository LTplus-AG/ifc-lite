/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type JSZip from 'jszip';
import type { ReportWarning } from './reader-warning.js';

export function isMacOsxShadowPath(path: string): boolean {
  return /(?:^|\/)__MACOSX(?:\/|$)/i.test(path);
}

/** Resolve the common folder added when a project directory is zipped whole. */
export function resolveArchiveRoot(zip: JSZip): string {
  if (zip.file('bcf.version')) return '';

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
    }
  });
  return topicFolders;
}
