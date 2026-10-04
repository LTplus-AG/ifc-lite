/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { matchesGlob } from '@ifc-lite/plugin-api';
import type { FileFilter, PluginContext, SourceFile } from '@ifc-lite/plugin-api';
import type { DropboxApiClient } from './http-client.js';
import { decodeMetadataEntry } from './dropbox-types.js';

/** Resolve each distinct parent path once; malformed parents retain their path. */
export async function resolveContainerIdsByParentPath(
  client: DropboxApiClient,
  ctx: PluginContext,
  parentPaths: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  await Promise.all(
    [...parentPaths].map(async (parentPath) => {
      try {
        const raw = await client.rpc('/files/get_metadata', { path: parentPath }, signal);
        const entry = decodeMetadataEntry(raw);
        if (entry['.tag'] !== 'folder') {
          ctx.log.warn('Dropbox: search result parent path did not resolve to a folder', { parentPath, tag: entry['.tag'] });
          return;
        }
        resolved.set(parentPath, entry.id);
      } catch (err) {
        ctx.log.warn('Dropbox: failed to resolve search result parent folder id; falling back to its path', {
          parentPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  return resolved;
}

export function applyFileFilter(files: SourceFile[], filter?: FileFilter): SourceFile[] {
  let result = files;
  if (filter?.namePatterns?.length) {
    const patterns = filter.namePatterns;
    result = result.filter((file) => patterns.some((pattern) => matchesGlob(file.name, pattern)));
  }
  if (filter?.mimeTypes?.length) {
    const mimeTypes = filter.mimeTypes;
    result = result.filter((file) => file.mimeType && mimeTypes.includes(file.mimeType));
  }
  return result;
}

/** `files/list_folder/get_latest_cursor` responds with just `{ cursor }` —
 *  no `entries`/`has_more` the way a full listing page has. */
export function decodeCursorOnly(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { cursor?: unknown }).cursor !== 'string') {
    throw new Error('Dropbox list_folder/get_latest_cursor response is missing "cursor"');
  }
  return (raw as { cursor: string }).cursor;
}
