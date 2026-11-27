/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Add one server entry to a client's JSON config without touching the rest.
 *
 * Other servers, and every other top-level key, keep their values (the file
 * is re-serialized, so its spacing is normalized). A replaced entry keeps the
 * user's own keys such as `env`. A file that is not plain JSON (VS Code and
 * Cursor users add comments) is refused rather than rewritten, because a
 * rewrite would drop the comments.
 */

import { InstallError } from './clients.js';

export type MergeResult =
  | { status: 'added' | 'replaced'; text: string; kept: string[] }
  | { status: 'unchanged' }
  | { status: 'conflict'; existing: unknown };

type JsonObject = Record<string, unknown>;

/** Keys that say how a client reaches a server; a replaced entry loses all of them. */
const LAUNCH_KEYS = ['command', 'args', 'type', 'transport', 'url', 'serverUrl', 'headers'];

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

  // hasOwn: a name like `constructor` must not find Object.prototype's.
  const existing = Object.hasOwn(servers, name) ? servers[name] : undefined;
  // Ours replace the launch keys, and an old HTTP entry's url/headers go with
  // them; anything else the user added (env, cwd, disabled) is kept.
  const merged = replacedEntry(existing, entry);
  if (existing !== undefined) {
    if (canonical(merged) === canonical(existing)) return { status: 'unchanged' };
    if (!force) return { status: 'conflict', existing };
  }
  const next = { ...root, [key]: { ...servers, [name]: merged } };
  return {
    status: existing === undefined ? 'added' : 'replaced',
    text: `${JSON.stringify(next, null, 2)}\n`,
    kept: Object.keys(merged).filter((k) => !Object.hasOwn(entry, k)),
  };
}

/** What replacing `existing` with `entry` writes: our launch keys, the user's other keys. */
function replacedEntry(existing: unknown, entry: JsonObject): JsonObject {
  const kept = isObject(existing)
    ? Object.fromEntries(Object.entries(existing).filter(([k]) => !LAUNCH_KEYS.includes(k)))
    : {};
  return { ...kept, ...entry };
}

/**
 * An entry for a message, without values that can hold tokens: `command`,
 * `type` and a url's origin are shown, every other key by name only.
 */
export function describeEntry(entry: unknown): string {
  if (!isObject(entry)) return typeof entry;
  const shown: string[] = [];
  if (typeof entry.command === 'string') shown.push(`command: ${entry.command}`);
  if (typeof entry.type === 'string') shown.push(`type: ${entry.type}`);
  if (typeof entry.url === 'string') shown.push(`url: ${originOf(entry.url)}`);
  const others = Object.keys(entry).filter((k) => !['command', 'type', 'url'].includes(k));
  if (others.length) shown.push(`also: ${others.join(', ')}`);
  return shown.join('\n');
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return '(not a URL)';
  }
}

/** JSON with object keys sorted, so key order does not make two entries differ. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}
