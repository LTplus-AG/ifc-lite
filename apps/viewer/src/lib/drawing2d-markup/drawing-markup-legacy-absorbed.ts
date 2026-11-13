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
 * `ObjectType` is the `DRAWING_MARKUP_OBJECTTYPE` tag of the id's kind (the
 * reader names a `Measure` annotation's item `ifc-measure-N`, and so on): an
 * id that points at nothing, at another entity type, at an annotation without
 * an IfcLite tag, or at one tagged as another kind absorbs nothing, so the
 * save keeps that entity. A kind `drawingMarkupItemExpressId` gains must be
 * added to {@link TAG_OF_KIND}; until then its items absorb nothing.
 *
 * The identities are the ones the embedded restore records
 * (`restoredEmbeddedMarkupIdentities`), so the sweep and later saves treat
 * them alike, and the save subscription persists the set with the entry. A
 * restore that runs before the store is attached defers the check
 * (`absorbEmbeddedMarkupOnceReadable`). The pre-#7035 key move derives the
 * old entry's share before merging it with an entry that records a set.
 */

import { DRAWING_MARKUP_OBJECTTYPE } from '@ifc-lite/create';
import { drawingMarkupItemExpressId } from '@/lib/overlay-parse/drawing-markup-read';
import { getDrawingMarkupReadContext } from './drawing-markup-context.js';
import { embeddedMarkupIdentity } from './drawing-markup-absorbed.js';
import { buildDrawingMarkupMetaLookup, sourceMarkupGlobalId } from './drawing-markup-restore.js';

/** The tag of the annotation the embedded reader turns into an item of each id kind. */
const TAG_OF_KIND: Readonly<Record<string, string>> = {
  measure: DRAWING_MARKUP_OBJECTTYPE.MEASURE,
  polygon: DRAWING_MARKUP_OBJECTTYPE.POLYGON_AREA,
  text: DRAWING_MARKUP_OBJECTTYPE.TEXT,
  cloud: DRAWING_MARKUP_OBJECTTYPE.CLOUD,
};

/**
 * The identities of the tagged markup annotations in `modelId`'s loaded file
 * that `lists` (an old entry's restored markup) were read from. `null` while
 * the model has no parsed store to check them against.
 */
export function legacyEntryEmbeddedMarkupIdentities(modelId: string, lists: Iterable<readonly { id: string }[] | undefined>): string[] | null {
  const context = getDrawingMarkupReadContext(modelId);
  if (!context) return null;
  const { view, dataStore } = context;
  const meta = buildDrawingMarkupMetaLookup(view, dataStore);
  const identities = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) {
      const expressId = drawingMarkupItemExpressId(item.id);
      if (expressId === null) continue;
      // @raw-entity-enumeration-ok point lookup of one source entity's type; deletions are checked by the meta lookup
      if (dataStore.entityIndex.byId.get(expressId)?.type?.toUpperCase() !== 'IFCANNOTATION') continue;
      const tag = TAG_OF_KIND[/^ifc-([a-z]+)-/.exec(item.id)?.[1] ?? ''];
      if (!tag || meta(expressId)?.objectType !== tag) continue;
      identities.add(embeddedMarkupIdentity(expressId, sourceMarkupGlobalId(dataStore, expressId)));
    }
  }
  return [...identities];
}
