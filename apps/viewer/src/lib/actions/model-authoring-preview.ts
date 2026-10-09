/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Preflight for a reviewed authoring batch: resolve every element, storey,
 * type and material; check the edit gate and each expected class, name, type,
 * material, position and angle against the effective model; then let the
 * native builders decide in a dry run on a draft overlay. The preview is a
 * pure snapshot (it writes nothing); commit re-runs it and refuses if
 * anything moved since.
 */

import { authoringCurtainWallGhost } from './model-authoring-curtain-wall-ghost';
import { resolveReviewedLayers, LayerRefusal } from './model-authoring-layers';
import { resolveReviewedStoreyReassignment } from './model-authoring-storey-reassignment';
import { gridCreationGhost } from './model-authoring-grid-ghost';
import { nativeGridExpected, sameGridExpected } from './model-authoring-grid-native';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
import { readNativeReplacementExpected } from './model-authoring-replacement';
import { authoringSlabOpeningGhost } from './model-authoring-slab-opening-ghost';
import { verifySlabOpeningHost } from './model-authoring-slab-opening';
import { stairRailingGhost } from './model-authoring-stair-railing-ghost';
import { nativeStairEvidence, sameStairSnapshot } from './model-authoring-stair-lifecycle';
import { stairPatchInMetres } from './model-authoring-stair-railing-fields';
import type { ViewerState } from '@/store';
import { mutationDenial } from '@/store/mutation-permission';
import { stairRailingRefusal } from '@/store/slices/mutation-stair-railing';
import { materialsOf, typeOf } from '@/lib/commands/modeling/authored-kinds';
import { copiedProductsInStore, createCopyContext, productStoreyOrigin, liveEntityConforms } from '@ifc-lite/create';
import { batchDigest } from './model-change-preview';
import { isNewElement, toMetres, type AuthoringOp, type ElementTarget, type ExistingElement, type ModelAuthoringBatch } from './model-authoring';
import type { ElementId } from './model-authoring-native';
import { validateAuthoringDraft } from './model-authoring-preview-draft';
import {
  authoringReader, className, conforms, deletionRefusal, materialNameOf, nameOf, typeNameOf, type AuthoringReader,
} from './model-authoring-read';
import { captureAuthoringSources } from './model-authoring-sources';
import { resolveGlobalId } from './resolve-global-id';
import { readElementProfileFromTarget } from '@/store/slices/mutation-element-profile';
import { readAuthoringSizeFromTarget, sameNativeDimensions } from './model-authoring-size';
import { verifyReachExpected, verifyReachStoreyFrame, reachBefore } from './model-authoring-reach';
import { sizeInMetres } from './model-authoring-size-params';
import { profileInMetres } from './model-authoring-shape-params';
import { authoringHostedEditGhost } from './model-authoring-hosted-edit-ghost';
import { hostedFillRefusal } from '@/store/slices/mutation-hosted-fill';
import { readExpectedHostedEdit, sameHostedEdit } from './model-authoring-hosted-edit';
import { readSplitSnapshot, sameSplitSnapshot } from './model-authoring-split-state';
import { uniqueSplitGuid } from './model-authoring-split';
import { authoringSplitMarker } from './model-authoring-split-ghost';
import { authoringSizeGhost } from './model-authoring-size-ghost';
import { reviewAlignment } from './model-authoring-align';
import { reviewElementTransform } from './model-authoring-transform-review';
import { AuthoringRefusal as Refusal } from './model-authoring-preview-refusal';

import type { AuthoringRowStatus, AuthoringRow, ModelAuthoringPreview } from './model-authoring-preview-types';
export type { AuthoringRowStatus, AuthoringBefore, AuthoringRow, ModelAuthoringPreview } from './model-authoring-preview-types';

interface Context {
  state: ViewerState;
  batch: ModelAuthoringBatch;
  readers: Map<string, AuthoringReader | null>;
  /** ref → index of the row that creates it. */
  creators: Map<string, number>;
  rows: AuthoringRow[];
}

function reader(ctx: Context, modelId: string): AuthoringReader {
  if (!ctx.readers.has(modelId)) ctx.readers.set(modelId, authoringReader(ctx.state, modelId));
  const found = ctx.readers.get(modelId);
  if (!found) throw new Refusal('missing-target', 'The model is not loaded');
  return found;
}

function locate(ctx: Context, target: { globalId: string; modelId?: string }): { modelId: string; expressId: number } {
  const hit = resolveGlobalId(ctx.state, target);
  if (hit === 'missing') throw new Refusal('missing-target', `${target.globalId} is not in a loaded model`);
  if (hit === 'ambiguous') throw new Refusal('ambiguous-target', `${target.globalId} is in several models; name the model`);
  return hit;
}

function existing(ctx: Context, target: ExistingElement, row: AuthoringRow): number {
  const { modelId, expressId } = locate(ctx, target);
  join(row, modelId);
  const r = reader(ctx, modelId);
  if ((row.op.op.startsWith('stair.') || row.op.op.startsWith('railing.')) && !uniqueSplitGuid(r.dataStore, r.editor, target.globalId)) throw new Refusal('ambiguous-target', 'The native stair or railing target GlobalId is not unique in its owning model');
  if ((row.op.op === 'material.layers' || row.op.op === 'element.replace' || row.op.op === 'element.align' || (row.op.op === 'element.rotate' && !!row.op.pivot) || row.op.op === 'element.split' || row.op.op === 'element.trimExtend' || row.op.op === 'type.detach') && !uniqueSplitGuid(r.dataStore, r.editor, target.globalId)) throw new Refusal('ambiguous-target', 'The native target GlobalId is not unique in its owning model');
  const ifcClass = className(r, expressId);
  const name = nameOf(r, expressId);
  row.before.ifcClass = ifcClass;
  row.before.name = name;
  if (!conforms(r, expressId, target.ifcClass) || name !== target.name) {
    throw new Refusal('conflict', `Expected ${target.ifcClass} "${target.name}"; the model has ${ifcClass} "${name}"`);
  }
  return expressId;
}

/** Every element of one operation lives in one model: one native undo batch per model. */
function join(row: AuthoringRow, modelId: string): void {
  if (row.modelId !== null && row.modelId !== modelId) throw new Refusal('unsupported', 'An operation cannot span two models');
  row.modelId = modelId;
}

function element(ctx: Context, target: ElementTarget, row: AuthoringRow): ElementId {
  if (!isNewElement(target)) return { id: existing(ctx, target, row) };
  const creator = ctx.creators.get(target.ref)!;
  row.dependsOn.push(creator);
  const model = ctx.rows[creator].modelId;
  if (model) join(row, model);
  return { ref: target.ref };
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

function resolve(ctx: Context, row: AuthoringRow): void {
  const { op } = row;
  switch (op.op) {
    case 'element.trimExtend': {
      row.resolved.target = row.expressId = existing(ctx, op.target, row);
      const r = reader(ctx, row.modelId!);
      try { verifyReachStoreyFrame(r.dataStore, r.view, row.expressId); }
      catch (error) { throw new Refusal('unsupported', error instanceof Error ? error.message : String(error)); }
      try { verifyReachExpected(r.dataStore, r.view, r.editor, row.expressId, op); }
      catch (error) { throw new Refusal('conflict', error instanceof Error ? error.message : String(error)); }
      row.before.reach = reachBefore(ctx.state, row.modelId!, row.expressId) ?? undefined;
      if ('wall' in op.boundary) {
        row.resolved.reachBoundary = element(ctx, op.boundary.wall, row);
        if ('id' in row.resolved.reachBoundary) {
          try { verifyReachStoreyFrame(r.dataStore, r.view, row.resolved.reachBoundary.id); }
          catch (error) { throw new Refusal('unsupported', error instanceof Error ? error.message : String(error)); }
        }
      }
      return;
    }
    case 'hosted.edit': {
      row.resolved.target = row.expressId = existing(ctx, op.target, row);
      const r = reader(ctx, row.modelId!);
      const refusal = hostedFillRefusal(ctx.state, row.modelId!);
      if (refusal) throw new Refusal('unsupported', refusal);
      if (!uniqueSplitGuid(r.dataStore, r.editor, op.target.globalId)) throw new Refusal('ambiguous-target', 'The native hosted target GlobalId is not unique in its owning model');
      try { row.before.hosted = readExpectedHostedEdit(r.dataStore, r.editor, row.expressId, ctx.batch.units); }
      catch (error) { throw new Refusal('invalid', error instanceof Error ? error.message : String(error)); }
      if (!sameHostedEdit(row.before.hosted, op.expected)) throw new Refusal('conflict', 'The current native hosted binding, position or dimensions differ from the expected state');
      return;
    }
    case 'element.reassignStorey':
      Object.assign(row.resolved, resolveReviewedStoreyReassignment(op, target => existing(ctx, target, row), target => locate(ctx, target), modelId => join(row, modelId)));
      row.expressId = row.resolved.target!; row.previewUnavailable = true; return;
    case 'element.split': {
      row.resolved.target = row.expressId = existing(ctx, op.target, row);
      const r = reader(ctx, row.modelId!);
      try { row.before.split = readSplitSnapshot(r.dataStore, r.editor, row.expressId, ctx.batch.units); }
      catch (error) { throw new Refusal('invalid', error instanceof Error ? error.message : String(error)); }
      if (!sameSplitSnapshot(row.before.split, op.expected)) throw new Refusal('conflict', 'The current native split shape, placement or provenance differs from the expected snapshot');
      return;
    }
    case 'element.resize': case 'element.profile': {
      row.resolved.target = row.expressId = existing(ctx, op.target, row);
      const r = reader(ctx, row.modelId!);
      if (op.op === 'element.resize') {
        const current = readAuthoringSizeFromTarget(r, row.expressId, op.expected.kind);
        if (!current) throw new Refusal('invalid', 'The native editor cannot read this target as the requested editable size kind');
        row.before.size = current;
        if (!sameNativeDimensions(current, sizeInMetres(op.expected, ctx.batch.units))) throw new Refusal('conflict', 'The current native dimensions differ from the expected dimensions');
        const next = sizeInMetres(op.size, ctx.batch.units);
        const currentValues = current as unknown as Record<string, unknown>;
        if (Object.entries(next).filter(([, value]) => typeof value === 'number').every(([key, value]) =>
          Math.abs(Number(currentValues[key]) - Number(value)) <= 1e-9)) throw new Refusal('unchanged', 'Already these dimensions');
      } else {
        const current = readElementProfileFromTarget(r, row.expressId);
        if (!current) throw new Refusal('invalid', 'The native editor cannot read a supported centred extrusion section');
        row.before.Profile = current;
        if (!sameNativeDimensions(current, profileInMetres(op.expected, ctx.batch.units))) throw new Refusal('conflict', 'The current native section differs from the expected Profile');
        if (sameNativeDimensions(current, profileInMetres(op.Profile, ctx.batch.units))) throw new Refusal('unchanged', 'Already this Profile');
      }
      return;
    }
    case 'element.replace': {
      row.resolved.target=row.expressId=existing(ctx,op.target,row);const r=reader(ctx,row.modelId!);readNativeReplacementExpected(r.dataStore,r.editor,row.expressId);
      const storey=locate(ctx,op.storey);join(row,storey.modelId);row.resolved.storey=storey.expressId;row.before.storeyName=nameOf(r,storey.expressId);row.previewUnavailable=true;return;
    }
    case 'stair.resize': case 'stair.delete': case 'railing.delete': case 'stair.replace': case 'railing.replace': {
      row.resolved.target=row.expressId=existing(ctx,op.target,row);
      const nativeRefusal=stairRailingRefusal(ctx.state,row.modelId!);if(nativeRefusal)throw new Refusal('unsupported',nativeRefusal);
      const r=reader(ctx,row.modelId!);
      if(!conforms(r,row.expressId,'IfcStair')&&!conforms(r,row.expressId,'IfcRailing')&&!(op.op==='stair.resize'&&conforms(r,row.expressId,'IfcStairFlight')))throw new Refusal('unsupported','This lifecycle target must be a native stair or railing');
      if(op.op==='stair.resize'){const current=nativeStairEvidence(ctx.state,row.modelId!,row.expressId);if(!current)throw new Refusal('unsupported','The native editor cannot read a supported single stepped flight with known length units');if(!sameStairSnapshot(current,op.expected))throw new Refusal('conflict','The current native stair snapshot differs from expected');const patch=stairPatchInMetres(op.size,ctx.batch.units);if(Object.entries(patch).every(([key,value])=>Math.abs(current[key as keyof typeof patch]!-value)<=1e-9))throw new Refusal('unchanged','Already these stair dimensions');}
      if(op.op==='railing.delete'){if(!conforms(r,row.expressId,'IfcRailing'))throw new Refusal('unsupported','Railing removal requires an IfcRailing');const refusal=deletionRefusal(r,row.expressId,'IfcRailing');if(refusal)throw new Refusal('unsupported',refusal);}
      if(op.op==='stair.delete'&&!conforms(r,row.expressId,'IfcStair'))throw new Refusal('unsupported','Stair assembly removal requires an IfcStair root');
      if('storey' in op){const storey=locate(ctx,op.storey);join(row,storey.modelId);if(!liveEntityConforms(r.dataStore,storey.expressId,'IfcBuildingStorey',r.view))throw new Refusal('conflict','Replacement target is not an IfcBuildingStorey');row.resolved.storey=storey.expressId;row.before.storeyName=nameOf(r,storey.expressId);}
      row.previewUnavailable=true;return;
    }
    case 'curtainWall.create':
    case 'grid.create': case 'column.createOnGrid':
    case 'stair.create': case 'railing.create':
    case 'element.create': {
      const storey = locate(ctx, op.storey);
      join(row, storey.modelId);
      if(op.op==='curtainWall.create'){const data=ctx.state.models.get(storey.modelId)?.ifcDataStore;if(!data?.source.byteLength||String(data.schemaVersion).toUpperCase()==='IFC5')throw new Refusal('unsupported','Curtain walls require a native IFC2X3, IFC4 or IFC4X3 source');}
      if(op.op==='stair.create'||op.op==='railing.create'){const nativeRefusal=stairRailingRefusal(ctx.state,storey.modelId);if(nativeRefusal)throw new Refusal('unsupported',nativeRefusal);}
      const r = reader(ctx, storey.modelId);
      if (!liveEntityConforms(r.dataStore, storey.expressId, 'IfcBuildingStorey', r.view)) throw new Refusal('conflict', `${op.storey.globalId} is not an IfcBuildingStorey`);
      row.resolved.storey = storey.expressId;
      row.before.storeyName = nameOf(r, storey.expressId);
      if (op.op === 'grid.create' || op.op === 'column.createOnGrid') {
        if (!uniqueSplitGuid(r.dataStore, r.editor, op.storey.globalId)) throw new Refusal('ambiguous-target', 'The native storey GlobalId is not unique');
        if (!nativeLengthUnitAvailable(r)) throw new Refusal('unsupported', 'The grid requires readable declared length units');
        if (op.op === 'column.createOnGrid') {
          // Generic element labels use empty text when unnamed; the Grid's
          // nullable native Name stays intact and is checked by its draft writer.
          row.resolved.grid = element(ctx, 'ref' in op.grid ? { ref: op.grid.ref } : { ...op.grid.target, name: op.grid.target.name ?? '' }, row);
          if ('target' in op.grid && 'id' in row.resolved.grid) {
            if (!uniqueSplitGuid(r.dataStore, r.editor, op.grid.target.globalId)) throw new Refusal('ambiguous-target', 'The current grid GlobalId is not unique');
            if (!sameGridExpected(nativeGridExpected(r, row.resolved.grid.id, storey.expressId), op.grid.expected)) throw new Refusal('conflict', 'The native grid axes or current placement differ from the full expected snapshot');
          }
        }
      }
      return;
    }
    case 'element.copy': case 'element.array': {
      try {
        row.resolved.subject = element(ctx, op.target, row);
        if ('id' in row.resolved.subject) {
          row.expressId = row.resolved.subject.id;
          const r = reader(ctx, row.modelId!);
          const copyContext = createCopyContext(r.dataStore, r.editor);
          const population = new Set(copiedProductsInStore(copyContext, [row.expressId]));
          if (ctx.rows.slice(0, row.index).some(previous => previous.status === 'ready' && previous.modelId === row.modelId
            && previous.expressId !== null && population.has(previous.expressId)
            && previous.op.op !== 'element.copy' && previous.op.op !== 'element.array')) {
            throw new Refusal('unsupported', 'Copy the source before editing it in this batch, so its preview uses the same geometry as the copy');
          }
          const placement = productStoreyOrigin(copyContext, row.expressId);
          if (!placement) throw new Refusal('invalid', 'The element has no native copy placement');
          row.before.origin = [placement.origin[0], placement.origin[1]];
          if (op.from && (!near(toMetres(ctx.batch, op.from[0]), placement.origin[0], 0.001) || !near(toMetres(ctx.batch, op.from[1]), placement.origin[1], 0.001))) throw new Refusal('conflict', 'The source copy placement differs from the expected from point');
        } else if (op.from) throw new Refusal('unsupported', 'An element created in this batch has no prior placement to pin');
        if (op.storey) {
          const target = locate(ctx, op.storey);
          join(row, target.modelId);
          const r = reader(ctx, target.modelId);
          if (!liveEntityConforms(r.dataStore, target.expressId, 'IfcBuildingStorey', r.view)) throw new Refusal('conflict', 'The target is not an IfcBuildingStorey');
          row.resolved.storey = target.expressId;
          row.before.storeyName = nameOf(r, target.expressId);
        }
      } catch (error) {
        if (error instanceof Refusal) throw error;
        throw new Refusal('invalid', error instanceof Error ? error.message : String(error));
      }
      return;
    }
    case 'element.delete': {
      row.resolved.target = row.expressId = existing(ctx, op.target, row);
      const refusal = deletionRefusal(reader(ctx, row.modelId!), row.expressId);
      if (refusal) throw new Refusal('unsupported', refusal);
      return;
    }
    case 'element.align': {
      const reference = existing(ctx, op.reference, row);
      const targets = op.targets.map(target => existing(ctx, target, row));
      row.expressId = reference;
      row.resolved.alignment = { reference, targets, storeyId: 0 };
      reviewAlignment(ctx.state, ctx.batch, row, reader(ctx, row.modelId!));
      return;
    }
    case 'element.move': case 'element.rotate': {
      row.resolved.target = row.expressId = existing(ctx, op.target, row);
      return reviewElementTransform(ctx.state, reader(ctx, row.modelId!), ctx.batch, row);
    }
    case 'material.layers': {
      row.resolved.target = row.expressId = existing(ctx, op.target, row);
      try {
        row.resolved.layers = resolveReviewedLayers(ctx.state, reader(ctx, row.modelId!), row.expressId, op, ctx.batch.units);
      } catch (error) {
        if (error instanceof LayerRefusal) throw new Refusal(error.status, error.message);
        throw error;
      }
      row.previewUnavailable = true;
      return;
    }
    case 'type.detach': {
      row.resolved.target = row.expressId = existing(ctx, op.target, row);
      const r = reader(ctx, row.modelId!);
      const current = typeOf({ dataStore: r.dataStore, view: r.view }, row.expressId);
      if (current === null) throw new Refusal('unchanged', 'The occurrence is already untyped');
      if (!uniqueSplitGuid(r.dataStore, r.editor, op.expected.GlobalId)) throw new Refusal('ambiguous-target', 'The expected native type GlobalId is not unique in its owning model');
      const expected = locate(ctx, { globalId: op.expected.GlobalId, modelId: row.modelId! });
      if (expected.expressId !== current || nameOf(r, current) !== op.expected.Name) throw new Refusal('conflict', 'The occurrence has a different current type');
      row.resolved.typeId = current;
      row.before.type = nameOf(r, current);
      row.previewUnavailable = true;
      return;
    }
    case 'type.assign': case 'material.assign': {
      const subject = row.resolved.subject = element(ctx, op.target, row);
      if ('id' in subject) row.expressId = subject.id;
      return op.op === 'type.assign' ? resolveType(ctx, row, op) : resolveMaterial(ctx, row, op);
    }
    case 'walls.join':
      row.resolved.walls = [element(ctx, op.walls[0], row), element(ctx, op.walls[1], row)];
      row.expressId = row.resolved.walls.flatMap((wall) => 'id' in wall ? [wall.id] : [])[0] ?? null;
      return;
    case 'hosted.create': {
      row.resolved.host = element(ctx, op.host, row);
      if ('id' in row.resolved.host) row.expressId = row.resolved.host.id;
      if ('params' in op) {
        if (row.expressId !== null) { const r = reader(ctx, row.modelId!);
          try { row.before.split = verifySlabOpeningHost(ctx.batch, op, r.dataStore, r.editor, row.expressId, false); }
          catch (error) { throw new Refusal('invalid', error instanceof Error ? error.message : String(error)); }
        }
      }
      return;
    }
  }
}

function resolveType(ctx: Context, row: AuthoringRow, op: Extract<AuthoringOp, { op: 'type.assign' }>): void {
  const r = reader(ctx, row.modelId!);
  if (row.expressId !== null) row.before.type = typeNameOf(r, row.expressId);
  if ('create' in op.type) { row.resolved.typeId = null; return compareExpected(row, op.expected, row.before.type); }
  const found = locate(ctx, op.type);
  if (found.modelId !== row.modelId) throw new Refusal('unsupported', 'The type is in another model');
  if (!liveEntityConforms(r.dataStore, found.expressId, 'IfcTypeObject', r.view) || nameOf(r, found.expressId) !== op.type.name) {
    throw new Refusal('conflict', `${op.type.globalId} is not the type "${op.type.name}"`);
  }
  row.resolved.typeId = found.expressId;
  compareExpected(row, op.expected, row.before.type);
  if (row.expressId !== null && row.before.type === op.type.name) throw new Refusal('unchanged', 'Already of this type');
}

function resolveMaterial(ctx: Context, row: AuthoringRow, op: Extract<AuthoringOp, { op: 'material.assign' }>): void {
  const r = reader(ctx, row.modelId!);
  if (row.expressId !== null) row.before.material = materialNameOf(r, row.expressId);
  compareExpected(row, op.expected, row.before.material);
  const named = materialsOf({ dataStore: r.dataStore, view: r.view }).filter((m) => m.name === op.material.name);
  if (named.length > 1) throw new Refusal('ambiguous-target', `${named.length} materials are named "${op.material.name}"`);
  if (named.length === 0 && !op.material.create) throw new Refusal('missing-target', `No material "${op.material.name}"; set "create": true to add it`);
  row.resolved.materialId = named[0]?.expressId ?? null;
  if (row.expressId !== null && row.before.material === op.material.name) throw new Refusal('unchanged', 'Already this material');
}

function compareExpected(row: AuthoringRow, expected: string | null | undefined, current: string | null | undefined): void {
  if (row.expressId === null || expected === undefined) return;
  if ((current ?? null) !== expected) throw new Refusal('conflict', `Expected ${expected === null ? 'none' : `"${expected}"`}; the model has ${current === null || current === undefined ? 'none' : `"${current}"`}`);
}

export function previewModelAuthoring(state: ViewerState, batch: ModelAuthoringBatch): ModelAuthoringPreview {
  const ctx: Context = { state, batch, readers: new Map(), creators: new Map(), rows: [] };
  for (const [index, op] of batch.operations.entries()) {
    const row: AuthoringRow = { index, op, status: 'ready', modelId: null, expressId: null, resolved: {}, before: {}, dependsOn: [] };
    ctx.rows.push(row);
    if ('ref' in op && typeof op.ref === 'string') ctx.creators.set(op.ref, index);
    if (op.op === 'element.array') for (const ref of op.refs) ctx.creators.set(ref, index);
    try {
      resolve(ctx, row);
      if (row.dependsOn.some((i) => ctx.rows[i].status !== 'ready')) throw new Refusal('blocked', 'It needs an element another row creates, which is not ready');
      const denial = row.modelId ? mutationDenial(state, row.modelId) : null;
      if (denial) throw new Refusal('denied', denial);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      row.status = error.status;
      row.issue = error.message;
    }
  }
  validateAuthoringDraft(state, batch, ctx.rows, modelId => reader(ctx, modelId));
  for (const row of ctx.rows) if (row.status === 'ready' && row.modelId && (row.op.op === 'element.resize' || row.op.op === 'element.profile' || row.op.op === 'element.trimExtend' || (row.op.op === 'material.layers' && row.op.scope === 'element' && row.resolved.layers?.kind === 'wall'))) {
    const boundary = row.op.op === 'element.trimExtend' ? row.resolved.reachBoundary : undefined;
    // The whole native batch validates this boundary; the independent body draft
    // cannot reproduce a preceding edit of the same existing wall (#7262).
    if (boundary && 'id' in boundary && ctx.rows.some(previous => previous.index < row.index
      && previous.status === 'ready' && previous.modelId === row.modelId && previous.expressId === boundary.id
      && previous.op.op !== 'element.copy' && previous.op.op !== 'element.array')) {
      row.previewUnavailable = true;
      continue;
    }
    const ghost = authoringSizeGhost(state, batch, row, row.modelId, 0);
    row.previewUnavailable = ghost.unavailable;
    row.previewOmitted = ghost.omitted;
    row.previewOuterBodyOnly = ghost.outerBodyOnly;
  }
  for (const row of ctx.rows) if (row.status === 'ready' && row.op.op === 'hosted.edit') row.previewUnavailable = authoringHostedEditGhost(state, batch, row, 0, ctx.rows) === null;
  for (const row of ctx.rows) if (row.status === 'ready' && row.op.op === 'element.split') {
    row.previewUnavailable = authoringSplitMarker(state, batch, row, 0) === null;
  }
  for(const row of ctx.rows)if(row.status==='ready'&&row.op.op==='hosted.create'&&'params' in row.op)row.previewUnavailable=!authoringSlabOpeningGhost(state,row,ctx.rows,0);
  for(const row of ctx.rows)if(row.status==='ready'&&['stair.create','railing.create','stair.replace','railing.replace'].includes(row.op.op))row.previewUnavailable=!stairRailingGhost(state,batch,row,0);
  for (const row of ctx.rows) if (row.status === 'ready' && row.op.op === 'curtainWall.create') row.previewUnavailable = authoringCurtainWallGhost(state, batch, row, 0).length === 0;
  for (const row of ctx.rows) if (row.status === 'ready' && (row.op.op === 'grid.create' || row.op.op === 'column.createOnGrid')) row.previewUnavailable = gridCreationGhost(state, batch, row, 0).length === 0;
  const preview = { batch, rows: ctx.rows, mutationVersion: state.mutationVersion, digest: batchDigest(batch) };
  captureAuthoringSources(state, preview);
  return preview;
}


export function authoringCounts(rows: readonly AuthoringRow[]): Record<AuthoringRowStatus, number> {
  const counts: Record<AuthoringRowStatus, number> = { ready: 0, unchanged: 0, conflict: 0, 'missing-target': 0, 'ambiguous-target': 0,
    denied: 0, unsupported: 0, invalid: 0, blocked: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}
