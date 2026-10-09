/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isValidStoredScript, isScriptWithinSizeLimit, type SavedScript } from './persistence';
export const SCRIPT_FILE_LIMIT = 1_000_000;
export function decodePortableScript(text: string): SavedScript {
  if (text.length > SCRIPT_FILE_LIMIT) throw new Error('Script file is too large.');
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error('Script file is not valid JSON.', { cause: error }); }
  if (value && typeof value === 'object' && 'kind' in value) {
    if (value.kind !== 'ifc-lite-script' || !('version' in value) || value.version !== 1 || !('script' in value)) throw new Error('This script file format is not supported.');
    if (Object.keys(value).some(key => !['kind', 'version', 'script'].includes(key))) throw new Error('Script file has unsupported metadata.');
    value = value.script;
  }
  // The recognized original single SavedScript record is the legacy format.
  if (!isValidStoredScript(value) || value.version !== 1 || value.id.length > 256 || !value.name.trim() || value.name.length > 100 || !isScriptWithinSizeLimit(value.code)) throw new Error('Script file has invalid or unsupported script metadata.');
  if (Object.keys(value).some(key => !['id', 'name', 'code', 'createdAt', 'updatedAt', 'version'].includes(key))) throw new Error('Script file has unsupported script metadata.');
  return { id: value.id, name: value.name, code: value.code, createdAt: value.createdAt, updatedAt: value.updatedAt, version: value.version };
}
export function encodePortableScript(script: SavedScript): string {
  const text = JSON.stringify({ kind: 'ifc-lite-script', version: 1, script }, null, 2);
  decodePortableScript(text);
  return text;
}
