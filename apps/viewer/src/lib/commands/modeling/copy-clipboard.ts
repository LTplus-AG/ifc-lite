/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's copy buffer (#6232 C3): Ctrl+C remembers which
 * elements to copy and where the first one's placement sits on its storey;
 * `element.paste` writes copies of them lined up with the cursor, on the
 * workspace's storey. It holds element ids, not their data: a paste copies
 * the elements as they are then, and refuses one deleted in between.
 */

import { createCopyContext, productStoreyOrigin } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { copySources } from './copy-elements.js';
import type { Vec3 } from './types.js';

export interface CopyClipboard {
  readonly modelId: string;
  /** Model-local ids; the openings, doors and windows of a copied host ride with it. */
  readonly ids: readonly number[];
  /** The first element's placement origin on its storey, metres: the paste's grip. */
  readonly base: Vec3;
}

let clipboard: CopyClipboard | null = null;

export function readCopyClipboard(): CopyClipboard | null {
  return clipboard;
}

/** Forget the copy buffer (a model unload, tests). */
export function clearCopyClipboard(): void {
  clipboard = null;
}

/**
 * The selected elements, as the viewer's other selection readers take them
 * (`hideSelection`): the multi-selection when there is one, else the plain
 * click's element. Model-local ids of the first one's model, that one first.
 */
export function selectedElements(s: ViewerState): { modelId: string; ids: number[] } | null {
  const globalIds = s.selectedEntityIds.size > 0 ? [...s.selectedEntityIds] : s.selectedEntityId === null ? [] : [s.selectedEntityId];
  if (s.selectedEntityId !== null && globalIds.includes(s.selectedEntityId)) {
    globalIds.splice(globalIds.indexOf(s.selectedEntityId), 1);
    globalIds.unshift(s.selectedEntityId);
  }
  if (globalIds.length === 0) return null;
  const refs = globalIds.map(resolveEntityRef);
  const modelId = refs[0].modelId;
  if (!s.models.has(modelId)) return null;
  return { modelId, ids: [...new Set(refs.filter((r) => r.modelId === modelId).map((r) => r.expressId))] };
}

export type CopyVerdict = { ok: true; count: number } | { ok: false; reason: string } | { ok: false; reason: null };

/**
 * Put the selection of `modelId` in the copy buffer. `reason: null` means
 * nothing is selected there: the key is not ours to take.
 */
export function copySelectionToClipboard(s: ViewerState, modelId: string): CopyVerdict {
  const selected = selectedElements(s);
  if (!selected || selected.modelId !== modelId) return { ok: false, reason: null };
  const sources = copySources(s, modelId, selected.ids);
  if ('refusal' in sources) return { ok: false, reason: sources.refusal };
  const target = modelEditTarget(s, modelId);
  let origin: ReturnType<typeof productStoreyOrigin> = null;
  try {
    origin = target ? productStoreyOrigin(createCopyContext(target.dataStore, target.editor), sources.ids[0]) : null;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!origin) return { ok: false, reason: 'The selected element has no placement to copy from' };
  clipboard = { modelId, ids: sources.ids, base: origin.origin };
  return { ok: true, count: sources.ids.length };
}
