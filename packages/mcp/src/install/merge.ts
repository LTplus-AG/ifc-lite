/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Add one server entry to a client's JSON config without touching the rest.
 *
 * Other servers, and every other top-level key, come back exactly as they
 * were parsed. A file that is not plain JSON (VS Code and Cursor users add
 * comments) is refused rather than rewritten, because a rewrite would drop
 * the comments.
 */

import { InstallError } from './clients.js';

export type MergeResult =
  | { status: 'added' | 'replaced'; text: string }
  | { status: 'unchanged' }
  | { status: 'conflict'; existing: unknown };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param existingText the file's contents, or undefined when it does not exist.
 * @param force replace an entry of the same name that differs from `entry`.
 */
export function mergeServer(
  existingText: string | undefined,
  key: string,
  name: string,
  entry: JsonObject,
  force: boolean,
): MergeResult {
  let root: JsonObject = {};
  if (existingText !== undefined && existingText.trim() !== '') {
    let parsed: unknown;
    try {
      // Notepad saves a byte-order mark, which JSON.parse rejects.
      parsed = JSON.parse(existingText.replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new InstallError(`it is not plain JSON (${(err as Error).message}); comments are not supported here`);
    }
    if (!isObject(parsed)) throw new InstallError('its top level is not a JSON object');
    root = parsed;
  }
  const servers = root[key] ?? {};
  if (!isObject(servers)) throw new InstallError(`its "${key}" is not a JSON object`);

  const existing = servers[name];
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(entry)) return { status: 'unchanged' };
    if (!force) return { status: 'conflict', existing };
  }
  const next = { ...root, [key]: { ...servers, [name]: entry } };
  return { status: existing === undefined ? 'added' : 'replaced', text: `${JSON.stringify(next, null, 2)}\n` };
}
