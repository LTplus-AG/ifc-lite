/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * FederationRegistry - Bulletproof multi-model ID management
 *
 * Each model gets a unique ID offset, ensuring globally unique IDs across
 * all federated models. This eliminates ID collisions when multiple IFC
 * files have overlapping expressIds.
 *
 * Inspired by HOOPS Communicator's loadSubtree approach where node IDs
 * are automatically offset to avoid conflicts.
 */

export interface ModelRange {
  modelId: string;
  offset: number;       // Start of this model's global ID range
  maxExpressId: number; // Highest expressId in this model
}

export interface GlobalIdLookup {
  modelId: string;
  expressId: number;
}

// Safety limit - warn before approaching 32-bit limit
// WebGPU picking uses r32uint (max 4,294,967,295)
const MAX_SAFE_OFFSET = 2_000_000_000;

/**
 * Central registry for multi-model federation
 * Manages ID offsets and provides O(1) to-global / O(log N) from-global transformations
 */
export class FederationRegistry {
  private modelRanges: Map<string, ModelRange> = new Map();
  private sortedRanges: ModelRange[] = []; // Sorted by offset for binary search
  private nextOffset: number = 0;

  /**
   * Register a new model and get its ID offset
   * Call this BEFORE adding meshes to the scene
   *
   * @param modelId Unique identifier for this model
   * @param maxExpressId Highest expressId in this model (scan meshes first)
   * @returns The offset to add to all expressIds for this model
   */
  registerModel(modelId: string, maxExpressId: number): number {
    // Validate inputs
    if (!modelId || typeof modelId !== 'string') {
      throw new Error(`[FederationRegistry] Invalid modelId: ${modelId}`);
    }
    if (typeof maxExpressId !== 'number' || !Number.isFinite(maxExpressId) || maxExpressId < 0) {
      throw new Error(`[FederationRegistry] Invalid maxExpressId: ${maxExpressId} for model ${modelId}`);
    }

    // Check for duplicate registration
    if (this.modelRanges.has(modelId)) {
      const existing = this.modelRanges.get(modelId)!;
      console.warn(`[FederationRegistry] Model ${modelId} already registered with offset ${existing.offset}`);
      return existing.offset;
    }

    // Check for overflow
    if (this.nextOffset + maxExpressId > MAX_SAFE_OFFSET) {
      throw new Error(
        `[FederationRegistry] Cannot register model: would exceed safe ID limit. ` +
        `Current offset: ${this.nextOffset}, model max ID: ${maxExpressId}. ` +
        `Please unload some models first.`
      );
    }

    const offset = this.nextOffset;
    const range: ModelRange = { modelId, offset, maxExpressId };

    this.modelRanges.set(modelId, range);
    this.sortedRanges.push(range);
    // Keep sorted by offset for binary search
    this.sortedRanges.sort((a, b) => a.offset - b.offset);

    // Next model starts after this model's range (+1 gap for safety)
    this.nextOffset = offset + maxExpressId + 1;

    return offset;
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
    if (localId < 0 || localId > range.maxExpressId) {
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

  /**
   * Get the offset for a model (useful for batch transformations)
   */
  getOffset(modelId: string): number | null {
    return this.modelRanges.get(modelId)?.offset ?? null;
  }

  /**
   * Check if a model is registered
   */
  hasModel(modelId: string): boolean {
    return this.modelRanges.has(modelId);
  }

  /**
   * Get all registered model IDs
   */
  getModelIds(): string[] {
    return Array.from(this.modelRanges.keys());
  }

  /**
   * Get the number of registered models
   */
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
    return {
      start: range.offset,
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
    return localId >= 0 && localId <= range.maxExpressId;
  }

  /**
   * Clear all registrations (for full reset)
   */
  clear(): void {
    this.modelRanges.clear();
    this.sortedRanges = [];
    this.nextOffset = 0;
  }

  /**
   * Binary search to find the range that could contain a globalId
   * Returns the range with the largest offset that is <= globalId
   */
  private binarySearchRange(globalId: number): ModelRange | null {
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
// Export both the class (for testing) and a singleton instance
export const federationRegistry = new FederationRegistry();
