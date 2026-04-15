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

  /**
   * Build BVH from meshes
   */
  build(meshes: MeshData[]): void {
    if (meshes.length === 0) {
      this.root = null;
      return;
    }

    // Create mesh indices array
    const meshIndices = meshes.map((_, i) => i);

    // Build tree recursively
    this.root = this.buildNode(meshes, meshIndices);
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
  private buildNode(meshes: MeshData[], meshIndices: number[]): BVHNode {
    // Calculate bounding box for all meshes
    const bounds = this.calculateBounds(meshes, meshIndices);

    // Leaf node if few enough meshes
    if (meshIndices.length <= this.maxMeshesPerLeaf) {
      return {
        bounds,
        meshIndices,
        isLeaf: true,
      };
    }

    // Split meshes along longest axis
    const axis = this.getLongestAxis(bounds);
    const sortedIndices = [...meshIndices].sort((a, b) => {
      const centerA = this.getMeshCenter(meshes[a])[axis];
      const centerB = this.getMeshCenter(meshes[b])[axis];
      return centerA - centerB;
    });

    const mid = Math.floor(sortedIndices.length / 2);
    const leftIndices = sortedIndices.slice(0, mid);
    const rightIndices = sortedIndices.slice(mid);

    // Recursively build child nodes
    return {
      bounds,
      meshIndices: [],
      left: this.buildNode(meshes, leftIndices),
      right: this.buildNode(meshes, rightIndices),
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
   * Calculate bounding box for a set of meshes
   */
  private calculateBounds(meshes: MeshData[], meshIndices: number[]): AABB {
    const bounds: AABB = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    };

    for (const index of meshIndices) {
      const mesh = meshes[index];
      const positions = mesh.positions;

      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];

        bounds.min.x = Math.min(bounds.min.x, x);
        bounds.min.y = Math.min(bounds.min.y, y);
        bounds.min.z = Math.min(bounds.min.z, z);

        bounds.max.x = Math.max(bounds.max.x, x);
        bounds.max.y = Math.max(bounds.max.y, y);
        bounds.max.z = Math.max(bounds.max.z, z);
      }
    }

    return bounds;
  }

  /**
   * Get center of mesh bounding box
   */
  private getMeshCenter(mesh: MeshData): { x: number; y: number; z: number } {
    const positions = mesh.positions;
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

    return {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: (minZ + maxZ) / 2,
    };
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
