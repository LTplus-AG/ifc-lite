/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Root-placement zeroing and georeferencing/address blanking for the
 * "anonymized isolated export" feature (#2934, plan section A4).
 *
 * Coordinates are the strongest identifying signal a reproduction carries —
 * an absolute site position pins the model to a real address — but the
 * ROTATION in the placement chain and any non-orthogonal cuts are exactly
 * what a parsing bug reproduction needs to keep. So this module zeroes only
 * the TRANSLATION of each root `IfcLocalPlacement` (`PlacementRelTo = $`),
 * leaving `Axis`/`RefDirection` and every child placement untouched.
 *
 * **Clone, never rewrite.** `IfcCartesianPoint` and `IfcAxis2Placement3D` /
 * `2D` records are routinely SHARED — two storeys placed at the same origin,
 * or a template point reused across a model — so rewriting one in place would
 * silently move every other placement that happens to reference the same
 * point. Each zeroed root gets its own freshly-cloned point and axis via
 * `StoreEditor.addEntity`, and only the root's `RelativePlacement` slot is
 * repointed (`setPositionalAttribute`) to the clone. Nothing else in the
 * model ever sees the edit.
 *
 * The same clone-and-repoint mechanism handles
 * `IfcGeometricRepresentationContext.WorldCoordinateSystem` (a second, less
 * obvious place a survey offset can live — #2934's plan A4 step 4) and is
 * shared between both call sites as {@link zeroAxisPlacementSlot}.
 *
 * `IfcGridPlacement` / `IfcLinearPlacement` roots have no `RelativePlacement`
 * → `IfcCartesianPoint` chain to clone against, so they are left untouched
 * and reported as a warning rather than silently ignored or corrupted.
 *
 * Reads go through {@link readEntityArgs} / {@link attrIndex}
 * (`subset-entity-reader.ts`) so a positional slot is always resolved BY
 * EXPRESS NAME against the schema registry, never a hand-counted index that
 * would silently drift the day an entity's attribute layout changes.
 */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { IfcAttributeValue } from '@ifc-lite/parser';
import type { EffectiveEntityIndex } from './effective-index.js';
import type { AnonymizeOptions } from './anonymize-types.js';
import { attrIndex, readEntityArgs, type EntityByteRangeIndex } from './subset-entity-reader.js';
import { splitTopLevelArgs } from './step-argument-parser.js';
import { entityRef, stepReal } from './step-serialization.js';

/** The slice of {@link AnonymizeOptions} this module reads. */
export type PlacementAnonymizationOptions = Pick<
  AnonymizeOptions,
  'zeroRootPlacement' | 'removeGeoreferencing'
>;

/** What {@link applyPlacementAnonymization} did — folded into
 *  `AnonymizeResult.stats` by the orchestrator (`anonymize-export.ts`). */
export interface PlacementAnonymizationResult {
  /** Each root `IfcLocalPlacement` this call zeroed, and the ORIGINAL
   *  (pre-zero) translation it removed. */
  zeroedPlacements: { expressId: number; translation: number[] }[];
  /** Non-fatal notices: an unsupported root placement kind, an unreadable
   *  chain, multiple roots collapsing onto one origin, or a chain this walk
   *  bounded before it reached one (256-hop cap, see "Bounding walks over
   *  file-supplied references", AGENTS.md). */
  warnings: string[];
}

const IFC_SITE_ADDRESS_ATTRIBUTES = [
  'RefLatitude',
  'RefLongitude',
  'RefElevation',
  'LandTitleNumber',
  'SiteAddress',
] as const;

/**
 * Zero every root `IfcLocalPlacement` translation reachable from
 * `includedIds`, zero `WorldCoordinateSystem` on every
 * `IfcGeometricRepresentationContext` (always exported — it is an
 * `INFRASTRUCTURE_TYPES` member, `reference-collector.ts`), and blank
 * `IfcSite` / `IfcBuilding` georeferencing and address attributes.
 *
 * `store`/`index` are read from (never mutated directly) — every change goes
 * through `editor` (new entities, positional overrides) or `view` (named
 * attribute overrides), so the private `MutablePropertyView` overlay the
 * orchestrator built stays the ONE place this export's edits live.
 */
export function applyPlacementAnonymization(
  store: { readonly source: IfcSourceBytes },
  index: EffectiveEntityIndex,
  includedIds: ReadonlySet<number>,
  editor: StoreEditor,
  view: MutablePropertyView,
  opts?: PlacementAnonymizationOptions,
): PlacementAnonymizationResult {
  const warnings: string[] = [];
  const zeroedPlacements: { expressId: number; translation: number[] }[] = [];

  if (opts?.zeroRootPlacement !== false) {
    zeroRootPlacements(store, index, includedIds, editor, warnings, zeroedPlacements);
    zeroWorldCoordinateSystems(store, index, editor, warnings);
  }

  if (opts?.removeGeoreferencing !== false) {
    blankSiteAndBuildingAddresses(index, includedIds, view);
  }

  return { zeroedPlacements, warnings };
}

// ---------------------------------------------------------------------------
// Root IfcLocalPlacement discovery + zeroing
// ---------------------------------------------------------------------------

interface RootPlacement {
  rootId: number;
  rootType: string;
}

function zeroRootPlacements(
  store: { readonly source: IfcSourceBytes },
  index: EntityByteRangeIndex,
  includedIds: ReadonlySet<number>,
  editor: StoreEditor,
  warnings: string[],
  zeroedPlacements: { expressId: number; translation: number[] }[],
): void {
  // Memoised by placementId: the root a placement chain terminates at is a
  // pure function of that id ("Bounding walks", AGENTS.md — global memoising
  // is the right scope here, not path-scoped, since the answer never
  // accumulates across callers), and many products in a subset commonly
  // share one storey/building placement chain.
  const rootCache = new Map<number, RootPlacement | null>();
  const localPlacementRoots = new Set<number>();

  for (const id of includedIds) {
    const rec = readEntityArgs(store, index, id);
    if (!rec) continue;
    const objectPlacementIdx = attrIndex(rec.type, 'ObjectPlacement'); // declared on IfcProduct itself — slot order checked identical across ENTITIES_IFC2X3/_IFC4/_IFC4X3, no `schema` arg needed (#3309)
    if (objectPlacementIdx < 0 || objectPlacementIdx >= rec.args.length) continue;
    const placementId = parseRef(rec.args[objectPlacementIdx]);
    if (placementId === null) continue;

    let root = rootCache.get(placementId);
    if (root === undefined) {
      root = findRootPlacement(store, index, placementId, warnings);
      rootCache.set(placementId, root);
    }
    if (!root) continue;

    if (root.rootType !== 'IFCLOCALPLACEMENT') {
      warnings.push(
        `#${root.rootId} (${root.rootType}) is a root placement this export cannot zero — only ` +
          `IfcLocalPlacement roots are supported; left untouched, so its absolute position is still in the file.`,
      );
      continue;
    }
    localPlacementRoots.add(root.rootId);
  }

  for (const rootId of localPlacementRoots) {
    const translation = zeroAxisPlacementSlot(store, index, editor, rootId, 'IFCLOCALPLACEMENT', 'RelativePlacement', warnings);
    if (translation) zeroedPlacements.push({ expressId: rootId, translation });
  }

  if (zeroedPlacements.length > 1) {
    warnings.push(
      `${zeroedPlacements.length} independent root placements were each zeroed to the origin; ` +
        `their original relative offset from one another is not preserved.`,
    );
  }
}

/**
 * Follow `PlacementRelTo` from `startPlacementId` while the current record is
 * an `IfcLocalPlacement`, and return the terminal placement — either an
 * `IfcLocalPlacement` with `PlacementRelTo = $` (a zeroable root) or a
 * non-`IfcLocalPlacement` record the chain cannot continue past (an
 * `IfcGridPlacement` / `IfcLinearPlacement`, reported by the caller). `null`
 * when the chain could not be safely walked at all — a cycle, a hop past the
 * 256-hop cap, or a link that does not resolve to a readable record — each
 * case appending its own warning before returning.
 */
function findRootPlacement(
  store: { readonly source: IfcSourceBytes },
  index: EntityByteRangeIndex,
  startPlacementId: number,
  warnings: string[],
): RootPlacement | null {
  const visited = new Set<number>();
  let currentId = startPlacementId;
  let hops = 0;

  for (;;) {
    if (visited.has(currentId)) {
      warnings.push(
        `Placement chain from #${startPlacementId} revisits #${currentId} (PlacementRelTo cycle); left untouched.`,
      );
      return null;
    }
    visited.add(currentId);
    hops++;
    if (hops > 256) {
      warnings.push(
        `Placement chain from #${startPlacementId} exceeds 256 hops; left untouched rather than followed indefinitely.`,
      );
      return null;
    }

    const rec = readEntityArgs(store, index, currentId);
    if (!rec) {
      warnings.push(
        `Placement #${currentId} in the chain from #${startPlacementId} could not be read; left untouched.`,
      );
      return null;
    }
    if (rec.type !== 'IFCLOCALPLACEMENT') {
      return { rootId: currentId, rootType: rec.type };
    }

    const relToIdx = attrIndex(rec.type, 'PlacementRelTo'); // `rec.type` is always IFCLOCALPLACEMENT here — order verified identical across all 3 schemas (#3309)
    const parentId = relToIdx >= 0 && relToIdx < rec.args.length ? parseRef(rec.args[relToIdx]) : null;
    if (parentId === null) {
      return { rootId: currentId, rootType: rec.type };
    }
    currentId = parentId;
  }
}

// ---------------------------------------------------------------------------
// IfcGeometricRepresentationContext.WorldCoordinateSystem
// ---------------------------------------------------------------------------

/**
 * Every `IfcGeometricRepresentationContext` in the model — not just
 * `includedIds` — because it is an `INFRASTRUCTURE_TYPES` member
 * (`reference-collector.ts`) and is therefore always carried into the
 * export regardless of what the caller selected. A plain, non-recursive
 * pass over `index`: bounded by the model's own (small) count of
 * representation contexts, not a reference walk that needs its own guard.
 */
function zeroWorldCoordinateSystems(
  store: { readonly source: IfcSourceBytes },
  index: EffectiveEntityIndex,
  editor: StoreEditor,
  warnings: string[],
): void {
  for (const [id, ref] of index) {
    if (index.effectiveType(id, ref.type) !== 'IFCGEOMETRICREPRESENTATIONCONTEXT') continue;
    // `TrueNorth` is deliberately left alone — only the origin offset is
    // identifying; the survey rotation is exactly the kind of
    // geometry-relevant signal this feature is written to keep (#2934).
    zeroAxisPlacementSlot(store, index, editor, id, 'IFCGEOMETRICREPRESENTATIONCONTEXT', 'WorldCoordinateSystem', warnings);
  }
}

// ---------------------------------------------------------------------------
// Shared clone-and-repoint primitive
// ---------------------------------------------------------------------------

/**
 * Zero the `IfcCartesianPoint.Location` reachable through
 * `entityId.<slotName>` → `IfcAxis2Placement2D|3D` → `Location`, by CLONING
 * the point and the axis placement (never rewriting either — see the module
 * doc) and repointing `entityId.<slotName>` at the clone.
 *
 * Returns the original (pre-zero) coordinates when a zero-clone was
 * performed, or `null` when there was nothing to do: the slot is `$`, it
 * does not resolve to an `IfcAxis2Placement2D/3D` → `IfcCartesianPoint`
 * chain (warned), or the point is already at the origin.
 */
function zeroAxisPlacementSlot(
  store: { readonly source: IfcSourceBytes },
  index: EntityByteRangeIndex,
  editor: StoreEditor,
  entityId: number,
  entityType: string,
  slotName: string,
  warnings: string[],
): number[] | null {
  const slotIdx = attrIndex(entityType, slotName); // entityType/slotName always fixed literals, order verified identical across all 3 schemas (#3309)
  if (slotIdx < 0) return null;

  const rec = readEntityArgs(store, index, entityId);
  if (!rec || slotIdx >= rec.args.length) return null;
  const axisId = parseRef(rec.args[slotIdx]);
  if (axisId === null) return null; // `$` — nothing placed here to zero.

  const axisRec = readEntityArgs(store, index, axisId);
  if (!axisRec) {
    warnings.push(
      `#${entityId} ${slotName} references #${axisId}, which could not be read; left untouched.`,
    );
    return null;
  }
  const is3D = axisRec.type === 'IFCAXIS2PLACEMENT3D';
  const is2D = axisRec.type === 'IFCAXIS2PLACEMENT2D';
  if (!is3D && !is2D) {
    warnings.push(
      `#${entityId} ${slotName} resolves to #${axisId} (${axisRec.type}), not an ` +
        `IfcAxis2Placement2D/3D; left untouched.`,
    );
    return null;
  }

  const locationIdx = attrIndex(axisRec.type, 'Location'); // IfcAxis2Placement2D/3D — same verified-stable guarantee as slotIdx above (#3309)
  const pointId = locationIdx >= 0 ? parseRef(axisRec.args[locationIdx]) : null;
  if (pointId === null) return null;

  const pointRec = readEntityArgs(store, index, pointId);
  if (!pointRec || pointRec.type !== 'IFCCARTESIANPOINT') {
    warnings.push(
      `#${entityId} ${slotName} → #${axisId} → Location #${pointId} is not an IfcCartesianPoint; left untouched.`,
    );
    return null;
  }
  const coords = parseCoordinateList(pointRec.args[0]);
  if (!coords || coords.every((c) => c === 0)) return null; // absent, or already at the origin.

  // Clone the point at the origin, same dimensionality.
  const newPoint = editor.addEntity('IfcCartesianPoint', [coords.map(() => stepReal(0))]);

  // Clone the axis placement, carrying `Axis`/`RefDirection` over VERBATIM —
  // the rotation is exactly what a reproduction needs to keep.
  const newAxisAttrs: IfcAttributeValue[] = [entityRef(newPoint.expressId)];
  for (const name of is3D ? (['Axis', 'RefDirection'] as const) : (['RefDirection'] as const)) {
    const idx = attrIndex(axisRec.type, name); // same guarantee as locationIdx above (#3309)
    newAxisAttrs.push(idx >= 0 ? verbatimAttr(axisRec.args[idx]) : null);
  }
  const newAxis = editor.addEntity(is3D ? 'IfcAxis2Placement3D' : 'IfcAxis2Placement2D', newAxisAttrs);

  editor.setPositionalAttribute(entityId, slotIdx, entityRef(newAxis.expressId));
  return coords;
}

// ---------------------------------------------------------------------------
// IfcSite / IfcBuilding georeferencing + address blanking
// ---------------------------------------------------------------------------

/**
 * `IfcMapConversion(Scaled)` / `IfcProjectedCRS` need no handling here, and the
 * reason is conditional since #3351: `IDENTIFYING_TYPES` and inverse-only, so
 * `removeGeoreferencing` ON leaves them absent, while OFF must ROOT them —
 * merely not excluding an inverse-only entity still drops it silently.
 *
 * All six blanked slots are OPTIONAL but not all STRING-typed — a LIST OF
 * INTEGER, a REAL, and two entity refs among them — so `$` (via
 * `setPositionalAttribute` + `null`) is the only blank valid for all of them;
 * `setAttribute` only emits a quoted STEP string and would corrupt the rest.
 */
function blankSiteAndBuildingAddresses(
  index: EffectiveEntityIndex,
  includedIds: ReadonlySet<number>,
  view: MutablePropertyView,
): void {
  for (const id of includedIds) {
    const type = index.typeOf(id);
    if (type === 'IFCSITE') {
      for (const attr of IFC_SITE_ADDRESS_ATTRIBUTES) {
        const idx = attrIndex(type, attr); // IfcSite's address slots verified stable across all 3 schemas (#3309)
        if (idx >= 0) view.setPositionalAttribute(id, idx, null);
      }
    } else if (type === 'IFCBUILDING') {
      const idx = attrIndex(type, 'BuildingAddress'); // verified stable across all 3 schemas (#3309)
      if (idx >= 0) view.setPositionalAttribute(id, idx, null);
    }
  }
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/** `"#42"` → `42`; anything else (`$`, a literal, missing) → `null`. */
function parseRef(token: string | undefined): number | null {
  if (!token) return null;
  const match = /^#(\d+)$/.exec(token.trim());
  return match ? Number(match[1]) : null;
}

/** Carry a verbatim STEP token (`$` or `#N`) into `StoreEditor.addEntity`'s
 *  attribute conventions: `$` becomes `null`, a reference token is passed
 *  through as the `"#42"` string `addEntity` recognizes. */
function verbatimAttr(token: string | undefined): IfcAttributeValue {
  if (!token) return null;
  const trimmed = token.trim();
  return trimmed === '$' || trimmed === '' ? null : trimmed;
}

/** Parse an `IfcCartesianPoint.Coordinates` token — a parenthesized,
 *  top-level-comma-separated REAL list (`(1000.,2000.,30.)`) — into numbers.
 *  `null` when the token isn't a list, or any member doesn't parse as a
 *  finite number. */
function parseCoordinateList(token: string | undefined): number[] | null {
  if (!token) return null;
  const trimmed = token.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return null;
  const numbers = splitTopLevelArgs(trimmed.slice(1, -1)).map((part) => Number(part.trim()));
  return numbers.every((n) => Number.isFinite(n)) ? numbers : null;
}
