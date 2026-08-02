/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Differential layer composer (spec §2 / §10 / §12.4).
 *
 * `extractMinimalLayer(doc, baseline)` produces an IFCX layer that
 * contains *only* what changed since `baseline`:
 *   - Entities created since baseline.
 *   - Entities whose attributes / children / inherits changed since
 *     baseline (only the changed fields appear). Structured branches
 *     (psets / quantities / classifications / materials / geometryRef)
 *     participate via the same flattened-attribute view the full
 *     snapshot writer emits (`structured-attrs.ts`, #1031).
 *
 * Composed with the baseline, the layer reproduces `doc`'s current
 * state — that's the IFCX layer composition contract from §2 (each
 * peer becomes a layer author, layer composition is the merge
 * function).
 *
 * Strategy: reconstruct a "before" Y.Doc from the baseline state,
 * compare entity-by-entity with the live doc, and emit IFCX nodes
 * containing only the diff.
 *
 * Deletions are expressed as overlays (layer-prs spec 02 §2.3):
 *   - a deleted entity emits a tombstone opinion
 *     `{ "ifclite::deleted": true }` which shadows weaker opinions for
 *     the path (and its children) during composition;
 *   - removed children / inherits emit `null` values (standard IFCX
 *     removal semantics);
 *   - removed attributes emit `null` values (the convention the merge
 *     engine and `bakeLayers` resolve).
 */

import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import * as Y from 'yjs';
import { createCollabDoc, entitiesMap } from '../doc/schema.js';
import { entityToJSON } from '../doc/entity.js';
import { snapshotToIfcx, type SnapshotOptions } from './to-ifcx.js';
import { flattenStructuredBranches, geometryRecordLookup } from './structured-attrs.js';

export interface ExtractMinimalLayerOptions {
  /** Forwarded to `snapshotToIfcx` for header / timestamp / id. */
  snapshot?: SnapshotOptions;
  /**
   * If true (default), include attributes that changed value from the
   * baseline as well as new attributes. If false, only include keys
   * that didn't exist in the baseline at all.
   */
  includeUpdatedValues?: boolean;
  /**
   * If true (default), express deletions since the baseline as
   * tombstone opinions (`ifclite::deleted`) and `null` removals. Set to
   * false for the legacy additive-only layer shape.
   */
  includeDeletions?: boolean;
}

/**
 * Build a minimal IFCX layer expressing the diff between `baseline`
 * and `doc`. `baseline` is whatever `Y.encodeStateAsUpdate(doc)`
 * returned at the fork / snapshot point.
 */
export function extractMinimalLayer(
  doc: Y.Doc,
  baseline: Uint8Array,
  options: ExtractMinimalLayerOptions = {},
): IfcxFile {
  const includeUpdatedValues = options.includeUpdatedValues ?? true;
  const includeDeletions = options.includeDeletions ?? true;
  // Reconstruct the "before" state by replaying the baseline update on
  // a fresh doc.
  const before = createCollabDoc({ gc: false });
  try {
    if (baseline.byteLength > 0) Y.applyUpdate(before, baseline);

    // Snapshot the live doc through the standard writer so we get a
    // header + imports + schemas template, then trim the data array down
    // to the diff.
    const live = snapshotToIfcx(doc, options.snapshot);
    const beforeEnts = entitiesMap(before);
    const liveEnts = entitiesMap(doc);
    const liveGeometryFor = geometryRecordLookup(doc);
    const beforeGeometryFor = geometryRecordLookup(before);

    const diffNodes: IfcxNode[] = [];

    liveEnts.forEach((entUntyped, path) => {
      const liveJson = entityToJSON(entUntyped as Y.Map<unknown>);
      // Diff over the flattened attribute view so structured-branch
      // edits (psets / quantities / classifications / materials /
      // geometryRef) surface exactly like the full writer emits them —
      // the two writers stay in lockstep by construction (#1031).
      const liveAttrs = flattenStructuredBranches(liveJson, { geometryRecordFor: liveGeometryFor });
      const beforeUntyped = beforeEnts.get(path);
      if (!beforeUntyped) {
        // Entity is new — emit it whole (sans empty branches).
        const node: IfcxNode = { path };
        if (Object.keys(liveAttrs).length > 0) node.attributes = liveAttrs;
        if (Object.keys(liveJson.children).length > 0) node.children = { ...liveJson.children };
        if (Object.keys(liveJson.inherits).length > 0) node.inherits = { ...liveJson.inherits };
        diffNodes.push(node);
        return;
      }

      const beforeJson = entityToJSON(beforeUntyped as Y.Map<unknown>);
      const beforeAttrs = flattenStructuredBranches(beforeJson, { geometryRecordFor: beforeGeometryFor });
      const node: IfcxNode = { path };
      let dirty = false;

      // Attributes: include keys that are new OR (when configured)
      // whose value changed; removed keys emit null.
      const addedAttrs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(liveAttrs)) {
        const wasInBaseline = key in beforeAttrs;
        if (!wasInBaseline) {
          addedAttrs[key] = value;
          continue;
        }
        if (includeUpdatedValues && !deepEqual(value, beforeAttrs[key])) {
          addedAttrs[key] = value;
        }
      }
      if (includeDeletions) {
        for (const key of Object.keys(beforeAttrs)) {
          if (!(key in liveAttrs)) addedAttrs[key] = null;
        }
      }
      if (Object.keys(addedAttrs).length > 0) {
        node.attributes = addedAttrs;
        dirty = true;
      }

      // Children: same rule; removed roles emit null (IFCX removal).
      const addedChildren: Record<string, string | null> = {};
      for (const [role, child] of Object.entries(liveJson.children)) {
        const wasInBaseline = role in beforeJson.children;
        if (!wasInBaseline || (includeUpdatedValues && beforeJson.children[role] !== child)) {
          addedChildren[role] = child;
        }
      }
      if (includeDeletions) {
        for (const role of Object.keys(beforeJson.children)) {
          if (!(role in liveJson.children)) addedChildren[role] = null;
        }
      }
      if (Object.keys(addedChildren).length > 0) {
        node.children = addedChildren;
        dirty = true;
      }

      // Inherits: same rule.
      const addedInherits: Record<string, string | null> = {};
      for (const [role, inh] of Object.entries(liveJson.inherits)) {
        const wasInBaseline = role in beforeJson.inherits;
        if (!wasInBaseline || (includeUpdatedValues && beforeJson.inherits[role] !== inh)) {
          addedInherits[role] = inh;
        }
      }
      if (includeDeletions) {
        for (const role of Object.keys(beforeJson.inherits)) {
          if (!(role in liveJson.inherits)) addedInherits[role] = null;
        }
      }
      if (Object.keys(addedInherits).length > 0) {
        node.inherits = addedInherits;
        dirty = true;
      }

      if (dirty) diffNodes.push(node);
    });

    // Entities deleted since the baseline: tombstone opinions that shadow
    // the entity (and its subtree) when the stack composes.
    if (includeDeletions) {
      beforeEnts.forEach((_entUntyped, path) => {
        if (!liveEnts.has(path)) {
          diffNodes.push({ path, attributes: { [IFCLITE_ATTR.DELETED]: true } });
        }
      });
    }

    return {
      ...live,
      data: diffNodes,
    };
  } finally {
    // Deterministic cleanup even when extraction throws.
    before.destroy();
  }
}

/**
 * Heuristic deep-equal: handles primitives, arrays, and plain objects.
 * Sufficient for IFCX values which are JSON-shaped by construction.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}
