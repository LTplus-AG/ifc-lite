import type { MeshData } from '@ifc-lite/geometry';
import type { Ray, Vec3 } from './raycaster.js';

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export interface BVHNode {
  bounds: AABB;
  meshIndices: number[];
  left?: BVHNode;
  right?: BVHNode;
  isLeaf: boolean;
}

export class BVH {
  private root: BVHNode | null = null;
  private readonly maxMeshesPerLeaf = 8;

  // Per-mesh AABB cache (6 floats/mesh: minX,minY,minZ,maxX,maxY,maxZ), filled
  // once per build. Storing in a Float32Array is lossless for f32 positions, so
  // unioning these and deriving centroids as (min+max)/2 reproduces exactly the
  // split order and node bounds the old per-vertex recompute produced — without
  // re-scanning every vertex at every recursion level.
  private meshAABBs: Float32Array | null = null;

  /**
   * Build BVH from meshes
   */
  build(meshes: MeshData[]): void {
    if (meshes.length === 0) {
      this.root = null;
      this.meshAABBs = null;
      return;
    }

    // Single O(total verts) pass: cache each mesh's AABB. An empty mesh keeps
    // Infinity/-Infinity, so it contributes nothing to a union (matching the old
    // per-vertex calculateBounds) and yields a NaN centroid (matching the old
    // getMeshCenter) — behaviour is unchanged for that degenerate case.
    const aabbs = new Float32Array(meshes.length * 6);
    for (let m = 0; m < meshes.length; m++) {
      const positions = meshes[m].positions;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      }
      const o = m * 6;
      aabbs[o] = minX;
      aabbs[o + 1] = minY;
      aabbs[o + 2] = minZ;
      aabbs[o + 3] = maxX;
      aabbs[o + 4] = maxY;
      aabbs[o + 5] = maxZ;
    }
    this.meshAABBs = aabbs;

    // Create mesh indices array
    const meshIndices = meshes.map((_, i) => i);

    // Build tree recursively (uses the cached AABBs, not the vertex arrays)
    this.root = this.buildNode(meshIndices);
  }

  /**
   * Get meshes that potentially intersect with ray
   */
  getMeshesForRay(ray: Ray, meshes: MeshData[]): number[] {
    if (!this.root) {
      return meshes.map((_, i) => i);
    }

    const result: number[] = [];
    this.traverseRay(this.root, ray, result);
    return result;
  }

  /**
   * Build a BVH node recursively
   */
  private buildNode(meshIndices: number[]): BVHNode {
    // Calculate bounding box by unioning the cached per-mesh AABBs
    const bounds = this.unionCachedBounds(meshIndices);

    // Leaf node if few enough meshes
    if (meshIndices.length <= this.maxMeshesPerLeaf) {
      return {
        bounds,
        meshIndices,
        isLeaf: true,
      };
    }

    // Split meshes along longest axis, sorting on cached centroids
    const axis = this.getLongestAxis(bounds);
    const k = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const sortedIndices = [...meshIndices].sort(
      (a, b) => this.cachedCenter(a, k) - this.cachedCenter(b, k)
    );

    const mid = Math.floor(sortedIndices.length / 2);
    const leftIndices = sortedIndices.slice(0, mid);
    const rightIndices = sortedIndices.slice(mid);

    // Recursively build child nodes
    return {
      bounds,
      meshIndices: [],
      left: this.buildNode(leftIndices),
      right: this.buildNode(rightIndices),
      isLeaf: false,
    };
  }

  /**
   * Traverse BVH and collect meshes that intersect ray
   */
  private traverseRay(node: BVHNode, ray: Ray, result: number[]): void {
    // Test ray against node bounds
    if (!this.rayIntersectsAABB(ray, node.bounds)) {
      return;
    }

    // Leaf node - add all meshes
    if (node.isLeaf) {
      result.push(...node.meshIndices);
      return;
    }

    // Interior node - recurse
    if (node.left) {
      this.traverseRay(node.left, ray, result);
    }
    if (node.right) {
      this.traverseRay(node.right, ray, result);
    }
  }

  /**
   * Ray-AABB intersection test
   */
  private rayIntersectsAABB(ray: Ray, bounds: AABB): boolean {
    const { origin, direction } = ray;
    const { min, max } = bounds;

    let tmin = -Infinity;
    let tmax = Infinity;

    // Test each axis
    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(direction[axis]) < 0.0000001) {
        // Ray parallel to axis
        if (origin[axis] < min[axis] || origin[axis] > max[axis]) {
          return false;
        }
      } else {
        const invD = 1.0 / direction[axis];
        let t0 = (min[axis] - origin[axis]) * invD;
        let t1 = (max[axis] - origin[axis]) * invD;

        if (t0 > t1) {
          [t0, t1] = [t1, t0];
        }

        tmin = Math.max(tmin, t0);
        tmax = Math.min(tmax, t1);

        if (tmin > tmax) {
          return false;
        }
      }
    }

    return tmax >= 0; // Intersection in front of ray origin
  }

  /**
   * Union the cached per-mesh AABBs for a set of mesh indices (no vertex scan)
   */
  private unionCachedBounds(meshIndices: number[]): AABB {
    const aabbs = this.meshAABBs!;
    const bounds: AABB = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    };

    for (const index of meshIndices) {
      const o = index * 6;
      bounds.min.x = Math.min(bounds.min.x, aabbs[o]);
      bounds.min.y = Math.min(bounds.min.y, aabbs[o + 1]);
      bounds.min.z = Math.min(bounds.min.z, aabbs[o + 2]);
      bounds.max.x = Math.max(bounds.max.x, aabbs[o + 3]);
      bounds.max.y = Math.max(bounds.max.y, aabbs[o + 4]);
      bounds.max.z = Math.max(bounds.max.z, aabbs[o + 5]);
    }

    return bounds;
  }

  /**
   * Center of a cached mesh AABB along an axis (k = 0|1|2). Derived in f64 from
   * the lossless f32 bounds, so it equals the old getMeshCenter exactly.
   */
  private cachedCenter(index: number, k: number): number {
    const aabbs = this.meshAABBs!;
    const o = index * 6;
    return (aabbs[o + k] + aabbs[o + 3 + k]) / 2;
  }

  /**
   * Get longest axis of bounding box
   */
  private getLongestAxis(bounds: AABB): 'x' | 'y' | 'z' {
    const dx = bounds.max.x - bounds.min.x;
    const dy = bounds.max.y - bounds.min.y;
    const dz = bounds.max.z - bounds.min.z;

    if (dx > dy && dx > dz) return 'x';
    if (dy > dz) return 'y';
    return 'z';
  }
}
