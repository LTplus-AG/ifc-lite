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
 *     baseline (only the changed fields appear).
 *
 * Composed with the baseline, the layer reproduces `doc`'s current
 * state — that's the IFCX layer composition contract from §2 (each
 * peer becomes a layer author, layer composition is the merge
 * function).
 *
 * Strategy: reconstruct a "before" Y.Doc from the baseline state,
 * compare entity-by-entity with the live doc, and emit IFCX nodes
 * containing only the diff. We deliberately don't try to express
 * deletions in the layer — IFCX overlay semantics are additive in
 * v0.x, and deletion overlays are spec'd for a future version.
 */

import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import * as Y from 'yjs';
import { createCollabDoc, entitiesMap } from '../doc/schema.js';
import { entityToJSON } from '../doc/entity.js';
import { snapshotToIfcx, type SnapshotOptions } from './to-ifcx.js';

export interface ExtractMinimalLayerOptions {
  /** Forwarded to `snapshotToIfcx` for header / timestamp / id. */
  snapshot?: SnapshotOptions;
  /**
   * If true (default), include attributes that changed value from the
   * baseline as well as new attributes. If false, only include keys
   * that didn't exist in the baseline at all.
   */
  includeUpdatedValues?: boolean;
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
  // Reconstruct the "before" state by replaying the baseline update on
  // a fresh doc.
  const before = createCollabDoc({ gc: false });
  if (baseline.byteLength > 0) Y.applyUpdate(before, baseline);

  // Snapshot the live doc through the standard writer so we get a
  // header + imports + schemas template, then trim the data array down
  // to the diff.
  const live = snapshotToIfcx(doc, options.snapshot);
  const beforeEnts = entitiesMap(before);
  const liveEnts = entitiesMap(doc);

  const diffNodes: IfcxNode[] = [];

  liveEnts.forEach((entUntyped, path) => {
    const liveJson = entityToJSON(entUntyped as Y.Map<unknown>);
    const beforeUntyped = beforeEnts.get(path);
    if (!beforeUntyped) {
      // Entity is new — emit it whole (sans empty branches).
      const node: IfcxNode = { path };
      if (Object.keys(liveJson.attributes).length > 0) node.attributes = { ...liveJson.attributes };
      if (Object.keys(liveJson.children).length > 0) node.children = { ...liveJson.children };
      if (Object.keys(liveJson.inherits).length > 0) node.inherits = { ...liveJson.inherits };
      diffNodes.push(node);
      return;
    }

    const beforeJson = entityToJSON(beforeUntyped as Y.Map<unknown>);
    const node: IfcxNode = { path };
    let dirty = false;

    // Attributes: include keys that are new OR (when configured)
    // whose value changed.
    const addedAttrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(liveJson.attributes)) {
      const wasInBaseline = key in beforeJson.attributes;
      if (!wasInBaseline) {
        addedAttrs[key] = value;
        continue;
      }
      if (includeUpdatedValues && !deepEqual(value, beforeJson.attributes[key])) {
        addedAttrs[key] = value;
      }
    }
    if (Object.keys(addedAttrs).length > 0) {
      node.attributes = addedAttrs;
      dirty = true;
    }

    // Children: same rule.
    const addedChildren: Record<string, string> = {};
    for (const [role, child] of Object.entries(liveJson.children)) {
      const wasInBaseline = role in beforeJson.children;
      if (!wasInBaseline || (includeUpdatedValues && beforeJson.children[role] !== child)) {
        addedChildren[role] = child;
      }
    }
    if (Object.keys(addedChildren).length > 0) {
      node.children = addedChildren;
      dirty = true;
    }

    // Inherits: same rule.
    const addedInherits: Record<string, string> = {};
    for (const [role, inh] of Object.entries(liveJson.inherits)) {
      const wasInBaseline = role in beforeJson.inherits;
      if (!wasInBaseline || (includeUpdatedValues && beforeJson.inherits[role] !== inh)) {
        addedInherits[role] = inh;
      }
    }
    if (Object.keys(addedInherits).length > 0) {
      node.inherits = addedInherits;
      dirty = true;
    }

    if (dirty) diffNodes.push(node);
  });

  before.destroy();

  return {
    ...live,
    data: diffNodes,
  };
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
