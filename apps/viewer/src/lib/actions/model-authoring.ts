/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reviewed native authoring (viewer AI P15A): a serialisable, bounded batch of
 * creation, deletion, placement and relationship edits that the viewer's own
 * builders and modelling commands carry out. A sibling of `model.changes`
 * (P04), not a new version of it: data corrections compare one scalar with
 * an expected scalar, while authoring creates identities, takes lengths in a
 * declared unit and frame, and may refer to an element created earlier in the
 * same batch. Both share the GlobalId resolution, the staleness rule, one
 * native undo batch per model and the receipt library.
 *
 * Every length in a batch is in its declared `units` (`m` or `mm`), in the
 * storey-local frame (IFC Z-up, metres from the storey's placement after
 * conversion), the frame the in-store builders take. Rotation angles are degrees;
 * canonical stair Direction is radians and expected stair snapshots remain verbatim.
 * Other angles are degrees,
 * counter-clockwise seen from above. Nothing here writes.
 */

import { parseExpectedHostedEdit, parseHostedEdit, type ExpectedHostedEdit } from './model-authoring-hosted-edit';
import type { HostedElementEdit } from '@ifc-lite/create';
import { parseShapeParams, parseProfileSectionParams, AUTHORING_OUTLINE_WORK_LIMIT, type ShapeParams } from './model-authoring-shape-params';
import { parseSplitSnapshot, parseSplitCut, type SplitCut } from './model-authoring-split-params';
import type { SplitSnapshot } from './model-authoring-split-state';
import { parseSizeParams, type ExpectedSize } from './model-authoring-size-params';
import { parseStairRailingParams, parseStairPatch, parseExpectedStair, railingPostWork, STAIR_RAILING_WORK_LIMIT } from './model-authoring-stair-railing-fields';
import type { RailingInStoreParams, StairInStoreParams, StairDimensions, StairDimensionEdit, ProfileSection } from '@ifc-lite/create';
import type { ElementSizePatch } from '@/store/slices/mutation-element-size';
import { parseCopyFields, type CopyFields, type ArrayFields } from './model-authoring-copy-fields';
import { parseGlobalIdTarget, parseLength, parsePoint, parseRef, parseText, record, type LengthRange } from './model-authoring-fields';

export const AUTHORING_CLASSES = ['IfcWall', 'IfcSlab', 'IfcRoof', 'IfcPlate', 'IfcColumn', 'IfcBeam', 'IfcMember', 'IfcSpace'] as const;
export type AuthoringClass = typeof AUTHORING_CLASSES[number];
export const HOSTED_KINDS = ['door', 'window', 'opening'] as const;
export type HostedKind = typeof HOSTED_KINDS[number];
export type AuthoringUnits = 'm' | 'mm';
export type Point3 = [number, number, number];

/** An element of a loaded model, with the class and name the proposal expects it to have now. */
export interface ExistingElement { globalId: string; modelId?: string; ifcClass: string; name: string }
/** An element created by an earlier `element.create`, `hosted.create`, copy or array of the same batch. */
export interface NewElement { ref: string }
export type ElementTarget = ExistingElement | NewElement;
export interface StoreyTarget { globalId: string; modelId?: string }

/** Axis from `start` to `end` (walls: `thickness` across, `height` up; beams and members: `width` × `height` section). */
export interface AxisParams { start: Point3; end: Point3; thickness?: number; width?: number; height: number }
/** Rectangle from the `position` corner along +X (`width`) and +Y (`depth`); slabs, roofs and plates use `thickness`, spaces `height`. */
export interface BoxParams { position: Point3; width: number; depth: number; thickness?: number; height?: number }

export type AuthoringOp =
  | { op: 'stair.resize'; target: ExistingElement; expected: StairDimensions; size: StairDimensionEdit }
  | { op: 'stair.delete' | 'railing.delete'; target: ExistingElement }
  | { op: 'stair.replace'; target: ExistingElement; ref: string; storey: StoreyTarget; params: StairInStoreParams }
  | { op: 'railing.replace'; target: ExistingElement; ref: string; storey: StoreyTarget; params: RailingInStoreParams }
  | { op: 'stair.create'; ref: string; storey: StoreyTarget; params: StairInStoreParams }
  | { op: 'railing.create'; ref: string; storey: StoreyTarget; params: RailingInStoreParams }
  | { op: 'element.create'; ref: string; ifcClass: AuthoringClass; storey: StoreyTarget; name: string; params: AxisParams | BoxParams | ShapeParams }
  | { op: 'element.split'; target: ExistingElement; expected: SplitSnapshot; cut: SplitCut }
  | ({ op: 'element.copy'; target: ElementTarget; ref: string } & CopyFields)
  | ({ op: 'element.array'; target: ElementTarget; refs: string[] } & ArrayFields)
  | { op: 'hosted.edit'; target: ExistingElement; expected: ExpectedHostedEdit; edit: HostedElementEdit }
  | { op: 'element.delete'; target: ExistingElement }
  | { op: 'element.resize'; target: ExistingElement; expected: ExpectedSize; size: ElementSizePatch }
  | { op: 'element.profile'; target: ExistingElement; expected: ProfileSection; Profile: ProfileSection }
  /** Horizontal move by a storey-local delta; `from` optionally pins today's placement origin [x, y] in the storey. */
  | { op: 'element.move'; target: ExistingElement; delta: [number, number]; from?: [number, number] }
  /** Turn about the element's own placement origin; `fromDeg` optionally pins today's angle. */
  | { op: 'element.rotate'; target: ExistingElement; angleDeg: number; fromDeg?: number }
  | { op: 'type.assign'; target: ElementTarget; expected?: string | null; type: { globalId: string; name: string } | { create: { ifcClass: string; name: string } } }
  | { op: 'material.assign'; target: ElementTarget; expected?: string | null; material: { name: string; create: boolean } }
  | { op: 'walls.join'; walls: [ElementTarget, ElementTarget] }
  /** A door, window or opening in a host wall: `offset` from the wall's placement origin along it to the centre, `sill` above it. */
  | { op: 'hosted.create'; ref?: string; kind: HostedKind; host: ElementTarget; name?: string; offset: number; sill: number; width: number; height: number };

export type AuthoringOpName = AuthoringOp['op'];
export const AUTHORING_OPS: readonly AuthoringOpName[] = ['stair.resize', 'stair.delete', 'railing.delete', 'stair.replace', 'railing.replace', 'stair.create', 'railing.create', 'element.create', 'element.delete', 'element.split', 'element.resize', 'element.profile', 'element.move', 'element.rotate', 'element.copy', 'element.array',
  'type.assign', 'material.assign', 'walls.join', 'hosted.create', 'hosted.edit'];

export interface ModelAuthoringBatch {
  version: 1;
  kind: 'model.authoring';
  title: string;
  rationale?: string;
  units: AuthoringUnits;
  frame: 'storey-local';
  operations: AuthoringOp[];
}

export const MODEL_AUTHORING_LIMIT = 200;

/** Builder-plausible ranges, metres. A value outside one is usually a unit mistake, so the message says so. */
const R = {
  coordinate: { min: -10_000, max: 10_000, signed: true },
  thickness: { min: 0.01, max: 5 },
  section: { min: 0.01, max: 10 },
  height: { min: 0.1, max: 200 },
  extent: { min: 0.05, max: 1_000 },
  fill: { min: 0.05, max: 20 },
  offset: { min: -1_000, max: 1_000, signed: true },
  sill: { min: -20, max: 200, signed: true },
  delta: { min: -1_000, max: 1_000, signed: true },
} satisfies Record<string, LengthRange>;

export const isNewElement = (target: ElementTarget): target is NewElement => 'ref' in target;

function existing(value: unknown, at: string): ExistingElement {
  const target = parseGlobalIdTarget(value, at);
  if (!record(value)) throw new Error(`${at} is not an object`);
  if (typeof value.ifcClass !== 'string' || !/^Ifc[A-Za-z0-9]+$/.test(value.ifcClass)) throw new Error(`${at} must state the element's expected ifcClass`);
  if (typeof value.name !== 'string' || value.name.length > 200) throw new Error(`${at} must state the element's expected name ("" when unnamed)`);
  return { ...target, ifcClass: value.ifcClass, name: value.name };
}

function element(value: unknown, at: string, refs: ReadonlyMap<string, AuthoringOp>): ElementTarget {
  if (record(value) && 'ref' in value) {
    const ref = parseRef(value.ref, at);
    if (!refs.has(ref)) throw new Error(`${at} refers to "${ref}", which no earlier operation creates`);
    return { ref };
  }
  return existing(value, at);
}

/** A wall by its expected class, or a wall an earlier `element.create` builds. */
function isWall(target: ElementTarget, refs: ReadonlyMap<string, AuthoringOp>): boolean {
  const visited = new Set<string>();
  while (isNewElement(target)) {
    if (visited.has(target.ref)) return false;
    visited.add(target.ref);
    const creator = refs.get(target.ref);
    if (creator?.op === 'element.create') return creator.ifcClass === 'IfcWall';
    if (creator?.op !== 'element.copy' && creator?.op !== 'element.array') return false;
    target = creator.target;
  }
  return target.ifcClass.startsWith('IfcWall');
}

function createParams(value: Record<string, unknown>, ifcClass: AuthoringClass, units: AuthoringUnits, at: string): AxisParams | BoxParams | ShapeParams {
  const p = value.params;
  if (!record(p)) throw new Error(`${at} needs params`);
  const shape = parseShapeParams(p, ifcClass, units, at);
  if (shape) return shape;
  const length = (key: string, range: LengthRange) => parseLength(p[key], units, range, `${at} ${key}`);
  if (ifcClass === 'IfcWall' || ifcClass === 'IfcBeam' || ifcClass === 'IfcMember') {
    const start = parsePoint(p.start, units, R.coordinate, `${at} start`);
    const end = parsePoint(p.end, units, R.coordinate, `${at} end`);
    const factor = units === 'mm' ? 0.001 : 1;
    if (Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]) * factor < 0.05) throw new Error(`${at} is shorter than 0.05 m`);
    if (ifcClass === 'IfcWall' && Math.abs(end[2] - start[2]) * factor > 1e-9) throw new Error(`${at}: a wall's start and end must share one height`);
    return ifcClass === 'IfcWall'
      ? { start, end, thickness: length('thickness', R.thickness), height: length('height', R.height) }
      : { start, end, width: length('width', R.section), height: length('height', R.section) };
  }
  const position = parsePoint(p.position, units, R.coordinate, `${at} position`);
  if (ifcClass === 'IfcColumn') return { position, width: length('width', R.section), depth: length('depth', R.section), height: length('height', R.height) };
  const box = { position, width: length('width', R.extent), depth: length('depth', R.extent) };
  return ifcClass === 'IfcSpace' ? { ...box, height: length('height', R.height) } : { ...box, thickness: length('thickness', R.thickness) };
}

function expectedName(value: Record<string, unknown>, target: ElementTarget, at: string): { expected?: string | null } {
  if (isNewElement(target)) {
    if (value.expected !== undefined) throw new Error(`${at}: an element created in this batch has no current value to expect`);
    return {};
  }
  if (!Object.hasOwn(value, 'expected') || (value.expected !== null && typeof value.expected !== 'string')) {
    throw new Error(`${at} must state the expected current name (null when none)`);
  }
  return { expected: value.expected as string | null };
}

function operation(value: unknown, index: number, units: AuthoringUnits, refs: Map<string, AuthoringOp>): AuthoringOp {
  const at = `Operation ${index + 1}`;
  if (!record(value)) throw new Error(`${at} is not an object`);
  const defineRef = (op: AuthoringOp & { ref?: string }) => {
    if (op.ref === undefined) return op;
    if (refs.has(op.ref)) throw new Error(`${at} reuses ref "${op.ref}"`);
    refs.set(op.ref, op);
    return op;
  };
  switch (value.op) {
    case 'stair.resize': return {op:value.op,target:existing(value.target,at),expected:parseExpectedStair(value.expected,`${at} expected`),size:parseStairPatch(value.size,units,`${at} size`)};
    case 'stair.delete': case 'railing.delete': return {op:value.op,target:existing(value.target,at)};
    case 'stair.replace': return defineRef({op:value.op,target:existing(value.target,at),ref:parseRef(value.ref,at),storey:parseGlobalIdTarget(value.storey,`${at} storey`),params:parseStairRailingParams(value.params,'stair',units,at)});
    case 'railing.replace': return defineRef({op:value.op,target:existing(value.target,at),ref:parseRef(value.ref,at),storey:parseGlobalIdTarget(value.storey,`${at} storey`),params:parseStairRailingParams(value.params,'railing',units,at)});
    case 'stair.create': return defineRef({ op: value.op, ref: parseRef(value.ref, at), storey: parseGlobalIdTarget(value.storey, `${at} storey`), params: parseStairRailingParams(value.params, 'stair', units, at) });
    case 'railing.create': return defineRef({ op: value.op, ref: parseRef(value.ref, at), storey: parseGlobalIdTarget(value.storey, `${at} storey`), params: parseStairRailingParams(value.params, 'railing', units, at) });
    case 'hosted.edit': {
      if (Object.keys(value).some(key => !['op', 'target', 'expected', 'edit'].includes(key))) throw new Error(`${at}: unsupported hosted edit field`);
      const target = existing(value.target, at);
      if (!['IfcDoor', 'IfcWindow', 'IfcOpeningElement', 'IfcOpeningStandardCase'].includes(target.ifcClass)) throw new Error(`${at}: hosted.edit requires a native door, window or opening occurrence`);
      return { op: value.op, target, expected: parseExpectedHostedEdit(value.expected, units, `${at} expected`), edit: parseHostedEdit(value.edit, units, `${at} edit`) };
    }
    case 'element.split': {
      if (Object.keys(value).some(key => !['op', 'target', 'expected', 'cut'].includes(key))) throw new Error(`${at}: unsupported split field`);
      const expected = parseSplitSnapshot(value.expected, `${at} expected`), cut = parseSplitCut(value.cut, units, `${at} cut`);
      if (expected.kind !== cut.kind) throw new Error(`${at}: the native snapshot kind and cut kind must agree`);
      return { op: value.op, target: existing(value.target, at), expected, cut };
    }
    case 'element.resize': {
      const expected = parseSizeParams(value.expected, units, `${at} expected`, true);
      const size = parseSizeParams(value.size, units, `${at} size`, false);
      if (expected.kind !== size.kind) throw new Error(`${at}: expected and changed native size kinds must match`);
      return { op: value.op, target: existing(value.target, at), expected, size };
    }
    case 'element.profile':
      return { op: value.op, target: existing(value.target, at), expected: parseProfileSectionParams(value.expected, units, `${at} expected`), Profile: parseProfileSectionParams(value.Profile, units, `${at} Profile`) };
    case 'element.create': {
      if (!AUTHORING_CLASSES.includes(value.ifcClass as AuthoringClass)) {
        throw new Error(`${at}: ifcClass must be one of ${AUTHORING_CLASSES.join(', ')}; other classes are not authored by the viewer`);
      }
      const ifcClass = value.ifcClass as AuthoringClass;
      return defineRef({ op: 'element.create', ref: parseRef(value.ref, at), ifcClass, storey: parseGlobalIdTarget(value.storey, `${at} storey`),
        name: parseText(value.name, `${at} name`), params: createParams(value, ifcClass, units, at) });
    }
    case 'element.copy': {
      const target = element(value.target, at, refs);
      const fields = parseCopyFields(value, units, at, false);
      return defineRef({ ...fields, op: 'element.copy', target, ref: parseRef(value.ref, at) });
    }
    case 'element.array': {
      const target = element(value.target, at, refs);
      const fields = parseCopyFields(value, units, at, true);
      if (!Array.isArray(value.refs) || value.refs.length !== fields.count - 1) throw new Error(`${at}: refs must name each of the count - 1 copies`);
      const names = value.refs.map(name => parseRef(name, at));
      const op: AuthoringOp = { ...fields, op: 'element.array', target, refs: names };
      for (const name of names) {
        if (refs.has(name)) throw new Error(`${at} reuses ref "${name}"`);
        refs.set(name, op);
      }
      return op;
    }
    case 'element.delete':
      return { op: 'element.delete', target: existing(value.target, at) };
    case 'element.move': {
      if (!Array.isArray(value.delta) || value.delta.length !== 2) {
        throw new Error(`${at}: delta must be [dx, dy]; vertical moves are not supported`);
      }
      const delta = value.delta.map((d, i) => parseLength(d, units, R.delta, `${at} delta[${i}]`)) as [number, number];
      if (value.from !== undefined && (!Array.isArray(value.from) || value.from.length !== 2)) throw new Error(`${at}: from must be [x, y] in ${units}`);
      const from = Array.isArray(value.from) ? value.from.map((v, i) => parseLength(v, units, R.coordinate, `${at} from[${i}]`)) as [number, number] : undefined;
      if (Math.hypot(...delta) * (units === 'mm' ? 0.001 : 1) < 1e-4) throw new Error(`${at} moves by nothing`);
      return { op: 'element.move', target: existing(value.target, at), delta,
        ...(from ? { from } : {}) };
    }
    case 'element.rotate': {
      const angle = value.angleDeg;
      if (typeof angle !== 'number' || !Number.isFinite(angle) || angle === 0 || Math.abs(angle) > 360) throw new Error(`${at}: angleDeg must be a non-zero number of degrees within ±360`);
      if (value.fromDeg !== undefined && (typeof value.fromDeg !== 'number' || !Number.isFinite(value.fromDeg))) throw new Error(`${at}: fromDeg must be a number`);
      return { op: 'element.rotate', target: existing(value.target, at), angleDeg: angle, ...(typeof value.fromDeg === 'number' ? { fromDeg: value.fromDeg } : {}) };
    }
    case 'type.assign': {
      const target = element(value.target, at, refs);
      const type = record(value.type) ? value.type : null;
      if (!type) throw new Error(`${at} needs a type`);
      const create = record(type.create) ? type.create : null;
      const chosen = create
        ? { create: { ifcClass: parseText(create.ifcClass, `${at} type class`), name: parseText(create.name, `${at} type name`) } }
        : { globalId: parseGlobalIdTarget(type, `${at} type`).globalId, name: parseText(type.name, `${at} type name`) };
      if (create && !/^Ifc[A-Za-z0-9]+Type$/.test(chosen.create!.ifcClass)) throw new Error(`${at}: a new type needs an Ifc…Type class`);
      return { op: 'type.assign', target, ...expectedName(value, target, at), type: chosen as Extract<AuthoringOp, { op: 'type.assign' }>['type'] };
    }
    case 'material.assign': {
      const target = element(value.target, at, refs);
      const material = record(value.material) ? value.material : null;
      if (!material || (material.create !== undefined && typeof material.create !== 'boolean')) throw new Error(`${at} needs a material {name, create}`);
      return { op: 'material.assign', target, ...expectedName(value, target, at),
        material: { name: parseText(material.name, `${at} material name`), create: material.create === true } };
    }
    case 'walls.join': {
      if (!Array.isArray(value.walls) || value.walls.length !== 2) throw new Error(`${at} joins exactly two walls`);
      const walls = value.walls.map((wall, i) => element(wall, `${at} wall ${i + 1}`, refs)) as [ElementTarget, ElementTarget];
      for (const wall of walls) if (!isWall(wall, refs)) throw new Error(`${at}: only walls are joined`);
      return { op: 'walls.join', walls };
    }
    case 'hosted.create': {
      if (!HOSTED_KINDS.includes(value.kind as HostedKind)) throw new Error(`${at}: kind must be door, window or opening`);
      const host = element(value.host, at, refs);
      if (!isWall(host, refs)) throw new Error(`${at}: doors, windows and openings are hosted in walls only`);
      const length = (key: string, range: LengthRange) => parseLength(value[key], units, range, `${at} ${key}`);
      return defineRef({ op: 'hosted.create', ...(value.ref !== undefined ? { ref: parseRef(value.ref, at) } : {}), kind: value.kind as HostedKind, host,
        ...(value.name !== undefined ? { name: parseText(value.name, `${at} name`) } : {}),
        offset: length('offset', R.offset), sill: length('sill', R.sill), width: length('width', R.fill), height: length('height', R.fill) });
    }
    default:
      throw new Error(`${at} has an unsupported operation; supported: ${AUTHORING_OPS.join(', ')}`);
  }
}

/** Strict, bounded parse of a complete JSON answer (optionally fenced). Throws with a reason a person can act on. */
export function parseModelAuthoringBatch(answer: string): ModelAuthoringBatch {
  if (answer.length > 400_000) throw new Error('The authoring batch exceeds the text limit');
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!record(value) || value.version !== 1 || value.kind !== 'model.authoring') throw new Error('Not a model authoring batch');
  const title = parseText(value.title, 'The batch title');
  if (value.rationale !== undefined && (typeof value.rationale !== 'string' || value.rationale.length > 2000)) throw new Error('The rationale must be text');
  if (value.units !== 'm' && value.units !== 'mm') throw new Error('An authoring batch must declare "units": "m" or "mm"');
  if (value.frame !== 'storey-local') throw new Error('An authoring batch must declare "frame": "storey-local"; other frames are refused');
  if (!Array.isArray(value.operations) || value.operations.length === 0) throw new Error('An authoring batch needs at least one operation');
  if (value.operations.length > MODEL_AUTHORING_LIMIT) throw new Error(`An authoring batch may hold at most ${MODEL_AUTHORING_LIMIT} operations`);
  const refs = new Map<string, AuthoringOp>();
  const units = value.units;
  const operations = value.operations.map((op, index) => operation(op, index, units, refs));
  const splitTargets = operations.filter((op): op is Extract<AuthoringOp, { op: 'element.split' }> => op.op === 'element.split').map(op => `${op.target.modelId ?? ''}:${op.target.globalId}`);
  if (new Set(splitTargets).size !== splitTargets.length) throw new Error('Split targets must be unique; no targets are silently discarded');
  const splitWork = operations.reduce((sum, op) => sum + (op.op === 'element.split' && op.expected.kind === 'slab' ? op.expected.chain.footprint.length ** 2 : 0), 0);
  if (splitWork > AUTHORING_OUTLINE_WORK_LIMIT) throw new Error(`Split preview work exceeds ${AUTHORING_OUTLINE_WORK_LIMIT} vertex-pair units; use a smaller explicit selection`);
  const stairRailingWork = operations.reduce((total, op) => total + (
    op.op === 'stair.create' || op.op === 'stair.replace' ? op.params.NumberOfRisers
      : op.op === 'railing.create' || op.op === 'railing.replace' ? railingPostWork(op.params.Path, op.params.PostSpacing) : 0), 0);
  if (stairRailingWork > STAIR_RAILING_WORK_LIMIT) throw new Error(`The native stair-step/railing-post work exceeds ${STAIR_RAILING_WORK_LIMIT}; split this proposal into smaller batches`);
  const outlineWork = operations.reduce((sum, op) => sum + (op.op === 'element.create' && 'OuterCurve' in op.params ? op.params.OuterCurve.length ** 2 : 0), 0);
  if (outlineWork > AUTHORING_OUTLINE_WORK_LIMIT) throw new Error(`The polygon preview work exceeds ${AUTHORING_OUTLINE_WORK_LIMIT} vertex-pair units; split this proposal into smaller batches`);
  const copies = operations.reduce((total, op) => total + (op.op === 'element.array' ? op.count - 1 : op.op === 'element.copy' ? 1 : 0), 0);
  if (copies > MODEL_AUTHORING_LIMIT) throw new Error(`An authoring batch may create at most ${MODEL_AUTHORING_LIMIT} copy roots`);
  return { version: 1, kind: 'model.authoring', title, ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}),
    units, frame: 'storey-local', operations };
}

/** A length of `batch` in metres. */
export const toMetres = (batch: Pick<ModelAuthoringBatch, 'units'>, value: number): number => batch.units === 'mm' ? value / 1000 : value;
export const pointToMetres = (batch: Pick<ModelAuthoringBatch, 'units'>, point: readonly number[]): Point3 =>
  [toMetres(batch, point[0]), toMetres(batch, point[1]), toMetres(batch, point[2])];
