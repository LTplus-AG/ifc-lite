/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Save 2D drawing markup into the IFC model" (issue #4153) — the UI-facing
 * write action. Resolves the spatial anchor, sweeps any markup this feature
 * saved earlier (idempotence — see {@link removeDrawingMarkupFromStore}),
 * and calls `@ifc-lite/create`'s `addDrawingMarkupToStore` with the current
 * `Drawing2DState` markup arrays.
 *
 * Overlay-only, like every other in-store authoring action
 * (`emit-spatial-zones.ts`, `wall-edit.ts`, …): this writes into the
 * model's `StoreEditor` overlay and calls `markModelsDirty`, which is what
 * makes `ExportChangesButton` pick the model up — it does NOT write to
 * disk. A user must still run Export Changes (or the outer Export dialog)
 * to get a file with this markup in it. `SaveMarkupToModelButton.tsx`'s
 * copy says so explicitly, so pressing this button never reads as "saved to
 * disk".
 *
 * ## No section-cut reprojection (a documented scope limit, not an oversight)
 * `drawing-markup.ts`'s own header comment calls out that reprojecting a
 * plan/section drawing's local 2D coordinates through the `SectionConfig`
 * cut plane into true 3D world space is a "UI/wiring concern for the future
 * 'save into model' action" — i.e. this one. It is NOT done here: markup
 * points are written verbatim as the `Drawing2DState` arrays already hold
 * them (drawing-space metres), into a freshly emitted `Annotation`
 * sub-context anchored at the target storey's placement. The reader does
 * NOT read those points back verbatim: it composes the annotation's own
 * placement chain and inverts the symbolic parser's plan-Y-negation
 * convention to recover the authored local point, undoing exactly what
 * this writer did (anchor-then-write-verbatim), not the section cut. That
 * reader-side inversion is what makes round-tripping (save → export →
 * reopen → restore) recover the authored coordinates and scalars on a
 * model whose storey chain isn't the identity — a reader that took the
 * parsed geometry as-is would not, and did not before that inversion
 * existed. What is still NOT true, with or without that reader fix: the
 * saved annotation's real-world 3D position/orientation does not track the
 * drawing's actual section cut — placing the markup at its true cut-plane
 * pose in a general IFC viewer does not work, yet.
 *
 * ## Idempotence
 * `addDrawingMarkupToStore` is purely additive — it has no notion of "the
 * markup already saved". Calling it twice would leave two copies of every
 * annotation in the overlay. `removeDrawingMarkupFromStore` sweeps every
 * overlay-only `IfcAnnotation` tagged with a `DRAWING_MARKUP_OBJECTTYPE`
 * value (plus everything only it references) before every save, so
 * pressing Save N times leaves exactly one copy of the CURRENT markup, not
 * an empty overlay plus N batches. Mirrors `emit-spatial-zones.ts`'s
 * `removeSpatialZones` sweep-and-replace, simplified: markup has no "named
 * set" to key removal on (unlike a zone set) — every tagged annotation
 * belongs to this ONE feature's one shared batch, so a save always
 * supersedes the whole previous batch.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { EntityExtractor } from '@ifc-lite/parser';
import type { StoreEditor, NewEntity } from '@ifc-lite/mutations';
import {
  addDrawingMarkupToStore,
  resolveSpatialAnchor,
  DRAWING_MARKUP_OBJECTTYPE,
  type DrawingMarkupObjectType,
  type MeasureMarkupParams,
  type PolygonAreaMarkupParams,
  type TextMarkupParams,
} from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { getDrawingMarkupModelContext } from './drawing-markup-context.js';

/**
 * `Drawing2DState`'s own four markup array shapes (`drawing2DSlice.ts`,
 * READ ONLY here — this module never imports that file, only mirrors its
 * shapes structurally, same convention `drawing-markup.ts`'s own
 * `DrawingMarkupBatchInput` doc explains). `cloudAnnotations2D` is typed
 * with a plain `points: Point2D[]` in the store (not a 2-tuple), since nothing
 * about the store's shape statically guarantees exactly two corners — this
 * module is what validates that before handing it to the writer, which
 * DOES require the tuple.
 */
export interface SaveMarkupInput {
  measure2DResults: Array<{ id: string } & MeasureMarkupParams>;
  polygonArea2DResults: Array<{ id: string } & PolygonAreaMarkupParams>;
  textAnnotations2D: Array<{ id: string } & TextMarkupParams>;
  cloudAnnotations2D: Array<{ id: string; points: Array<{ x: number; y: number }>; label: string }>;
}

export type SaveMarkupRefusal = 'no-model' | 'no-anchor' | 'no-root-context' | 'nothing-to-save' | 'invalid-markup';

export interface SaveMarkupOutcome {
  measuresSaved: number;
  polygonsSaved: number;
  textsSaved: number;
  cloudsSaved: number;
  /** Annotations swept from an earlier save this run replaced. */
  previousRemoved: number;
  refusal: SaveMarkupRefusal | null;
}

const EMPTY_COUNTS = { measuresSaved: 0, polygonsSaved: 0, textsSaved: 0, cloudsSaved: 0, previousRemoved: 0 };

/** `IfcAnnotation.ObjectType`'s positional index — see `drawing-markup.ts`'s `emitAnnotation`. */
const ANNOTATION_OBJECT_TYPE_INDEX = 4;

const MARKUP_TAG_VALUES = new Set<string>(Object.values(DRAWING_MARKUP_OBJECTTYPE));

/** Every `#N` an attribute list points at, one level deep, flattening lists. Copy of `emit-spatial-zones.ts`'s `refsOf` — small enough not to share, and markup's walk has no relationship-entity special case zones need. */
function refsOf(attributes: readonly unknown[]): number[] {
  const out: number[] = [];
  for (const attribute of attributes) {
    for (const value of Array.isArray(attribute) ? attribute : [attribute]) {
      if (typeof value !== 'string' || !value.startsWith('#')) continue;
      const id = Number(value.slice(1));
      if (Number.isInteger(id)) out.push(id);
    }
  }
  return out;
}

/**
 * Remove every overlay-only `IfcAnnotation` tagged with a
 * `DRAWING_MARKUP_OBJECTTYPE` value, plus every overlay entity only it
 * references (placement, polyline/points, representation, property/quantity
 * sets — `MutablePropertyView.deleteEntity` purges an entity's own psets/
 * qsets as part of tombstoning it). Overlay-only by construction, like
 * `removeSpatialZones`: a `#N` pointing into the FILE (the anchor's context,
 * owner history) is never followed or deleted.
 *
 * Returns how many tagged annotations were removed (0 if none had been
 * saved yet).
 */
export function removeDrawingMarkupFromStore(editor: StoreEditor): number {
  const overlay = new Map<number, NewEntity>(editor.getNewEntities().map((e) => [e.expressId, e]));
  const doomed = new Set<number>();
  for (const entity of overlay.values()) {
    if (entity.type !== 'IfcAnnotation') continue;
    const objectType = entity.attributes[ANNOTATION_OBJECT_TYPE_INDEX];
    if (typeof objectType !== 'string' || !MARKUP_TAG_VALUES.has(objectType as DrawingMarkupObjectType)) continue;
    doomed.add(entity.expressId);
  }
  if (doomed.size === 0) return 0;
  const annotationCount = doomed.size;

  const queue = [...doomed];
  while (queue.length > 0) {
    const entity = overlay.get(queue.pop() as number);
    if (!entity) continue;
    for (const ref of refsOf(entity.attributes)) {
      if (!overlay.has(ref) || doomed.has(ref)) continue;
      doomed.add(ref);
      queue.push(ref);
    }
  }

  for (const id of doomed) editor.removeEntity(id);
  return annotationCount;
}

function firstStoreyId(store: IfcDataStore): number | null {
  const storeys = store.entityIndex.byType?.get('IFCBUILDINGSTOREY');
  return storeys && storeys.length > 0 ? storeys[0] : null;
}

/**
 * The model's root 3D `IfcGeometricRepresentationContext` — what
 * `emitMarkupSubContext` needs as `ParentContext`. Deliberately NOT
 * `resolveSpatialAnchor`'s `bodyContextId`: that prefers a 'Body'
 * SUBcontext when one exists, and a sub-context chained under another
 * sub-context is not what `drawing-markup-geometry.ts`'s doc comment
 * documents this parameter as ("the model's root 3D
 * IfcGeometricRepresentationContext"). Same fallback shape as
 * `resolve-anchor.ts`'s own context lookups, minus the subcontext
 * preference.
 */
function findRootGeometricContextId(store: IfcDataStore): number | null {
  if (store.source.byteLength <= 0) return null;
  const extractor = new EntityExtractor(store.source);
  const ctxIds = store.entityIndex.byType.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [];
  for (const id of ctxIds) {
    const ref = store.entityIndex.byId.get(id);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
    const dimension = entity?.attributes?.[2];
    if (typeof dimension === 'number' && dimension === 3) return id;
  }
  return ctxIds[0] ?? null;
}

/** `p.x`/`p.y` finite — mirrors `@ifc-lite/create`'s `drawing-markup.ts`
 *  `assertFinitePoint` (a bare `Number.isFinite` pair, not exported: kept in
 *  sync by inspection, same as this module already mirrors that package's
 *  `Drawing2DState` shapes structurally per the doc comment above). */
function isFinitePoint(p: { x: number; y: number }): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Non-negative and finite — mirrors `assertFiniteNonNegative`. */
function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Reject a batch `addDrawingMarkupToStore` would throw on, WITHOUT calling
 * it — every write-side guard it can hit, mirrored read-only here (see
 * `drawing-markup.ts`'s `assertFinitePoint`/`assertFiniteNonNegative` and
 * `addPolygonAreaMarkupToStore`'s own `points.length < 3` check).
 *
 * Why pre-validate rather than try/catch the write: `addDrawingMarkupToStore`
 * is a multi-item batch call with no transactional guarantee (confirmed —
 * `StoreEditor` has no checkpoint/rollback) — a NaN/Infinity 3 items in
 * would leave the sub-context and the first 2 items' entities already added
 * to the overlay when it throws. Worse, `saveDrawingMarkupToModel` sweeps
 * the PREVIOUS save's annotations before calling this, so a throw after the
 * sweep would also destroy the last good save. Validating first, before any
 * mutation (including the sweep), makes both failure modes structurally
 * impossible instead of needing to unwind them.
 *
 * A restored-from-file markup entry is the one path this actually protects
 * against in practice: a hand-edited/malformed IFC file can carry an
 * out-of-range STEP REAL (e.g. `1.E400`) on an `IfcAnnotationFillArea`
 * boundary ring, which the Rust tessellator has no finiteness guard for on
 * that specific branch (unlike the polyline/line path a Measure/Polygon
 * restores from) — parses as `Infinity`, survives the WASM boundary
 * unchanged, and `readCloud` (`drawing-markup-read.ts`) does not validate
 * point coordinates, only the Distance/Area/Perimeter quantities. That
 * `Infinity` then rides `useDrawingMarkupRestoreOnLoad`'s restore straight
 * into `Drawing2DState.cloudAnnotations2D`, unfiltered.
 *
 * Returns the first problem found (for a user-facing/console message), or
 * `null` if the whole batch is clean.
 */
function findInvalidMarkup(input: SaveMarkupInput, validClouds: SaveMarkupInput['cloudAnnotations2D']): string | null {
  for (const m of input.measure2DResults) {
    if (!isFinitePoint(m.start) || !isFinitePoint(m.end)) return `measurement "${m.id}" has a non-finite point`;
    if (!isFiniteNonNegative(m.distance)) return `measurement "${m.id}" has a non-finite or negative distance`;
  }
  for (const p of input.polygonArea2DResults) {
    if (p.points.length < 3) return `area "${p.id}" needs at least 3 points`;
    if (p.points.some((pt) => !isFinitePoint(pt))) return `area "${p.id}" has a non-finite point`;
    if (!isFiniteNonNegative(p.area)) return `area "${p.id}" has a non-finite or negative area`;
    if (!isFiniteNonNegative(p.perimeter)) return `area "${p.id}" has a non-finite or negative perimeter`;
  }
  for (const t of input.textAnnotations2D) {
    if (!isFinitePoint(t.position)) return `text "${t.id}" has a non-finite position`;
    // `Drawing2DState`'s live `textAnnotations2D` never sets `extent` today
    // (it is a `TextMarkupParams`-only field, no store equivalent) — this
    // guards the type-allowed case anyway, mirroring `addTextMarkupToStore`'s
    // own default.
    if (t.extent && !(isFiniteNonNegative(t.extent.sizeX) && isFiniteNonNegative(t.extent.sizeY))) {
      return `text "${t.id}" has a non-finite or negative extent`;
    }
  }
  for (const c of validClouds) {
    if (!isFinitePoint(c.points[0]) || !isFinitePoint(c.points[1])) return `cloud "${c.id}" has a non-finite point`;
  }
  return null;
}

/**
 * Save the current 2D drawing markup into `modelId`'s overlay.
 *
 * `input` mirrors `Drawing2DState`'s own four markup arrays structurally
 * (see `drawing-markup.ts`'s `DrawingMarkupBatchInput` doc) — the caller
 * passes the live store arrays directly, no reshaping needed, EXCEPT for
 * `cloudAnnotations2D`: the store's `points` is a plain array, while the
 * writer requires exactly the two rectangle corners as a tuple. A cloud
 * with any other point count cannot have been produced by
 * `completeCloudAnnotation2D` (the store's own drawing tool always writes
 * exactly two), so it is dropped here as malformed rather than passed
 * through and rejected deeper in the stack.
 */
export function saveDrawingMarkupToModel(
  modelId: string,
  input: SaveMarkupInput,
  targetView: 'PLAN_VIEW' | 'SECTION_VIEW' = 'PLAN_VIEW',
): SaveMarkupOutcome {
  const validClouds = input.cloudAnnotations2D.filter(
    (c): c is typeof c & { points: readonly [{ x: number; y: number }, { x: number; y: number }] } =>
      c.points.length === 2,
  );

  const total =
    input.measure2DResults.length + input.polygonArea2DResults.length + input.textAnnotations2D.length + validClouds.length;

  // Validate BEFORE touching the store at all — see `findInvalidMarkup`'s
  // doc comment for why this has to happen ahead of the sweep below, not
  // just ahead of the write.
  const problem = findInvalidMarkup(input, validClouds);
  if (problem) {
    // eslint-disable-next-line no-console
    console.warn(`[saveDrawingMarkupToModel] refusing to save: ${problem}`);
    return { ...EMPTY_COUNTS, refusal: 'invalid-markup' };
  }

  const context = getDrawingMarkupModelContext(modelId);
  if (!context) return { ...EMPTY_COUNTS, refusal: 'no-model' };
  const { editor, dataStore } = context;

  const storeyId = firstStoreyId(dataStore);
  if (storeyId === null) return { ...EMPTY_COUNTS, refusal: 'no-anchor' };
  let anchor;
  try {
    anchor = resolveSpatialAnchor(dataStore, storeyId);
  } catch {
    return { ...EMPTY_COUNTS, refusal: 'no-anchor' };
  }

  const rootContextId = findRootGeometricContextId(dataStore);
  if (rootContextId === null) return { ...EMPTY_COUNTS, refusal: 'no-root-context' };

  // Sweep BEFORE checking `total === 0`: an empty batch with a previous save
  // present is a legitimate "clear the saved markup" — not a no-op refusal.
  const previousRemoved = removeDrawingMarkupFromStore(editor);

  if (total === 0) {
    if (previousRemoved > 0) useViewerStore.getState().markModelsDirty([modelId]);
    return { ...EMPTY_COUNTS, previousRemoved, refusal: previousRemoved > 0 ? null : 'nothing-to-save' };
  }

  // `findInvalidMarkup` above covers every guard `addDrawingMarkupToStore`
  // (and the builders it calls) can throw on today, so this should never
  // fire — kept as a last-resort net, not the primary defense, since
  // `StoreEditor` has no checkpoint/rollback: without this, a THIRD failure
  // mode neither guard above catches would leave orphaned overlay entities
  // (the sub-context, and whichever items were added before the throw) with
  // no error surfaced and no `markModelsDirty`, i.e. a half-written overlay
  // that silently looks clean.
  const idsBeforeWrite = new Set(editor.getNewEntities().map((e) => e.expressId));
  let result;
  try {
    result = addDrawingMarkupToStore(
      editor,
      anchor,
      rootContextId,
      {
        measure2DResults: input.measure2DResults,
        polygonArea2DResults: input.polygonArea2DResults,
        textAnnotations2D: input.textAnnotations2D,
        cloudAnnotations2D: validClouds,
      },
      targetView,
    );
  } catch (error) {
    for (const entity of editor.getNewEntities()) {
      if (!idsBeforeWrite.has(entity.expressId)) editor.removeEntity(entity.expressId);
    }
    // eslint-disable-next-line no-console
    console.warn('[saveDrawingMarkupToModel] addDrawingMarkupToStore threw despite pre-validation:', error);
    return { ...EMPTY_COUNTS, refusal: 'invalid-markup' };
  }
  useViewerStore.getState().markModelsDirty([modelId]);

  return {
    measuresSaved: result.measures.length,
    polygonsSaved: result.polygons.length,
    textsSaved: result.texts.length,
    cloudsSaved: result.clouds.length,
    previousRemoved,
    refusal: null,
  };
}
