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

import { commitNativeReplacement } from './model-authoring-replacement-commit';
import { writeSlabOpening } from './model-authoring-slab-opening';
import type { StoreApi } from 'zustand';
import { generateIfcGuid } from '@ifc-lite/encoding';
import type { ViewerState } from '@/store';
import { copyElements } from '@/lib/commands/modeling/copy-elements';
import { authoringCopyTransforms, copyRefs } from './model-authoring-copy';
import { writeHostedEdit } from './model-authoring-hosted-edit';
import { hostedFillRefusal } from '@/store/slices/mutation-hosted-fill';
import { authoringSourcesAreCurrent } from './model-authoring-sources';
import { runTransaction } from '@/lib/commands/modeling/transaction';
import type { AuthoringTransaction, CommitResult, ModelingCommand } from '@/lib/commands/modeling/types';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { commitElementAlignment, commitElementTransform, planSelectionTransform } from '@/lib/element-transform/commit';
import { writeNativeSplit } from './model-authoring-split';
import { recordModellingEdit, recordModellingCommit } from '@/store/slices/mutation-modelling-records';
import { toMetres, type AuthoringOp, type ModelAuthoringBatch } from './model-authoring';
import { authoredElementOf, hostedSpecOf, idOf, writeRelation, writeNativeTypeDetach } from './model-authoring-native';
import { previewModelAuthoring, type AuthoringRow, type ModelAuthoringPreview } from './model-authoring-preview';
import { undoBatch, type AppliedChange, type CommitOutcome, type ModelChangeReceipt } from './model-change-commit';
import { commitElementSize } from '@/lib/element-size-commit';
import { setElementProfile } from '@/store/slices/mutation-element-profile';
import { writeCurtainWallCreation } from './model-authoring-curtain-wall-native';
import { completeCurtainWallHierarchy } from '@/store/slices/mutation-curtain-grid';
import { writeStairLifecycle, writeStairCreation } from './model-authoring-stair-lifecycle';
import { nativePlacementFromTarget } from './model-authoring-placement';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
import { completeEntityRemoval } from '@/store/slices/mutation-mesh-stash';
import { completeStairRailingGeometry } from '@/store/slices/mutation-stair-railing';
import { writeAuthoringReach } from './model-authoring-reach';
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
    case 'element.replace': return commitNativeReplacement(tx,batch,row,refs,ids,written);
    case 'stair.resize': case 'stair.delete': case 'railing.delete': case 'stair.replace': case 'railing.replace': {
      const dataStore=tx.store.models.get(modelId)?.ifcDataStore;if(!dataStore)throw new Error('The native lifecycle source is unavailable');
      const result=recordModellingEdit(tx.api,modelId,(_methods,editor)=>writeStairLifecycle(dataStore,editor,batch,op,resolved.target!,resolved.storey),tx.batchId);
      for(const id of result.deleted)completeEntityRemoval(tx.api.getState,tx.api.setState,modelId,id,tx.api.getState().removedNewEntities.get(`${modelId}:${id}`));
      written.created.push(...result.created);written.deleted.push(...result.deleted);written.remesh.push(...result.remesh);
      if('ref' in op&&result.root!==undefined){const view=tx.api.getState().mutationViews.get(modelId),made=view?.getNewEntity(result.root),gid=made?.attributes[0];if(typeof gid!=='string')throw new Error('The native replacement has no GlobalId');ids.set(op.ref,result.root);refs.set(op.ref,gid);completeStairRailingGeometry(tx.api,modelId,resolved.storey!,{expressId:result.root,...(result.created.length>1?{flightId:result.created[1]}:{})},op.op==='stair.replace'?'IFCSTAIR':'IFCRAILING',tx.batchId,false);return [{...base,globalId:gid,field:op.op==='stair.replace'?'IfcStair':'IfcRailing',before:op.target.globalId,after:op.params.Name??null}];}
      return [{...base,globalId:op.target.globalId,field:op.op==='stair.resize'?'Dimensions':op.target.ifcClass,before:op.op==='stair.resize'?JSON.stringify(op.expected):op.target.name,after:op.op==='stair.resize'?JSON.stringify(op.size):null}];
    }
    case 'curtainWall.create': {
      const source = tx.store.models.get(modelId)?.ifcDataStore;
      if (!source) throw new Error('The native curtain-wall source is unavailable');
      const out = recordModellingEdit(tx.api, modelId, (_methods, editor) => writeCurtainWallCreation(source, editor, batch, op, resolved.storey!), tx.batchId);
      const globalId = tx.api.getState().mutationViews.get(modelId)?.getNewEntity(out.curtainWallId)?.attributes[0];
      if (typeof globalId !== 'string') throw new Error('The native curtain wall has no GlobalId');
      completeCurtainWallHierarchy(tx.api, modelId, resolved.storey!, out);
      const all = [out.curtainWallId, ...out.mullionIds, ...out.transomIds, ...out.panelIds];
      ids.set(op.ref, out.curtainWallId); refs.set(op.ref, globalId); written.created.push(...all); written.remesh.push(...all);
      return [{ ...base, globalId, field: 'IfcCurtainWall', before: null, after: JSON.stringify({ Name: op.params.Name ?? 'Curtain Wall', IfcMember: out.mullionIds.length + out.transomIds.length, IfcPlate: out.panelIds.length }) }];
    }
    case 'stair.create': case 'railing.create': {
      const source = tx.store.models.get(modelId)?.ifcDataStore;
      if (!source) throw new Error('The native creation source is unavailable');
      const out = recordModellingEdit(tx.api, modelId, (_methods, editor) => writeStairCreation(source, editor, batch, op, resolved.storey!), tx.batchId);
      const globalId = tx.api.getState().mutationViews.get(modelId)?.getNewEntity(out.expressId)?.attributes[0];
      if (typeof globalId !== 'string') throw new Error('The native product has no GlobalId');
      completeStairRailingGeometry(tx.api, modelId, resolved.storey!, out, op.op === 'stair.create' ? 'IFCSTAIR' : 'IFCRAILING', tx.batchId, false);
      ids.set(op.ref,out.expressId);refs.set(op.ref,globalId);written.created.push(out.expressId,...(out.flightId===undefined?[]:[out.flightId]));written.remesh.push(out.flightId??out.expressId);
      return [{...base,globalId,field:op.op==='stair.create'?'IfcStair':'IfcRailing',before:null,after:op.params.Name??null}];
    }
    case 'hosted.edit': {
      const refusal = hostedFillRefusal(tx.api.getState(), modelId);
      if (refusal) throw new Error(refusal);
      const source = tx.api.getState().models.get(modelId)?.ifcDataStore;
      if (!source) throw new Error('The native hosted source is unavailable');
      const read = recordModellingEdit(tx.api, modelId, (_methods, draft) => writeHostedEdit(batch, source, draft, resolved.target!, op.expected, op.edit, op.target.globalId), tx.batchId);
      written.remesh.push(read.hostId, read.openingId, ...(read.fillingId === null ? [] : [read.fillingId]));
      return [{ ...base, globalId: op.target.globalId, field: 'Hosted occurrence', before: JSON.stringify(before.hosted), after: JSON.stringify(op.edit) }];
    }
    case 'element.trimExtend': {
      const result = recordModellingEdit(tx.api, modelId, (_methods, editor) =>
        writeAuthoringReach(batch, tx.store.models.get(modelId)!.ifcDataStore!, editor, resolved.target!, op, resolved.reachBoundary, ids), tx.batchId);
      written.remesh.push(...result.walls);
      written.moved = true;
      return [{ ...base, globalId: op.target.globalId, field: 'Trim/Extend', before: JSON.stringify(before.reach),
        after: JSON.stringify({ mode: result.op, end: result.end, lengthMetres: result.length, joined: result.joined }) }];
    }
    case 'element.split': {
      const scopes = [...tx.store.models].map(([id, model]) => ({ dataStore: model.ifcDataStore, view: tx.store.mutationViews.get(id) }));
      const result = recordModellingCommit(tx.api, modelId, (editor, store) => writeNativeSplit(batch, op, store, editor, resolved.target!, { globalIdScopes: scopes }), tx.batchId);
      tx.api.getState().recordAuthoredElement(modelId, result.storeyId, result.addedId, result.element, { historyRecorded: true });
      written.created.push(result.addedId); written.remesh.push(result.sourceId, result.addedId);
      return [{ ...base, globalId: op.target.globalId, field: 'Split', before: JSON.stringify(before.split),
        after: JSON.stringify({ addedGlobalId: result.element.params.GlobalId, leftId: result.leftId, rightId: result.rightId, openings: result.openings }) }];
    }
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
      const out = 'params' in op
        ? recordModellingEdit(tx.api, modelId, (_methods, draft) => writeSlabOpening(batch, op, tx.store.models.get(modelId)!.ifcDataStore!, draft, host, globalId), tx.batchId)
        : tx.store.addHostedFill(modelId, host, hostedSpecOf(batch, op, globalId), tx.batchId);
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
    case 'type.detach': {
      const dataStore = tx.store.models.get(modelId)?.ifcDataStore;
      if (!dataStore) throw new Error('The native model source is unavailable');
      recordModellingEdit(tx.api, modelId, (_methods, draft) => writeNativeTypeDetach(op, dataStore, draft, resolved), tx.batchId);
      written.remesh.push(resolved.target!);
      return [{ ...base, globalId: op.target.globalId, field: 'Type', before: before.type ?? null, after: null }];
    }
    case 'element.delete':
      if (!tx.store.removeEntity(modelId, resolved.target!)) throw new Error(`${op.target.globalId} could not be removed`);
      written.deleted.push(resolved.target!);
      return [{ ...base, globalId: op.target.globalId, field: before.ifcClass ?? op.target.ifcClass, before: before.name ?? null, after: null }];
    case 'element.align': {
      const a = resolved.alignment;
      if (!a?.geometry) throw new Error('Native Align preparation is unavailable');
      const result = commitElementAlignment(tx, modelId, { reference: a.reference, targets: a.targets, mode: op.mode }, a.geometry.boxes, a.geometry.plane);
      written.remesh.push(...result.remesh); written.moved = true;
      const currentTarget = readOnlyModelEditTarget(tx.store, modelId);
      return op.targets.map((target, i) => {
        const current = nativePlacementFromTarget(currentTarget, a.targets[i]);
        const prior = op.expected.targets[i];
        return ({ ...base, globalId: target.globalId, field: 'Placement',
        before: fmt(batch, 'origin' in prior ? prior.origin : prior.frame.o),
        after: current ? fmt(batch, 'origin' in current ? current.origin : current.frame.o) : 'Native placement unavailable after Align' });
      });
    }
    case 'element.move': case 'element.rotate': {
      const root = planSelectionTransform(tx.store, modelId, [resolved.target!])?.roots.find((r) => r.expressId === resolved.target);
      const plane = root ? buildStoreyWorkplane(tx.store, modelId, root.storeyId, 0) : null;
      if (!root || !plane || !isWorkplane(plane)) throw new Error(`${op.target.globalId} can no longer be moved`);
      const m = (v: number) => toMetres(batch, v);
      const result = op.op === 'element.move'
        ? commitElementTransform(tx, modelId, [resolved.target!], { kind: 'move', from: plane.localToRender([0, 0, 0]), to: plane.localToRender([m(op.delta[0]), m(op.delta[1]), 0]) })
        : commitElementTransform(tx, modelId, [resolved.target!], { kind: 'rotate', pivot: plane.localToRender(op.pivot ? [m(op.pivot[0]), m(op.pivot[1]), 0] : [root.origin[0], root.origin[1], 0]), angle: (op.angleDeg * Math.PI) / 180 });
      written.remesh.push(...result.remesh); written.moved = true;
      if (op.op === 'element.rotate') {
        const from = before.angleDeg ?? 0;
        const changes: AppliedChange[] = [{ ...base, globalId: op.target.globalId, field: 'Angle', before: `${from.toFixed(1)}°`, after: `${(from + op.angleDeg).toFixed(1)}°` }];
        if (op.pivot) {
          const actual = planSelectionTransform(tx.store, modelId, [resolved.target!])?.roots.find(r => r.expressId === resolved.target);
          if (!actual) throw new Error('Native rotated placement is unavailable');
          changes.push({ ...base, globalId: op.target.globalId, field: 'Placement', before: fmt(batch, root.origin), after: fmt(batch, actual.origin) });
        }
        return changes;
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
