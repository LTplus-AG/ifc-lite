/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { MAX_REFERENCES, ownReference, type RegisteredAppearanceReference } from './types.js';

/** Registration only. Encoded assets and original PDF bytes are never embedded. */
export interface ReferenceManifest {
  version: 1;
  units: 'm';
  axes: 'engineering-z-up';
  frameKey: string;
  references: readonly RegisteredAppearanceReference[];
}
export function serializeReferences(references: ReadonlyMap<string, RegisteredAppearanceReference>, frameKey: string): string {
  const manifest: ReferenceManifest = { version: 1, units: 'm', axes: 'engineering-z-up', frameKey,
    references: [...references.values()] };
  const text = JSON.stringify(manifest);
  parseReferences(text, frameKey);
  return text;
}
export function parseReferences(text: string, frameKey: string): ReadonlyMap<string, RegisteredAppearanceReference> {
  if (text.length > 2_000_000) throw new Error('Drawing registration exceeds 2 MB.');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object') throw new Error('Invalid drawing registration.');
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || v.units !== 'm' || v.axes !== 'engineering-z-up'
    || !Array.isArray(v.references) || v.references.length > MAX_REFERENCES) {
    throw new Error('Unsupported drawing registration. Expected version 1, metres and engineering Z-up axes.');
  }
  if (v.frameKey !== frameKey) throw new Error('The drawing registration coordinate frame differs from this workspace.');
  const references = new Map<string, RegisteredAppearanceReference>();
  for (const raw of v.references) {
    const record = ownReference(raw);
    if (record.frameKey !== frameKey) throw new Error('A drawing reference has a different coordinate frame.');
    if (references.has(record.id)) throw new Error('Duplicate drawing reference identifier.');
    references.set(record.id, record);
  }
  return references;
}
