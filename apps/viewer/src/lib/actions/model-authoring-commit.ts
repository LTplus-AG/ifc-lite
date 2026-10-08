/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Commit of an approved, previewed authoring batch: per model ONE modeling
 * transaction (`runTransaction`, one undo step, all-or-nothing, the wasm
 * re-mesh of everything created, moved or reshaped), written through the
 * store's gated actions and modelling methods, the same writes the Model
 * workspace's tools make. A batch spanning models reverts the models already
 * committed when a later one refuses. The receipt is a `ModelChangeReceipt`
 * of kind `model.authoring`, so the receipt library, the Changes panel list
 * and `undoModelChanges` serve both producers.
 */

import type { StoreApi } from 'zustand';
import { writeReviewedLayers } from './model-authoring-layers';
import { generateIfcGuid } from '@ifc-lite/encoding';
import type { ViewerState } from '@/store';
import { copyElements } from '@/lib/commands/modeling/copy-elements';
import { authoringCopyTransforms, copyRefs } from './model-authoring-copy';
import { authoringSourcesAreCurrent } from './model-authoring-sources';
import { runTransaction } from '@/lib/commands/modeling/transaction';
import type { AuthoringTransaction, CommitResult, ModelingCommand } from '@/lib/commands/modeling/types';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { commitElementTransform, planSelectionTransform } from '@/lib/element-transform/commit';
import { detachFromType, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { toMetres, type AuthoringOp, type ModelAuthoringBatch } from './model-authoring';
import { authoredElementOf, hostedSpecOf, idOf, writeRelation } from './model-authoring-native';
import { previewModelAuthoring, type AuthoringRow, type ModelAuthoringPreview } from './model-authoring-preview';
import { undoBatch, type AppliedChange, type CommitOutcome, type ModelChangeReceipt } from './model-change-commit';
import { commitElementSize } from '@/lib/element-size-commit';
import { setElementProfile } from '@/store/slices/mutation-element-profile';
import { sizeInMetres } from './model-authoring-size-params';
import { profileInMetres } from './model-authoring-shape-params';

/** Rows that will be written: approved, ready, and every creation they use is written too. */
export function writableRows(preview: ModelAuthoringPreview, approved: ReadonlySet<number>): AuthoringRow[] {
  const chosen = new Set<number>();
  for (const row of preview.rows) {
    if (approved.has(row.index) && row.status === 'ready' && row.dependsOn.every((i) => chosen.has(i))) chosen.add(row.index);
  }
  return preview.rows.filter((row) => chosen.has(row.index));
}

interface Written { created: number[]; deleted: number[]; remesh: number[]; moved: boolean }

const fmt = (batch: ModelAuthoringBatch, values: readonly number[]) =>
  `(${values.map((v) => Number((batch.units === 'mm' ? v * 1000 : v).toFixed(batch.units === 'mm' ? 1 : 4))).join(', ')}) ${batch.units}`;

function createElement(s: ViewerState, modelId: string, storey: number, element: ReturnType<typeof authoredElementOf>): number {
  let out: { expressId: number } | { error: string };
  switch (element.kind) {
    case 'wall': out = s.addWall(modelId, storey, element.params); break;
    case 'slab': out = s.addSlab(modelId, storey, element.params); break;
    case 'roof': out = s.addRoof(modelId, storey, element.params); break;
    case 'plate': out = s.addPlate(modelId, storey, element.params); break;
    case 'column': out = s.addColumn(modelId, storey, element.params); break;
    case 'beam': out = s.addBeam(modelId, storey, element.params); break;
    case 'member': out = s.addMember(modelId, storey, element.params); break;
    case 'space': out = s.addSpace(modelId, storey, element.params); break;
  }
  if ('error' in out) throw new Error(out.error);
  return out.expressId;
}

/** Write one row; throws so the transaction rolls the model back. */
function writeRow(tx: AuthoringTransaction, batch: ModelAuthoringBatch, row: AuthoringRow, refs: Map<string, string | number>, ids: Map<string, number>, written: Written): AppliedChange[] {
  const modelId = row.modelId!;
  const { op, resolved, before } = row;
  const base = { index: row.index, op: op.op, modelId };
  const targetGid = 'target' in op && !('ref' in op.target) ? op.target.globalId : undefined;
  switch (op.op) {
    case 'element.resize': case 'element.profile': {
      const outcome = op.op === 'element.resize'
        ? commitElementSize(tx.api, modelId, resolved.target!, sizeInMetres(op.size, batch.units))
        : setElementProfile(() => tx.store, modelId, resolved.target!, profileInMetres(op.Profile, batch.units));
      if (!outcome.ok) throw new Error(outcome.reason);
      written.remesh.push(...outcome.remesh);
      return [{ ...base, globalId: op.target.globalId, field: op.op === 'element.resize' ? 'Dimensions' : 'Profile',
        before: JSON.stringify(op.expected),
        after: JSON.stringify(op.op === 'element.resize' ? op.size : op.Profile) }];
    }
    case 'element.create': {
      const globalId = generateIfcGuid();
      const id = createElement(tx.store, modelId, resolved.storey!, authoredElementOf(batch, op, globalId));
      ids.set(op.ref, id); refs.set(op.ref, globalId);
      written.created.push(id); written.remesh.push(id);
      return [{ ...base, globalId, field: op.ifcClass, before: null, after: op.name }];
    }
    case 'hosted.create': {
      const globalId = generateIfcGuid();
      const host = idOf(resolved.host!, ids);
      const out = tx.store.addHostedFill(modelId, host, hostedSpecOf(batch, op, globalId), tx.batchId);
      if ('error' in out) throw new Error(out.error);
      if (op.ref) { ids.set(op.ref, out.expressId); refs.set(op.ref, globalId); }
      written.created.push(out.expressId); written.remesh.push(out.expressId, out.openingId, out.hostId);
      return [{ ...base, globalId, field: op.kind === 'opening' ? 'IfcOpeningElement' : op.kind === 'door' ? 'IfcDoor' : 'IfcWindow', before: null, after: op.name ?? op.kind }];
    }
    case 'element.copy': case 'element.array': {
      const outcome = copyElements(tx.api, modelId, [idOf(resolved.subject!, ids)], authoringCopyTransforms(batch, op, resolved.storey), { batchId: tx.batchId });
      written.created.push(...outcome.copiedFrom.keys());
      written.remesh.push(...outcome.meshed);
      const r = tx.store.mutationViews.get(modelId);
      return outcome.copies.map((id, i) => {
        const entity = r?.getNewEntity(id);
        const globalId = entity?.attributes[0];
        if (!entity || typeof globalId !== 'string') throw new Error('A native copy has no GlobalId');
        const ref = copyRefs(op)[i];
        ids.set(ref, id); refs.set(ref, globalId);
        return { ...base, globalId, field: entity.type, before: null, after: typeof entity.attributes[2] === 'string' ? entity.attributes[2] : null };
      });
    }
    case 'material.layers': {
      const dataStore = tx.store.models.get(modelId)?.ifcDataStore;
      if (!dataStore) throw new Error('The native model source is unavailable');
      const changed = recordModellingEdit(tx.api, modelId, (methods, draft) => writeReviewedLayers(
        { modelId, dataStore, view: draft.getMutationView(), editor: draft }, draft, methods, resolved.layers!), tx.batchId);
      written.remesh.push(...changed);
      return [{ ...base, globalId: op.target.globalId, field: 'MaterialLayers', before: JSON.stringify(op.expected),
        after: JSON.stringify({ scope: op.scope, MaterialLayers: op.MaterialLayers }) }];
    }
    case 'type.detach': {
      const dataStore = tx.store.models.get(modelId)?.ifcDataStore;
      if (!dataStore) throw new Error('The native model source is unavailable');
      recordModellingEdit(tx.api, modelId, (_methods, draft) => detachFromType(draft, dataStore, [resolved.target!]), tx.batchId);
      written.remesh.push(resolved.target!);
      return [{ ...base, globalId: op.target.globalId, field: 'Type', before: before.type ?? null, after: null }];
    }
    case 'element.delete':
      if (!tx.store.removeEntity(modelId, resolved.target!)) throw new Error(`${op.target.globalId} could not be removed`);
      written.deleted.push(resolved.target!);
      return [{ ...base, globalId: op.target.globalId, field: before.ifcClass ?? op.target.ifcClass, before: before.name ?? null, after: null }];
    case 'element.move': case 'element.rotate': {
      const root = planSelectionTransform(tx.store, modelId, [resolved.target!])?.roots.find((r) => r.expressId === resolved.target);
      const plane = root ? buildStoreyWorkplane(tx.store, modelId, root.storeyId, 0) : null;
      if (!root || !plane || !isWorkplane(plane)) throw new Error(`${op.target.globalId} can no longer be moved`);
      const m = (v: number) => toMetres(batch, v);
      const result = op.op === 'element.move'
        ? commitElementTransform(tx, modelId, [resolved.target!], { kind: 'move', from: plane.localToRender([0, 0, 0]), to: plane.localToRender([m(op.delta[0]), m(op.delta[1]), 0]) })
        : commitElementTransform(tx, modelId, [resolved.target!], { kind: 'rotate', pivot: plane.localToRender([root.origin[0], root.origin[1], 0]), angle: (op.angleDeg * Math.PI) / 180 });
      written.remesh.push(...result.remesh); written.moved = true;
      if (op.op === 'element.rotate') {
        const from = before.angleDeg ?? 0;
        return [{ ...base, globalId: op.target.globalId, field: 'Angle', before: `${from.toFixed(1)}°`, after: `${(from + op.angleDeg).toFixed(1)}°` }];
      }
      const origin = before.origin ?? root.origin;
      return [{ ...base, globalId: op.target.globalId, field: 'Placement', before: fmt(batch, origin),
        after: fmt(batch, [origin[0] + m(op.delta[0]), origin[1] + m(op.delta[1])]) }];
    }
    default: {
      const changed = recordModellingEdit(tx.api, modelId, (methods) => writeRelation(methods, modelId, op, resolved, ids), tx.batchId);
      written.remesh.push(...changed);
      return [relationReceipt(base, op, row, refs, targetGid)];
    }
  }
}

function relationReceipt(base: Pick<AppliedChange, 'index' | 'op' | 'modelId'>, op: AuthoringOp, row: AuthoringRow, refs: ReadonlyMap<string, string | number>, targetGid: string | undefined): AppliedChange {
  const gid = (target: { ref: string } | { globalId: string }) => 'ref' in target ? String(refs.get(target.ref) ?? target.ref) : target.globalId;
  if (op.op === 'walls.join') return { ...base, globalId: gid(op.walls[0]), field: 'Join', before: null, after: gid(op.walls[1]) };
  if (op.op === 'type.assign') {
    return { ...base, globalId: targetGid ?? gid(op.target), field: 'Type', before: row.before.type ?? null, after: 'create' in op.type ? op.type.create.name : op.type.name };
  }
  if (op.op === 'material.assign') {
    return { ...base, globalId: targetGid ?? gid(op.target), field: 'Material', before: row.before.material ?? null, after: op.material.name };
  }
  throw new Error(`${op.op} has no relationship receipt`);
}

export function commitModelAuthoring(
  store: StoreApi<ViewerState>,
  preview: ModelAuthoringPreview,
  approved: ReadonlySet<number>,
  origin: string,
): CommitOutcome {
  // Re-run the preflight: approval covers what was shown, nothing that moved since.
  if (!authoringSourcesAreCurrent(store.getState(), preview)) return { ok: false, reason: 'stale' };
  const fresh = previewModelAuthoring(store.getState(), preview.batch);
  if (fresh.digest !== preview.digest || store.getState().mutationVersion !== preview.mutationVersion) return { ok: false, reason: 'stale' };
  const chosen = writableRows(fresh, approved);
  if (chosen.length === 0) return { ok: false, reason: 'nothing-approved' };
  const byModel = new Map<string, AuthoringRow[]>();
  for (const row of chosen) byModel.set(row.modelId!, [...(byModel.get(row.modelId!) ?? []), row]);

  const batches: ModelChangeReceipt['batches'] = [];
  const applied: AppliedChange[] = [];
  for (const [modelId, rows] of byModel) {
    const done: AppliedChange[] = [];
    const command: ModelingCommand = {
      id: 'assistant.modelAuthoring', labelKey: 'modelAuthoring.commandLabel', hud: {}, snap: 'modeling',
      init: () => null, pointerMove: (g) => g, pointerDown: (g) => g,
      commit: (_g, tx): CommitResult => {
        const written: Written = { created: [], deleted: [], remesh: [], moved: false };
        const refs = new Map<string, string | number>();
        const ids = new Map<string, number>();
        for (const row of rows) done.push(...writeRow(tx, preview.batch, row, refs, ids, written));
        const remesh = [...new Set(written.remesh)].filter((id) => !written.deleted.includes(id));
        return { created: written.created, deleted: written.deleted, remesh,
          ...(written.created.length === 0 && written.moved ? { remeshCause: 'hostsChanged' as const } : {}) };
      },
    };
    const outcome = runTransaction(store, command, null, { get: store.getState, modelId, storeyId: null, workplane: null });
    if (!outcome.ok || !outcome.batchId) {
      // Keep a multi-model batch all-or-nothing: revert models already committed.
      for (const committed of [...batches].reverse()) undoBatch(store, committed.batchId);
      return { ok: false, reason: 'refused', detail: outcome.ok ? 'Nothing was written' : outcome.reason };
    }
    batches.push({ modelId, batchId: outcome.batchId });
    applied.push(...done);
  }
  const written = new Set(chosen.map((row) => row.index));
  const skipped = fresh.rows.filter((row) => !written.has(row.index))
    .map((row) => ({ index: row.index, status: row.status === 'ready' ? 'not-approved' as const : row.status }));
  return { ok: true, receipt: { version: 1, kind: 'model.authoring', id: crypto.randomUUID(), title: preview.batch.title, digest: preview.digest,
    createdAt: new Date().toISOString(), origin, batches, applied, skipped, status: 'applied' } };
}
