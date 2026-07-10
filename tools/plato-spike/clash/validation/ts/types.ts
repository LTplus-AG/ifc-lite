/* Local mirror of the plato clash math types (shape-identical to
 * @ifc-lite/spatial AABB and packages/clash/src/types.ts). */

/** A 3-component vector `[x, y, z]`. */
export type Vec3 = [number, number, number];

/** A 4x4 transform, column-major, length 16. */
export type Mat4 = readonly number[];

/** Axis-aligned bounding box. */
export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}
