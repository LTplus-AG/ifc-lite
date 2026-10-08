/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RoomCommand } from '@ifc-lite/sdk';
import { isRecord, onlyKeys, requiredText } from '@/lib/check-authoring/proposal-json';

export interface RoomRootTarget { GlobalId: string; Name: string }
export interface RoomProposal {
  version: 1;
  kind: 'room.command';
  title: string;
  modelId: string;
  storey: RoomRootTarget;
  units: 'm' | 'mm';
  frame: 'storey-local';
  command: RoomCommand & { action: 'auto' | 'footprint' | 'pick' | 'update' | 'edit' }
    & Required<Pick<RoomCommand, 'weld' | 'minArea' | 'boundary' | 'height' | 'z' | 'namePattern'>>;
  rooms?: RoomRootTarget[];
  /** Supplied complete native snapshot, compared exactly; never an instruction or a writer input. */
  expected?: unknown;
}

const actionKeys = {
  auto: [], footprint: [], pick: ['point'], update: ['rooms'], edit: ['operation', 'tolerance'],
} as const;
export function declaresRoomCommand(content: string): boolean {
  return /^\s*(?:\{|```)/.test(content) && /"kind"\s*:\s*"room\.command"/.test(content);
}
function finite(value: unknown, at: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${at} must be a finite number from ${min} to ${max}`);
  return value;
}
function point(value: unknown, factor: number, at: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${at} requires two explicit storey-local coordinates`);
  return [finite(value[0], at, -10000 / factor, 10000 / factor) * factor, finite(value[1], at, -10000 / factor, 10000 / factor) * factor];
}
function rootTarget(value: unknown, at: string): RoomRootTarget {
  if (!isRecord(value)) throw new Error(`${at} requires its current GlobalId and Name`);
  onlyKeys(value, ['GlobalId', 'Name'], at);
  const GlobalId = requiredText(value, 'GlobalId', at, 22);
  if (!/^[0-3][0-9A-Za-z_$]{21}$/.test(GlobalId)) throw new Error(`${at} requires its actual IFC GlobalId`);
  if (typeof value.Name !== 'string' || value.Name.length > 240) throw new Error(`${at} requires its current Name, including an empty Name`);
  return { GlobalId, Name: value.Name };
}
/** A supplied snapshot has a work/depth bound even before native semantic equality is checked. */
function boundedExpected(value: unknown): unknown {
  if (!isRecord(value)) throw new Error('expected must be the complete native Room snapshot');
  const pending = [{ value: value as unknown, depth: 0 }];
  let work = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++work > 12000 || item.depth > 16) throw new Error('The expected Room snapshot is too large; prepare a smaller storey');
    if (Array.isArray(item.value)) {
      if (item.value.length > 4096) throw new Error('The expected Room snapshot is too large');
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
    } else if (isRecord(item.value)) {
      const keys = Object.keys(item.value);
      if (keys.length > 24) throw new Error('The expected Room snapshot has too many fields');
      for (const key of keys) pending.push({ value: item.value[key], depth: item.depth + 1 });
    }
  }
  return value;
}

/** Separate async Room route: no arbitrary native settings, inferred point or mixed synchronous edits. */
export function parseRoomProposal(content: string): RoomProposal {
  if (content.length > 80000) throw new Error('The Room proposal is too large; prepare one smaller storey');
  const trimmed = content.trim(), fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'room.command') throw new Error('Expected a version 1 Room command');
  onlyKeys(value, ['version', 'kind', 'title', 'modelId', 'storey', 'units', 'frame', 'command', 'expected'], 'Room proposal');
  if (value.units !== 'm' && value.units !== 'mm') throw new Error('Room lengths must declare m or mm');
  if (value.frame !== 'storey-local') throw new Error('Room coordinates require the storey-local IFC Z-up frame');
  const factor = value.units === 'mm' ? .001 : 1;
  const storey = rootTarget(value.storey, 'storey');
  const c = value.command;
  if (!isRecord(c) || (c.action !== 'auto' && c.action !== 'pick' && c.action !== 'footprint' && c.action !== 'update' && c.action !== 'edit')) throw new Error('Supported Room actions are pick, auto, footprint, update and edit');
  onlyKeys(c, ['action', 'weld', 'minArea', 'boundary', 'height', 'z', 'namePattern', 'PredefinedType', 'ObjectType', ...actionKeys[c.action]], 'command');
  if (c.boundary !== 'inner' && c.boundary !== 'center' && c.boundary !== 'outer') throw new Error('Choose inner, center or outer boundary');
  const settings = {
    weld: finite(c.weld, 'weld', .000001 / factor, 5 / factor) * factor,
    minArea: finite(c.minArea, 'minArea (m²)', 0, 1000000), boundary: c.boundary,
    height: finite(c.height, 'height', .1 / factor, 200 / factor) * factor,
    z: finite(c.z, 'z', -10000 / factor, 10000 / factor) * factor,
    namePattern: requiredText(c, 'namePattern', 'command', 200),
    ...(c.PredefinedType !== undefined ? { PredefinedType: requiredText(c, 'PredefinedType', 'command', 80) } : {}),
    ...(c.ObjectType !== undefined ? { ObjectType: requiredText(c, 'ObjectType', 'command', 240) } : {}),
  };
  let command: RoomProposal['command'];
  let rooms: RoomRootTarget[] | undefined;
  if (c.action === 'auto' || c.action === 'footprint') command = { ...settings, action: c.action };
  else if (c.action === 'pick') command = { ...settings, action: 'pick', point: point(c.point, factor, 'pick point') };
  else if (c.action === 'update') {
    if (!Array.isArray(c.rooms) || !c.rooms.length || c.rooms.length > 128) throw new Error('Update requires 1..128 explicit current room targets');
    rooms = c.rooms.map((room, index) => rootTarget(room, `rooms[${index}]`));
    if (new Set(rooms.map(room => room.GlobalId)).size !== rooms.length) throw new Error('Update room targets must be unique');
    command = { ...settings, action: 'update', expressIds: [] };
  } else {
    const op = c.operation;
    if (!isRecord(op)) throw new Error('Edit requires an explicit native layout operation');
    const tolerance = finite(c.tolerance, 'edit tolerance', .000001 / factor, 1 / factor) * factor;
    if (op.kind === 'prune') { onlyKeys(op, ['kind'], 'operation'); command = { ...settings, action: 'edit', tolerance, operation: { kind: 'prune' } }; }
    else if (op.kind === 'remove') { onlyKeys(op, ['kind', 'at'], 'operation'); command = { ...settings, action: 'edit', tolerance, operation: { kind: 'remove', at: point(op.at, factor, 'remove point') } }; }
    else if (op.kind === 'drag') { onlyKeys(op, ['kind', 'from', 'to'], 'operation'); command = { ...settings, action: 'edit', tolerance, operation: { kind: 'drag', from: point(op.from, factor, 'drag start'), to: point(op.to, factor, 'drag end') } }; }
    else if (op.kind === 'split') { onlyKeys(op, ['kind', 'a', 'b'], 'operation'); command = { ...settings, action: 'edit', tolerance, operation: { kind: 'split', a: point(op.a, factor, 'cut start'), b: point(op.b, factor, 'cut end') } }; }
    else throw new Error('Supported layout operations are drag, split, remove and prune');
  }
  return { version: 1, kind: 'room.command', title: requiredText(value, 'title', 'Room proposal', 200), modelId: requiredText(value, 'modelId', 'Room proposal', 200),
    storey, units: value.units, frame: 'storey-local', command, ...(rooms ? { rooms } : {}),
    ...(value.expected !== undefined ? { expected: boundedExpected(value.expected) } : {}) };
}

export const ROOM_COMMAND_GUIDANCE = `Room proposals use kind "room.command", version 1, title, one modelId, storey {GlobalId,Name}, explicit units m/mm and frame storey-local. command action is pick/auto/footprint/update/edit, with explicit weld, minArea (always m²), boundary inner/center/outer, height, z and namePattern; optional exact native PredefinedType/ObjectType. Pick requires the user's explicit point [x,y]; never choose a candidate index or infer a click. Update requires command.rooms with explicit current {GlobalId,Name} targets, resolved to native expressIds at preparation. Edit requires tolerance and native operation drag {from,to}, split {a,b}, remove {at} or prune. This requests an explicit local preparation and review, not execution. Auto approves the entire captured untaken population, never a per-room subset. If supplied native Room evidence is unavailable or sampled, ask for preparation; do not invent contours, settings, room identities or expected values. When a complete native Room snapshot is attached, preserve it as expected. All lengths and points in a proposal use the declared units; expected native snapshot stays SI metres. No AutoAll, new-file builder, mixed model.authoring batch or automatic run.`;
