/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification carrier for the IFC5 (IFCX) exporter (`ifc5-exporter.ts`,
 * split out to stay under the module-size budget).
 *
 * Resolves an entity's `IfcClassificationReference`s (via
 * `IfcRelAssociatesClassification`, including type-level associations) into
 * the `ifclite::classifications` wire shape (`{ system, code, uri?,
 * description? }[]`), the same shape and attribute key
 * `@ifc-lite/collab`'s snapshot layer (`structured-attrs.ts`) already uses
 * for its structured classification branch — so a classified entity reads
 * back the same way whether the IFCX came from this exporter or from a
 * collab snapshot.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { extractClassificationsOnDemand } from '@ifc-lite/parser';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';

export interface Ifc5ClassificationRef {
  system: string;
  code: string;
  uri?: string;
  description?: string;
}

/**
 * `extractClassificationsOnDemand` needs the source STEP buffer plus the
 * `onDemandClassificationMap` built during columnar parsing; an IFCX-sourced
 * `IfcDataStore` (round-tripping an already-IFC5 model) has neither, so this
 * resolves to an empty list there rather than throwing — that input never
 * carried a classification to lose in the first place.
 */
export function getClassificationsForEntity(
  dataStore: IfcDataStore,
  entityId: number,
): Ifc5ClassificationRef[] {
  const infos = extractClassificationsOnDemand(dataStore, entityId);
  const refs: Ifc5ClassificationRef[] = [];

  for (const info of infos) {
    // A classification with neither a code nor a name carries nothing a
    // reader could show or match against — skip it rather than emit a
    // `{ system, code: '' }` placeholder that looks like real data.
    const code = info.identification || info.name;
    if (!code) continue;

    const ref: Ifc5ClassificationRef = {
      system: info.system || 'Unknown',
      code,
    };
    if (info.location) ref.uri = info.location;
    if (info.description) ref.description = info.description;
    refs.push(ref);
  }

  return refs;
}

/**
 * Mutates `attributes` in place with the entity's classifications under
 * `ifclite::classifications` (the exporter's `attributes` record is built
 * incrementally per node, so this mirrors how Name/Description are set
 * directly rather than returned and merged).
 */
export function addClassificationAttribute(
  dataStore: IfcDataStore,
  entityId: number,
  attributes: Record<string, unknown>,
): void {
  const classifications = getClassificationsForEntity(dataStore, entityId);
  if (classifications.length > 0) attributes[IFCLITE_ATTR.CLASSIFICATIONS] = classifications;
}
