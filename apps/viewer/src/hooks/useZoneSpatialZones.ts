/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Emit a zone set as `IfcSpatialZone` entities (issue #2508 item 3), so the
 * zones themselves - not just the numbers about them - survive an export.
 *
 * The write-back (`useZoneWriteBack`) says how much of each ELEMENT is in each
 * zone. This says what the ZONES ARE: named regions with a shape and a
 * position, which a receiving tool can select, colour and filter by without
 * parsing a property value. The two are complementary, and this deliberately
 * does not replace either half.
 *
 * ## Per model, because a zone set spans a federation
 *
 * Zones are authored against the shared scene, so one set can reach elements in
 * several loaded models. There is no such thing as a federated IFC file, so
 * each model gets its OWN copy of the zones, referencing its own elements. The
 * copies agree because they are all built from the same world coordinates.
 *
 * A model that federation alignment RE-BASED is refused rather than emitted
 * into: its render coordinates undo to the anchor file's coordinate system, so
 * the zone would be written into this file by someone else's origin. Same
 * refusal, for the same reason, as the apportionment's `rescaled-by-alignment`.
 *
 * ## Why this does not enter the undo stack
 *
 * Like the write-back, it writes through each model's `MutablePropertyView`
 * directly and commits one `markModelsDirty`. Its inverse is the panel's
 * explicit Remove, which sweeps by the zone set's name.
 */

import { useCallback } from 'react';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { configureMutationView } from '@/utils/configureMutationView';
import { geometryVolumesSurviveAlignment } from '@/lib/compare/alignmentTrust';
import { resolveRenderFrame } from './useRenderFrameOffsets.js';
import {
  emitSpatialZones,
  removeSpatialZones,
  type EmitRefusal,
  type ZoneMembership,
} from '@/lib/zones/emit-spatial-zones.js';
import type { ZoneSet } from '@/lib/zones';

/** What one model's emission did, named so the panel can say which model. */
export interface ModelEmitOutcome {
  modelId: string;
  modelName: string;
  zonesEmitted: number;
  elementsReferenced: number;
  zonesReplaced: number;
  refusal: EmitRefusal | null;
}

export interface ZoneEmitResult {
  models: ModelEmitOutcome[];
  /** Set when nothing was emitted anywhere, and why. */
  blocked: 'collab-role' | 'no-members' | null;
  elapsedMs: number;
}

/** Per-model handles the loop would otherwise re-derive. */
interface ModelContext {
  editor: StoreEditor;
  store: IfcDataStore;
  name: string;
  rebased: boolean;
}

/**
 * Get-or-create a model's overlay AND its editor.
 *
 * The editor cache is the store's own (`storeEditors`), shared with the
 * authoring actions, because express-id allocation runs off the watermark the
 * view holds: two editors over one view are safe, but reusing the cached one
 * keeps that a fact rather than a thing to re-check.
 */
function contextFor(modelId: string, cache: Map<string, ModelContext | null>): ModelContext | null {
  const cached = cache.get(modelId);
  if (cached !== undefined) return cached;

  const state = useViewerStore.getState();
  const model = state.models.get(modelId);
  const store = (model?.ifcDataStore ?? (modelId === 'legacy' ? state.ifcDataStore : null)) as IfcDataStore | null;
  if (!store) {
    cache.set(modelId, null);
    return null;
  }

  let view = state.getMutationView(modelId);
  if (!view) {
    view = new MutablePropertyView(store.properties || null, modelId);
    configureMutationView(view, store);
    state.registerMutationView(modelId, view);
  }
  let editor = state.storeEditors.get(modelId);
  if (!editor) {
    editor = new StoreEditor(store, view);
    state.storeEditors.set(modelId, editor);
  }

  const context: ModelContext = {
    editor,
    store,
    name: model?.name ?? modelId,
    rebased: model ? !geometryVolumesSurviveAlignment(model.federationAlignmentStatus) : false,
  };
  cache.set(modelId, context);
  return context;
}

/** The set's elements, grouped by the model whose file they live in. */
function membersByModel(zoneSet: ZoneSet): Map<string, ZoneMembership[]> {
  const byModel = new Map<string, ZoneMembership[]>();
  for (const [globalId, record] of useViewerStore.getState().zoneAssignments) {
    const assignment = record[zoneSet.id];
    if (!assignment || assignment.touchedZoneIds.length === 0) continue;
    const ref = resolveEntityRef(globalId);
    const list = byModel.get(ref.modelId);
    const member: ZoneMembership = { expressId: ref.expressId, touchedZoneIds: assignment.touchedZoneIds };
    if (list) list.push(member);
    else byModel.set(ref.modelId, [member]);
  }
  return byModel;
}

/** Emit `zoneSet` into every model it reaches. */
export function emitZoneSpatialZones(zoneSet: ZoneSet): ZoneEmitResult {
  const state = useViewerStore.getState();
  if (!state.canCollabEdit()) return { models: [], blocked: 'collab-role', elapsedMs: 0 };

  const t0 = performance.now();
  const byModel = membersByModel(zoneSet);
  if (byModel.size === 0) return { models: [], blocked: 'no-members', elapsedMs: performance.now() - t0 };

  // One frame for the whole scene, resolved by the readouts' own rule: the
  // federation is aligned to the earliest-loaded model's frame at load, so that
  // model's offsets are what every model on screen was drawn with.
  const frame = resolveRenderFrame(state.models, state.geometryResult);

  const contexts = new Map<string, ModelContext | null>();
  const outcomes: ModelEmitOutcome[] = [];
  const touchedModels: string[] = [];

  for (const [modelId, members] of byModel) {
    const context = contextFor(modelId, contexts);
    if (!context) continue;
    const result = emitSpatialZones(context.editor, context.store, zoneSet, members, frame, {
      rebased: context.rebased,
    });
    outcomes.push({
      modelId,
      modelName: context.name,
      zonesEmitted: result.zonesEmitted,
      elementsReferenced: result.elementsReferenced,
      zonesReplaced: result.zonesReplaced,
      refusal: result.refusal,
    });
    if (result.zonesEmitted > 0 || result.zonesReplaced > 0) touchedModels.push(modelId);
  }

  if (touchedModels.length > 0) useViewerStore.getState().markModelsDirty(touchedModels);
  return { models: outcomes, blocked: null, elapsedMs: performance.now() - t0 };
}

export interface ZoneEmitRemoval {
  /** Zones removed, across every model. */
  removed: number;
  blocked: 'collab-role' | null;
}

/**
 * Remove the zones an emission wrote, from every model that has any.
 *
 * Sweeps every model with an overlay rather than only the ones the set
 * currently reaches: a zone that has since moved off a model leaves its
 * `IfcSpatialZone` behind, and that is exactly the copy nothing else clears.
 */
export function removeZoneSpatialZones(zoneSet: ZoneSet): ZoneEmitRemoval {
  const state = useViewerStore.getState();
  if (!state.canCollabEdit()) return { removed: 0, blocked: 'collab-role' };

  const contexts = new Map<string, ModelContext | null>();
  const touchedModels: string[] = [];
  let removed = 0;
  for (const [modelId] of state.mutationViews) {
    const context = contextFor(modelId, contexts);
    if (!context) continue;
    const count = removeSpatialZones(context.editor, zoneSet.name);
    if (count === 0) continue;
    removed += count;
    touchedModels.push(modelId);
  }
  if (touchedModels.length > 0) useViewerStore.getState().markModelsDirty(touchedModels);
  return { removed, blocked: null };
}

/** React-facing handles. */
export function useZoneSpatialZones() {
  const emit = useCallback((zoneSet: ZoneSet) => emitZoneSpatialZones(zoneSet), []);
  const remove = useCallback((zoneSet: ZoneSet) => removeZoneSpatialZones(zoneSet), []);
  return { emit, remove };
}
