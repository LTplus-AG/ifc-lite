/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { asSourceBytes, getAttributeNamesAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue, MutablePropertyView } from '@ifc-lite/mutations';
import { getEffectiveEntityIndex } from './effective-index.js';
import { effectiveAppearanceRecord } from './effective-appearance-record.js';
import { collectRefsInByteRange, refGroupFromArg } from './reference-collector.js';
import { splitTopLevelArgs } from './step-argument-parser.js';

const RELATING = new Map([['IFCRELASSOCIATESMATERIAL', 'RelatingMaterial'], ['IFCRELDEFINESBYTYPE', 'RelatingType']]);
const BINDINGS = new Map([
  ['IFCRELASSOCIATESMATERIAL', 'RelatedObjects'], ['IFCRELDEFINESBYTYPE', 'RelatedObjects'],
  ['IFCMATERIALDEFINITIONREPRESENTATION', 'RepresentedMaterial'],
  ['IFCSTYLEDITEM', 'Item'], ['IFCSTYLEDREPRESENTATION', 'Items'],
  ['IFCPRESENTATIONLAYERASSIGNMENT', 'AssignedItems'], ['IFCPRESENTATIONLAYERWITHSTYLE', 'AssignedItems'],
  ['IFCINDEXEDTRIANGLETEXTUREMAP', 'MappedTo'],
  ['IFCINDEXEDPOLYGONALTEXTUREMAP', 'MappedTo'], ['IFCTEXTUREMAP', 'MappedTo'],
]);

/**
 * Capture effective geometry/placement/appearance dependencies for conditional
 * replay (#4243). Source and authored references use the actual STEP writers.
 * Property relationships are not traversed inversely; unrelated property edits
 * therefore do not invalidate an appearance command's Undo/Redo.
 */
export function captureAppearanceDependencies(
  store: IfcDataStore, view: MutablePropertyView, roots: ReadonlySet<number>,
): { validate(current: MutablePropertyView): void } {
  const read = (current: MutablePropertyView) => {
    // Refuse a large source/overlay before the effective index copies its maps.
    if (store.entityIndex.byId.size + (store.deferredEntityIndex?.size ?? 0) > 200_000
      || current.getNewEntities().length > 100_000) {
      throw new Error('Appearance dependency validation exceeds its entity budget. Choose a smaller IFC model.');
    }
    const index = getEffectiveEntityIndex(store, current, true);
    const source = asSourceBytes(store.source);
    const rows = new Map<number, { line: string; refs: readonly number[] }>();
    let bytes = 0, values = 0, strings = 0, refs = 0;
    // Native planning accepts 128MiB source + 64MiB output. The effective
    // dependency graph may contain both, including higher precision new UVs.
    const byteLimit = 192 * 1024 * 1024;
    const encoder = new TextEncoder(), scratch = new Uint8Array(16 * 1024);
    const refuse = () => { throw new Error(`Appearance dependency validation exceeds its safety budget (${bytes} bytes, ${values} attribute values). Choose a smaller scope.`); };
    const inspect = (value: IfcAttributeValue | undefined) => {
      const frames: Array<{ values: ReadonlyArray<IfcAttributeValue | undefined>; cursor: number }> = [{ values: [value], cursor: 0 }];
      while (frames.length) {
        const frame = frames[frames.length - 1];
        if (frame.cursor === frame.values.length) { frames.pop(); continue; }
        const value = frame.values[frame.cursor++];
        if (++values > 8_000_000 || frames.length > 64) refuse();
        if (Array.isArray(value)) {
          if (value.length > 8_000_000 - values) refuse();
          frames.push({ values: value, cursor: 0 });
        } else if (value && typeof value === 'object' && 'typed' in value) {
          frames.push({ values: [value.typed.type, value.typed.value], cursor: 0 });
        } else if (typeof value === 'string') { strings += value.length; if (strings > 8 * 1024 * 1024) refuse(); }
      }
    };
    const row = (id: number) => {
      let result = rows.get(id);
      if (result) return result;
      if (rows.size >= 100_000) refuse();
      const record = index.get(id);
      if (!record) { result = { line: '', refs: [] }; rows.set(id, result); return result; }
      if (record.byteLength > byteLimit - bytes) refuse();
      const type = index.typeOf(id) ?? '';
      // Unchanged source dependencies are already represented by an immutable
      // marker below. Scan their original bytes directly instead of decoding,
      // rewriting and encoding large coordinate lists solely to find edges.
      // Binding rows still need their EXPRESS target slot for inverse traversal.
      const original = !index.isOverlayCreated(id) && !index.hasSourceMutation?.(id)
        && !current.getEntityTypeMutation(id);
      if (original && !BINDINGS.has(type)) {
        const span = source.slice(record.byteOffset, record.byteOffset + record.byteLength);
        if (span.length !== record.byteLength) throw new Error('Truncated IFC source during appearance validation.');
        bytes += span.length;
        for (let offset = 0; offset < span.length; offset++) {
          if (span[offset] === 0x23 && ++refs > 2_000_000) refuse();
        }
        result = { line: '', refs: collectRefsInByteRange(span, 0, span.length) };
        rows.set(id, result); return result;
      }
      inspect(current.getNewEntity(id)?.attributes);
      for (const value of current.getPositionalMutationsForEntity(id)?.values() ?? []) inspect(value);
      for (const attribute of current.getAttributeMutationsForEntity(id)) inspect(attribute.value);
      const line = effectiveAppearanceRecord(store, current, index, id);
      // Exact UTF-8 work accounting with bounded scratch storage. Counting
      // every ASCII character as three bytes rejected real Convento walls.
      for (let offset = 0; offset < line.length;) {
        const progress = encoder.encodeInto(line.slice(offset), scratch);
        offset += progress.read; bytes += progress.written;
        if (!progress.read || bytes > byteLimit) refuse();
      }
      for (const char of line) if (char === '#' && ++refs > 2_000_000) refuse();
      const encoded = encoder.encode(line);
      let forward: readonly number[] = collectRefsInByteRange(encoded, 0, encoded.length);
      const relating = RELATING.get(type);
      if (relating) {
        // Membership is validated by the complete row, but peer products sharing
        // a type/material are not dependencies of this object's appearance.
        const slot = getAttributeNamesAcrossSchemas(type).indexOf(relating);
        if (slot < 0) refuse();
        const args = splitTopLevelArgs(line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')));
        const ref = args[slot] === undefined ? undefined : refGroupFromArg(args[slot]);
        forward = typeof ref === 'number' ? [ref] : ref ?? [];
      }
      result = { line, refs: forward };
      rows.set(id, result); return result;
    };
    // Inverse bindings are discovered by their actual EXPRESS target slot, not
    // by a shared texture/style reference that could belong to another object.
    const inverse = new Map<number, number[]>();
    for (const [type, attribute] of BINDINGS) {
      const slot = getAttributeNamesAcrossSchemas(type).indexOf(attribute);
      if (slot < 0) throw new Error(`Cannot resolve ${type}.${attribute} for appearance validation.`);
      for (const id of index.byType.get(type) ?? []) {
        const line = row(id).line;
        const args = splitTopLevelArgs(line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')));
        const target = args[slot] === undefined ? null : refGroupFromArg(args[slot]);
        for (const targetId of typeof target === 'number' ? [target] : target ?? []) {
          if (!Number.isSafeInteger(targetId)) refuse();
          const ids = inverse.get(targetId) ?? []; ids.push(id); inverse.set(targetId, ids);
        }
      }
    }
    if (roots.size > 100_000) refuse();
    for (const id of roots) if (!Number.isSafeInteger(id) || id <= 0) refuse();
    const pending = [...roots], visited = new Set(pending);
    const result = new Map<number, string | null>();
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const id = pending[cursor], record = row(id);
      // Immutable source rows need no duplicate string in each Undo/Redo
      // checkpoint. An SDK override changes this marker to an effective row.
      const original = index.has(id) && !index.isOverlayCreated(id)
        && !index.hasSourceMutation?.(id) && !current.getEntityTypeMutation(id);
      result.set(id, original ? null : record.line);
      for (const next of [...record.refs, ...(inverse.get(id) ?? [])]) {
        if (!visited.has(next)) { if (visited.size >= 100_000) refuse(); visited.add(next); pending.push(next); }
      }
    }
    return result;
  };
  const snapshot = read(view);
  return { validate(current) {
    const actual = read(current);
    if (actual.size !== snapshot.size || [...snapshot].some(([id, line]) => actual.get(id) !== line)) {
      throw new Error('The IFC geometry or appearance changed after this command. Undo the newer edit or reload the model.');
    }
  } };
}
