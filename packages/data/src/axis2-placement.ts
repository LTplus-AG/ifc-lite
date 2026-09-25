/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `build_axis2_matrix`'s `try_normalize(1e-9)` on the Axis. */
const AXIS_EPSILON = 1e-9;
/** `build_axis2_matrix`'s `x_axis_orthogonal.norm() > 1e-6` switch. */
const PROJECTION_EPSILON = 1e-6;

/**
 * The local X axis an `IfcAxis2Placement3D` has when its `RefDirection` is
 * absent (`$`), as ifc-lite's renderer computes it (#5922).
 *
 * This is the single TypeScript definition. It mirrors `build_axis2_matrix`
 * in `rust/geometry/src/transform.rs`, which the renderer's object and
 * shape-placement parsers (`parse_axis2_placement_3d` and its siblings) feed:
 * each passes world X `(1,0,0)` for a `$` RefDirection, and
 * `build_axis2_matrix` projects it onto the plane normal to the normalised
 * Axis. (Conic surface parametrisation in `advanced_face/conics.rs` picks its
 * own reference direction; that is a different concern, not this fill.) That
 * is the schema's `IfcFirstProjAxis(Axis, $)` everywhere except next to the
 * X axis:
 *
 *   - when the projection is no longer than 1e-6 (Axis within about 1e-6 rad
 *     of +X or -X), the renderer takes `(0,0,1) x Axis` instead. For exactly
 *     `+X` that is `(0,1,0)`, the schema's own switch to world Y. For exactly
 *     `-X`, where the schema's projection of X vanishes and it gives no
 *     answer, it is `(0,-1,0)`.
 *   - an Axis near +X but inside that tolerance with a positive Y or Z offset
 *     gets about `(0,+1,0)`, where the schema's projection points about
 *     `(0,-1,0)`. That is the renderer's behaviour and it is copied here on
 *     purpose: a reader that fills `$` differently from the viewer turns the
 *     frame 180 degrees about its Axis relative to what is drawn.
 *
 * `rust/geometry/tests/absent_ref_direction_fill.rs` pins the same vectors on
 * the Rust side; change both together.
 *
 * A zero-length Axis is read as `(0,0,1)`, as `build_axis2_matrix` does, and
 * gives `(1,0,0)`. The result is unit length and perpendicular to the Axis.
 */
export function firstProjAxis(axis: readonly [number, number, number]): [number, number, number] {
  // `Math.sqrt` of the sum of squares, not `Math.hypot`, to round like
  // nalgebra's `norm()`.
  const axisLength = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
  const z: [number, number, number] = axisLength > AXIS_EPSILON
    ? [axis[0] / axisLength, axis[1] / axisLength, axis[2] / axisLength]
    : [0, 0, 1];
  // World X minus its component along Z. `X . Z` is just `z[0]`.
  const projected: [number, number, number] = [1 - z[0] * z[0], -z[1] * z[0], -z[2] * z[0]];
  const projectedLength = Math.sqrt(
    projected[0] * projected[0] + projected[1] * projected[1] + projected[2] * projected[2],
  );
  if (projectedLength > PROJECTION_EPSILON) {
    return [projected[0] / projectedLength, projected[1] / projectedLength, projected[2] / projectedLength];
  }
  // The projection collapsed, so Z is within 1e-6 of +-X and |z[2]| < 0.9:
  // `build_axis2_matrix` takes (0,0,1) x Z = (-z[1], z[0], 0) on that branch.
  const fallbackLength = Math.sqrt(z[0] * z[0] + z[1] * z[1]);
  return [-z[1] / fallbackLength, z[0] / fallbackLength, 0];
}
