/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue, MutablePropertyView } from '@ifc-lite/mutations';
import { authoredEntityRefs, getEffectiveEntityIndex } from './effective-index.js';
import { collectRefsInByteRange } from './reference-collector.js';
import { effectiveAppearanceRecord, effectiveImageUri } from './effective-appearance-record.js';

const RESOURCE_TYPES = new Set(['IFCIMAGETEXTURE', 'IFCTEXTUREVERTEXLIST', 'IFCSURFACESTYLE',
  'IFCSURFACESTYLEWITHTEXTURES', 'IFCSURFACESTYLESHADING', 'IFCSURFACESTYLERENDERING', 'IFCCOLOURRGB']);

/**
 * Pure, conservative cleanup plan for explicitly owned appearance resources.
 * Never returns source-backed entities or entities outside the candidate set.
 * History supplies creation IDs and saved attribute values as protected values.
 * Effective slots use the same named/positional precedence as STEP export.
 * A budget refusal throws before returning any partial deletion plan.
 */
export function planAuthoredResourceCleanup(
  dataStore: IfcDataStore, view: MutablePropertyView,
  candidateIds: ReadonlySet<number>, protectedValues: Iterable<IfcAttributeValue> = [],
): { entityIds: Set<number>; retainedImageUris: Set<string> } {
  if (candidateIds.size > 250_000) throw new Error('Authored appearance cleanup exceeds its entity budget; resources were retained.');
  const index = getEffectiveEntityIndex(dataStore, view, true);
  const candidates = new Set([...candidateIds].filter(id => index.isOverlayCreated(id)
    && !index.isDeleted(id) && RESOURCE_TYPES.has(index.typeOf(id) ?? '')));
  const live = new Set<number>();
  const pending: number[] = [];
  let work = 0;
  const account = () => { if (++work > 2_000_000) throw new Error('Authored appearance cleanup exceeds its reference budget; resources were retained.'); };
  let valueWork = 0, stringUnits = 0;
  const inspect = (value: IfcAttributeValue | undefined) => {
    const frames: Array<{ values: ReadonlyArray<IfcAttributeValue | undefined>; cursor: number }> = [{ values: [value], cursor: 0 }];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (frame.cursor === frame.values.length) { frames.pop(); continue; }
      const next = frame.values[frame.cursor++];
      if (++valueWork > 8_000_000 || frames.length > 64) throw new Error('Authored appearance cleanup exceeds its attribute budget; resources were retained.');
      if (Array.isArray(next)) {
        if (next.length > 8_000_000 - valueWork) throw new Error('Authored appearance cleanup exceeds its attribute budget; resources were retained.');
        frames.push({ values: next, cursor: 0 });
      } else if (next && typeof next === 'object' && 'typed' in next) {
        frames.push({ values: [next.typed.type, next.typed.value], cursor: 0 });
      } else if (typeof next === 'string') {
        stringUnits += next.length;
        if (stringUnits > 128 * 1024 * 1024) throw new Error('Authored appearance cleanup exceeds its attribute budget; resources were retained.');
      }
    }
  };
  const retain = (id: number) => {
    account();
    if (candidates.has(id) && !live.has(id)) { live.add(id); pending.push(id); }
  };
  if (candidates.size) for (const value of protectedValues) {
    inspect(value);
    for (const id of authoredEntityRefs(value)) retain(id);
    if (live.size === candidates.size) break;
  }
  const source = asSourceBytes(dataStore.source);
  const imageUris = new Map<number, string>();
  const needsGraph = live.size !== candidates.size;
  const imageRecords = function* () {
    for (const id of index.byType.get('IFCIMAGETEXTURE') ?? []) {
      const record = index.get(id); if (record) yield [id, record] as const;
    }
  };
  // Non-candidates are roots. Visit candidates only after a live reference
  // reaches them: unreachable history UV arrays need neither serialization nor
  // recursive validation to prove that no surviving entity can refer to them.
  const graphRecords = function* () {
    for (const entry of index) if (!candidates.has(entry[0])) yield entry;
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const id = pending[cursor], record = index.get(id);
      if (record) yield [id, record] as const;
    }
  };
  let sourceBytes = 0, sourceHashes = 0, emittedBytes = 0, emittedHashes = 0;
  for (const [entityId, record] of needsGraph ? graphRecords() : imageRecords()) {
    account();
    inspect(view.getNewEntity(entityId)?.attributes);
    for (const value of view.getPositionalMutationsForEntity(entityId)?.values() ?? []) inspect(value);
    for (const attribute of view.getAttributeMutationsForEntity(entityId)) inspect(attribute.value);
    const isImage = index.typeOf(entityId) === 'IFCIMAGETEXTURE';
    let bytes: Uint8Array;
    if (index.isOverlayCreated(entityId)) {
      const line = effectiveAppearanceRecord(dataStore, view, index, entityId);
      bytes = new TextEncoder().encode(line);
      if (isImage) { const uri = effectiveImageUri(line); if (uri !== undefined) imageUris.set(entityId, uri); }
    } else {
      sourceBytes += record.byteLength;
      if (sourceBytes > 128 * 1024 * 1024) throw new Error('Authored appearance cleanup exceeds its source byte budget; resources were retained.');
      bytes = source.slice(record.byteOffset, record.byteOffset + record.byteLength);
      if (bytes.length !== record.byteLength) throw new Error('Incomplete IFC source during appearance cleanup; resources were retained.');
      // Even an originally dangling source reference may name a later allocated ID.
      // Account before the canonical writer/scanner allocates output arrays.
      for (const byte of bytes) if (byte === 35 && ++sourceHashes > 2_000_000) {
        throw new Error('Authored appearance cleanup exceeds its reference budget; resources were retained.');
      }
      if (isImage || index.hasSourceMutation?.(entityId) || view.getEntityTypeMutation(entityId)) {
        const line = effectiveAppearanceRecord(dataStore, view, index, entityId);
        bytes = new TextEncoder().encode(line);
        if (isImage) { const uri = effectiveImageUri(line); if (uri !== undefined) imageUris.set(entityId, uri); }
      }
    }
    emittedBytes += bytes.length;
    if (emittedBytes > 128 * 1024 * 1024) throw new Error('Authored appearance cleanup exceeds its emitted byte budget; resources were retained.');
    if (needsGraph) for (const byte of bytes) if (byte === 35 && ++emittedHashes > 2_000_000) {
      throw new Error('Authored appearance cleanup exceeds its reference budget; resources were retained.');
    }
    const groups = needsGraph ? collectRefsInByteRange(bytes, 0, bytes.length) : [];
    for (const group of groups) {
      for (const id of typeof group === 'number' ? [group] : group) {
        retain(id);
      }
    }
    // Binding entities are intentionally never deletion candidates: their live
    // inverse link to geometry roots the style/map resources they still name.
    // Keeping an unbound binding is conservative and cannot break other edits.
  }
  const entityIds = new Set([...candidates].filter(id => !live.has(id)));
  return { entityIds, retainedImageUris: new Set([...imageUris].filter(([id]) => !entityIds.has(id)).map(([, uri]) => uri)) };
}
