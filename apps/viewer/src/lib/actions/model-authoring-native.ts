/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The native write of each reviewed authoring operation, in the two places it
 * runs: a preview DRY RUN against a draft of the model's overlay that is never
 * published (so the builders' own validation decides, with earlier operations
 * of the batch in place), and the commit through the store's gated actions.
 * Both reach the same `@ifc-lite/create` builders: `addOrdinaryElementInStore`
 * (the store's `addWall` & co.), `addHostedElementInStore` (`addHostedFill`),
 * and `bim.store`'s modelling methods for joins, types and materials.
 */

import { profileInMetres } from './model-authoring-shape-params';
import { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { copyBatchInStore, addHostedElementInStore, addOrdinaryElementInStore, resolveSpatialAnchor, type OrdinaryInStoreElement } from '@ifc-lite/create';
import { createModellingStoreBackend, resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import { ensureStoreyPlacement } from '@/store/slices/storeyPlacement';
import type { HostedFillSpec } from '@/store/slices/mutation-hosted-fill';
import { detachFromType, type ModellingMethods } from '@/store/slices/mutation-modelling-records';
import { draftElementSize } from '@/lib/element-size-commit';
import { writeElementProfile } from '@/store/slices/mutation-element-profile';
import { sizeInMetres } from './model-authoring-size-params';
import { authoringCopyTransforms, copyRefs } from './model-authoring-copy';
import { pointToMetres, toMetres, type AuthoringOp, type AxisParams, type BoxParams, type ModelAuthoringBatch } from './model-authoring';

/** An element an operation acts on: one of the model's, or one an earlier operation of the batch creates. */
export type ElementId = { id: number } | { ref: string };

/** What preview resolved for an operation; the commit re-resolves and must find the same. */
export interface ResolvedOp {
  target?: number;
  /** The element a type or material is assigned to. */
  subject?: ElementId;
  storey?: number;
  host?: ElementId;
  walls?: [ElementId, ElementId];
  /** Existing type / material to relate, or null to create the one the operation names. */
  typeId?: number | null;
  materialId?: number | null;
}

type Create = Extract<AuthoringOp, { op: 'element.create' }>;
type Hosted = Extract<AuthoringOp, { op: 'hosted.create' }>;

const KIND: Record<Create['ifcClass'], OrdinaryInStoreElement['kind']> = {
  IfcWall: 'wall', IfcSlab: 'slab', IfcRoof: 'roof', IfcPlate: 'plate', IfcColumn: 'column', IfcBeam: 'beam', IfcMember: 'member', IfcSpace: 'space',
};

/** The builder parameters of an `element.create`, converted to the builders' metres. */
export function authoredElementOf(batch: ModelAuthoringBatch, op: Create, globalId?: string): OrdinaryInStoreElement {
  const m = (v: number) => toMetres(batch, v);
  const identity = { Name: op.name, ...(globalId ? { GlobalId: globalId } : {}) };
  const kind = KIND[op.ifcClass];
  const shape = op.params;
  if ('Profile' in shape) {
    if (shape.Profile === 'polygon' && 'OuterCurve' in shape) {
      const footprint = { ...identity, Profile: 'polygon' as const, OuterCurve: shape.OuterCurve.map(([x, y]): [number, number] => [m(x), m(y)]), Position: pointToMetres(batch, shape.position) };
      if (kind === 'space') return { kind, params: { ...footprint, Height: m(shape.height!) } };
      if (kind === 'slab' || kind === 'roof' || kind === 'plate') return { kind, params: { ...footprint, Thickness: m(shape.thickness!) } };
    } else if (typeof shape.Profile === 'object') {
      const Profile = profileInMetres(shape.Profile, batch.units);
      if (kind === 'column' && 'position' in shape) return { kind, params: { ...identity, Profile, Position: pointToMetres(batch, shape.position), Height: m(shape.height!) } };
      if ((kind === 'beam' || kind === 'member') && 'start' in shape) return { kind, params: { ...identity, Profile, Start: pointToMetres(batch, shape.start), End: pointToMetres(batch, shape.end) } };
    }
    throw new Error('The native shape does not match its element class');
  }
  if (kind === 'wall' || kind === 'beam' || kind === 'member') {
    const p = op.params as AxisParams;
    const axis = { ...identity, Start: pointToMetres(batch, p.start), End: pointToMetres(batch, p.end), Height: m(p.height) };
    return kind === 'wall' ? { kind, params: { ...axis, Thickness: m(p.thickness!) } } : { kind, params: { ...axis, Width: m(p.width!) } };
  }
  const p = op.params as BoxParams;
  const box = { ...identity, Position: pointToMetres(batch, p.position), Width: m(p.width), Depth: m(p.depth) };
  if (kind === 'column') return { kind, params: { ...box, Height: m(p.height!) } };
  if (kind === 'space') return { kind, params: { ...box, Height: m(p.height!) } };
  return { kind, params: { ...box, Thickness: m(p.thickness!) } };
}

/** The hosted-element spec of a `hosted.create`, in metres. */
export function hostedSpecOf(batch: ModelAuthoringBatch, op: Hosted, globalId?: string): HostedFillSpec {
  const m = (v: number) => toMetres(batch, v);
  const common = { Offset: m(op.offset), Sill: m(op.sill), Width: m(op.width), Height: m(op.height),
    ...(op.name ? { Name: op.name } : {}), ...(globalId ? { GlobalId: globalId } : {}) };
  if (op.kind === 'door') return { kind: 'door', params: common };
  if (op.kind === 'window') return { kind: 'window', params: common };
  return { kind: 'opening', params: common };
}

export function idOf(element: ElementId, refs: ReadonlyMap<string, number>): number {
  if ('id' in element) return element.id;
  const id = refs.get(element.ref);
  if (id === undefined) throw new Error(`"${element.ref}" was not created`);
  return id;
}

/**
 * Join, type and material writes through `bim.store`'s modelling methods: the
 * same calls the dry run makes on a draft and the commit makes through
 * `recordModellingEdit`. Returns the elements whose mesh changes.
 */
export function writeRelation(methods: ModellingMethods, modelId: string, op: AuthoringOp, resolved: ResolvedOp, refs: ReadonlyMap<string, number>): number[] {
  switch (op.op) {
    case 'walls.join': {
      const [a, b] = resolved.walls!.map((wall) => idOf(wall, refs));
      methods.joinWalls(modelId, a, b);
      return [a, b];
    }
    case 'type.assign': {
      const element = idOf(resolved.subject!, refs);
      const typeId = resolved.typeId ?? ('create' in op.type
        ? methods.addElementType(modelId, { Type: op.type.create.ifcClass, Name: op.type.create.name }).expressId
        : null);
      if (typeId === null) throw new Error('The type no longer exists');
      methods.assignType(modelId, typeId, [element]);
      return [element];
    }
    case 'material.assign': {
      const element = idOf(resolved.subject!, refs);
      const materialId = resolved.materialId ?? methods.addMaterial(modelId, { Name: op.material.name }).expressId;
      methods.assignMaterial(modelId, materialId, [element]);
      return [element];
    }
    default:
      throw new Error(`${op.op} is not a relationship write`);
  }
}

export interface DryRunRow { index: number; op: AuthoringOp; resolved: ResolvedOp }

/**
 * Run `rows` (one model's, in batch order) against a draft of `view`'s overlay
 * and drop the draft: the live model is never written. Each operation is
 * atomic inside the draft, so a refused one leaves nothing for the next. A row
 * whose ref names a refused creation fails with that reason. Returns the
 * refusal per row index.
 */
export function dryRunAuthoring(
  batch: ModelAuthoringBatch,
  dataStore: IfcDataStore,
  view: import('@ifc-lite/mutations').MutablePropertyView,
  modelId: string,
  rows: readonly DryRunRow[],
): Map<number, string> {
  const refusals = new Map<number, string>();
  if (rows.length === 0) return refusals;
  view.prepareAtomic((draftView) => {
    const editor = new StoreEditor(dataStore, draftView);
    const refs = new Map<string, number>();
    for (const row of rows) {
      try {
        editor.runAtomic((draft) => draftAuthoringOperation(batch, dataStore, modelId, draft, row, refs));
      } catch (error) {
        refusals.set(row.index, error instanceof Error ? error.message : String(error));
      }
    }
  });
  return refusals;
}

export function draftAuthoringOperation(batch: ModelAuthoringBatch, dataStore: IfcDataStore, modelId: string, draft: StoreEditor, row: DryRunRow, refs: Map<string, number>): void {
  const { op, resolved } = row;
  switch (op.op) {
    case 'type.detach':
      detachFromType(draft, dataStore, [resolved.target!]);
      return;
    case 'element.resize': {
      const outcome = draftElementSize(dataStore, draft, draftMethods(dataStore, modelId, draft), modelId, resolved.target!, sizeInMetres(op.size, batch.units));
      if (!outcome.ok) throw new Error(outcome.reason);
      return;
    }
    case 'element.profile': {
      const outcome = writeElementProfile({ modelId, dataStore, view: draft.getMutationView(), editor: draft }, resolved.target!, profileInMetres(op.Profile, batch.units),
        (updates) => { for (const update of updates) draft.setPositionalAttribute(update.entityId, update.index, update.value); });
      if (!outcome.ok) throw new Error(outcome.reason);
      return;
    }
    case 'element.create': {
      const storey = resolved.storey!;
      const id = addOrdinaryElementInStore(draft, (d) => {
        ensureStoreyPlacement(dataStore, d, storey);
        return resolveSpatialAnchor(dataStore, storey, d.getMutationView());
      }, authoredElementOf(batch, op));
      refs.set(op.ref, id);
      return;
    }
    case 'hosted.create': {
      const created = addHostedElementInStore(dataStore, draft, idOf(resolved.host!, refs), hostedSpecOf(batch, op));
      if (op.ref) refs.set(op.ref, created.expressId);
      return;
    }
    case 'element.copy': case 'element.array': {
      const copies = copyBatchInStore(dataStore, draft, [idOf(resolved.subject!, refs)], authoringCopyTransforms(batch, op, resolved.storey));
      for (const [i, copy] of copies.entries()) refs.set(copyRefs(op)[i], copy.copyId);
      return;
    }
    case 'element.delete':
      if (!draft.removeEntity(resolved.target!)) throw new Error('The element could not be removed');
      return;
    case 'element.move': case 'element.rotate':
      // Checked against the transform planner and placement chain in preview; nothing to stage.
      return;
    default:
      writeRelation(draftMethods(dataStore, modelId, draft), modelId, op, resolved, refs);
  }
}

function draftMethods(dataStore: IfcDataStore, modelId: string, draft: StoreEditor): ModellingMethods {
  return createModellingStoreBackend(() => ({
    modelId, store: dataStore, editor: draft, mutationView: draft.getMutationView(),
    ownerHistoryId: resolveLiveOwnerHistoryId(dataStore, draft, draft.getMutationView()),
  }));
}
