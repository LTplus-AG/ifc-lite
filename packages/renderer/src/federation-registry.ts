/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { retainedCreationEnd, ModelRangeExtensionRefusedError } from './retained-creation-range.js';
export { ModelRangeExtensionRefusedError } from './retained-creation-range.js';
import { OverlayIdSpaceExhaustedError } from './overlay-id-space-exhausted-error.js';

export interface ModelRange {
  modelId: string;
  offset: number;       // Start of this model's global ID range
  maxExpressId: number; // Highest expressId in this model
  reservedMaxExpressId: number;
  publishedStart: number | null;
}

/** The registry's own record: the public range plus where its overlay headroom ends. */
interface RegisteredRange extends ModelRange {
  /** Last local ID of the overlay headroom; the next model starts right after it. */
  overlayMaxExpressId: number;
  /** Source ownership plus any unused gap before retained creations. */
  ownedEnd: number;
}

export interface GlobalIdLookup {
  modelId: string;
  expressId: number;
}

// Safety limit - warn before approaching 32-bit limit
// WebGPU picking uses r32uint (max 4,294,967,295)
const MAX_SAFE_OFFSET = 2_000_000_000;

// Overlay headroom prevents later model reservations from aliasing authored IDs.
const OVERLAY_ID_HEADROOM = 1_000_000;

/**
 * Central registry for multi-model federation
 * Manages ID offsets and provides O(1) to-global / O(log N) from-global transformations
 */
export class FederationRegistry {
  private modelRanges: Map<string, RegisteredRange> = new Map();
  private sortedRanges: RegisteredRange[] = []; // Sorted by offset for binary search
  private nextOffset: number = 0;
  private rangeListeners = new Set<(modelId?: string) => void>();

  /** Observe ownership and reservation changes (including overlay publication). */
  subscribe(listener: (modelId?: string) => void): () => void {
    this.rangeListeners.add(listener);
    return () => { this.rangeListeners.delete(listener); };
  }

  /** Every listener sees the change; the first failure is rethrown afterwards. */
  private rangesChanged(modelId?: string): void {
    let failure: { error: unknown } | undefined;
    for (const listener of this.rangeListeners) {
      try { listener(modelId); } catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
  }

  /** Capacity at an allocator's next ID; earlier authored IDs may await lazy publication. */
  hasOverlayCapacity(modelId: string, nextLocalId: number, count = 1): boolean {
    const range = this.modelRanges.get(modelId), end = nextLocalId + count - 1;
    return range !== undefined && range.publishedStart !== null && range.maxExpressId >= range.reservedMaxExpressId
      && Number.isSafeInteger(nextLocalId) && nextLocalId > range.maxExpressId
      && Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(end) && end <= this.overlayEnd(range);
  }

  /**
   * Register a new model and get its ID offset
   * Call this BEFORE adding meshes to the scene
   *
   * @param modelId Unique identifier for this model
   * @param maxExpressId Highest expressId in this model (scan meshes first)
   * @returns The offset to add to all expressIds for this model
   */
  registerModel(modelId: string, maxExpressId: number, firstRetainedExpressId = 0): number {
    const retained = firstRetainedExpressId > 0 && firstRetainedExpressId <= maxExpressId ? 0 : firstRetainedExpressId;
    const existing = this.modelRanges.get(modelId);
    if (existing) {
      // Progressive loaders already reserved and published the source. Only a
      // fully published, overlay-free range reserves the gap before retained
      // creations; any other duplicate registration stays a no-op.
      if (retained > existing.ownedEnd + 1 && existing.publishedStart !== null && existing.maxExpressId === existing.ownedEnd) {
        this.extendModel(modelId, existing.reservedMaxExpressId, retained);
      }
      return existing.offset;
    }
    return this.createRange(modelId, maxExpressId, retained, true);
  }

  /** Reserve a fixed local-ID envelope before progressive publication. */
  reserveModel(modelId: string, reservedMaxExpressId: number): number {
    return this.createRange(modelId, reservedMaxExpressId, 0, false);
  }

  private createRange(modelId: string, reservedMaxExpressId: number, firstRetainedExpressId: number, publish: boolean): number {
    // Validate inputs
    if (!modelId || typeof modelId !== 'string') {
      throw new Error(`[FederationRegistry] Invalid modelId: ${modelId}`);
    }
    if (!Number.isSafeInteger(reservedMaxExpressId) || reservedMaxExpressId < 0) {
      throw new Error(`[FederationRegistry] Invalid reservedMaxExpressId: ${reservedMaxExpressId} for model ${modelId}`);
    }

    // Check for duplicate registration
    if (this.modelRanges.has(modelId)) {
      const existing = this.modelRanges.get(modelId)!;
      console.warn(`[FederationRegistry] Model ${modelId} already registered with offset ${existing.offset}`);
      return existing.offset;
    }

    // Check for overflow
    if (this.nextOffset + reservedMaxExpressId > MAX_SAFE_OFFSET) {
      throw new Error(
        `[FederationRegistry] Cannot register model: would exceed safe ID limit. ` +
        `Current offset: ${this.nextOffset}, reserved model max ID: ${reservedMaxExpressId}. ` +
        `Please unload some models first.`
      );
    }

    const offset = this.nextOffset;
    const overlayMaxExpressId = reservedMaxExpressId + OVERLAY_ID_HEADROOM;
    // A conflicting retained overlay must not prevent source/geometry loading.
    // The viewer keeps those edits quarantined until the user discards them.
    const ownedEnd = retainedCreationEnd(reservedMaxExpressId, reservedMaxExpressId,
      Math.min(overlayMaxExpressId, MAX_SAFE_OFFSET - offset),
      firstRetainedExpressId);
    const range: RegisteredRange = { modelId, offset, maxExpressId: publish ? ownedEnd : -1,
      reservedMaxExpressId, overlayMaxExpressId, ownedEnd, publishedStart: publish ? 0 : null };

    this.modelRanges.set(modelId, range);
    this.sortedRanges.push(range);
    // Keep sorted by offset for binary search
    this.sortedRanges.sort((a, b) => a.offset - b.offset);

    // Next model starts after this model's range (+1 gap for safety), plus
    // reserved headroom for mutation-overlay ids allocated into this model's
    // own space after load (see OVERLAY_ID_HEADROOM above).
    this.nextOffset = offset + overlayMaxExpressId + 1;

    this.rangesChanged(modelId);
    return offset;
  }

  /** Grow source ownership without moving its offset. Retained creations may
   * reserve an unused gap, but cannot overlap source IDs. Capacity clamps the
   * source and gap without refusing hydration. Published overlays still refuse. */
  extendModel(modelId: string, maxExpressId: number, firstRetainedExpressId = 0): number {
    const range = this.modelRanges.get(modelId);
    if (!range) throw new ModelRangeExtensionRefusedError(`[FederationRegistry] Cannot extend unknown model ${modelId}`);
    if (!Number.isInteger(maxExpressId) || maxExpressId < 0) {
      throw new ModelRangeExtensionRefusedError(`[FederationRegistry] Invalid maxExpressId: ${maxExpressId} for model ${modelId}`);
    }
    if (range.publishedStart === null || range.maxExpressId !== range.ownedEnd) {
      throw new ModelRangeExtensionRefusedError(`[FederationRegistry] Cannot extend ${modelId}: its range is partly published or already carries overlay IDs`);
    }
    const sourceEnd = Math.max(maxExpressId, range.reservedMaxExpressId);
    const newest = this.nextOffset === range.offset + range.overlayMaxExpressId + 1;
    const overlayEnd = Math.min(newest ? sourceEnd + OVERLAY_ID_HEADROOM : range.overlayMaxExpressId, MAX_SAFE_OFFSET - range.offset);
    const boundedSourceEnd = Math.min(sourceEnd, overlayEnd);
    const gapEnd = retainedCreationEnd(sourceEnd, boundedSourceEnd, overlayEnd, firstRetainedExpressId);
    const previous = { ...range };
    let end = sourceEnd;
    if (newest) {
      if (range.offset + maxExpressId > MAX_SAFE_OFFSET) {
        throw new ModelRangeExtensionRefusedError(`[FederationRegistry] Cannot extend ${modelId} to ${maxExpressId}: would exceed safe ID limit`);
      }
      range.overlayMaxExpressId = end + OVERLAY_ID_HEADROOM;
      this.nextOffset = range.offset + range.overlayMaxExpressId + 1;
    } else {
      end = Math.min(end, range.overlayMaxExpressId);
    }
    range.reservedMaxExpressId = end;
    range.ownedEnd = Math.max(range.ownedEnd, gapEnd);
    range.maxExpressId = range.ownedEnd;
    if (range.reservedMaxExpressId !== previous.reservedMaxExpressId || range.ownedEnd !== previous.ownedEnd
      || range.overlayMaxExpressId !== previous.overlayMaxExpressId) {
      try { this.rangesChanged(modelId); }
      catch (cause) {
        // A listener may itself refuse a reentrant extension. The outer
        // extension has committed, so its error must never look pre-change.
        throw new Error('[FederationRegistry] Range notification failed after ownership changed', { cause });
      }
    }
    return range.maxExpressId;
  }

  /** Publish the next contiguous owned local range inside a reservation. */
  publishRange(modelId: string, start: number, end: number): void {
    const range = this.modelRanges.get(modelId);
    if (!range) throw new Error(`[FederationRegistry] Cannot publish unknown model ${modelId}`);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > range.reservedMaxExpressId) {
      throw new Error(`[FederationRegistry] Invalid published range ${start}..${end} for ${modelId}`);
    }
    if (range.publishedStart === null) {
      range.publishedStart = start;
    } else if (start !== range.maxExpressId + 1) {
      throw new Error(`[FederationRegistry] Published IDs for ${modelId} must be contiguous and source ordered`);
    }
    range.maxExpressId = end === range.reservedMaxExpressId ? range.ownedEnd : end;
    this.rangesChanged(modelId);
  }

  /** Whether this exact next allocation batch can extend published overlay ownership. */
  canPublishOverlayFrom(modelId: string, firstLocalId: number, count = 1): boolean {
    return this.hasOverlayCapacity(modelId, firstLocalId, count)
      && firstLocalId === this.modelRanges.get(modelId)!.maxExpressId + 1;
  }

  private overlayEnd(range: RegisteredRange): number {
    return Math.min(range.overlayMaxExpressId, MAX_SAFE_OFFSET - range.offset);
  }

  private assertOverlayRange(modelId: string, start: number, end: number): RegisteredRange {
    const range = this.modelRanges.get(modelId);
    if (!range) throw new Error(`[FederationRegistry] Cannot publish unknown model ${modelId}`);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start
      || start <= range.reservedMaxExpressId || range.publishedStart === null || range.maxExpressId < range.reservedMaxExpressId) {
      throw new Error(`[FederationRegistry] Invalid overlay range ${start}..${end} for ${modelId}`);
    }
    if (start !== range.maxExpressId + 1) {
      throw new Error(`[FederationRegistry] Overlay IDs for ${modelId} must extend published ownership contiguously`);
    }
    if (end > this.overlayEnd(range)) throw new OverlayIdSpaceExhaustedError();
    return range;
  }

  /** Publish derived/overlay IDs from the separately reserved headroom. */
  publishOverlayRange(modelId: string, start: number, end: number): void {
    const range = this.assertOverlayRange(modelId, start, end);
    range.maxExpressId = end;
    this.rangesChanged(modelId);
  }

  /**
   * Resolve an owned overlay range while it is still detached from its
   * mutation transaction. This validates the exact range that will be
   * publishable, but deliberately does not make it pickable or owned yet.
   * Callers must publish it only after the backing records commit.
   */
  previewOverlayGlobalId(modelId: string, start: number, end: number, expressId: number): number {
    const range = this.assertOverlayRange(modelId, start, end);
    if (!Number.isSafeInteger(expressId) || expressId < start || expressId > end) {
      throw new Error(`[FederationRegistry] Invalid overlay preview ${start}..${end} for ${modelId}`);
    }
    return range.offset + expressId;
  }

  /**
   * Unregister a model (when removed from viewer)
   * Note: The offset space is NOT reclaimed to avoid invalidating any
   * existing references (selections, undo stack, etc.)
   */
  unregisterModel(modelId: string): void {
    const range = this.modelRanges.get(modelId);
    if (!range) {
      console.warn(`[FederationRegistry] Cannot unregister unknown model: ${modelId}`);
      return;
    }

    this.modelRanges.delete(modelId);
    this.sortedRanges = this.sortedRanges.filter(r => r.modelId !== modelId);
    this.rangesChanged(modelId);
    // Note: nextOffset is NOT reduced - offset space is burned
  }

  /**
   * Transform a local expressId to a globally unique ID
   * O(1) - direct map lookup + addition
   */
  toGlobalId(modelId: string, expressId: number): number {
    const range = this.modelRanges.get(modelId);
    if (!range) {
      return expressId;
    }
    if (!this.isPublished(range, expressId)) {
      throw new Error(`[FederationRegistry] Local ID ${expressId} is not published for model ${modelId}`);
    }
    return expressId + range.offset;
  }

  /**
   * Transform a global ID back to model + local expressId
   * O(log N) - binary search on sorted ranges
   */
  fromGlobalId(globalId: number): GlobalIdLookup | null {
    if (this.sortedRanges.length === 0) {
      return null;
    }

    // Binary search to find which range contains this globalId
    const range = this.binarySearchRange(globalId);
    if (!range) {
      return null;
    }

    // Verify the globalId is actually within this model's range
    const localId = globalId - range.offset;
    if (!this.isPublished(range, localId)) {
      // globalId is in the gap between models
      return null;
    }

    return {
      modelId: range.modelId,
      expressId: localId,
    };
  }

  /**
   * Get the model ID that owns a global ID (without computing expressId)
   * O(log N)
   */
  getModelForGlobalId(globalId: number): string | null {
    const result = this.fromGlobalId(globalId);
    return result?.modelId ?? null;
  }

  /** Get the offset for a model (useful for batch transformations) */
  getOffset(modelId: string): number | null {
    return this.modelRanges.get(modelId)?.offset ?? null;
  }

  /** Check if a model is registered */
  hasModel(modelId: string): boolean {
    return this.modelRanges.has(modelId);
  }

  /** Get all registered model IDs */
  getModelIds(): string[] {
    return Array.from(this.modelRanges.keys());
  }

  /** Get the number of registered models */
  getModelCount(): number {
    return this.modelRanges.size;
  }

  /**
   * Get all global IDs for a model (as a range)
   * Useful for bulk operations like "hide all entities in model X"
   */
  getGlobalIdRange(modelId: string): { start: number; end: number } | null {
    const range = this.modelRanges.get(modelId);
    if (!range) return null;
    if (range.publishedStart === null) return null;
    return {
      start: range.offset + range.publishedStart,
      end: range.offset + range.maxExpressId,
    };
  }

  /**
   * Check if a global ID belongs to a specific model
   * O(1) when we know the model
   */
  isInModel(globalId: number, modelId: string): boolean {
    const range = this.modelRanges.get(modelId);
    if (!range) return false;
    const localId = globalId - range.offset;
    return this.isPublished(range, localId);
  }

  /** Clear all registrations (for full reset) */
  clear(): void {
    this.modelRanges.clear();
    this.sortedRanges = [];
    this.nextOffset = 0;
    this.rangesChanged();
  }

  private isPublished(range: RegisteredRange, localId: number): boolean {
    return range.publishedStart !== null
      && Number.isInteger(localId)
      && localId >= range.publishedStart
      && localId <= range.maxExpressId;
  }

  /**
   * Binary search to find the range that could contain a globalId
   * Returns the range with the largest offset that is <= globalId
   */
  private binarySearchRange(globalId: number): RegisteredRange | null {
    const ranges = this.sortedRanges;
    if (ranges.length === 0) return null;

    // If globalId is before first range, no match
    if (globalId < ranges[0].offset) return null;

    let lo = 0;
    let hi = ranges.length - 1;

    // Find the rightmost range where offset <= globalId
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (ranges[mid].offset <= globalId) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    return ranges[lo];
  }
}

// Singleton instance for the application
export const federationRegistry = new FederationRegistry();
