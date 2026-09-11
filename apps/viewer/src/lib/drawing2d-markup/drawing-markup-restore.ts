/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Save 2D drawing markup into the IFC model" (issue #4153) — the UI-facing
 * READ action. Wraps `@ifc-lite/overlay-parse`'s (this app's own)
 * `readDrawingMarkupFromParseResult` with the two things only the viewer can
 * supply: the model's already-parsed `ParseResult` (the symbolic-annotation
 * parse cache every other annotation overlay shares — this does NOT run a
 * second WASM walk) and a per-entity `ObjectType`/property-set/quantity-set
 * lookup, built off the model's `MutablePropertyView` so it sees base file
 * data (and any overlay edits already made this session) alike.
 *
 * A `null` return means "the model has not been parsed yet" (no cached
 * `ParseResult`) — the caller (`useDrawingMarkupRestoreOnLoad.ts`) is
 * expected to call `ensureParseFor`/wait on `subscribeToParseCache` and
 * retry, never to treat `null` as "no markup".
 */

import { EntityExtractor, extractLengthUnitScale, getAttributeNames, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import {
  DRAWING_MARKUP_PSET_NAME,
  DRAWING_MARKUP_QSET_NAME,
} from '@ifc-lite/create';
import {
  readDrawingMarkupFromParseResult,
  type DrawingMarkupMetaLookup,
  type DrawingMarkupReadResult,
} from '@/lib/overlay-parse/drawing-markup-read';
import { getParseFor } from '@/hooks/symbolic-parse-cache';
import { getDrawingMarkupReadContext } from './drawing-markup-context.js';

/**
 * Read one entity's `ObjectType`, straight off the source bytes via
 * `EntityExtractor` — same convention `resolve-anchor.ts`'s
 * `findStoreyPlacementId` uses for a root attribute, and for the same
 * reason: `dataStore.entities.getObjectType` is `EntityTable`'s BATCHED
 * columnar cache, which `columnar-parser.ts` only populates ObjectType for
 * a few categories (Group family, geometry, type objects) — an
 * `IfcAnnotation` lands in the "other relevant products" bucket, which is
 * batch-extracted for GlobalId+Name ONLY (`columnar-parser.ts`'s "batch
 * other-relevant GlobalId+Name" phase). Reading `entities.getObjectType`
 * for a markup annotation on a lite-parsed store silently returns `''`
 * every time — this reads the byte-level attribute directly instead, so it
 * does not depend on which columns the fast parse chose to pre-populate.
 * The attribute name is resolved via the schema's own layout, not a
 * hard-coded index, so it stays correct if IfcRoot's layout ever shifts.
 */
function readBaseObjectType(dataStore: IfcDataStore, expressId: number): string | null {
  if (dataStore.source.byteLength <= 0) return null;
  const ref = dataStore.entityIndex.byId.get(expressId);
  if (!ref) return null;
  const extractor = new EntityExtractor(dataStore.source);
  const entity = extractor.extractEntity(ref);
  if (!entity) return null;
  const names = getAttributeNames(entity.type);
  const idx = names.indexOf('ObjectType');
  const value = entity.attributes?.[idx >= 0 ? idx : 4];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Build the per-entity `ObjectType`/property-set/quantity-set lookup
 * `readDrawingMarkupFromParseResult` needs, off `view` (a `MutablePropertyView`
 * merging base file data with any overlay edits — property/quantity sets,
 * unlike ObjectType, ARE fully on-demand-extracted regardless of parse
 * tier, so `getForEntity`/`getQuantitiesForEntity` need no equivalent
 * byte-level fallback) and `dataStore` (for `readBaseObjectType` above).
 * Exported on its own so this wiring — the part unique to the viewer, as
 * opposed to `readDrawingMarkupFromParseResult`'s already-tested geometry/
 * quantity logic — is independently testable without needing a real
 * symbolic-annotation parse.
 */
export function buildDrawingMarkupMetaLookup(
  view: MutablePropertyView,
  dataStore: IfcDataStore,
): DrawingMarkupMetaLookup {
  return (expressId) => {
    const objectType = readBaseObjectType(dataStore, expressId);

    const properties = new Map<string, string>();
    const pset = view.getForEntity(expressId).find((s) => s.name === DRAWING_MARKUP_PSET_NAME);
    for (const p of pset?.properties ?? []) properties.set(p.name, String(p.value));

    const quantities = new Map<string, number>();
    const qset = view.getQuantitiesForEntity(expressId).find((s) => s.name === DRAWING_MARKUP_QSET_NAME);
    for (const q of qset?.quantities ?? []) quantities.set(q.name, q.value);

    return { objectType, quantities, properties };
  };
}

/**
 * Model length-unit scale (metres per native unit), the same fallback
 * `resolve-anchor.ts` uses: default to a metre file, and never let a
 * failed extraction throw — a wrong scale would silently mis-place restored
 * markup, but a thrown error would drop it entirely.
 */
function lengthUnitScaleFor(dataStore: IfcDataStore): number {
  try {
    if (dataStore.source.byteLength > 0) {
      const scale = extractLengthUnitScale(dataStore.source, dataStore.entityIndex);
      if (Number.isFinite(scale) && scale > 0) return scale;
    }
  } catch {
    // Keep the metre fallback below — see the doc comment above.
  }
  return 1;
}

/**
 * Read `modelId`'s tagged markup annotations back into typed
 * `Drawing2DState` arrays. Returns `null` when the model has no parsed
 * `ParseResult` cached yet (not "parsed but empty" — see
 * `symbolic-parse-cache.ts`'s `getParseFor`), OR when anything about
 * resolving the model's context/meta lookup throws. Returns an all-empty
 * {@link DrawingMarkupReadResult} for a model with no tagged `IfcAnnotation`
 * entities at all.
 *
 * NEVER THROWS: this runs unconditionally from a mount effect
 * (`useDrawingMarkupRestoreOnLoad`) reached by every model, including test
 * fixtures elsewhere in the codebase that seed a deliberately partial
 * `IfcDataStore` stub as `activeModelId`'s model — an unexpected shape
 * there must degrade to "nothing restored yet, try again later" rather
 * than crash the panel that mounted this hook.
 */
export function restoreDrawingMarkupFromModel(modelId: string): DrawingMarkupReadResult | null {
  try {
    const context = getDrawingMarkupReadContext(modelId);
    if (!context) return null;
    const { view, dataStore } = context;

    const parseResult = getParseFor(dataStore);
    if (!parseResult) return null;

    const meta = buildDrawingMarkupMetaLookup(view, dataStore);
    return readDrawingMarkupFromParseResult(parseResult, meta, { lengthUnitScale: lengthUnitScaleFor(dataStore) });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[drawing-markup-restore] failed to resolve markup for', modelId, error);
    return null;
  }
}
