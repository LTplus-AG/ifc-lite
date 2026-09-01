/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification/material array replacement and IfcClass extraction, split
 * out of `from-ifcx.ts` (module-size ratchet). Used by `overlayEntity` and
 * `createNodeEntity` when applying an IFCX layer's opinions onto an entity.
 */

import * as Y from 'yjs';
import { getEntity } from '../doc/entity.js';
import { ENTITY_KEY, type ClassificationRef, type MaterialAssignment } from '../doc/schema.js';

export function setClassifications(
  doc: Y.Doc,
  path: string,
  refs: readonly ClassificationRef[],
): void {
  const arr = getEntity(doc, path)?.get(ENTITY_KEY.CLASSIFICATIONS) as
    | Y.Array<ClassificationRef>
    | undefined;
  if (!arr) return;
  if (arr.length > 0) arr.delete(0, arr.length);
  arr.push([...refs]);
}

export function setMaterials(
  doc: Y.Doc,
  path: string,
  assignments: readonly MaterialAssignment[],
): void {
  const arr = getEntity(doc, path)?.get(ENTITY_KEY.MATERIALS) as
    | Y.Array<MaterialAssignment>
    | undefined;
  if (!arr) return;
  if (arr.length > 0) arr.delete(0, arr.length);
  arr.push([...assignments]);
}

/** Read the IfcClass code out of the well-known `bsi::ifc::class` attribute. */
export function readIfcClass(attributes: Record<string, unknown> | undefined): string | undefined {
  if (!attributes) return undefined;
  const cls = attributes['bsi::ifc::class'];
  if (cls && typeof cls === 'object' && 'code' in cls) {
    const code = (cls as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
