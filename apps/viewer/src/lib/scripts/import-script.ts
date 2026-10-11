/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { canCreateScript, isValidStoredScript, saveScripts, type SavedScript } from './persistence';
const KEY = 'ifc-lite-scripts';
export interface ScriptImportOwner { scripts: SavedScript[]; raw: string | null }
export function captureScriptImportOwner(): ScriptImportOwner {
  const scripts = useViewerStore.getState().savedScripts;
  const raw = localStorage.getItem(KEY);
  if (raw !== null) {
    let data: unknown;
    try { data = JSON.parse(raw); } catch (error) { throw new Error('Existing saved scripts are unreadable. Export your session scripts before repairing browser storage.', { cause: error }); }
    const rows = Array.isArray(data) ? data : data && typeof data === 'object' && 'schemaVersion' in data && data.schemaVersion === 1 && 'scripts' in data && Array.isArray(data.scripts) ? data.scripts : null;
    if (!rows || rows.length > 500 || !rows.every(row => isValidStoredScript(row) && row.version === 1)) throw new Error('Existing saved scripts are incomplete or use an unsupported storage format. Export session scripts before repairing storage.');
    if (JSON.stringify(rows) !== JSON.stringify(scripts)) throw new Error('Saved scripts in this tab differ from browser storage. Export session scripts, then reload before importing.');
  } else if (scripts.length) {
    throw new Error('Session scripts are not saved in browser storage. Save or export them before importing.');
  }
  return { scripts, raw };
}
export function commitImportedScript(script: SavedScript, owner: ScriptImportOwner): SavedScript {
  const current = useViewerStore.getState();
  if (current.savedScripts !== owner.scripts || localStorage.getItem(KEY) !== owner.raw) throw new Error('Saved scripts changed while this file was being read. Review the current library and retry.');
  if (!canCreateScript(current.savedScripts.length)) throw new Error('The saved script library is full.');
  const copy = { ...script, id: crypto.randomUUID() };
  const scripts = [...current.savedScripts, copy];
  const result = saveScripts(scripts);
  if (!result.ok) throw new Error(result.message);
  // Durable-first append; importing never changes the active/dirty editor or runs code.
  useViewerStore.setState({ savedScripts: scripts });
  return copy;
}
