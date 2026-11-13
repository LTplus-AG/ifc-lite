/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The absorbed embedded markup (`drawing-markup-absorbed.ts`) of a
 * localStorage entry written before the entry recorded it.
 *
 * Such an entry has markup but no `absorbedEmbeddedMarkup` field. When it was
 * seeded from the file's own embedded markup, its items still carry the ids
 * the embedded reader assigned (`ifc-<kind>-<expressId>`,
 * `drawingMarkupItemExpressId`). Without this, nothing it restores is
 * absorbed, and the next "save markup to model" writes those items again
 * beside the embedded annotations they came from.
 *
 * The entry is keyed by a hash of the file's whole content (the placement
 * identity, or the bare SHA-256 a pre-#7035 entry used), so its expressIds
 * name entities of the bytes now loaded. An item counts only when its
 * expressId is, in the loaded model, a live `IfcAnnotation` whose
 * `ObjectType` is one of the `DRAWING_MARKUP_OBJECTTYPE` tags: an id that
 * points at nothing, at another entity type, or at an annotation without an
 * IfcLite tag absorbs nothing, so the save keeps that entity. The kind in the
 * id is not interpreted here; `drawingMarkupItemExpressId` decides which ids
 * the reader assigns, so a kind added there is covered.
 *
 * The identities are the ones the embedded restore records
 * (`restoredEmbeddedMarkupIdentities`), so the sweep and later saves treat
 * them alike, and the save subscription persists the set with the entry.
 */

import { DRAWING_MARKUP_OBJECTTYPE } from '@ifc-lite/create';
import { drawingMarkupItemExpressId } from '@/lib/overlay-parse/drawing-markup-read';
import { getDrawingMarkupReadContext } from './drawing-markup-context.js';
import { embeddedMarkupIdentity } from './drawing-markup-absorbed.js';
import { buildDrawingMarkupMetaLookup, sourceMarkupGlobalId } from './drawing-markup-restore.js';

const MARKUP_TAGS = new Set<unknown>(Object.values(DRAWING_MARKUP_OBJECTTYPE));

/**
 * The identities of the tagged markup annotations in `modelId`'s loaded file
 * that `lists` (an old entry's restored markup) were read from. Empty when
 * the model has no parsed store.
 */
export function legacyEntryEmbeddedMarkupIdentities(modelId: string, lists: Iterable<readonly { id: string }[] | undefined>): string[] {
  const context = getDrawingMarkupReadContext(modelId);
  if (!context) return [];
  const { view, dataStore } = context;
  const meta = buildDrawingMarkupMetaLookup(view, dataStore);
  const identities = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) {
      const expressId = drawingMarkupItemExpressId(item.id);
      if (expressId === null) continue;
      // @raw-entity-enumeration-ok point lookup of one source entity's type; deletions are checked by the meta lookup
      if (dataStore.entityIndex.byId.get(expressId)?.type?.toUpperCase() !== 'IFCANNOTATION') continue;
      if (!MARKUP_TAGS.has(meta(expressId)?.objectType)) continue;
      identities.add(embeddedMarkupIdentity(expressId, sourceMarkupGlobalId(dataStore, expressId)));
    }
  }
  return [...identities];
}
