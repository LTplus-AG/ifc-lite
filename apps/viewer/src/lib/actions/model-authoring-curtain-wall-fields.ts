/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { curtainWallLayout, type CurtainWallInStoreParams, type CurtainWallGridSpec } from '@ifc-lite/create';
import { MAX_CURTAIN_WALL_PANELS } from '@/lib/commands/modeling/commands/curtainwall-place-geometry';
import { parsePoint, record } from './model-authoring-fields';
import { parseProfileSectionParams, profileInMetres } from './model-authoring-shape-params';
import type { AuthoringUnits } from './model-authoring';

/** Bound canonical layout fan-out before it allocates grid lines or part records. */
export const CURTAIN_WALL_PART_LIMIT = 5000;
const fields = ['Start', 'End', 'Height', 'UGrid', 'VGrid', 'MullionProfile', 'TransomProfile', 'PanelThickness', 'EdgeMembers', 'PredefinedType', 'Name', 'Description', 'ObjectType', 'Tag', 'GlobalId'];
const coordinate = { min: -10000, max: 10000, signed: true };
const metres = (v: number, units: AuthoringUnits) => units === 'mm' ? v / 1000 : v;
function length(v: unknown, units: AuthoringUnits, at: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || metres(v, units) > 1000) throw new Error(`${at}: a finite positive length at most 1000 m is required`);
  return v;
}
function grid(v: unknown, units: AuthoringUnits, at: string): CurtainWallGridSpec {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_CURTAIN_WALL_PANELS) return v;
  if (Array.isArray(v) && v.length < MAX_CURTAIN_WALL_PANELS) return v.map((n, i) => length(n, units, `${at}[${i}]`));
  throw new Error(`${at}: provide a bounded positive integer bay count or explicit interior offsets`);
}
export function curtainWallParamsInMetres(p: CurtainWallInStoreParams, units: AuthoringUnits): CurtainWallInStoreParams {
  const m = (n: number) => metres(n, units);
  const scaleGrid = (g: CurtainWallGridSpec) => typeof g === 'number' ? g : g.map(m);
  return { ...p, Start: p.Start.map(m) as [number, number, number], End: p.End.map(m) as [number, number, number], Height: m(p.Height),
    ...(p.UGrid === undefined ? {} : { UGrid: scaleGrid(p.UGrid) }), ...(p.VGrid === undefined ? {} : { VGrid: scaleGrid(p.VGrid) }),
    ...(p.MullionProfile === undefined ? {} : { MullionProfile: profileInMetres(p.MullionProfile, units) }),
    ...(p.TransomProfile === undefined ? {} : { TransomProfile: profileInMetres(p.TransomProfile, units) }),
    ...(p.PanelThickness === undefined ? {} : { PanelThickness: m(p.PanelThickness) }) };
}
export function curtainWallPartWork(p: CurtainWallInStoreParams, units: AuthoringUnits): number {
  const m = curtainWallParamsInMetres(p, units);
  const bays = m.UGrid === undefined ? Math.max(1, Math.ceil(Math.hypot(m.End[0]-m.Start[0], m.End[1]-m.Start[1]) / 1.5 - 1e-9)) : typeof m.UGrid === 'number' ? m.UGrid : m.UGrid.length + 1;
  const rows = m.VGrid === undefined ? 1 : typeof m.VGrid === 'number' ? m.VGrid : m.VGrid.length + 1;
  const edge = m.EdgeMembers ?? true;
  const parts = bays * rows + (edge ? bays + 1 : bays - 1) + bays * (edge ? rows + 1 : rows - 1);
  if (bays * rows > MAX_CURTAIN_WALL_PANELS || parts > CURTAIN_WALL_PART_LIMIT) throw new Error(`Curtain-wall layout exceeds ${MAX_CURTAIN_WALL_PANELS} panels or ${CURTAIN_WALL_PART_LIMIT} native parts; no targets are truncated`);
  return parts;
}
export function parseCurtainWallParams(value: unknown, units: AuthoringUnits, at: string): CurtainWallInStoreParams {
  if (!record(value)) throw new Error(`${at}: canonical curtain-wall params are required`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`${at}: unsupported curtain-wall field ${key}`);
  const p: CurtainWallInStoreParams = { Start: parsePoint(value.Start, units, coordinate, `${at} Start`), End: parsePoint(value.End, units, coordinate, `${at} End`), Height: length(value.Height, units, `${at} Height`) };
  for (const key of ['UGrid', 'VGrid'] as const) if (value[key] !== undefined) p[key] = grid(value[key], units, `${at} ${key}`);
  for (const key of ['MullionProfile', 'TransomProfile'] as const) if (value[key] !== undefined) p[key] = parseProfileSectionParams(value[key], units, `${at} ${key}`);
  if (value.PanelThickness !== undefined) p.PanelThickness = length(value.PanelThickness, units, `${at} PanelThickness`);
  if (value.EdgeMembers !== undefined) { if (typeof value.EdgeMembers !== 'boolean') throw new Error(`${at}: EdgeMembers must be boolean`); p.EdgeMembers = value.EdgeMembers; }
  if (value.PredefinedType !== undefined) { if (value.PredefinedType !== 'USERDEFINED' && value.PredefinedType !== 'NOTDEFINED') throw new Error(`${at}: unsupported curtain-wall PredefinedType`); p.PredefinedType = value.PredefinedType; }
  for (const key of ['Name', 'Description', 'ObjectType', 'Tag', 'GlobalId'] as const) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || value[key].length > (key === 'Description' ? 2000 : 200)) throw new Error(`${at}: ${key} must be bounded native text`);
    p[key] = value[key];
  }
  curtainWallPartWork(p, units);
  curtainWallLayout(curtainWallParamsInMetres(p, units));
  return p;
}
