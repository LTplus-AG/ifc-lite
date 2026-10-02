/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseIDS, type IDSDocument } from '@ifc-lite/ids';
import { parseRuleSetFile, type RuleSetFile } from '@ifc-lite/rules';
import { optionalLocalStorage, preserveUnreadableEntry } from '../storage/unreadable-entry.js';

export type DefinitionKind = 'rules' | 'ids';
export type ValidationDefinition =
  | { id: string; kind: 'rules'; file: RuleSetFile }
  | { id: string; kind: 'ids'; xml: string; document: IDSDocument };
export interface DefinitionLibrary {
  version: 1;
  entries: ValidationDefinition[];
  active: Record<DefinitionKind, string | null>;
}
export interface DefinitionLibraryRead { library: DefinitionLibrary; error: string | null; writable: boolean }
export const MAX_DEFINITIONS = 100;
export const MAX_DEFINITION_BYTES = 8 * 1024 * 1024;
const KEY = 'ifc-lite:validation:definition-library';
const record = (raw: unknown): raw is Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw);

export function emptyDefinitionLibrary(): DefinitionLibrary {
  return { version: 1, entries: [], active: { rules: null, ids: null } };
}
export function activeDefinition(library: DefinitionLibrary, kind: DefinitionKind): ValidationDefinition | undefined {
  return library.entries.find(entry => entry.kind === kind && entry.id === library.active[kind]);
}
export function definitionTitle(entry: ValidationDefinition): string {
  return entry.kind === 'rules' ? entry.file.name : entry.document.info.title;
}

/** Persist source definitions, never derived validation results. IDS XML is
 * retained exactly; every restored projection uses its original parser. */
function payload(library: DefinitionLibrary): string {
  if (library.entries.length > MAX_DEFINITIONS) throw new Error('The definition library is full (100 checks). Export or delete a check first.');
  const text = JSON.stringify({ ...library, entries: library.entries.map(entry =>
    entry.kind === 'ids' ? { id: entry.id, kind: entry.kind, xml: entry.xml } : entry) });
  if (new TextEncoder().encode(text).byteLength > MAX_DEFINITION_BYTES) throw new Error('The definition library exceeds 8 MB. Export or delete a check first.');
  return text;
}

export function checkDefinitionLibrary(library: DefinitionLibrary): string | null {
  try { payload(library); return null; }
  catch (error) { return error instanceof Error ? error.message : 'The definition library could not be serialized.'; }
}

export function saveDefinitionLibrary(library: DefinitionLibrary, writable: boolean): string | null {
  if (!writable) return 'Saved checks could not be read or backed up. Existing storage has been preserved.';
  try {
    // Editors may briefly emit an incomplete draft. Keep it usable in this
    // session, but never overwrite the last restorable record with it.
    for (const entry of library.entries) if (entry.kind === 'rules') {
      const parsed = parseRuleSetFile(entry.file);
      if (!parsed.ok) return `Edits remain available in this session. Complete the rule set before saving: ${parsed.error}`;
    }
    optionalLocalStorage()?.setItem(KEY, payload(library)); return null;
  }
  catch (error) {
    console.warn('[ifc-lite] validation definition library could not be saved.', error);
    return error instanceof Error ? `Checks remain available in this session, but could not be saved: ${error.message}` : 'Checks could not be saved.';
  }
}

function parseLibrary(raw: unknown): DefinitionLibrary {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.entries) || raw.entries.length > MAX_DEFINITIONS || !record(raw.active)) throw new Error('Expected a version 1 definition library.');
  const seen = new Set<string>();
  const entries: ValidationDefinition[] = raw.entries.map((entry: unknown) => {
    if (!record(entry) || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) throw new Error('Expected distinct definition identities.');
    seen.add(entry.id);
    if (entry.kind === 'rules') {
      const parsed = parseRuleSetFile(entry.file);
      if (!parsed.ok) throw new Error(parsed.error);
      return { id: entry.id, kind: 'rules', file: parsed.file };
    }
    if (entry.kind !== 'ids' || typeof entry.xml !== 'string') throw new Error('Expected an IDS source document.');
    return { id: entry.id, kind: 'ids', xml: entry.xml, document: parseIDS(entry.xml) };
  });
  const active: DefinitionLibrary['active'] = { rules: null, ids: null };
  for (const kind of ['rules', 'ids'] as const) {
    const id = raw.active[kind];
    if (id !== null && !(typeof id === 'string' && entries.some(entry => entry.id === id && entry.kind === kind))) throw new Error('Active definition is not in its library.');
    active[kind] = id;
  }
  return { version: 1, entries, active };
}

export function loadDefinitionLibrary(): DefinitionLibraryRead {
  const storage = optionalLocalStorage();
  try {
    const text = storage?.getItem(KEY);
    if (text == null) return { library: emptyDefinitionLibrary(), error: null, writable: true };
    if (new TextEncoder().encode(text).byteLength > MAX_DEFINITION_BYTES) throw new Error('Saved definition library exceeds 8 MB.');
    return { library: parseLibrary(JSON.parse(text)), error: null, writable: true };
  } catch (error) {
    const writable = preserveUnreadableEntry(storage, KEY, error);
    return { library: emptyDefinitionLibrary(), writable,
      error: writable ? 'Saved checks could not be read; their original bytes have been backed up.' : 'Saved checks could not be read or backed up; existing storage has been preserved.' };
  }
}
