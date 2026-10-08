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

import type { ViewerState } from '@/store';
import { mutationDenial } from '@/store/mutation-permission';
import { materialsOf } from '@/lib/commands/modeling/authored-kinds';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '@/lib/commands/modeling/workplane';
import { planElementTransform, type TransformRoot } from '@/lib/element-transform/plan';
import { describeRefusal } from '@/lib/element-transform/commit';
import { copiedProductsInStore, createCopyContext, productStoreyOrigin, liveEntityConforms } from '@ifc-lite/create';
import type { RowStatus } from './model-change-preview';
import { batchDigest } from './model-change-preview';
import { isNewElement, toMetres, type AuthoringOp, type ElementTarget, type ExistingElement, type ModelAuthoringBatch } from './model-authoring';
import { dryRunAuthoring, type ElementId, type ResolvedOp } from './model-authoring-native';
import {
  authoringReader, className, conforms, deletionRefusal, materialNameOf, nameOf, placementAngle, typeNameOf, type AuthoringReader,
} from './model-authoring-read';
import { captureAuthoringSources } from './model-authoring-sources';
import { resolveGlobalId } from './resolve-global-id';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import { readAuthoringSize, sameNativeDimensions } from './model-authoring-size';
import { sizeInMetres, type ExpectedSize } from './model-authoring-size-params';
import { profileInMetres } from './model-authoring-shape-params';
import { authoringHostedEditGhost } from './model-authoring-hosted-edit-ghost';
import { hostedFillRefusal } from '@/store/slices/mutation-hosted-fill';
import { readExpectedHostedEdit, sameHostedEdit, type ExpectedHostedEdit } from './model-authoring-hosted-edit';
import type { ProfileSection } from '@ifc-lite/create';
import { authoringSizeGhost } from './model-authoring-size-ghost';

/** P04's statuses plus `invalid` (a native builder or planner refused it) and `blocked` (it needs a row that is not ready). */
export type AuthoringRowStatus = RowStatus | 'invalid' | 'blocked';

/** What the element is now, for the before → after summary. */
export interface AuthoringBefore {
  hosted?: ExpectedHostedEdit;
  size?: ExpectedSize;
  Profile?: ProfileSection;
  ifcClass?: string;
  name?: string;
  storeyName?: string;
  type?: string | null;
  material?: string | null;
  /** Placement origin in the storey, metres. */
  origin?: [number, number];
  angleDeg?: number;
}

export interface AuthoringRow {
  previewUnavailable?: boolean;
  previewOmitted?: string[];
  previewOuterBodyOnly?: boolean;
  index: number;
  op: AuthoringOp;
  status: AuthoringRowStatus;
  modelId: string | null;
  /** The existing element the operation acts on (the host for a hosted element), when it has one. */
  expressId: number | null;
  resolved: ResolvedOp;
  before: AuthoringBefore;
  /** Indices of the rows whose creations this one uses. */
  dependsOn: number[];
  /** Why the row is not ready: the native refusal, the expectation that failed, or the edit gate's reason. */
  issue?: string;
}

export interface ModelAuthoringPreview {
  batch: ModelAuthoringBatch;
  rows: AuthoringRow[];
  mutationVersion: number;
  digest: string;
}

class Refusal extends Error {
  constructor(readonly status: AuthoringRowStatus, message: string) { super(message); }
}

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

function existing(ctx: Context, target: ExistingElement, row: AuthoringRow, located = locate(ctx, target)): number {
  const { modelId, expressId } = located;
  join(row, modelId);
  const r = reader(ctx, modelId);
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

function transformRoot(ctx: Context, row: AuthoringRow, expressId: number): TransformRoot {
  const r = reader(ctx, row.modelId!);
  const plan = planElementTransform({ dataStore: r.dataStore, view: r.view, selected: [expressId],
    storeyOf: (id) => elementStoreyId(ctx.state, r.modelId, id) });
  if (plan.refused.length > 0) throw new Refusal('invalid', describeRefusal(plan.refused[0]));
  const root = plan.roots.find((candidate) => candidate.expressId === expressId);
  if (!root) throw new Refusal('invalid', 'The element moves with its host; move the host instead');
  const plane = buildStoreyWorkplane(ctx.state, r.modelId, root.storeyId, 0);
  if (!isWorkplane(plane)) throw new Refusal('unsupported', plane.refused);
  row.before.origin = [...root.origin];
  return root;
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

function resolve(ctx: Context, row: AuthoringRow): void {
  const { op } = row;
  switch (op.op) {
    case 'hosted.edit': {
      const located = locate(ctx, op.target);
      const refusal = hostedFillRefusal(ctx.state, located.modelId);
      if (refusal) throw new Refusal('unsupported', refusal);
      row.resolved.target = row.expressId = existing(ctx, op.target, row, located);
      const r = reader(ctx, row.modelId!);
      try { row.before.hosted = readExpectedHostedEdit(r.dataStore, r.editor, row.expressId, ctx.batch.units); }
      catch (error) { throw new Refusal('invalid', error instanceof Error ? error.message : String(error)); }
      if (!sameHostedEdit(row.before.hosted, op.expected)) throw new Refusal('conflict', 'The current native hosted binding, position or dimensions differ from the expected state');
      return;
    }
    case 'element.resize': case 'element.profile': {
      row.resolved.target = row.expressId = existing(ctx, op.target, row);
      if (op.op === 'element.resize') {
        const current = readAuthoringSize(ctx.state, row.modelId!, row.expressId, op.expected.kind);
        if (!current) throw new Refusal('invalid', 'The native editor cannot read this target as the requested editable size kind');
        row.before.size = current;
        if (!sameNativeDimensions(current, sizeInMetres(op.expected, ctx.batch.units))) throw new Refusal('conflict', 'The current native dimensions differ from the expected dimensions');
        const next = sizeInMetres(op.size, ctx.batch.units);
        const currentValues = current as unknown as Record<string, unknown>;
        if (Object.entries(next).filter(([, value]) => typeof value === 'number').every(([key, value]) =>
          Math.abs(Number(currentValues[key]) - Number(value)) <= 1e-9)) throw new Refusal('unchanged', 'Already these dimensions');
      } else {
        const current = readElementProfile(ctx.state, row.modelId!, row.expressId);
        if (!current) throw new Refusal('invalid', 'The native editor cannot read a supported centred extrusion section');
        row.before.Profile = current;
        if (!sameNativeDimensions(current, profileInMetres(op.expected, ctx.batch.units))) throw new Refusal('conflict', 'The current native section differs from the expected Profile');
        if (sameNativeDimensions(current, profileInMetres(op.Profile, ctx.batch.units))) throw new Refusal('unchanged', 'Already this Profile');
      }
      return;
    }
    case 'element.create': {
      const storey = locate(ctx, op.storey);
      join(row, storey.modelId);
      const r = reader(ctx, storey.modelId);
      if (!liveEntityConforms(r.dataStore, storey.expressId, 'IfcBuildingStorey', r.view)) throw new Refusal('conflict', `${op.storey.globalId} is not an IfcBuildingStorey`);
      row.resolved.storey = storey.expressId;
      row.before.storeyName = nameOf(r, storey.expressId);
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
    case 'element.move': case 'element.rotate': {
      row.resolved.target = row.expressId = existing(ctx, op.target, row);
      const root = transformRoot(ctx, row, row.expressId);
      return op.op === 'element.move' ? checkMove(ctx, op, root) : checkTurn(ctx, row, op, root);
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
      return;
    }
  }
}

function checkMove(ctx: Context, op: Extract<AuthoringOp, { op: 'element.move' }>, root: TransformRoot): void {
  if (!op.from) return;
  const from = op.from.map((v) => toMetres(ctx.batch, v));
  if (!near(from[0], root.origin[0], 0.001) || !near(from[1], root.origin[1], 0.001)) {
    throw new Refusal('conflict', `Expected the element at (${op.from.join(', ')}); it is elsewhere now`);
  }
}

function checkTurn(ctx: Context, row: AuthoringRow, op: Extract<AuthoringOp, { op: 'element.rotate' }>, root: TransformRoot): void {
  const angle = placementAngle(reader(ctx, row.modelId!), row.expressId!);
  if (!root.upright || !angle?.turnable) throw new Refusal('invalid', 'Its placement has no explicit reference direction to turn');
  const deg = angle.deg + (Math.atan2(root.parent.axis[1], root.parent.axis[0]) * 180) / Math.PI;
  row.before.angleDeg = deg;
  if (op.fromDeg !== undefined && !near(((op.fromDeg - deg) % 360 + 540) % 360 - 180, 0, 0.1)) {
    throw new Refusal('conflict', `Expected the element turned ${op.fromDeg}°; it is at ${deg.toFixed(1)}° now`);
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
  nativeDryRun(ctx, batch);
  for (const row of ctx.rows) if (row.status === 'ready' && row.modelId && (row.op.op === 'element.resize' || row.op.op === 'element.profile')) {
    const ghost = authoringSizeGhost(state, batch, row, row.modelId, 0);
    row.previewUnavailable = ghost.unavailable;
    row.previewOmitted = ghost.omitted;
    row.previewOuterBodyOnly = ghost.outerBodyOnly;
  }
  for (const row of ctx.rows) if (row.status === 'ready' && row.op.op === 'hosted.edit') row.previewUnavailable = authoringHostedEditGhost(state, batch, row, 0, ctx.rows) === null;
  const preview = { batch, rows: ctx.rows, mutationVersion: state.mutationVersion, digest: batchDigest(batch) };
  captureAuthoringSources(state, preview);
  return preview;
}

/** The builders decide what static checks cannot: dimensions, hosts, joins, schema support. */
function nativeDryRun(ctx: Context, batch: ModelAuthoringBatch): void {
  const byModel = new Map<string, AuthoringRow[]>();
  for (const row of ctx.rows) if (row.status === 'ready' && row.modelId) byModel.set(row.modelId, [...(byModel.get(row.modelId) ?? []), row]);
  for (const [modelId, rows] of byModel) {
    const r = reader(ctx, modelId);
    const refusals = dryRunAuthoring(batch, r.dataStore, r.view, modelId, rows.map(({ index, op, resolved }) => ({ index, op, resolved })));
    for (const row of rows) {
      const refusal = refusals.get(row.index);
      if (refusal === undefined) continue;
      const blocked = row.dependsOn.some((i) => refusals.has(i));
      row.status = blocked ? 'blocked' : 'invalid';
      row.issue = blocked ? 'It needs an element another row creates, which the model refused' : refusal;
    }
  }
}

export function authoringCounts(rows: readonly AuthoringRow[]): Record<AuthoringRowStatus, number> {
  const counts: Record<AuthoringRowStatus, number> = { ready: 0, unchanged: 0, conflict: 0, 'missing-target': 0, 'ambiguous-target': 0,
    denied: 0, unsupported: 0, invalid: 0, blocked: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}
