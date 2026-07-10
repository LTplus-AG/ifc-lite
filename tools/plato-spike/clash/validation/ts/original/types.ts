/* Local type mirror for the copied original math sources. */
export type Vec3 = [number, number, number];
export type Mat4 = readonly number[];
export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}
