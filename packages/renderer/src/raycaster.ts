import type { MeshData } from '@ifc-lite/geometry';

export interface Ray {
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Intersection {
  point: Vec3;
  normal: Vec3;
  distance: number;
  meshIndex: number;
  triangleIndex: number;
  expressId: number;
  barycentricCoord: { u: number; v: number; w: number };
}

export class Raycaster {
  private epsilon = 0.0000001;

  /**
   * Cast a ray through all meshes and return the closest intersection
   */
  raycast(ray: Ray, meshes: MeshData[]): Intersection | null {
    let closestIntersection: Intersection | null = null;
    let closestDistance = Infinity;

    for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
      const mesh = meshes[meshIndex];
      const intersection = this.raycastMesh(ray, mesh, meshIndex);

      if (intersection && intersection.distance < closestDistance) {
        closestDistance = intersection.distance;
        closestIntersection = intersection;
      }
    }

    return closestIntersection;
  }

  /**
   * Cast ray through a single mesh
   */
  private raycastMesh(ray: Ray, mesh: MeshData, meshIndex: number): Intersection | null {
    const positions = mesh.positions;
    const indices = mesh.indices;

    // Validate input
    if (!indices || indices.length === 0 || !positions || positions.length === 0) {
      return null;
    }

    // Positions are in the element's local frame (world = origin + position).
    // Shift the ray ONCE into that local frame instead of offsetting every
    // triangle vertex — a pure translation, so ray.direction, the distance t and
    // the normal are all unaffected. The hit point comes back in the local frame
    // and is lifted to world below. No-op when origin is absent/[0,0,0].
    const o = mesh.origin;
    const localRay: Ray = o
      ? {
          origin: { x: ray.origin.x - o[0], y: ray.origin.y - o[1], z: ray.origin.z - o[2] },
          direction: ray.direction,
        }
      : ray;

    // Ensure triangle count is valid
    if (indices.length % 3 !== 0) {
      console.warn(`Invalid index count for mesh ${mesh.expressId}: ${indices.length}`);
      return null;
    }

    let closestIntersection: Intersection | null = null;
    let closestDistance = Infinity;

    // Test each triangle
    for (let i = 0; i < indices.length; i += 3) {
      const idx0 = indices[i];
      const idx1 = indices[i + 1];
      const idx2 = indices[i + 2];

      // Validate indices are within bounds
      const maxIndex = positions.length / 3 - 1;
      if (idx0 > maxIndex || idx1 > maxIndex || idx2 > maxIndex) {
        continue; // Skip invalid triangles
      }

      const i0 = idx0 * 3;
      const i1 = idx1 * 3;
      const i2 = idx2 * 3;

      const v0: Vec3 = {
        x: positions[i0],
        y: positions[i0 + 1],
        z: positions[i0 + 2],
      };
      const v1: Vec3 = {
        x: positions[i1],
        y: positions[i1 + 1],
        z: positions[i1 + 2],
      };
      const v2: Vec3 = {
        x: positions[i2],
        y: positions[i2 + 1],
        z: positions[i2 + 2],
      };

      // Skip degenerate triangles (NaN or identical vertices)
      if (
        !isFinite(v0.x) || !isFinite(v0.y) || !isFinite(v0.z) ||
        !isFinite(v1.x) || !isFinite(v1.y) || !isFinite(v1.z) ||
        !isFinite(v2.x) || !isFinite(v2.y) || !isFinite(v2.z)
      ) {
        continue;
      }

      const intersection = this.intersectTriangle(localRay, v0, v1, v2);

      if (intersection && intersection.distance < closestDistance) {
        closestDistance = intersection.distance;

        // Calculate normal from triangle
        const normal = this.calculateTriangleNormal(v0, v1, v2);

        // intersection.point is in the local frame (computed from localRay);
        // lift it back to world space for the caller.
        const worldPoint: Vec3 = o
          ? { x: intersection.point.x + o[0], y: intersection.point.y + o[1], z: intersection.point.z + o[2] }
          : intersection.point;

        closestIntersection = {
          point: worldPoint,
          normal,
          distance: intersection.distance,
          meshIndex,
          triangleIndex: i / 3,
          expressId: mesh.expressId,
          barycentricCoord: intersection.barycentricCoord,
        };
      }
    }

    return closestIntersection;
  }

  /**
   * Ray-triangle intersection using Möller–Trumbore algorithm
   */
  private intersectTriangle(
    ray: Ray,
    v0: Vec3,
    v1: Vec3,
    v2: Vec3
  ): { point: Vec3; distance: number; barycentricCoord: { u: number; v: number; w: number } } | null {
    // Edge vectors
    const edge1 = this.subtract(v1, v0);
    const edge2 = this.subtract(v2, v0);

    // Calculate determinant
    const h = this.cross(ray.direction, edge2);
    const det = this.dot(edge1, h);

    // Ray parallel to triangle
    if (Math.abs(det) < this.epsilon) {
      return null;
    }

    const invDet = 1.0 / det;

    // Calculate u parameter
    const s = this.subtract(ray.origin, v0);
    const u = invDet * this.dot(s, h);

    if (u < 0.0 || u > 1.0) {
      return null;
    }

    // Calculate v parameter
    const q = this.cross(s, edge1);
    const v = invDet * this.dot(ray.direction, q);

    if (v < 0.0 || u + v > 1.0) {
      return null;
    }

    // Calculate t (distance along ray)
    const t = invDet * this.dot(edge2, q);

    if (t < this.epsilon) {
      return null; // Intersection behind ray origin
    }

    // Calculate intersection point
    const point: Vec3 = {
      x: ray.origin.x + ray.direction.x * t,
      y: ray.origin.y + ray.direction.y * t,
      z: ray.origin.z + ray.direction.z * t,
    };

    // Barycentric coordinates
    const w = 1.0 - u - v;

    return {
      point,
      distance: t,
      barycentricCoord: { u, v, w },
    };
  }

  /**
   * Calculate triangle normal
   */
  private calculateTriangleNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
    const edge1 = this.subtract(v1, v0);
    const edge2 = this.subtract(v2, v0);
    const normal = this.cross(edge1, edge2);
    return this.normalize(normal);
  }

  /**
   * Vector math utilities
   */
  private subtract(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  }

  private cross(a: Vec3, b: Vec3): Vec3 {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  private dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  private normalize(v: Vec3): Vec3 {
    const length = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (length === 0) return { x: 0, y: 0, z: 1 };
    return {
      x: v.x / length,
      y: v.y / length,
      z: v.z / length,
    };
  }

  private length(v: Vec3): number {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  }

  /**
   * Get closest point on line segment to a point
   */
  closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
    const ab = this.subtract(b, a);
    const ap = this.subtract(p, a);
    const t = Math.max(0, Math.min(1, this.dot(ap, ab) / this.dot(ab, ab)));

    return {
      x: a.x + ab.x * t,
      y: a.y + ab.y * t,
      z: a.z + ab.z * t,
    };
  }

  /**
   * Distance from point to point
   */
  distance(a: Vec3, b: Vec3): number {
    return this.length(this.subtract(a, b));
  }
}
