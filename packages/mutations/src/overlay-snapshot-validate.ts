/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { OverlaySnapshotHistory, OverlaySnapshotV1 } from './overlay-snapshot-types.js';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an overlay snapshot record.');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new TypeError('Expected snapshot rows.'); return value; }
function text(value: unknown): asserts value is string { if (typeof value !== 'string') throw new TypeError('Expected a snapshot string.'); }
function id(value: unknown, minimum = 1): void { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new TypeError('Invalid snapshot EXPRESS ID or index.'); }
function tuple(value: unknown, length: number): unknown[] { const row = list(value); if (row.length !== length) throw new TypeError('Invalid snapshot row length.'); return row; }
function edit(value: unknown): void {
  const row = record(value);
  if (row.operation !== 'SET' && row.operation !== 'DELETE') throw new TypeError('Invalid snapshot mutation operation.');
}
function propertyValue(value: unknown): void {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) { for (const child of item) pending.push(child); }
    else if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new TypeError('Invalid snapshot property value.');
  }
}
function attributeValue(value: unknown): void {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) { for (const child of item) pending.push(child); continue; }
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) continue;
    const marker = record(item), keys = Object.keys(marker);
    if (keys.length === 1 && typeof marker.real === 'number') continue;
    const typed = keys.length === 1 && marker.typed ? record(marker.typed) : null;
    if (!typed || typeof typed.type !== 'string') throw new TypeError('Invalid snapshot IFC attribute.');
    if (Array.isArray(typed.value)) { for (const number of typed.value) if (typeof number !== 'number') throw new TypeError('Invalid typed index.'); }
    else if (!['string', 'number', 'boolean'].includes(typeof typed.value)) throw new TypeError('Invalid typed value.');
  }
}
function entity(value: unknown): void { const row = record(value); id(row.expressId); text(row.type); for (const item of list(row.attributes)) attributeValue(item); }
function sets(value: unknown, kind: 'property' | 'quantity'): void {
  const row = record(value); text(row.name);
  for (const item of list(row[kind === 'property' ? 'properties' : 'quantities'])) text(record(item).name);
}
function attributes(value: unknown, entityId?: number): void {
  for (const item of list(value)) {
    const row = tuple(item, 3); id(row[0]); text(row[1]);
    const edit = record(row[2]); text(edit.attribute); text(edit.value);
    if (edit.attribute !== row[1] || (entityId !== undefined && row[0] !== entityId)) throw new TypeError('Mismatched snapshot attribute target.');
  }
}
function members(value: unknown, entityId?: number, quantity = false): void {
  for (const item of list(value)) {
    const row = tuple(item, 4); id(row[0]); text(row[1]); text(row[2]); edit(row[3]);
    const mutation = record(row[3]);
    if (mutation.operation === 'SET') {
      if (quantity && typeof mutation.value !== 'number') throw new TypeError('Invalid snapshot quantity.');
      propertyValue(mutation.value);
    }
    if (entityId !== undefined && row[0] !== entityId) throw new TypeError('Mismatched forgotten row target.');
  }
}
function journal(value: unknown): void {
  const ids = new Set<string>();
  for (const item of list(value)) {
    const row = record(item); text(row.id); text(row.type); text(row.modelId); id(row.entityId);
    if (!row.id || ids.has(row.id) || typeof row.timestamp !== 'number' || !Number.isFinite(row.timestamp)) throw new TypeError('Invalid snapshot journal identity or timestamp.');
    ids.add(row.id);
  }
}

/** JSON data only; bound depth/work and reject cycles before serializing live rows. */
export function validateJsonGraph(root: unknown): void {
  const path = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; leave?: boolean }> = [{ value: root, depth: 0 }];
  let work = 0;
  while (stack.length) {
    const { value, depth, leave } = stack.pop()!;
    if (leave) { if (value && typeof value === 'object') path.delete(value); continue; }
    if (++work > 2_000_000 || depth > 256) throw new RangeError('Snapshot exceeds the depth/work limit.');
    if (!value || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new TypeError('Snapshot values must be JSON data.');
      continue;
    }
    if (path.has(value)) throw new TypeError('Cannot serialize cyclic snapshot data.');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Snapshot values must be plain records.');
    path.add(value); stack.push({ value, depth, leave: true });
    const children = Array.isArray(value) ? value : Object.values(value);
    if (children.length + stack.length + work > 2_000_000) throw new RangeError('Snapshot exceeds the depth/work limit.');
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }
}

export function validateSnapshot(value: unknown): asserts value is OverlaySnapshotV1 {
  validateJsonGraph(value);
  const dto = record(value);
  if (dto.format !== 'ifc-lite/overlay-snapshot') throw new TypeError('Unknown overlay snapshot format.');
  if (dto.version !== 1) throw new TypeError('Unsupported overlay snapshot version ' + String(dto.version) + '; reader supports version 1.');
  const source = record(dto.source); text(source.contentHash);
  if (!source.contentHash) throw new TypeError('A full source-content hash is required.');
  if (source.schema !== undefined) text(source.schema);
  text(dto.createdAt); if (!Number.isFinite(Date.parse(dto.createdAt))) throw new TypeError('Invalid snapshot creation timestamp.');
  id(dto.nextExpressId); journal(dto.journal);
  const state = record(dto.state);
  members(state.properties); members(state.quantities, undefined, true); attributes(state.attributes);
  for (const item of list(state.positional)) { const row = tuple(item, 3); id(row[0]); id(row[1], 0); attributeValue(row[2]); }
  for (const item of list(state.retypes)) { const row = tuple(item, 2); id(row[0]); text(record(row[1]).newType); }
  const created = record(state.createdSets), deleted = record(state.deletedSets);
  for (const kind of ['property', 'quantity'] as const) {
    for (const item of list(created[kind])) { const row = tuple(item, 2); id(row[0]); sets(row[1], kind); }
    for (const item of list(deleted[kind])) { const row = tuple(item, 2); id(row[0]); text(row[1]); }
  }
  for (const item of list(state.createdEntities)) entity(item);
  for (const item of list(state.tombstones)) id(item);
  for (const item of list(state.aliases)) { const row = tuple(item, 2); id(row[0]); id(row[1]); }
  for (const item of list(state.forgotten)) {
    const forgotten = record(item); id(forgotten.expressId);
    if (forgotten.rows === null) continue;
    const rows = record(forgotten.rows), target = forgotten.expressId as number;
    members(rows.properties, target); members(rows.quantities, target, true); attributes(rows.attributes, target);
    for (const item of list(rows.positional)) { const row = tuple(item, 2); id(row[0], 0); attributeValue(row[1]); }
    if (rows.retype !== null) text(record(rows.retype).newType);
    const created = record(rows.createdSets), deleted = record(rows.deletedSets);
    for (const kind of ['property', 'quantity'] as const) {
      for (const item of list(created[kind])) sets(item, kind);
      for (const item of list(deleted[kind])) text(item);
    }
    journal(rows.journal);
  }
}

const replayableTypes = new Set(['CREATE_PROPERTY', 'UPDATE_PROPERTY', 'DELETE_PROPERTY', 'CREATE_PROPERTY_SET', 'DELETE_PROPERTY_SET', 'CREATE_QUANTITY', 'UPDATE_QUANTITY', 'DELETE_QUANTITY', 'DELETE_QUANTITY_SET', 'UPDATE_ATTRIBUTE', 'UPDATE_POSITIONAL_ATTRIBUTE', 'UPDATE_ENTITY_TYPE', 'CREATE_ENTITY', 'DELETE_ENTITY']);

/** Host-only or unknown records drop the whole undo history; edits remain valid. */
export function validateHistory(value: unknown, dto: OverlaySnapshotV1): OverlaySnapshotHistory {
  const history = record(value), records = new Map(dto.journal.map(row => [row.id, row]));
  const used = new Set<string>();
  for (const item of [...list(history.undo), ...list(history.redo)]) {
    text(item); const row = records.get(item);
    if (!row || !replayableTypes.has(row.type) || used.has(item)) throw new TypeError('Undo/redo references a missing, host-only or duplicate mutation.');
    used.add(item);
  }
  const groups = new Set<string>();
  for (const item of list(history.groups)) {
    const row = tuple(item, 2); text(row[0]); text(row[1]);
    if (!records.has(row[0]) || groups.has(row[0])) throw new TypeError('Invalid snapshot history group.');
    groups.add(row[0]);
  }
  const creations = new Set(dto.journal.filter(row => row.type === 'CREATE_ENTITY').map(row => row.entityId));
  const parked = new Set<number>();
  for (const item of list(history.parked)) {
    entity(item); const expressId = record(item).expressId as number;
    if (!creations.has(expressId) || parked.has(expressId)) throw new TypeError('Parked history entity has no unique create record.');
    parked.add(expressId);
  }
  return value as OverlaySnapshotHistory;
}
