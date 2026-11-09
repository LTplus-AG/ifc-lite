/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { MutablePropertyView } from './mutable-property-view.js';
import { cooperativeOverlay } from './cooperative-overlay-access.js';
import { withoutEntityExposure } from './entity-read-barrier.js';
import { encodeNonFiniteNumbers, decodeNonFiniteNumbers } from './nonfinite-json.js';
import { restoreRows, snapshotRows } from './overlay-snapshot-state.js';
import { record, validateSnapshot, validateJsonGraph, validateHistory } from './overlay-snapshot-validate.js';
import type { OverlayRestoreOptions, OverlayRestoreResult, OverlaySnapshotOptions, OverlaySnapshotV1 } from './overlay-snapshot-types.js';

export class OverlaySourceMismatchError extends Error {
  constructor() { super('Overlay snapshot source-content hash does not match the target source.'); this.name = 'OverlaySourceMismatchError'; }
}
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
function requireHash(hash: string): void { if (typeof hash !== 'string' || !/^(?:[a-z0-9-]+:)?[a-f0-9]{64,}$/i.test(hash)) throw new TypeError('A full source-content hash is required.'); }

/** Serialize current effective rows AND the journal, including skip-history edits.
 * The caller supplies a digest of every source byte; this package cannot verify
 * the digest's coverage because it does not own the source buffer. */
export function snapshotOverlay(view: MutablePropertyView, options: OverlaySnapshotOptions): string {
  requireHash(options.sourceContentHash);
  return withoutEntityExposure(() => {
    const state = cooperativeOverlay(view).capture();
    const dto: OverlaySnapshotV1 = {
      format: 'ifc-lite/overlay-snapshot', version: 1,
      source: { contentHash: options.sourceContentHash, ...(options.schema === undefined ? {} : { schema: options.schema }) },
      createdAt: new Date().toISOString(), nextExpressId: state.nextAllocatedId + 1,
      state: snapshotRows(state), journal: state.mutationHistory,
      ...(options.history === undefined ? {} : { history: options.history }),
    };
    validateJsonGraph(dto);
    return JSON.stringify(dto, function(this: unknown, _key: string, value: unknown): unknown {
      if (Array.isArray(this) && value === undefined) throw new TypeError('Undefined array entries cannot be snapshotted.');
      if (typeof value === 'number' && Object.is(value, -0)) return { __nonFiniteNumber: '-0' };
      return encodeNonFiniteNumbers('value', value);
    });
  });
}

/** Restore from bounded JSON, validating everything on detached state before one
 * publication. Base tables/extractors stay attached to the destination view. */
export function restoreOverlay(view: MutablePropertyView, json: string, options: OverlayRestoreOptions): OverlayRestoreResult {
  requireHash(options.sourceContentHash);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('Invalid overlay snapshot byte limit.');
  if (typeof json !== 'string') throw new TypeError('Overlay restore expects serialized JSON.');
  if (json.length > maxBytes || new TextEncoder().encode(json).byteLength > maxBytes) throw new RangeError('Overlay snapshot exceeds the byte limit.');
  const parsed: unknown = JSON.parse(json, (_key: string, value: unknown): unknown => {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && record(value).__nonFiniteNumber === '-0') return -0;
    return decodeNonFiniteNumbers('value', value);
  });
  validateSnapshot(parsed);
  requireHash(parsed.source.contentHash);
  if (parsed.source.contentHash !== options.sourceContentHash) throw new OverlaySourceMismatchError();
  const access = cooperativeOverlay(view), original = access.capture();
  const occupied = original.mutationHistory.length > 0 || Object.values(original).some(value => value instanceof Map || value instanceof Set ? value.size > 0 : false);
  if (occupied && !options.replace) throw new Error('Restore requires an empty overlay; pass replace: true to replace its edits.');
  const result: OverlayRestoreResult = {};
  if (parsed.history !== undefined) {
    try { result.history = validateHistory(parsed.history, parsed); }
    catch (error) { result.historyDroppedReason = error instanceof Error ? error.message : String(error); }
  }
  const empty = cooperativeOverlay(new MutablePropertyView(null, access.modelId)).capture();
  empty.nextAllocatedId = original.nextAllocatedId;
  const restored = access.rebuild(restoreRows(parsed, empty));
  access.publish(restored);
  return result;
}
