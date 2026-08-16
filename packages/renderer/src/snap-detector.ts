import type { MeshData } from '@ifc-lite/geometry';
import type { Ray, Vec3, Intersection } from './raycaster.js';
import { Raycaster } from './raycaster.js';
import { distance, vecEquals, closestPointOnEdgeWithT, screenToWorldRadius } from './snap-geometry-utils.js';
import { buildGeometryCache, type MeshGeometryCache } from './snap-geometry-cache.js';
import type { SnapEdge } from './snap-edge-runs.js';
import { bestEdgeCandidate, detectCorner, type EdgeCandidate } from './snap-corner.js';

export enum SnapType {
  VERTEX = 'vertex',
  EDGE = 'edge',
  FACE = 'face',
  FACE_CENTER = 'face_center',
  /** A snapped scan point from a point-cloud asset (issue #1860) — never
   *  produced by `SnapDetector` itself; composed in by `RaycastEngine`. */
  POINT_CLOUD = 'point_cloud',
}

export interface SnapTarget {
  type: SnapType;
  position: Vec3;
  normal?: Vec3;
  expressId: number;
  confidence: number; // 0-1, higher is better
  metadata?: {
    vertices?: Vec3[]; // For edges/faces
    edgeIndex?: number;
    faceIndex?: number;
  };
}

export interface SnapOptions {
  snapToVertices: boolean;
  snapToEdges: boolean;
  snapToFaces: boolean;
  snapRadius: number; // In world units
  screenSnapRadius: number; // In pixels
  /**
   * Snap to point-cloud scan points (#1860). Consumed by `RaycastEngine`
   * (SnapDetector itself never produces POINT_CLOUD targets). Optional:
   * when absent, point snapping follows "is any of the mesh snap kinds
   * above enabled", so the viewer's single snap toggle governs scan
   * points too. See `pointCloudSnapEnabled`.
   */
  snapToPointClouds?: boolean;
}

// Edge lock state for magnetic snapping (passed from store)
export interface EdgeLockInput {
  edge: { v0: Vec3; v1: Vec3 } | null;
  meshExpressId: number | null;
  lockStrength: number;
}

// Extended snap result with edge lock info
export interface MagneticSnapResult {
  snapTarget: SnapTarget | null;
  edgeLock: {
    edge: { v0: Vec3; v1: Vec3 } | null;
    meshExpressId: number | null;
    edgeT: number; // Position on edge 0-1
    shouldLock: boolean; // Whether to lock to this edge
    shouldRelease: boolean; // Whether to release current lock
    /**
     * At a corner (vertex where edges meet) - and that corner is one of the
     * locked run's two ENDPOINTS. An interior junction of a merged run never
     * sets this, even though it does produce a VERTEX snap target: the viewer's
     * ring rendering encodes the corner position as `edgeT < 0.5`, which can
     * only name a run end. Junction rings are deferred until that consumer
     * (owned by PR #2641) can carry a corner position.
     */
    isCorner: boolean;
    cornerValence: number; // Number of edge lines at that corner (0 when !isCorner)
  };
}

// Magnetic snapping configuration constants
const MAGNETIC_CONFIG = {
  // Edge attraction zone = base radius × this multiplier
  EDGE_ATTRACTION_MULTIPLIER: 3.0,
  // Corner attraction zone = edge zone × this multiplier
  CORNER_ATTRACTION_MULTIPLIER: 2.0,
  // Confidence boost per connected edge at corner
  CORNER_CONFIDENCE_BOOST: 0.15,
  // Must move perpendicular × this factor to escape locked edge
  EDGE_ESCAPE_MULTIPLIER: 2.5,
  // Corner escape requires even more movement
  CORNER_ESCAPE_MULTIPLIER: 3.5,
  // Lock strength growth per frame while locked
  LOCK_STRENGTH_GROWTH: 0.05,
  // Maximum lock strength
  MAX_LOCK_STRENGTH: 1.5,
};

export class SnapDetector {
  private raycaster = new Raycaster();
  private defaultOptions: SnapOptions = {
    snapToVertices: true,
    snapToEdges: true,
    snapToFaces: true,
    snapRadius: 0.1, // 10cm in world units (meters)
    screenSnapRadius: 20, // pixels
  };

  // Cache for processed mesh geometry (vertices and edges).
  // Invalidated via clearCache(), which is called by Renderer.destroy() and
  // RaycastEngine.clearCaches(). The cache holds WORLD-space geometry, and both
  // keys below stay stable across an in-place geometry edit (a flat mesh's
  // positions or an instanced occurrence's matrix being mutated by
  // translateMeshesForEntity / translateInstancedEntity). So callers must invoke
  // clearCaches() not only on model load/unload but also after any in-place
  // mutation (gizmo move, numeric move, exploded view) — otherwise snap keeps
  // serving the pre-edit geometry. This is identical for flat and instanced
  // meshes; instancing adds no new staleness window.
  //
  // Keyed via cacheKeyFor(): GPU-instanced occurrences use their per-occurrence
  // `occurrenceKey` (issue #1405); flat meshes use a content signature
  // (expressId + origin + buffer sizes + sampled vertices), because one entity
  // is often emitted as several flat sub-pieces sharing an expressId — keying on
  // expressId alone served the first piece's edges/vertices for every later one,
  // so snap lit up on a single piece of a multi-piece element.
  private geometryCache = new Map<string, MeshGeometryCache>();

  /**
   * Detect best snap target near cursor
   */
  detectSnapTarget(
    ray: Ray,
    meshes: MeshData[],
    intersection: Intersection | null,
    camera: { position: Vec3; fov: number },
    screenHeight: number,
    options: Partial<SnapOptions> = {}
  ): SnapTarget | null {
    const opts = { ...this.defaultOptions, ...options };

    if (!intersection) {
      return null;
    }

    const targets: SnapTarget[] = [];

    // Calculate world-space snap radius based on screen-space radius and distance
    const distanceToCamera = distance(camera.position, intersection.point);
    const worldSnapRadius = screenToWorldRadius(
      opts.screenSnapRadius,
      distanceToCamera,
      camera.fov,
      screenHeight
    );

    // Only check the intersected mesh for snap targets (performance optimization)
    // Checking all meshes was causing severe framerate drops with large models
    const intersectedMesh = meshes[intersection.meshIndex];
    if (intersectedMesh) {
      // Detect vertices
      if (opts.snapToVertices) {
        targets.push(...this.findVertices(intersectedMesh, intersection.point, worldSnapRadius));
      }

      // Detect edges
      if (opts.snapToEdges) {
        targets.push(...this.findEdges(intersectedMesh, intersection.point, worldSnapRadius));
      }

      // Detect faces
      if (opts.snapToFaces) {
        targets.push(...this.findFaces(intersectedMesh, intersection, worldSnapRadius));
      }
    }

    // Return best target
    return this.getBestSnapTarget(targets);
  }

  /**
   * Detect snap target with magnetic edge locking behavior
   * This provides the "stick and slide along edges" experience
   */
  detectMagneticSnap(
    ray: Ray,
    meshes: MeshData[],
    intersection: Intersection | null,
    camera: { position: Vec3; fov: number },
    screenHeight: number,
    currentEdgeLock: EdgeLockInput,
    options: Partial<SnapOptions> = {}
  ): MagneticSnapResult {
    const opts = { ...this.defaultOptions, ...options };

    // Default result when no intersection
    if (!intersection) {
      return {
        snapTarget: null,
        edgeLock: {
          edge: null,
          meshExpressId: null,
          edgeT: 0,
          shouldLock: false,
          shouldRelease: true,
          isCorner: false,
          cornerValence: 0,
        },
      };
    }

    const distanceToCamera = distance(camera.position, intersection.point);
    const worldSnapRadius = screenToWorldRadius(
      opts.screenSnapRadius,
      distanceToCamera,
      camera.fov,
      screenHeight
    );

    const intersectedMesh = meshes[intersection.meshIndex];
    if (!intersectedMesh) {
      return {
        snapTarget: null,
        edgeLock: {
          edge: null,
          meshExpressId: null,
          edgeT: 0,
          shouldLock: false,
          shouldRelease: true,
          isCorner: false,
          cornerValence: 0,
        },
      };
    }

    const cache = this.getGeometryCache(intersectedMesh);

    // If edge snapping is disabled, skip edge logic entirely
    if (!opts.snapToEdges) {
      // Just return face/vertex snap as fallback
      const targets: SnapTarget[] = [];
      if (opts.snapToFaces) {
        targets.push(...this.findFaces(intersectedMesh, intersection, worldSnapRadius));
      }
      if (opts.snapToVertices) {
        targets.push(...this.findVertices(intersectedMesh, intersection.point, worldSnapRadius));
      }
      return {
        snapTarget: this.getBestSnapTarget(targets),
        edgeLock: {
          edge: null,
          meshExpressId: null,
          edgeT: 0,
          shouldLock: false,
          shouldRelease: true, // Release any existing lock when edge snapping disabled
          isCorner: false,
          cornerValence: 0,
        },
      };
    }

    // Track whether we're releasing from a previous lock
    let wasLockReleased = false;

    // If we have an active edge lock, try to maintain it
    if (currentEdgeLock.edge && currentEdgeLock.meshExpressId === intersectedMesh.expressId) {
      const lockResult = this.maintainEdgeLock(
        intersection.point,
        currentEdgeLock,
        cache,
        worldSnapRadius,
        intersectedMesh.expressId
      );

      if (!lockResult.edgeLock.shouldRelease) {
        // Still locked - return the sliding position
        return lockResult;
      }
      // Lock was released - continue to find new edges but remember we released
      wasLockReleased = true;
    }

    // No active lock or lock released - find best snap target with magnetic behavior
    const edgeRadius = worldSnapRadius * MAGNETIC_CONFIG.EDGE_ATTRACTION_MULTIPLIER;
    const cornerRadius = edgeRadius * MAGNETIC_CONFIG.CORNER_ATTRACTION_MULTIPLIER;

    // Compute view direction for visibility filtering
    const viewDir = {
      x: intersection.point.x - camera.position.x,
      y: intersection.point.y - camera.position.y,
      z: intersection.point.z - camera.position.z,
    };
    const viewLen = Math.sqrt(viewDir.x * viewDir.x + viewDir.y * viewDir.y + viewDir.z * viewDir.z);
    if (viewLen > 0) {
      viewDir.x /= viewLen;
      viewDir.y /= viewLen;
      viewDir.z /= viewLen;
    }

    // Find all nearby edges (filtered for visibility)
    const nearbyEdges: EdgeCandidate[] = [];

    for (const edge of cache.edges) {
      const result = closestPointOnEdgeWithT(intersection.point, edge.v0, edge.v1);
      if (result.distance < edgeRadius) {
        // Visibility check: edge should be on front-facing side
        // Compute vector from intersection point to edge closest point
        const toEdge = {
          x: result.point.x - intersection.point.x,
          y: result.point.y - intersection.point.y,
          z: result.point.z - intersection.point.z,
        };
        // Check if edge point is roughly on the visible side (dot with normal should be <= small positive)
        // Edges that are clearly behind the surface are filtered out
        const dotWithNormal = toEdge.x * intersection.normal.x + toEdge.y * intersection.normal.y + toEdge.z * intersection.normal.z;

        // Allow edges that are on the surface or slightly in front (tolerance for edge proximity)
        // Filter out edges that are clearly behind the intersected surface
        if (dotWithNormal <= edgeRadius * 0.5) {
          nearbyEdges.push({
            edge,
            closestPoint: result.point,
            distance: result.distance,
            t: result.t,
          });
        }
      }
    }

    // No nearby edges - use best available snap (faces/vertices)
    if (nearbyEdges.length === 0) {
      const candidates: SnapTarget[] = [];
      if (opts.snapToFaces) {
        candidates.push(...this.findFaces(intersectedMesh, intersection, worldSnapRadius));
      }
      if (opts.snapToVertices) {
        candidates.push(...this.findVertices(intersectedMesh, intersection.point, worldSnapRadius));
      }
      return {
        snapTarget: this.getBestSnapTarget(candidates),
        edgeLock: {
          edge: null,
          meshExpressId: null,
          edgeT: 0,
          shouldLock: false,
          shouldRelease: wasLockReleased, // Propagate release signal from maintainEdgeLock
          isCorner: false,
          cornerValence: 0,
        },
      };
    }

    // Pick the closest edge, with a geometric tiebreak: a plain distance sort
    // left equidistant candidates to array order, i.e. to wasm triangle
    // emission order (#2388's failure class).
    const bestEdge = bestEdgeCandidate(nearbyEdges) as EdgeCandidate;

    // Check if we're at a corner (near a run endpoint or an interior junction)
    const cornerInfo = detectCorner(
      bestEdge.edge,
      bestEdge.t,
      cornerRadius,
      intersection.point
    );

    // Determine snap target
    let snapTarget: SnapTarget;

    if (cornerInfo.isCorner && cornerInfo.vertex) {
      // Corner snap - snap to vertex
      const cornerVertex = cornerInfo.vertex;
      snapTarget = {
        type: SnapType.VERTEX,
        position: cornerVertex,
        expressId: intersectedMesh.expressId,
        confidence: Math.min(1, 0.99 + cornerInfo.valence * MAGNETIC_CONFIG.CORNER_CONFIDENCE_BOOST),
        metadata: { vertices: [bestEdge.edge.v0, bestEdge.edge.v1] },
      };
    } else {
      // Edge snap - snap to closest point on edge
      snapTarget = {
        type: SnapType.EDGE,
        position: bestEdge.closestPoint,
        expressId: intersectedMesh.expressId,
        confidence: 0.999 * (1.0 - bestEdge.distance / edgeRadius),
        metadata: { vertices: [bestEdge.edge.v0, bestEdge.edge.v1], edgeIndex: bestEdge.edge.index },
      };
    }

    // `edgeLock.isCorner` is restricted to ENDPOINT corners on purpose: its
    // only consumer encodes the ring position as `edgeT < 0.5`, a start/end
    // boolean that cannot place a mid-run junction (see `CornerInfo.atEndpoint`).
    // The junction keeps its exact vertex snap through `snapTarget` above.
    const cornerAtEnd = cornerInfo.isCorner && cornerInfo.atEndpoint;
    return {
      snapTarget,
      edgeLock: {
        edge: { v0: bestEdge.edge.v0, v1: bestEdge.edge.v1 },
        meshExpressId: intersectedMesh.expressId,
        edgeT: bestEdge.t,
        shouldLock: true,
        shouldRelease: false,
        isCorner: cornerAtEnd,
        cornerValence: cornerAtEnd ? cornerInfo.valence : 0,
      },
    };
  }

  /**
   * Maintain an existing edge lock - slide along edge or release if moved away
   */
  private maintainEdgeLock(
    point: Vec3,
    currentLock: EdgeLockInput,
    cache: MeshGeometryCache,
    worldSnapRadius: number,
    meshExpressId: number
  ): MagneticSnapResult {
    if (!currentLock.edge) {
      return {
        snapTarget: null,
        edgeLock: {
          edge: null,
          meshExpressId: null,
          edgeT: 0,
          shouldLock: false,
          shouldRelease: true,
          isCorner: false,
          cornerValence: 0,
        },
      };
    }

    const { v0, v1 } = currentLock.edge;

    // Project point onto the locked edge
    const result = closestPointOnEdgeWithT(point, v0, v1);

    // Calculate perpendicular distance (distance from point to edge line)
    const perpDistance = result.distance;

    // Calculate escape threshold based on lock strength
    const escapeMultiplier = MAGNETIC_CONFIG.EDGE_ESCAPE_MULTIPLIER * (1 + currentLock.lockStrength * 0.5);
    const escapeThreshold = worldSnapRadius * escapeMultiplier;

    // Check if we should release the lock
    if (perpDistance > escapeThreshold) {
      return {
        snapTarget: null,
        edgeLock: {
          edge: null,
          meshExpressId: null,
          edgeT: 0,
          shouldLock: false,
          shouldRelease: true,
          isCorner: false,
          cornerValence: 0,
        },
      };
    }

    // Still locked - calculate position along edge
    const edgeT = Math.max(0, Math.min(1, result.t));

    // Check for corner at current position
    const cornerRadius = worldSnapRadius * MAGNETIC_CONFIG.EDGE_ATTRACTION_MULTIPLIER * MAGNETIC_CONFIG.CORNER_ATTRACTION_MULTIPLIER;

    // Find the matching edge in cache to recover its valences and junctions.
    // A locked edge always came from this cache, so the fallback below only
    // fires when the mesh changed under the lock: it carries no valence, which
    // means no corner snap until the lock re-acquires.
    const matchingEdge = cache.edges.find(e =>
      (vecEquals(e.v0, v0) && vecEquals(e.v1, v1)) ||
      (vecEquals(e.v0, v1) && vecEquals(e.v1, v0))
    );

    // `edgeT` runs along the LOCK's orientation, so a cache edge stored the
    // other way round has to be flipped before it is read - endpoints and
    // endpoint valences, AND every junction parameter: junction `t` was
    // computed along the cached run, so under a reversed lock a junction at
    // cached t = 0.2 sits at lock-space t = 0.8. Left unflipped, the real
    // junction lost its vertex snap and its mirror position claimed it.
    const flipped = matchingEdge !== undefined && !vecEquals(matchingEdge.v0, v0);
    const edgeForCorner: SnapEdge = matchingEdge
      ? (flipped
        ? {
          ...matchingEdge,
          v0: matchingEdge.v1,
          v1: matchingEdge.v0,
          v0Valence: matchingEdge.v1Valence,
          v1Valence: matchingEdge.v0Valence,
          // map + reverse keeps the list sorted ascending by `t`.
          junctions: matchingEdge.junctions.map((j) => ({ ...j, t: 1 - j.t })).reverse(),
        }
        : matchingEdge)
      : {
        v0, v1, index: -1, length: distance(v0, v1),
        v0Valence: 0, v1Valence: 0, junctions: [],
      };
    const cornerInfo = detectCorner(edgeForCorner, edgeT, cornerRadius, point);

    // Calculate snap position (on the edge)
    const snapPosition: Vec3 = {
      x: v0.x + (v1.x - v0.x) * edgeT,
      y: v0.y + (v1.y - v0.y) * edgeT,
      z: v0.z + (v1.z - v0.z) * edgeT,
    };

    // Determine snap type
    let snapType: SnapType;
    let confidence: number;

    if (cornerInfo.isCorner && cornerInfo.vertex) {
      snapType = SnapType.VERTEX;
      confidence = Math.min(1, 0.99 + cornerInfo.valence * MAGNETIC_CONFIG.CORNER_CONFIDENCE_BOOST);
      // Snap to the exact corner vertex — an endpoint of the run, or an
      // interior junction the run was merged through.
      snapPosition.x = cornerInfo.vertex.x;
      snapPosition.y = cornerInfo.vertex.y;
      snapPosition.z = cornerInfo.vertex.z;
    } else {
      snapType = SnapType.EDGE;
      // Clamp confidence to 0-1 range (can go negative if perpDistance exceeds attraction radius)
      const rawConfidence = 0.999 * (1.0 - perpDistance / (worldSnapRadius * MAGNETIC_CONFIG.EDGE_ATTRACTION_MULTIPLIER));
      confidence = Math.max(0, Math.min(1, rawConfidence));
    }

    // Endpoint-only, for the same reason as in detectMagneticSnap: the ring
    // consumer cannot place a mid-run junction (see `CornerInfo.atEndpoint`).
    const cornerAtEnd = cornerInfo.isCorner && cornerInfo.atEndpoint;
    return {
      snapTarget: {
        type: snapType,
        position: snapPosition,
        expressId: meshExpressId,
        confidence,
        metadata: { vertices: [v0, v1] },
      },
      edgeLock: {
        edge: { v0, v1 },
        meshExpressId,
        edgeT,
        shouldLock: true,
        shouldRelease: false,
        isCorner: cornerAtEnd,
        cornerValence: cornerAtEnd ? cornerInfo.valence : 0,
      },
    };
  }

  /**
   * Get or compute geometry cache for a mesh
   */
  private getGeometryCache(mesh: MeshData): MeshGeometryCache {
    const key = this.cacheKeyFor(mesh);
    const cached = this.geometryCache.get(key);
    if (cached) {
      return cached;
    }

    const cache = buildGeometryCache(mesh);
    this.geometryCache.set(key, cache);
    return cache;
  }

  /**
   * Stable cache key for a mesh's snap geometry.
   *
   * GPU-instanced occurrences carry an explicit per-occurrence `occurrenceKey`
   * (issue #1405). Flat meshes do not, and keying them on `expressId` alone is
   * wrong whenever ONE entity is emitted as several flat sub-pieces — mesh
   * fragmentation routinely splits an element into many `MeshData` pieces (e.g.
   * an IfcMechanicalFastener "Bolt assembly" of mapped items materialized as 24
   * pieces), and mapped copies share both `expressId` and local positions while
   * differing only in `origin`. Keying on `expressId` served the first piece's
   * vertices/edges for every other, so snap lit up on a single piece.
   *
   * So flat pieces key on a cheap content signature: `expressId` + per-piece
   * `origin` (distinguishes same-template copies at different placements) +
   * buffer sizes + sampled vertices (distinguishes distinct sub-pieces of one
   * element). Pieces whose world geometry is genuinely identical collapse to the
   * same key, which is correct (their snap geometry is the same).
   */
  private cacheKeyFor(mesh: MeshData): string {
    if (mesh.occurrenceKey !== undefined) return mesh.occurrenceKey;
    const p = mesh.positions;
    const n = p.length;
    const o = mesh.origin;
    const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
    // middle vertex offset, aligned to a 3-float stride
    const mid = n >= 3 ? (Math.floor(n / 6) * 3) : 0;
    return `${mesh.expressId}:${n}:${mesh.indices?.length ?? 0}` +
      `:${ox},${oy},${oz}` +
      `:${p[0]},${p[1]},${p[2]}` +
      `:${p[mid]},${p[mid + 1]},${p[mid + 2]}` +
      `:${p[n - 3]},${p[n - 2]},${p[n - 1]}`;
  }

  /**
   * Find vertices near point
   */
  private findVertices(mesh: MeshData, point: Vec3, radius: number): SnapTarget[] {
    const targets: SnapTarget[] = [];
    const cache = this.getGeometryCache(mesh);

    // Find vertices within radius - ONLY when VERY close for smooth edge sliding
    for (const vertex of cache.vertices) {
      const dist = distance(vertex, point);
      // Only snap to vertices when within 20% of snap radius (very tight) to avoid sticky behavior
      if (dist < radius * 0.2) {
        targets.push({
          type: SnapType.VERTEX,
          position: vertex,
          expressId: mesh.expressId,
          confidence: 0.95 - dist / (radius * 0.2), // Lower than edges, only wins when VERY close
        });
      }
    }

    return targets;
  }

  /**
   * Find edges near point
   */
  private findEdges(mesh: MeshData, point: Vec3, radius: number): SnapTarget[] {
    const targets: SnapTarget[] = [];
    const cache = this.getGeometryCache(mesh);

    // Use MUCH larger radius for edges - very forgiving, cursor "jumps" to edges
    const edgeRadius = radius * 3.0; // Tripled for easy detection

    // Find edges near point using cached data
    for (const edge of cache.edges) {
      const closestPoint = this.raycaster.closestPointOnSegment(point, edge.v0, edge.v1);
      const dist = distance(closestPoint, point);

      if (dist < edgeRadius) {
        // Edge snap - ABSOLUTE HIGHEST priority for smooth sliding along edges
        // Maximum confidence ensures edges ALWAYS win over vertices/faces
        targets.push({
          type: SnapType.EDGE,
          position: closestPoint,
          expressId: mesh.expressId,
          confidence: 0.999 * (1.0 - dist / edgeRadius), // Nearly perfect priority for edges
          metadata: { vertices: [edge.v0, edge.v1], edgeIndex: edge.index },
        });
      }
    }

    return targets;
  }

  /**
   * Clear geometry cache (call when meshes change)
   */
  clearCache(): void {
    this.geometryCache.clear();
  }

  /**
   * Find faces/planes near intersection
   */
  private findFaces(mesh: MeshData, intersection: Intersection, radius: number): SnapTarget[] {
    const targets: SnapTarget[] = [];

    // Add the intersected face
    targets.push({
      type: SnapType.FACE,
      position: intersection.point,
      normal: intersection.normal,
      expressId: mesh.expressId,
      confidence: 0.5, // Lower priority than vertices/edges
      metadata: { faceIndex: intersection.triangleIndex },
    });

    // Calculate face center (centroid of triangle). Positions are in the
    // element's local frame; the intersection point is world-space, so lift
    // each vertex by the per-mesh origin (world = origin + local).
    const positions = mesh.positions;
    const indices = mesh.indices;
    const ox = mesh.origin ? mesh.origin[0] : 0;
    const oy = mesh.origin ? mesh.origin[1] : 0;
    const oz = mesh.origin ? mesh.origin[2] : 0;

    if (indices) {
      const triIndex = intersection.triangleIndex * 3;
      const i0 = indices[triIndex] * 3;
      const i1 = indices[triIndex + 1] * 3;
      const i2 = indices[triIndex + 2] * 3;

      const v0: Vec3 = {
        x: positions[i0] + ox,
        y: positions[i0 + 1] + oy,
        z: positions[i0 + 2] + oz,
      };
      const v1: Vec3 = {
        x: positions[i1] + ox,
        y: positions[i1 + 1] + oy,
        z: positions[i1 + 2] + oz,
      };
      const v2: Vec3 = {
        x: positions[i2] + ox,
        y: positions[i2 + 1] + oy,
        z: positions[i2 + 2] + oz,
      };

      const center: Vec3 = {
        x: (v0.x + v1.x + v2.x) / 3,
        y: (v0.y + v1.y + v2.y) / 3,
        z: (v0.z + v1.z + v2.z) / 3,
      };

      const dist = distance(center, intersection.point);
      if (dist < radius) {
        targets.push({
          type: SnapType.FACE_CENTER,
          position: center,
          normal: intersection.normal,
          expressId: mesh.expressId,
          confidence: 0.7 * (1.0 - dist / radius),
          metadata: { faceIndex: intersection.triangleIndex },
        });
      }
    }

    return targets;
  }

  /**
   * Select best snap target based on confidence and priority
   */
  private getBestSnapTarget(targets: SnapTarget[]): SnapTarget | null {
    if (targets.length === 0) return null;

    // Priority order: vertex > edge > face_center > face. POINT_CLOUD
    // never reaches this method (SnapDetector never produces it —
    // RaycastEngine composes point-cloud snaps in afterwards, #1860)
    // but the map must stay exhaustive over SnapType for the indexed
    // lookup below to type-check.
    const priorityMap: Record<SnapType, number> = {
      [SnapType.VERTEX]: 4,
      [SnapType.EDGE]: 3,
      [SnapType.FACE_CENTER]: 2,
      [SnapType.FACE]: 1,
      [SnapType.POINT_CLOUD]: 0,
    };

    // Sort by priority then confidence
    targets.sort((a, b) => {
      const priorityDiff = priorityMap[b.type] - priorityMap[a.type];
      if (priorityDiff !== 0) return priorityDiff;
      return b.confidence - a.confidence;
    });

    return targets[0];
  }

}
