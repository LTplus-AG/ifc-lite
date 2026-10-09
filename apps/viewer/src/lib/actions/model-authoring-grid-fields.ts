/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { GridInStoreParams, GridAxisInStoreParams, ColumnInStoreParams, ProfiledColumnInStoreParams } from '@ifc-lite/create';
import type { AuthoringUnits, ExistingElement, StoreyTarget } from './model-authoring';
import { parseGlobalIdTarget, parseLength, parsePoint, parseRef, parseText, record } from './model-authoring-fields';
import { parseProfileSectionParams, profileInMetres } from './model-authoring-shape-params';
import { MAX_GRID_AXES } from '@/lib/commands/modeling/commands/grid-place-geometry';

export interface GridAxisExpected {
  expressId: number;
  AxisTag: string;
  family: 'U' | 'V' | 'W';
  /** Native evidence always uses metres in the storey frame. */
  a: [number, number];
  b: [number, number];
}
export interface GridExpected { axes: GridAxisExpected[]; frame: { o: [number, number, number]; x: [number, number, number]; y: [number, number, number]; z: [number, number, number] } }
export type ReviewedGridBinding =
  | { target: ExistingElement; expected: GridExpected; IntersectingAxes: [number, number] }
  | { ref: string; IntersectingAxes: [string, string] };
export type ReviewedGridOp =
  | { op: 'grid.create'; ref: string; storey: StoreyTarget; params: GridInStoreParams }
  | { op: 'column.createOnGrid'; ref: string; storey: StoreyTarget; grid: ReviewedGridBinding; params: ColumnInStoreParams | ProfiledColumnInStoreParams };
function nativeName(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length > 200) throw new Error(`${at}: native Name/AxisTag must be current text, empty when unnamed`);
  return value;
}
const coordinate = { min: -10000, max: 10000, signed: true };
const section = { min: .01, max: 10 };
const height = { min: .1, max: 200 };
export function parseGridStorey(value: unknown, at: string): StoreyTarget {
  const target = parseGlobalIdTarget(value, at);
  if (!target.modelId) throw new Error(`${at}: provide the explicit loaded modelId`);
  return target;
}
function strict(value: unknown, allowed: string[], at: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${at}: unsupported or missing native fields`);
  return value;
}
function point2(value: unknown, units: AuthoringUnits, at: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${at} must have two coordinates`);
  return [parseLength(value[0], units, coordinate, at), parseLength(value[1], units, coordinate, at)];
}
function axes(value: unknown, units: AuthoringUnits, at: string, optional = false): GridAxisInStoreParams[] {
  if (optional && (value === undefined || (Array.isArray(value) && value.length === 0))) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GRID_AXES) throw new Error(`${at}: provide 1–${MAX_GRID_AXES} explicit axes`);
  return value.map((raw, index) => {
    const p = strict(raw, ['Tag', 'Start', 'End'], `${at}[${index}]`);
    const Start = point2(p.Start, units, `${at} Start`), End = point2(p.End, units, `${at} End`);
    if (Start.every((v, i) => v === End[i])) throw new Error(`${at}: an axis has zero length`);
    return { Tag: parseText(p.Tag, `${at} Tag`), Start, End };
  });
}
export function parseGridParams(value: unknown, units: AuthoringUnits, at: string): GridInStoreParams {
  const p = strict(value, ['Position', 'Direction', 'UAxes', 'VAxes', 'WAxes', 'Name', 'Description', 'ObjectType', 'PredefinedType'], at);
  // Check total supplied size before mapping arrays or doing any native work.
  const count = [p.UAxes, p.VAxes, p.WAxes].reduce<number>((sum, row) => sum + (Array.isArray(row) ? row.length : 0), 0);
  if (count > MAX_GRID_AXES) throw new Error(`${at}: at most ${MAX_GRID_AXES} axes are allowed`);
  const UAxes = axes(p.UAxes, units, `${at} UAxes`), VAxes = axes(p.VAxes, units, `${at} VAxes`), WAxes = axes(p.WAxes, units, `${at} WAxes`, true);
  const tags = [...UAxes, ...VAxes, ...WAxes].map(axis => axis.Tag);
  if (new Set(tags).size !== tags.length) throw new Error(`${at}: axis tags must be unique within the grid`);
  if (typeof p.Direction !== 'number' || !Number.isFinite(p.Direction)) throw new Error(`${at}: Direction must be explicit finite radians`);
  const PredefinedType = p.PredefinedType;
  if (PredefinedType !== undefined && !['RECTANGULAR', 'TRIANGULAR', 'IRREGULAR', 'USERDEFINED', 'NOTDEFINED'].includes(String(PredefinedType))) throw new Error(`${at}: unsupported straight-grid PredefinedType`);
  return { Position: parsePoint(p.Position, units, coordinate, `${at} Position`), Direction: p.Direction, UAxes, VAxes,
    ...(WAxes.length ? { WAxes } : {}), ...(PredefinedType === undefined ? {} : { PredefinedType: PredefinedType as GridInStoreParams['PredefinedType'] }),
    ...Object.fromEntries(['Name', 'Description', 'ObjectType'].filter(key => p[key] !== undefined).map(key => [key, parseText(p[key], `${at} ${key}`)])) };
}
export function parseGridColumnParams(value: unknown, units: AuthoringUnits, at: string): ColumnInStoreParams | ProfiledColumnInStoreParams {
  const p = strict(value, ['Position', 'Width', 'Depth', 'Height', 'Profile', 'RefDirection', 'Name', 'Description', 'ObjectType', 'Tag'], at);
  const common = { Position: parsePoint(p.Position, units, coordinate, `${at} Position`), Height: parseLength(p.Height, units, height, `${at} Height`),
    ...Object.fromEntries(['Name', 'Description', 'ObjectType', 'Tag'].filter(key => p[key] !== undefined).map(key => [key, parseText(p[key], `${at} ${key}`)])) };
  let RefDirection: [number, number, number] | undefined;
  if (p.RefDirection !== undefined) {
    if (!Array.isArray(p.RefDirection) || p.RefDirection.length !== 3 || p.RefDirection.some(v => typeof v !== 'number' || !Number.isFinite(v)) || p.RefDirection[2] !== 0 || Math.hypot(p.RefDirection[0], p.RefDirection[1]) === 0) throw new Error(`${at}: RefDirection must be a finite horizontal direction`);
    RefDirection = [p.RefDirection[0], p.RefDirection[1], 0];
  }
  if (p.Profile !== undefined) {
    if (p.Width !== undefined || p.Depth !== undefined) throw new Error(`${at}: choose Profile or Width/Depth`);
    return { ...common, ...(RefDirection ? { RefDirection } : {}), Profile: parseProfileSectionParams(p.Profile, units, `${at} Profile`) };
  }
  return { ...common, ...(RefDirection ? { RefDirection } : {}), Width: parseLength(p.Width, units, section, `${at} Width`), Depth: parseLength(p.Depth, units, section, `${at} Depth`) };
}
export function parseGridBinding(value: unknown, earlierGrid: (ref: string) => boolean, at: string): ReviewedGridBinding {
  if (record(value) && 'ref' in value) {
    const p = strict(value, ['ref', 'IntersectingAxes'], at), ref = parseRef(p.ref, at);
    if (!earlierGrid(ref)) throw new Error(`${at}: ref must name an earlier grid.create`);
    if (!Array.isArray(p.IntersectingAxes) || p.IntersectingAxes.length !== 2) throw new Error(`${at}: select two explicit native axis tags`);
    const tags: [string, string] = [parseText(p.IntersectingAxes[0], at), parseText(p.IntersectingAxes[1], at)];
    if (tags[0] === tags[1]) throw new Error(`${at}: crossing axes must differ`);
    return { ref, IntersectingAxes: tags };
  }
  const p = strict(value, ['target', 'expected', 'IntersectingAxes'], at);
  const target = strict(p.target, ['globalId', 'modelId', 'ifcClass', 'name'], `${at} target`);
  if (target.ifcClass !== 'IfcGrid') throw new Error(`${at}: target must be IfcGrid`);
  const current = strict(p.expected, ['axes', 'frame'], `${at} expected`);
  if (!Array.isArray(current.axes) || current.axes.length < 2 || current.axes.length > MAX_GRID_AXES) throw new Error(`${at}: expected needs the full bounded native axis snapshot`);
  const frameValue = strict(current.frame, ['o', 'x', 'y', 'z'], `${at} frame`);
  const vector = (value: unknown): [number, number, number] => {
    if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${at}: frame directions must be finite native vectors`);
    return [value[0], value[1], value[2]];
  };
  const frame = { o: parsePoint(frameValue.o, 'm', coordinate, `${at} frame origin`), x: vector(frameValue.x), y: vector(frameValue.y), z: vector(frameValue.z) };
  const expected = { frame, axes: current.axes.map((raw): GridAxisExpected => {
    const row = strict(raw, ['expressId', 'AxisTag', 'family', 'a', 'b'], at);
    if (!Number.isSafeInteger(row.expressId) || Number(row.expressId) <= 0 || !['U', 'V', 'W'].includes(String(row.family))) throw new Error(`${at}: invalid native axis identity`);
    return { expressId: row.expressId as number, AxisTag: nativeName(row.AxisTag, at), family: row.family as GridAxisExpected['family'], a: point2(row.a, 'm', at), b: point2(row.b, 'm', at) };
  }) };
  if (new Set(expected.axes.map(row => row.expressId)).size !== expected.axes.length) throw new Error(`${at}: native axis identities must be unique`);
  const ids = p.IntersectingAxes;
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1] || ids.some(id => !Number.isSafeInteger(id) || !expected.axes.some(axis => axis.expressId === id))) throw new Error(`${at}: crossing must select two actual expected axes`);
  return { target: { ...parseGridStorey(target, at), ifcClass: 'IfcGrid', name: nativeName(target.name, at) }, expected, IntersectingAxes: [ids[0], ids[1]] };
}
export function gridParamsInMetres(params: GridInStoreParams, units: AuthoringUnits): GridInStoreParams {
  const m = (n: number) => units === 'mm' ? n / 1000 : n;
  const convert = (list: readonly GridAxisInStoreParams[]) => list.map(axis => ({ ...axis, Start: axis.Start.map(m) as [number, number], End: axis.End.map(m) as [number, number] }));
  return { ...params, Position: params.Position?.map(m) as [number, number, number], UAxes: convert(params.UAxes), VAxes: convert(params.VAxes), ...(params.WAxes ? { WAxes: convert(params.WAxes) } : {}) };
}
export function gridColumnParamsInMetres(params: ColumnInStoreParams | ProfiledColumnInStoreParams, units: AuthoringUnits): ColumnInStoreParams | ProfiledColumnInStoreParams {
  const m = (n: number) => units === 'mm' ? n / 1000 : n;
  const common = { ...params, Position: params.Position.map(m) as [number, number, number], Height: m(params.Height) };
  return 'Profile' in params ? { ...common, Profile: profileInMetres(params.Profile, units) } : { ...common, Width: m(params.Width), Depth: m(params.Depth) };
}
