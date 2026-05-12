/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Filters cut segments based on opening locations
 * Removes wall segments that fall within opening voids
 */

import type {
  CutSegment,
  OpeningRelationships,
  OpeningInfo,
  Point2D,
  Vec3,
  SectionPlaneConfig,
  Bounds2D,
} from '../types.js';
import { projectTo2D, getProjectionAxes } from '../math.js';

/**
 * Filter options for opening handling
 */
export interface OpeningFilterOptions {
  /** Tolerance for point-in-bounds testing (world units) */
  tolerance: number;
  /** Whether to keep segments at opening boundaries */
  keepBoundarySegments: boolean;
}

const DEFAULT_OPTIONS: OpeningFilterOptions = {
  tolerance: 0.001,
  keepBoundarySegments: true,
};

/**
 * Filters cut segments to remove those falling within openings
 */
export class OpeningFilter {
  private relationships: OpeningRelationships;
  private options: OpeningFilterOptions;
  private openingBounds2D: Map<number, Bounds2D> = new Map();

  constructor(
    relationships: OpeningRelationships,
    options: Partial<OpeningFilterOptions> = {}
  ) {
    this.relationships = relationships;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Project opening bounds to 2D for the given section configuration
   */
  projectOpenings(config: SectionPlaneConfig): void {
    this.openingBounds2D.clear();
    const { axis, flipped } = config;

    for (const [id, info] of this.relationships.openingInfo) {
      const bounds2D = this.projectBoundsTo2D(info.bounds3D, axis, flipped);
      this.openingBounds2D.set(id, bounds2D);
    }
  }

  /**
   * Filter segments for a wall/slab element, removing those in openings
   */
  filterSegmentsForHost(
    segments: CutSegment[],
    hostEntityId: number
  ): CutSegment[] {
    const openingIds = this.relationships.voidedBy.get(hostEntityId);
    if (!openingIds || openingIds.length === 0) {
      // No openings in this host, return all segments
      return segments;
    }

    // Get 2D bounds of all openings for this host
    const openingBoundsList: Bounds2D[] = [];
    for (const openingId of openingIds) {
      const bounds = this.openingBounds2D.get(openingId);
      if (bounds) {
        openingBoundsList.push(bounds);
      }
    }

    if (openingBoundsList.length === 0) {
      return segments;
    }

    // Filter segments
    const result: CutSegment[] = [];
    for (const segment of segments) {
      const filtered = this.filterSegment(segment, openingBoundsList);
      result.push(...filtered);
    }

    return result;
  }

  /**
   * Filter a single segment against multiple opening bounds
   * Returns array of segments (may split or return empty)
   */
  private filterSegment(
    segment: CutSegment,
    openingBounds: Bounds2D[]
  ): CutSegment[] {
    const { p0_2d, p1_2d } = segment;

    // Check if segment is completely inside any opening
    for (const bounds of openingBounds) {
      if (
        this.pointInBounds(p0_2d, bounds) &&
        this.pointInBounds(p1_2d, bounds)
      ) {
        // Entire segment is inside opening, remove it
        return [];
      }
    }

    // Check if segment crosses any opening
    for (const bounds of openingBounds) {
      const intersections = this.segmentBoundsIntersections(p0_2d, p1_2d, bounds);

      if (intersections.length > 0) {
        // Segment crosses opening boundary - split it
        return this.splitSegmentAtOpening(segment, bounds, intersections);
      }
    }

    // Segment doesn't intersect any opening
    return [segment];
  }

  /**
   * Split a segment where it intersects an opening
   */
  private splitSegmentAtOpening(
    segment: CutSegment,
    bounds: Bounds2D,
    intersections: number[]
  ): CutSegment[] {
    const result: CutSegment[] = [];
    const { p0_2d, p1_2d } = segment;

    // Sort intersection parameters
    const tValues = [...intersections].sort((a, b) => a - b);

    // Determine which parts are outside the opening
    let lastT = 0;
    for (const t of tValues) {
      // Check if the midpoint of this segment piece is inside the opening
      const midT = (lastT + t) / 2;
      const midPoint = this.lerp2D(p0_2d, p1_2d, midT);

      if (!this.pointInBounds(midPoint, bounds)) {
        // This piece is outside - keep it
        if (t - lastT > this.options.tolerance) {
          result.push(this.createSubSegment(segment, lastT, t));
        }
      }
      lastT = t;
    }

    // Handle final piece (from last intersection to end)
    if (1 - lastT > this.options.tolerance) {
      const midT = (lastT + 1) / 2;
      const midPoint = this.lerp2D(p0_2d, p1_2d, midT);
      if (!this.pointInBounds(midPoint, bounds)) {
        result.push(this.createSubSegment(segment, lastT, 1));
      }
    }

    return result;
  }

  /**
   * Create a sub-segment from t0 to t1 along the original segment
   */
  private createSubSegment(
    segment: CutSegment,
    t0: number,
    t1: number
  ): CutSegment {
    return {
      p0: this.lerp3D(segment.p0, segment.p1, t0),
      p1: this.lerp3D(segment.p0, segment.p1, t1),
      p0_2d: this.lerp2D(segment.p0_2d, segment.p1_2d, t0),
      p1_2d: this.lerp2D(segment.p0_2d, segment.p1_2d, t1),
      entityId: segment.entityId,
      ifcType: segment.ifcType,
      modelIndex: segment.modelIndex,
    };
  }

  /**
   * Find where a 2D segment intersects a bounding box (returns t parameters)
   */
  private segmentBoundsIntersections(
    p0: Point2D,
    p1: Point2D,
    bounds: Bounds2D
  ): number[] {
    const tValues: number[] = [];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const tol = this.options.tolerance;

    // Check intersection with each edge
    // Left edge (x = bounds.min.x)
    if (Math.abs(dx) > tol) {
      const t = (bounds.min.x - p0.x) / dx;
      if (t > tol && t < 1 - tol) {
        const y = p0.y + t * dy;
        if (y >= bounds.min.y - tol && y <= bounds.max.y + tol) {
          tValues.push(t);
        }
      }
    }

    // Right edge (x = bounds.max.x)
    if (Math.abs(dx) > tol) {
      const t = (bounds.max.x - p0.x) / dx;
      if (t > tol && t < 1 - tol) {
        const y = p0.y + t * dy;
        if (y >= bounds.min.y - tol && y <= bounds.max.y + tol) {
          tValues.push(t);
        }
      }
    }

    // Bottom edge (y = bounds.min.y)
    if (Math.abs(dy) > tol) {
      const t = (bounds.min.y - p0.y) / dy;
      if (t > tol && t < 1 - tol) {
        const x = p0.x + t * dx;
        if (x >= bounds.min.x - tol && x <= bounds.max.x + tol) {
          tValues.push(t);
        }
      }
    }

    // Top edge (y = bounds.max.y)
    if (Math.abs(dy) > tol) {
      const t = (bounds.max.y - p0.y) / dy;
      if (t > tol && t < 1 - tol) {
        const x = p0.x + t * dx;
        if (x >= bounds.min.x - tol && x <= bounds.max.x + tol) {
          tValues.push(t);
        }
      }
    }

    return tValues;
  }

  private pointInBounds(p: Point2D, bounds: Bounds2D): boolean {
    const tol = this.options.tolerance;
    return (
      p.x >= bounds.min.x - tol &&
      p.x <= bounds.max.x + tol &&
      p.y >= bounds.min.y - tol &&
      p.y <= bounds.max.y + tol
    );
  }

  private lerp2D(a: Point2D, b: Point2D, t: number): Point2D {
    return {
      x: a.x + t * (b.x - a.x),
      y: a.y + t * (b.y - a.y),
    };
  }

  private lerp3D(a: Vec3, b: Vec3, t: number): Vec3 {
    return {
      x: a.x + t * (b.x - a.x),
      y: a.y + t * (b.y - a.y),
      z: a.z + t * (b.z - a.z),
    };
  }

  private projectBoundsTo2D(
    bounds3D: { min: Vec3; max: Vec3 },
    axis: 'x' | 'y' | 'z',
    flipped: boolean
  ): Bounds2D {
    // Project all 8 corners and find min/max
    const corners3D = [
      { x: bounds3D.min.x, y: bounds3D.min.y, z: bounds3D.min.z },
      { x: bounds3D.max.x, y: bounds3D.min.y, z: bounds3D.min.z },
      { x: bounds3D.min.x, y: bounds3D.max.y, z: bounds3D.min.z },
      { x: bounds3D.max.x, y: bounds3D.max.y, z: bounds3D.min.z },
      { x: bounds3D.min.x, y: bounds3D.min.y, z: bounds3D.max.z },
      { x: bounds3D.max.x, y: bounds3D.min.y, z: bounds3D.max.z },
      { x: bounds3D.min.x, y: bounds3D.max.y, z: bounds3D.max.z },
      { x: bounds3D.max.x, y: bounds3D.max.y, z: bounds3D.max.z },
    ];

    const corners2D = corners3D.map((p) => projectTo2D(p, axis, flipped));

    const xs = corners2D.map((p) => p.x);
    const ys = corners2D.map((p) => p.y);

    return {
      min: { x: Math.min(...xs), y: Math.min(...ys) },
      max: { x: Math.max(...xs), y: Math.max(...ys) },
    };
  }

  /**
   * Get the 2D bounds of an opening
   */
  getOpeningBounds2D(openingId: number): Bounds2D | undefined {
    return this.openingBounds2D.get(openingId);
  }

  /**
   * Get all opening bounds for a host element
   */
  getHostOpeningBounds(hostEntityId: number): Bounds2D[] {
    const openingIds = this.relationships.voidedBy.get(hostEntityId);
    if (!openingIds) return [];

    const result: Bounds2D[] = [];
    for (const id of openingIds) {
      const bounds = this.openingBounds2D.get(id);
      if (bounds) {
        result.push(bounds);
      }
    }
    return result;
  }
}
