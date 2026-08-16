// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Direction-aware plane-distance tolerance for the CSG clipper.
//!
//! Extracted from `csg/mod.rs` so the tolerance-sizing concern — and the two
//! doc comments carrying its reasoning and its known limitation — lives in one
//! place. Ported from the TypeScript `ProjectedPlaneEps` / `epsForPlane` pair
//! in `packages/clash/src/contact/{narrow-phase,tri-tri}.ts` (#2661), itself
//! following the LOCAL-vs-world tolerance sizing in `section-cutter.ts`
//! (#2622). Deliberately the same formulation as the clash narrow phase, not
//! a new one.
//!
//! This does NOT mean the crate now has a single plane-epsilon formulation.
//! `router/voids/aabb_clip.rs` still carries its own — max over axes, scaled
//! by `1e-6` rather than `2^-22` — against a hand-rolled copy of
//! `clip_triangle`'s body that does not route through
//! [`clip_triangle_with_epsilon`]. That divergence is pre-existing and
//! untouched here; converging it needs its own change with its own evidence.
//!
//! # The floor, and its known unit-divergence limitation
//!
//! [`super::ClippingProcessor::epsilon`] supplies [`PlaneEps`]'s floor. It is
//! a raw `f64` constant in whatever unit the mesh happens to be in when
//! `clip_mesh` runs — `clip_mesh` runs before `scale_mesh`
//! (`router/processing.rs:818` vs `:846`), so that is the file's native unit,
//! not metres, and the field is never rescaled by `unit_scale`.
//!
//! KNOWN LIMITATION (pre-existing, not introduced by the magnitude-scaling
//! fix): because the floor is a fixed file-unit constant, identical physical
//! geometry can classify differently depending on whether the file's units are
//! metres or millimetres. The projected term overtakes the floor at a
//! projected noise amplitude of about 4.19 file units
//! (`1e-6 / 2^-22 ~= 4.194304`) — above that, both unit choices converge on
//! the same scaled epsilon. Below it, a metre-authored file stays floored at a
//! constant `1e-6 m` (1 micrometre) regardless of how small the operand gets,
//! while a millimetre-authored file's scaled term keeps shrinking with the
//! operand (the floor in mm file units, `1e-6 mm`, is a nanometre and is
//! essentially never reached) — so the two units can pick different epsilons,
//! by up to ~40x, for the same real-world extent below the crossover. Both
//! sides remain sub-micrometre, and no building-scale corpus fixture has
//! exercised it. Left undone deliberately: rescaling this floor by
//! `unit_scale` is exactly the kind of tolerance change that needs its own PR
//! with its own corpus evidence, not a fold-in-on-review-comment fix (see the
//! 122x-looser-floor mistake avoided by not reusing `near_band_from_extent`).
//!
//! # Why not `near_band_from_extent`
//!
//! Despite sharing the `2^-22` term, `near_band_from_extent`
//! (`kernel/mesh_bridge.rs`) is not reused here: its floor (`8*SNAP_GRID`
//! ~= 1.22e-4) is sized for the exact kernel's snap grid and is only overtaken
//! past ~512 m, so at building extents it would flatten the epsilon 122x
//! looser.

use crate::mesh::Mesh;
use nalgebra::Vector3;

use super::{ClipResult, Plane, Triangle};

/// f32-ULP scale factor for a "worst-case" single-precision coordinate: for a
/// value with magnitude in `[2, 4)` the true float32 ULP is `2^-22`, and for
/// larger magnitudes the ULP only grows. Same `2^-22` term (and reasoning) as
/// `near_band_from_extent` in `kernel/mesh_bridge.rs` and `F32_ULP_SCALE` in
/// `packages/clash/src/contact/narrow-phase.ts` — kept local rather than
/// shared because plane-distance tolerance and penetration-depth tolerance are
/// different jobs, even though both derive from the same f32 ingestion floor.
const F32_ULP_SCALE: f64 = 1.0 / 4_194_304.0;

/// Per-axis f32 rounding-noise amplitudes plus a floor, resolved into a scalar
/// tolerance per plane by [`PlaneEps::for_normal`].
///
/// The classification epsilon must scale with the operand's coordinate
/// magnitude rather than stay a fixed `1e-6`: the plane is f64, vertices are
/// f32-native, and the f32 ULP exceeds `1e-6` above 16 m, misclassifying
/// on-plane vertices.
///
/// Crucially the magnitude must be tracked PER AXIS and projected onto the
/// plane's own normal, not collapsed to a single max over all three axes. A
/// signed plane distance is `dot(v - p, n)` for a unit normal `n`, so each
/// coordinate's rounding noise enters it weighted by that axis's normal
/// component; an axis orthogonal to the normal contributes nothing.
///
/// A max-over-axes scalar (this module's predecessor, an inline
/// `mesh_plane_extent` in `csg/mod.rs`) is compared against a quantity it was
/// not derived from: it scales the tolerance to the operand's distance from
/// the LOCAL frame's origin along whichever axis happens to be largest, even
/// when that axis is irrelevant to the plane being tested. A site-offset model
/// at x = 1e6 mm clipped by a horizontal plane through a wall spanning
/// z = 0..3000 mm got `eps = 1e6 * 2^-22 ~= 0.238 mm`, inflated entirely by
/// the irrelevant x axis, where the real f32 rounding step at that z is about
/// 2.4e-4 mm: roughly 1000x too loose on the only axis that matters.
#[derive(Debug, Clone, Copy)]
pub(super) struct PlaneEps {
    /// Per-axis absolute rounding-noise amplitude, in the mesh's native units.
    axis_noise: [f64; 3],
    /// Minimum tolerance, applied after projection.
    floor: f64,
}

impl PlaneEps {
    /// Per-axis f32 rounding-noise amplitudes for `mesh`'s vertices, floored
    /// (after projection) at `floor`.
    ///
    /// # Only the MESH contributes noise — never [`Plane::point`]
    ///
    /// The bounded quantity is `signed_distance = (v - p).dot(n)`
    /// ([`Plane::signed_distance`]). `v` comes from `Mesh::positions`, a
    /// `Vec<f32>`, so its quantization error is real and bounded per axis by
    /// about `|v_i| * 2^-24` (half an f32 ULP; [`F32_ULP_SCALE`] uses `2^-22`,
    /// a deliberate 4x margin). The projection in [`Self::for_normal`] turns
    /// those per-axis bounds into a bound on the distance itself. `p`, by
    /// contrast, is f64 END TO END — parsed straight out of
    /// `IfcAxis2Placement3D` and never round-tripped through f32 — so it
    /// injects no rounding noise of its own and belongs in no noise term.
    ///
    /// Folding `max|p_i|` in would also be geometrically meaningless:
    /// [`Plane::point`] is an arbitrary REPRESENTATIVE of the plane, not a
    /// property of it. Two `Plane`s describing the identical half-space would
    /// then classify differently — for `n = (0.6, 0, 0.8)` through the origin
    /// against a 3-unit triangle, a representative at the origin gives
    /// `eps = 1.0e-6` (floored) while `(8000, 0, -6000)` — exactly on the same
    /// plane — gives `2.29e-3`, 2288x looser. That is the very failure this
    /// module exists to fix (an irrelevant magnitude inflating the tolerance)
    /// reintroduced by a different route, and it is reachable: the plane point
    /// at `processors/boolean/mod.rs` comes from the half-space placement's
    /// Location, which is not constrained to sit anywhere near the mesh.
    /// `scaledPlaneEps` in `packages/clash/src/contact/narrow-phase.ts`
    /// likewise iterates only the mesh AABBs.
    ///
    /// # The floor
    ///
    /// Scaling must only ever *widen* the tolerance relative to the fixed
    /// `1e-6` it replaces, never narrow it — a bare `extent * F32_ULP_SCALE`
    /// is far tighter than `1e-6` for any extent under ~4.19 units, which
    /// would reintroduce at small extents the misclassification this exists
    /// to fix at large ones.
    pub(super) fn new(mesh: &Mesh, floor: f64) -> Self {
        let mut axis_noise = [0.0f64; 3];
        for (i, &c) in mesh.positions.iter().enumerate() {
            let a = (c as f64).abs();
            let axis = i % 3;
            if a > axis_noise[axis] {
                axis_noise[axis] = a;
            }
        }
        for noise in axis_noise.iter_mut() {
            *noise *= F32_ULP_SCALE;
        }
        Self { axis_noise, floor }
    }

    /// Resolve into a scalar tolerance for a plane with unit normal `n`:
    ///
    /// ```text
    /// eps(n) = max(floor, |n_x|*noise_x + |n_y|*noise_y + |n_z|*noise_z)
    /// ```
    ///
    /// # Why there is no division by `|n|` (unlike the TypeScript)
    ///
    /// `epsForPlane` in `packages/clash/src/contact/tri-tri.ts` divides the
    /// projected sum by `ln = |N|`. The reason is NOT merely that
    /// [`Plane::new`] normalizes and the TS is handed raw triangle normals —
    /// that is the weaker half. The load-bearing reason is that the TS
    /// divides its DISTANCES by `ln` too (`tri-tri.ts:82-84`:
    /// `(dot3(N2, a.v0) + d2) / ln2`), so eps and distance are compared in the
    /// same normalized units. Rust's [`Plane::signed_distance`] does not
    /// normalize anything at compare time — it dots against the stored normal
    /// as-is — so eps must carry the same `|n|` factor the distance does.
    /// Dividing here would make a `|n| = k` plane `k^2` too tight, not `k`.
    ///
    /// # Relation to a max-over-axes scalar: up to sqrt(3) LOOSER
    ///
    /// The L1 sum is not uniformly tighter than the max-over-axes form it
    /// replaces. For a unit normal, `sum_i |n_i| * M_i <= sqrt(3) * max_i M_i`,
    /// with equality for a body-diagonal normal on an axis-symmetric mesh — so
    /// a diagonal normal measures exactly `sqrt(3)` looser at every magnitude
    /// above the floor crossover. That is correct, not a defect: it is the
    /// right worst-case bound when all three axes' rounding errors can align,
    /// and the projection is still a pure restriction of WHICH axes may widen
    /// the tolerance (an axis orthogonal to `n` contributes exactly nothing).
    /// Any prose claiming this form is "never looser" than max-over-axes is
    /// wrong.
    pub(super) fn for_normal(&self, n: &Vector3<f64>) -> f64 {
        let projected = n.x.abs() * self.axis_noise[0]
            + n.y.abs() * self.axis_noise[1]
            + n.z.abs() * self.axis_noise[2];
        projected.max(self.floor)
    }
}

/// Classify `triangle`'s vertices against `plane` within the tolerance band
/// `eps` and split accordingly.
///
/// Same as [`super::ClippingProcessor::clip_triangle`], but with an explicit
/// classification epsilon instead of the processor's fixed floor.
/// [`super::ClippingProcessor::clip_mesh`] uses this to pass a per-call
/// epsilon resolved by [`PlaneEps::for_normal`] against the plane's own
/// normal, without mutating `self` through a `&self` API. Takes no `self`:
/// every tolerance it consults arrives in `eps`.
pub(super) fn clip_triangle_with_epsilon(
    triangle: &Triangle,
    plane: &Plane,
    eps: f64,
) -> ClipResult {
    // Calculate signed distances for all vertices
    let d0 = plane.signed_distance(&triangle.v0);
    let d1 = plane.signed_distance(&triangle.v1);
    let d2 = plane.signed_distance(&triangle.v2);

    // Edge intersection parameter, clamped to the segment. Vertices are
    // classified front/back with an epsilon band (`d >= -epsilon`), so a
    // "front" vertex can sit slightly behind the plane (d in [-epsilon, 0)).
    // Feeding that raw distance into `d_front / (d_front - d_back)` yields a
    // t outside [0, 1] — and when the plane is nearly coincident with a host
    // face the denominator collapses, extrapolating the cut vertex far off
    // the edge (issue #1155: a clipped column flew ~97 m). Clamping keeps the
    // intersection on the edge; the near-zero guard avoids a NaN from a
    // degenerate (in-plane) edge.
    let edge_t = |d_front: f64, d_back: f64| -> f64 {
        let denom = d_front - d_back;
        if denom.abs() < 1.0e-12 {
            0.0
        } else {
            (d_front / denom).clamp(0.0, 1.0)
        }
    };

    // Count vertices in front of plane
    let mut front_count = 0;
    if d0 >= -eps {
        front_count += 1;
    }
    if d1 >= -eps {
        front_count += 1;
    }
    if d2 >= -eps {
        front_count += 1;
    }

    match front_count {
        // All vertices behind - discard triangle
        0 => ClipResult::AllBehind,

        // All vertices in front - keep triangle
        3 => ClipResult::AllFront(triangle.clone()),

        // One vertex in front - create 1 smaller triangle
        1 => {
            let (front, back1, back2) = if d0 >= -eps {
                (triangle.v0, triangle.v1, triangle.v2)
            } else if d1 >= -eps {
                (triangle.v1, triangle.v2, triangle.v0)
            } else {
                (triangle.v2, triangle.v0, triangle.v1)
            };

            // Interpolate to find intersection points
            let d_front = if d0 >= -eps {
                d0
            } else if d1 >= -eps {
                d1
            } else {
                d2
            };
            let d_back1 = if d0 >= -eps {
                d1
            } else if d1 >= -eps {
                d2
            } else {
                d0
            };
            let d_back2 = if d0 >= -eps {
                d2
            } else if d1 >= -eps {
                d0
            } else {
                d1
            };

            let t1 = edge_t(d_front, d_back1);
            let t2 = edge_t(d_front, d_back2);

            let p1 = front + (back1 - front) * t1;
            let p2 = front + (back2 - front) * t2;

            ClipResult::Split(smallvec::smallvec![Triangle::new(front, p1, p2)])
        }

        // Two vertices in front - create 2 triangles
        2 => {
            let (front1, front2, back) = if d0 < -eps {
                (triangle.v1, triangle.v2, triangle.v0)
            } else if d1 < -eps {
                (triangle.v2, triangle.v0, triangle.v1)
            } else {
                (triangle.v0, triangle.v1, triangle.v2)
            };

            // Interpolate to find intersection points
            let d_back = if d0 < -eps {
                d0
            } else if d1 < -eps {
                d1
            } else {
                d2
            };
            let d_front1 = if d0 < -eps {
                d1
            } else if d1 < -eps {
                d2
            } else {
                d0
            };
            let d_front2 = if d0 < -eps {
                d2
            } else if d1 < -eps {
                d0
            } else {
                d1
            };

            let t1 = edge_t(d_front1, d_back);
            let t2 = edge_t(d_front2, d_back);

            let p1 = front1 + (back - front1) * t1;
            let p2 = front2 + (back - front2) * t2;

            ClipResult::Split(smallvec::smallvec![
                Triangle::new(front1, front2, p1),
                Triangle::new(front2, p2, p1),
            ])
        }

        _ => unreachable!(),
    }
}
