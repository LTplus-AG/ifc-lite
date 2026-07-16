/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer-stack helpers for the Layers panel (#1717 V1): provenance summary
 * extraction from parsed IFCX layers, and the per-layer contribution diff.
 * All layer data here is PATH-keyed; translate to expressIds only at the
 * selection boundary (`layerStackPathToId`).
 */

import { getProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { diffLayerStacks } from '@ifc-lite/merge';
import type { StackDiff } from '@ifc-lite/merge';
import type { LayerAuthorKind, LayerStackEntry } from '@/store/slices/layerStackSlice';

/** Federation-parser layer shape we consume (subset of `IfcxLayer`). */
export interface FederationLayerLike {
  id: string;
  name: string;
  file: IfcxFile;
  buffer: ArrayBuffer;
}

function isAuthorKind(value: unknown): value is LayerAuthorKind {
  return value === 'human' || value === 'agent' || value === 'hybrid';
}

/**
 * Build a panel entry from a federation layer: provenance summary when the
 * layer carries a manifest, content address when blake3-addressed.
 */
export function layerStackEntry(layer: FederationLayerLike): LayerStackEntry {
  const entry: LayerStackEntry = {
    id: layer.id,
    name: layer.name,
    file: layer.file,
    nodeCount: Array.isArray(layer.file.data) ? layer.file.data.length : 0,
    byteLength: layer.buffer.byteLength,
  };
  const headerId = layer.file.header?.id;
  if (typeof headerId === 'string' && headerId.startsWith('blake3:')) {
    entry.contentId = headerId;
  }
  // The manifest is raw foreign JSON: this runs INSIDE the federated
  // load, so a malformed value (checks: [null], author: "x") must
  // degrade to an unsigned-looking entry, never throw the whole load.
  const manifest = getProvenance(layer.file);
  if (manifest && typeof manifest === 'object') {
    if (isAuthorKind(manifest.author?.kind)) entry.authorKind = manifest.author.kind;
    if (typeof manifest.author?.principal === 'string') entry.authorPrincipal = manifest.author.principal;
    if (typeof manifest.intent === 'string') entry.intent = manifest.intent;
    if (typeof manifest.created === 'string') entry.created = manifest.created;
    if (manifest.merge) entry.isMerge = true;
    const checks = Array.isArray(manifest.checks) ? manifest.checks : [];
    if (checks.length > 0) {
      entry.checksTotal = checks.length;
      entry.checksPassed = checks.filter(
        (c) => typeof c === 'object' && c !== null && (c as { result?: unknown }).result === 'pass',
      ).length;
    }
  }
  return entry;
}

/**
 * What did this layer change on top of everything below it? Diffs the stack
 * prefix without the layer against the prefix including it. Runs on the
 * main thread after a macrotask yield, mirroring the compare engine.
 */
export async function computeLayerContribution(
  stack: readonly LayerStackEntry[],
  layerId: string,
): Promise<StackDiff | null> {
  const index = stack.findIndex((entry) => entry.id === layerId);
  if (index < 0) return null;
  // Yield so the busy state paints before the synchronous fold.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const files = stack.map((entry) => entry.file);
  return diffLayerStacks(files.slice(0, index), files.slice(0, index + 1));
}

/** Short display form of a blake3 content address. */
export function shortContentId(contentId: string): string {
  const hex = contentId.startsWith('blake3:') ? contentId.slice('blake3:'.length) : contentId;
  return hex.slice(0, 8);
}

/** Last path segment, for row labels; the full path stays in the tooltip. */
export function pathTail(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}
