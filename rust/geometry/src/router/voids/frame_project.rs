// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Frame construction and projection helpers, split out of `geom.rs` to keep
//! that file under the module-size ratchet. Re-exported from `geom` (see its
//! `pub(super) use`) so `super::geom::{mesh_to_frame, project_aabb_in_frame}`
//! at existing call sites keeps working unchanged.

use super::NORMALIZE_EPSILON;
use crate::{Mesh, Point3, Vector3};

/// Build a right-handed orthonormal wall frame `[len, up, depth]` from a
/// (roughly horizontal) opening depth axis: `depth` is the wall-thickness /
/// penetration axis, `up` is world +Z, `len` runs along the wall. Returns
/// `None` if `depth` is degenerate or too close to vertical (not a plan-rotated
/// wall). `len × up = depth`, so a box wound for world axes keeps its winding
/// when mapped back. Issue #1167: cutting the openings in this frame makes the
/// wall and its openings axis-aligned, where the exact subtract is clean — the
/// world-space tilted cut at large coordinates fragments badly.
pub(in crate::router::voids) fn wall_frame_from_depth(
    depth: Vector3<f64>,
) -> Option<[Vector3<f64>; 3]> {
    let d = depth.try_normalize(NORMALIZE_EPSILON)?;
    if d.z.abs() > 0.2 {
        return None; // roof/floor/sloped — not a plan-rotated wall
    }
    let up = Vector3::new(0.0, 0.0, 1.0);
    let len = up.cross(&d).try_normalize(NORMALIZE_EPSILON)?;
    let up = d.cross(&len).try_normalize(NORMALIZE_EPSILON)?; // re-orthogonalise
                                                              // [len, up, d] right-handed: len × up = d.
    Some([len, up, d])
}

/// Express `mesh` in the orthonormal frame `axes = [a, b, c]` about `center`:
/// `p' = [ (p-center)·a, (p-center)·b, (p-center)·c ]`. Centering keeps
/// coordinates small (f32-precise) and the rotation makes a frame-oriented box
/// axis-aligned. [`rotate_mesh_from_frame`] inverts it, returning the centre
/// in [`Mesh::origin`] rather than in the coordinates.
pub(in crate::router::voids) fn mesh_to_frame(
    mesh: &Mesh,
    axes: &[Vector3<f64>; 3],
    center: Vector3<f64>,
) -> Mesh {
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for ch in mesh.positions.chunks_exact(3) {
        let p = Vector3::new(ch[0] as f64, ch[1] as f64, ch[2] as f64) - center;
        positions.push(p.dot(&axes[0]) as f32);
        positions.push(p.dot(&axes[1]) as f32);
        positions.push(p.dot(&axes[2]) as f32);
    }
    let mut normals = Vec::with_capacity(mesh.normals.len());
    for ch in mesh.normals.chunks_exact(3) {
        let n = Vector3::new(ch[0] as f64, ch[1] as f64, ch[2] as f64);
        normals.push(n.dot(&axes[0]) as f32);
        normals.push(n.dot(&axes[1]) as f32);
        normals.push(n.dot(&axes[2]) as f32);
    }
    Mesh {
        positions,
        normals,
        indices: mesh.indices.clone(),
        rtc_applied: mesh.rtc_applied,
        origin: mesh.origin,
        // Frame-transformed cut intermediate — not an instanceable occurrence.
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
        welded_in_object_frame: false,
    }
}

/// Axis-aligned bounds of `mesh` expressed in the frame `axes` about `center`.
pub(in crate::router::voids) fn project_aabb_in_frame(
    mesh: &Mesh,
    axes: &[Vector3<f64>; 3],
    center: Vector3<f64>,
) -> Option<(Point3<f64>, Point3<f64>)> {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for ch in mesh.positions.chunks_exact(3) {
        let p = Vector3::new(ch[0] as f64, ch[1] as f64, ch[2] as f64) - center;
        for k in 0..3 {
            let v = p.dot(&axes[k]);
            lo[k] = lo[k].min(v);
            hi[k] = hi[k].max(v);
        }
    }
    // Validate BOTH bounds: a +inf projection lands only in `hi`, so checking
    // `lo` alone could return a non-finite AABB into the cutter path (#1259).
    (lo.iter().all(|v| v.is_finite()) && hi.iter().all(|v| v.is_finite())).then(|| {
        (
            Point3::new(lo[0], lo[1], lo[2]),
            Point3::new(hi[0], hi[1], hi[2]),
        )
    })
}
