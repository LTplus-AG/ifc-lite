/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinate Handler - handles large coordinate systems by shifting to origin
 * 
 * AEC models often use real-world coordinates (UTM, survey coordinates) with
 * values like X: 500,000m, Y: 5,000,000m. This causes float precision issues.
 * 
 * Solution: Shift model to local origin (centroid) while preserving original
 * coordinates for export/queries.
 */

import type { MeshData } from './types.js';

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export interface AABB {
    min: Vec3;
    max: Vec3;
}

export interface CoordinateInfo {
    originShift: Vec3;
    originalBounds: AABB;
    shiftedBounds: AABB;
    /** True if model had large coordinates requiring RTC shift. NOT the same as proper georeferencing via IfcMapConversion. */
    hasLargeCoordinates: boolean;
    /** RTC offset applied by WASM in IFC coordinates (Z-up). Used for multi-model alignment. */
    wasmRtcOffset?: Vec3;
    /** Building rotation angle in radians (from IfcSite placement). Rotation of building's principal axes relative to world X/Y/Z. */
    buildingRotation?: number;
    /**
     * Length-unit scale (file units → metres) resolved from IfcProject's unit
     * assignment, e.g. `0.001` for millimetre files. Lets a consumer transform
     * externally-resolved geometry (grids, survey points) into the render frame
     * without re-parsing units. See issue #945.
     */
    lengthUnitScale?: number;
}

export class CoordinateHandler {
    private originShift: Vec3 = { x: 0, y: 0, z: 0 };
    private readonly THRESHOLD = 10000; // 10km - threshold for large coordinates
    // Maximum reasonable coordinate - 10,000 km covers any georeferenced building on Earth
    // Values beyond this are garbage/corrupted data (safety net)
    private readonly MAX_REASONABLE_COORD = 1e7;

    // For incremental processing
    private accumulatedBounds: AABB | null = null;
    private shiftCalculated: boolean = false;

    // WASM RTC detection - if WASM already applied RTC, skip TypeScript shift
    private wasmRtcDetected: boolean = false;
    // Threshold for "normal" coordinates when WASM RTC is active (10km = reasonable campus/site size)
    private readonly NORMAL_COORD_THRESHOLD = 10000;
    // Active threshold for coordinate validation (set based on wasmRtcDetected)
    private activeThreshold: number = 1e7;

    // World→render metadata supplied by the WASM pre-pass (issue #945). These
    // are reported on CoordinateInfo so external viewers can map externally-
    // resolved geometry (grids, survey points) into the render frame.
    //
    // `wasmRtcOffset` is the RTC offset (IFC Z-up, metres) the WASM mesh path
    // actually subtracted — `null` when no shift was applied (model within 10km
    // of origin). Mirrors the value the viewer captures from the `rtcOffset`
    // streaming event, but populated here so it's present without viewer-side
    // patching. `lengthUnitScale` is the file-units→metres factor.
    private appliedWasmRtcOffset: Vec3 | null = null;
    private lengthUnitScale: number | undefined = undefined;

    /**
     * Check if a coordinate value is reasonable (not corrupted garbage)
     */
    private isReasonableValue(value: number): boolean {
        return Number.isFinite(value) && Math.abs(value) < this.MAX_REASONABLE_COORD;
    }

    /**
     * Calculate bounding box from all meshes (filtering out corrupted values)
     * @param meshes - Meshes to calculate bounds from
     * @param maxCoord - Optional max coordinate threshold (default: MAX_REASONABLE_COORD).
     *   NOTE: Ignored when WASM RTC is active — coordinates are already guaranteed
     *   small and valid by the WASM layer, so the fast sampling path is used instead.
     */
    calculateBounds(meshes: MeshData[], maxCoord?: number): AABB {
        // PERF: When WASM RTC is detected, coordinates are already small and valid.
        // Skip per-vertex Number.isFinite + Math.abs checks (saves ~6 calls per vertex
        // across 63.5M vertices = ~380M function calls avoided).
        // maxCoord is intentionally unused here — WASM RTC guarantees valid bounds.
        if (this.wasmRtcDetected && this.shiftCalculated) {
            return this.calculateBoundsFast(meshes);
        }

        const bounds: AABB = {
            min: { x: Infinity, y: Infinity, z: Infinity },
            max: { x: -Infinity, y: -Infinity, z: -Infinity },
        };

        const threshold = maxCoord ?? this.MAX_REASONABLE_COORD;
        let validVertexCount = 0;
        let corruptedVertexCount = 0;

        for (const mesh of meshes) {
            const positions = mesh.positions;
            for (let i = 0; i < positions.length; i += 3) {
                const x = positions[i];
                const y = positions[i + 1];
                const z = positions[i + 2];

                // Only include values within threshold (filter out outliers/garbage)
                const coordsFinite = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
                const withinThreshold = coordsFinite &&
                    Math.abs(x) < threshold && Math.abs(y) < threshold && Math.abs(z) < threshold;

                if (withinThreshold) {
                    bounds.min.x = Math.min(bounds.min.x, x);
                    bounds.min.y = Math.min(bounds.min.y, y);
                    bounds.min.z = Math.min(bounds.min.z, z);
                    bounds.max.x = Math.max(bounds.max.x, x);
                    bounds.max.y = Math.max(bounds.max.y, y);
                    bounds.max.z = Math.max(bounds.max.z, z);
                    validVertexCount++;
                } else {
                    corruptedVertexCount++;
                }
            }
        }

        if (corruptedVertexCount > 0) {
            // Corrupted vertices filtered during bounds calculation
        }

        return bounds;
    }

    /**
     * Fast bounds calculation using vertex sampling.
     * Used when WASM RTC is confirmed — coordinates are small and valid.
     * Samples first and last vertex of each mesh instead of scanning all vertices.
     * For 208K meshes this is ~416K vertex checks vs 63.5M = ~150x faster.
     * Accuracy is excellent because meshes are localized objects.
     */
    private calculateBoundsFast(meshes: MeshData[]): AABB {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const mesh of meshes) {
            const positions = mesh.positions;
            const len = positions.length;
            if (len < 3) continue;

            // Sample first vertex
            const x0 = positions[0];
            const y0 = positions[1];
            const z0 = positions[2];
            if (x0 < minX) minX = x0;
            if (y0 < minY) minY = y0;
            if (z0 < minZ) minZ = z0;
            if (x0 > maxX) maxX = x0;
            if (y0 > maxY) maxY = y0;
            if (z0 > maxZ) maxZ = z0;

            // Sample last vertex (if different from first)
            if (len >= 6) {
                const x1 = positions[len - 3];
                const y1 = positions[len - 2];
                const z1 = positions[len - 1];
                if (x1 < minX) minX = x1;
                if (y1 < minY) minY = y1;
                if (z1 < minZ) minZ = z1;
                if (x1 > maxX) maxX = x1;
                if (y1 > maxY) maxY = y1;
                if (z1 > maxZ) maxZ = z1;
            }
        }

        return {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
        };
    }

    /**
     * Check if coordinate shift is needed
     */
    needsShift(bounds: AABB): boolean {
        const maxCoord = Math.max(
            Math.abs(bounds.min.x), Math.abs(bounds.max.x),
            Math.abs(bounds.min.y), Math.abs(bounds.max.y),
            Math.abs(bounds.min.z), Math.abs(bounds.max.z)
        );

        return maxCoord > this.THRESHOLD;
    }

    /**
     * Calculate centroid (center point) from bounds
     */
    calculateCentroid(bounds: AABB): Vec3 {
        return {
            x: (bounds.min.x + bounds.max.x) / 2,
            y: (bounds.min.y + bounds.max.y) / 2,
            z: (bounds.min.z + bounds.max.z) / 2,
        };
    }

    /**
     * Shift positions in-place by subtracting origin shift
     * Corrupted values are set to 0 (center of shifted coordinate system)
     * @param positions - Position array to modify
     * @param shift - Origin shift to subtract
     * @param threshold - Optional threshold for valid coordinates (defaults to MAX_REASONABLE_COORD)
     */
    shiftPositions(positions: Float32Array, shift: Vec3, threshold?: number): void {
        const maxCoord = threshold ?? this.MAX_REASONABLE_COORD;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i];
            const y = positions[i + 1];
            const z = positions[i + 2];

            // For corrupted/outlier values, set to center (0) in shifted space
            const coordsValid = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
                Math.abs(x) < maxCoord && Math.abs(y) < maxCoord && Math.abs(z) < maxCoord;

            if (coordsValid) {
                positions[i] = x - shift.x;
                positions[i + 1] = y - shift.y;
                positions[i + 2] = z - shift.z;
            } else {
                // Corrupted/outlier vertex - set to origin to avoid visual artifacts
                positions[i] = 0;
                positions[i + 1] = 0;
                positions[i + 2] = 0;
            }
        }
    }

    /**
     * Shift bounds by subtracting origin shift
     */
    shiftBounds(bounds: AABB, shift: Vec3): AABB {
        return {
            min: {
                x: bounds.min.x - shift.x,
                y: bounds.min.y - shift.y,
                z: bounds.min.z - shift.z,
            },
            max: {
                x: bounds.max.x - shift.x,
                y: bounds.max.y - shift.y,
                z: bounds.max.z - shift.z,
            },
        };
    }

    /**
     * Process meshes: detect large coordinates and shift if needed
     */
    processMeshes(meshes: MeshData[]): CoordinateInfo {
        const emptyResult: CoordinateInfo = {
            originShift: { x: 0, y: 0, z: 0 },
            originalBounds: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 },
            },
            shiftedBounds: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 },
            },
            hasLargeCoordinates: false,
        };

        if (meshes.length === 0) {
            return emptyResult;
        }

        // Calculate original bounds (filtering corrupted values)
        const originalBounds = this.calculateBounds(meshes);

        // Check if we got valid bounds
        const hasValidBounds =
            originalBounds.min.x !== Infinity && originalBounds.max.x !== -Infinity;

        if (!hasValidBounds) {
            console.warn('[CoordinateHandler] No valid coordinates found in geometry');
            return emptyResult;
        }

        const size = {
            x: originalBounds.max.x - originalBounds.min.x,
            y: originalBounds.max.y - originalBounds.min.y,
            z: originalBounds.max.z - originalBounds.min.z,
        };
        const maxSize = Math.max(size.x, size.y, size.z);

        // Check if shift is needed (>10km from origin)
        const needsShift = this.needsShift(originalBounds);

        if (!needsShift) {
            // No shift needed - just clean up corrupted values in-place
            // Still shift by 0 to clean up corrupted vertices
            const zeroShift = { x: 0, y: 0, z: 0 };
            for (const mesh of meshes) {
                this.shiftPositions(mesh.positions, zeroShift);
            }
            return {
                originShift: zeroShift,
                originalBounds,
                shiftedBounds: originalBounds,
                hasLargeCoordinates: false,
            };
        }

        // Calculate centroid as origin shift
        const centroid = this.calculateCentroid(originalBounds);
        this.originShift = centroid;

        // Shift all mesh positions
        for (const mesh of meshes) {
            this.shiftPositions(mesh.positions, centroid);
        }

        // Calculate shifted bounds
        const shiftedBounds = this.shiftBounds(originalBounds, centroid);


        return {
            originShift: centroid,
            originalBounds,
            shiftedBounds,
            hasLargeCoordinates: true,
        };
    }

    /**
     * Convert local (shifted) coordinates back to world coordinates
     */
    toWorldCoordinates(localPos: Vec3): Vec3 {
        return {
            x: localPos.x + this.originShift.x,
            y: localPos.y + this.originShift.y,
            z: localPos.z + this.originShift.z,
        };
    }

    /**
     * Convert world coordinates to local (shifted) coordinates
     */
    toLocalCoordinates(worldPos: Vec3): Vec3 {
        return {
            x: worldPos.x - this.originShift.x,
            y: worldPos.y - this.originShift.y,
            z: worldPos.z - this.originShift.z,
        };
    }

    /**
     * Get current origin shift
     */
    getOriginShift(): Vec3 {
        return { ...this.originShift };
    }

    /**
     * Process meshes incrementally for streaming
     * Accumulates bounds and applies shift once calculated
     *
     * IMPORTANT: Detects if WASM already applied RTC offset by checking if
     * majority of meshes have small coordinates. If so, skips TypeScript shift.
     */
    processMeshesIncremental(batch: MeshData[]): void {
        // If WASM RTC was detected, use stricter threshold to exclude outliers
        // Store in instance variable so shiftPositions uses the same threshold
        this.activeThreshold = this.wasmRtcDetected ? this.NORMAL_COORD_THRESHOLD : this.MAX_REASONABLE_COORD;
        const batchBounds = this.calculateBounds(batch, this.activeThreshold);

        if (this.accumulatedBounds === null) {
            this.accumulatedBounds = batchBounds;
        } else {
            // Expand accumulated bounds
            this.accumulatedBounds.min.x = Math.min(this.accumulatedBounds.min.x, batchBounds.min.x);
            this.accumulatedBounds.min.y = Math.min(this.accumulatedBounds.min.y, batchBounds.min.y);
            this.accumulatedBounds.min.z = Math.min(this.accumulatedBounds.min.z, batchBounds.min.z);
            this.accumulatedBounds.max.x = Math.max(this.accumulatedBounds.max.x, batchBounds.max.x);
            this.accumulatedBounds.max.y = Math.max(this.accumulatedBounds.max.y, batchBounds.max.y);
            this.accumulatedBounds.max.z = Math.max(this.accumulatedBounds.max.z, batchBounds.max.z);
        }

        // Calculate shift on first batch if needed
        if (!this.shiftCalculated && this.accumulatedBounds) {
            const hasValidBounds =
                this.accumulatedBounds.min.x !== Infinity &&
                this.accumulatedBounds.max.x !== -Infinity;

            if (hasValidBounds) {
                const size = {
                    x: this.accumulatedBounds.max.x - this.accumulatedBounds.min.x,
                    y: this.accumulatedBounds.max.y - this.accumulatedBounds.min.y,
                    z: this.accumulatedBounds.max.z - this.accumulatedBounds.min.z,
                };
                const maxSize = Math.max(size.x, size.y, size.z);
                const centroid = this.calculateCentroid(this.accumulatedBounds);
                const distanceFromOrigin = Math.sqrt(
                    centroid.x ** 2 + centroid.y ** 2 + centroid.z ** 2
                );

                // DETECT IF WASM ALREADY APPLIED RTC
                // If majority of meshes have small coordinates, WASM already shifted them
                let smallCoordCount = 0;
                let largeCoordCount = 0;
                const SMALL_COORD_THRESHOLD = this.THRESHOLD; // Use same threshold as RTC detection

                for (const mesh of batch) {
                    const positions = mesh.positions;
                    if (positions.length >= 3) {
                        // Check first vertex of each mesh
                        const x = Math.abs(positions[0]);
                        const y = Math.abs(positions[1]);
                        const z = Math.abs(positions[2]);
                        const maxCoord = Math.max(x, y, z);
                        if (maxCoord < SMALL_COORD_THRESHOLD) {
                            smallCoordCount++;
                        } else {
                            largeCoordCount++;
                        }
                    }
                }

                // If >50% have small coords, WASM RTC was likely applied
                const totalMeshes = smallCoordCount + largeCoordCount;
                const wasmRtcLikelyApplied = totalMeshes > 0 && (smallCoordCount / totalMeshes) > 0.5;

                if (wasmRtcLikelyApplied) {
                    this.wasmRtcDetected = true;
                    // Recalculate bounds excluding outliers (use stricter threshold)
                    this.accumulatedBounds = this.calculateBounds(batch, this.NORMAL_COORD_THRESHOLD);
                }

                // Check if shift is needed (>10km from origin) AND WASM didn't already apply RTC
                if ((distanceFromOrigin > this.THRESHOLD || maxSize > this.THRESHOLD) && !wasmRtcLikelyApplied) {
                    this.originShift = centroid;
                }
            }
            this.shiftCalculated = true;
        }

        // Apply shift to this batch (only if we determined shift is needed AND WASM didn't already apply)
        // Use the same threshold for vertex cleanup as was used for bounds calculation
        if (this.originShift.x !== 0 || this.originShift.y !== 0 || this.originShift.z !== 0) {
            for (const mesh of batch) {
                this.shiftPositions(mesh.positions, this.originShift, this.activeThreshold);
            }
        }
    }

    /**
     * Fast incremental path for trusted native batches.
     *
     * Desktop native streaming already emits site-local coordinates, so the JS
     * layer does not need to re-run RTC detection, outlier filtering, or
     * position shifting for every vertex. We only need lightweight bounds
     * accumulation so the viewport can fit the camera while streaming.
     */
    processTrustedMeshesIncremental(batch: MeshData[]): void {
        const batchBounds = this.calculateBoundsFast(batch);
        const hasValidBounds =
            batchBounds.min.x !== Infinity &&
            batchBounds.max.x !== -Infinity;

        if (!hasValidBounds) {
            return;
        }

        if (this.accumulatedBounds === null) {
            this.accumulatedBounds = batchBounds;
        } else {
            this.accumulatedBounds.min.x = Math.min(this.accumulatedBounds.min.x, batchBounds.min.x);
            this.accumulatedBounds.min.y = Math.min(this.accumulatedBounds.min.y, batchBounds.min.y);
            this.accumulatedBounds.min.z = Math.min(this.accumulatedBounds.min.z, batchBounds.min.z);
            this.accumulatedBounds.max.x = Math.max(this.accumulatedBounds.max.x, batchBounds.max.x);
            this.accumulatedBounds.max.y = Math.max(this.accumulatedBounds.max.y, batchBounds.max.y);
            this.accumulatedBounds.max.z = Math.max(this.accumulatedBounds.max.z, batchBounds.max.z);
        }

        this.originShift = { x: 0, y: 0, z: 0 };
        this.wasmRtcDetected = true;
        this.shiftCalculated = true;
        this.activeThreshold = this.NORMAL_COORD_THRESHOLD;
    }

    /**
     * Get current coordinate info (for incremental updates)
     */
    getCurrentCoordinateInfo(): CoordinateInfo | null {
        if (!this.accumulatedBounds) {
            return null;
        }

        const hasValidBounds =
            this.accumulatedBounds.min.x !== Infinity &&
            this.accumulatedBounds.max.x !== -Infinity;

        if (!hasValidBounds) {
            return null;
        }

        const shiftedBounds = this.shiftBounds(this.accumulatedBounds, this.originShift);
        const hasLargeCoordinates =
            this.originShift.x !== 0 ||
            this.originShift.y !== 0 ||
            this.originShift.z !== 0;

        return {
            originShift: { ...this.originShift },
            originalBounds: { ...this.accumulatedBounds },
            shiftedBounds,
            hasLargeCoordinates,
            // Only attach wasmRtcOffset when a shift was actually applied, so
            // `wasmRtcOffset !== undefined` keeps meaning "geometry re-based"
            // for downstream federation / cache consumers.
            ...(this.appliedWasmRtcOffset ? { wasmRtcOffset: { ...this.appliedWasmRtcOffset } } : {}),
            ...(this.lengthUnitScale !== undefined ? { lengthUnitScale: this.lengthUnitScale } : {}),
        };
    }

    /**
     * Get final coordinate info after incremental processing
     */
    getFinalCoordinateInfo(): CoordinateInfo {
        const current = this.getCurrentCoordinateInfo();
        if (current) {
            return current;
        }

        // Fallback to zero bounds if no valid bounds found
        return {
            originShift: { x: 0, y: 0, z: 0 },
            originalBounds: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 },
            },
            shiftedBounds: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 },
            },
            hasLargeCoordinates: false,
            ...(this.appliedWasmRtcOffset ? { wasmRtcOffset: { ...this.appliedWasmRtcOffset } } : {}),
            ...(this.lengthUnitScale !== undefined ? { lengthUnitScale: this.lengthUnitScale } : {}),
        };
    }

    /**
     * Record the world→render metadata the WASM pre-pass resolved for this
     * model (issue #945): the length-unit scale and the RTC offset the mesh
     * path actually subtracted. Pass `rtcOffset: null` when no shift was
     * applied. Surfaced on the returned {@link CoordinateInfo} so external
     * viewers can map externally-resolved geometry into the render frame.
     */
    setWasmMetadata(lengthUnitScale: number | undefined, rtcOffset: Vec3 | null): void {
        this.lengthUnitScale = lengthUnitScale;
        this.appliedWasmRtcOffset = rtcOffset ? { ...rtcOffset } : null;
    }

    /**
     * Reset incremental state (for new file)
     */
    reset(): void {
        this.accumulatedBounds = null;
        this.shiftCalculated = false;
        this.originShift = { x: 0, y: 0, z: 0 };
        this.wasmRtcDetected = false;
        this.activeThreshold = this.MAX_REASONABLE_COORD;
        this.appliedWasmRtcOffset = null;
        this.lengthUnitScale = undefined;
    }
}
