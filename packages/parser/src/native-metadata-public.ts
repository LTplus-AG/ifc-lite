/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The existing native metadata surface, with explicit current type quantity coverage. */
export { resolveEffectiveEntityRecord, type EffectiveEntityRecord, type EntityRecordEdits } from './effective-entity-record.js';
export { effectiveMetadataRecord } from './effective-metadata-record.js';
export { resolveEffectiveRelationshipOverlay, effectiveRelationshipEdges, type EffectiveRelationship, type EffectiveRelationshipOverlay, type RelationshipOverlayReader } from './effective-relationship-overlay.js';
export { effectiveSpatialMemberIds, type EffectiveSpatialContext } from './effective-spatial-members.js';
export { effectiveStoreyId } from './effective-storey.js';
export { readCurrentTypeQuantities, type CurrentTypeQuantityResult } from './current-type-quantities.js';
