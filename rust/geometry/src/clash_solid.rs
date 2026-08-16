// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The intersection SOLID of a clashing pair — the overlap volume itself, as a
//! mesh the viewer can draw opaque while ghosting both parents (the BIMcollab
//! Zoom / Solibri presentation). A contact point tells you two elements touch;
//! this tells you how deep, in what shape, and in which direction.
//!
//! # On demand, never eager
//!
//! One model here yields 81 clashes. This entry point computes ONE pair and is
//! meant to be called when a clash row is selected, exactly like the existing
//! on-demand `@ifc-lite/clash/contact` path. Nothing in the detection sweep
//! calls it.
//!
//! # Why this is gated, and what the gate is
//!
//! The exact CSG kernel snaps every input coordinate to
//! [`SNAP_GRID`](crate::kernel::mesh_bridge) = `2^-16 m ≈ 15.26 µm` and treats
//! faces within [`near_band_from_extent`] of each other as coplanar. Inside that
//! band a thin overlap is not a thin solid — it is a *coplanar contact*, and the
//! arrangement returns a wedge rather than the slab. Measured on the analytic
//! box oracle (`tests/clash_intersection_oracle.rs`), a slab overlap reports:
//!
//! | penetration depth | reported volume |
//! |---|---|
//! | ≤ 8 snap cells (≤ 122 µm) | exactly **2/3** of the truth (−33 %), at every world scale |
//! | 10–24 cells (153–366 µm) | high by 5e-5 (at the origin) to 0.33 (at 1000 m) |
//! | ≥ 4 × the near band | **exact**, to f64, at every tessellation and world scale |
//!
//! So a naive "call the kernel and show the answer" API would draw a solid that
//! is a third too small for precisely the shallow clashes a coordinator cares
//! most about — and would report a volume for a 15 µm graze as if it meant
//! something. This module therefore refuses to return a solid it cannot stand
//! behind, and says why. The viewer draws the existing contact marker instead.
//!
//! This is a real limit, not a conservatism knob: below the near band there is
//! no exact solid to compute, only a coplanar contact, and the arrangement's
//! own output cannot tell you otherwise. **No intersection solid exists for
//! those pairs at this kernel's resolution**, and inventing one would be a
//! sliver, not a finding.
//!
//! Note what the sub-micron distances this kernel reports are NOT: evidence of
//! fine coordination issues. `TriMesh` ingests geometry as `f32` and queries it
//! in `f64`, so those distances land on the `f32` ULP at the pair's coordinate
//! magnitude — `2^-22 m ≈ 0.238 µm` for coordinates in `[2, 4)` — repeated
//! bit-identically across unrelated pairs, which is the signature of a
//! quantization floor rather than a physical graze. Do not state a real-world
//! graze distance here without a reproducible per-pair measurement behind it.

use crate::clash_contact_axes::{dot3, gate_axes};
use crate::kernel::arrangement::Tri;
use crate::kernel::mesh_bridge::{intersection_tris, near_band_from_extent};
use crate::mesh::Mesh;

/// Multiple of the kernel's near-coplanar band above which the intersection
/// volume was measured to be exactly analytic.
///
/// Evidence (`clash_intersection_oracle::intersection_is_exact_at_and_above_the_
/// trust_threshold` plus the recorded sweep in this module's docs): at world
/// offsets 0, 10, 100 and 1000 m the reported volume is exact from `4 ×` the
/// band upward, and carries a scale-dependent error below it. Lowering this
/// constant re-admits that error; it is not a free tightening.
const TRUST_BAND_MULTIPLE: f64 = 4.0;

/// Why no solid is being returned.
// Not `Eq`: `BelowKernelResolution` carries f64 measurements.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DegenerateReason {
    /// One or both operands had no triangles.
    EmptyOperand,
    /// The kernel's exact intersection is empty: the pair does not overlap, or
    /// overlaps by less than the `2^-16 m` snap grid so both faces snapped flush.
    /// A *touching* pair (coplanar faces, zero overlap) lands here.
    NoOverlap,
    /// The pair overlaps, but not deeply enough for the kernel's arrangement to
    /// resolve the overlap as a solid rather than a coplanar contact. The solid
    /// that would be returned here is systematically wrong (see the module
    /// docs), so it is withheld. `thickness_m` is the intersection's smallest
    /// extent over the candidate contact normals (see `gate_axes`), which for a
    /// box-box pair is the true penetration depth whatever the pair's
    /// orientation; `required_m` is the depth this pair would have needed.
    ///
    /// `thickness_m == 0.0` exactly is a real and distinct outcome, observed on
    /// the bridge model (`IfcColumn` #761 × `IfcWall` #828): the kernel returned
    /// triangles, but they are FLAT — a coplanar contact patch with no thickness
    /// at all, rather than a slab too thin to resolve. It is reported here
    /// instead of as [`NoOverlap`](Self::NoOverlap) because the arrangement did
    /// produce geometry; the caller's action is the same either way (fall back
    /// to the contact marker), and the two are told apart by this field.
    BelowKernelResolution { thickness_m: f64, required_m: f64 },
    /// The #1109 escalation budget tripped, so the arrangement is partial and
    /// nothing about it can be trusted.
    BudgetExhausted,
}

/// The overlap volume of one clashing pair.
///
/// `Solid` carries a closed, world-space triangle mesh in **f64** — not the f32
/// of [`Mesh`] — because the caller reports its volume, and the f32 round-trip
/// costs ~1e-7 relative on a quantity that is otherwise exact.
#[derive(Debug, Clone, PartialEq)]
pub enum IntersectionSolid {
    Solid {
        /// World-space vertex positions, `[x, y, z, …]`, f64.
        positions: Vec<f64>,
        /// Triangle indices into `positions / 3`.
        indices: Vec<u32>,
        /// Enclosed volume in m³. Exact to f64 on the analytic oracle.
        volume_m3: f64,
    },
    /// No solid to draw. The viewer keeps the contact marker it already has.
    Degenerate(DegenerateReason),
}

impl IntersectionSolid {
    /// `Some(volume)` for a solid, `None` when degenerate. Deliberately not
    /// `unwrap_or(0.0)`: "no measurable overlap" and "an overlap of zero" are
    /// different claims, and the caller must not be able to conflate them by
    /// accident.
    pub fn volume_m3(&self) -> Option<f64> {
        match self {
            Self::Solid { volume_m3, .. } => Some(*volume_m3),
            Self::Degenerate(_) => None,
        }
    }

    /// Triangle count of the solid; `0` when degenerate.
    pub fn triangle_count(&self) -> usize {
        match self {
            Self::Solid { indices, .. } => indices.len() / 3,
            Self::Degenerate(_) => 0,
        }
    }
}

/// Enclosed volume of a closed f64 triangle soup (divergence theorem).
fn tri_volume(tris: &[Tri]) -> f64 {
    tris.iter()
        .map(|t| {
            let (a, b, c) = (t[0], t[1], t[2]);
            let cr = [
                b[1] * c[2] - b[2] * c[1],
                b[2] * c[0] - b[0] * c[2],
                b[0] * c[1] - b[1] * c[0],
            ];
            a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
        })
        .sum::<f64>()
        .abs()
        / 6.0
}

/// Largest coordinate magnitude across both operands — the `extent` the kernel's
/// own near-coplanar band is sized from, so the gate widens with world distance
/// exactly as the kernel's own tolerance does.
fn operand_extent(a: &Mesh, b: &Mesh) -> f64 {
    a.positions
        .iter()
        .chain(b.positions.iter())
        .fold(0.0f64, |m, &c| {
            let c = c as f64;
            if c.is_finite() {
                m.max(c.abs())
            } else {
                m
            }
        })
}

/// The intersection solid of two world-space meshes, or an honest reason there
/// is none.
///
/// Both operands must already be in the **common world frame**: for a federated
/// pair the models' placements must be baked into `positions` before the call.
/// This function applies no transform and has no way to detect a missing one.
///
/// Costs one exact boolean of the two meshes; see the module docs for why the
/// result is gated rather than returned raw.
pub fn intersection_solid(a: &Mesh, b: &Mesh) -> IntersectionSolid {
    if a.indices.len() < 3 || b.indices.len() < 3 {
        return IntersectionSolid::Degenerate(DegenerateReason::EmptyOperand);
    }

    let tris = intersection_tris(a, b);
    if tris.is_empty() {
        // `intersection_tris` returns empty BOTH for a genuinely disjoint pair
        // and for a budget trip. Distinguish them: the budget state is still the
        // one this boolean left behind.
        let reason = if crate::kernel::budget::tripped() {
            DegenerateReason::BudgetExhausted
        } else {
            DegenerateReason::NoOverlap
        };
        return IntersectionSolid::Degenerate(reason);
    }

    // Gate on the solid's thinnest extent. It is a sound proxy for penetration
    // depth here BECAUSE it is the one quantity the misclassification does not
    // corrupt: the wedge the kernel returns for a sub-band overlap still spans
    // the full slab, so its extent still reports the true (too small)
    // thickness. Deriving the gate from the volume instead would be circular —
    // the volume is the thing under suspicion.
    //
    // WHICH DIRECTION that thickness is measured along is the other half of the
    // argument, and measuring it against the WORLD axes (as this did until the
    // #2573 review) is only right when the contact normal happens to be
    // parallel to one. Rotate the oracle's own 15–122 µm slab overlaps
    // obliquely and the wedge's min world-axis extent jumps to ~0.6 m: the gate
    // passed every one of them, and the volumes it returned ranged from 36 % to
    // 103 % of the truth, drifting with tessellation
    // (`rotated_near_band_overlap_is_withheld_exactly_as_the_axis_aligned_
    // one_is`, in the oracle). `gate_axes` supplies the contact normal
    // analytically instead, from the operands' own face planes, and keeps the
    // world axes in the set so the measure can only get stricter. See its doc
    // for what happens when an operand is not a box.
    //
    // Two earlier candidates were tried and rejected, both of which tried to
    // recover the direction from the KERNEL'S OUTPUT rather than from the
    // operands: (1) PCA of the wedge's vertex cloud is numerically unstable at
    // the aspect ratios this gate deals with and regressed the already-correct
    // axis-aligned case. (2) The normal of the wedge's largest-area triangle is
    // wrong precisely in the regime this gate exists for: below the near band
    // the kernel returns a genuine WEDGE (module docs above), not a flat slab,
    // so its largest face is not reliably the cap — measured thickness came out
    // over 30x too large on the very cases the oracle pins. Working from the
    // operands' face planes sidesteps the wedge entirely.
    let mut thickness = f64::INFINITY;
    for axis in &gate_axes(a, b) {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for t in &tris {
            for v in t {
                let p = dot3(*v, *axis);
                lo = lo.min(p);
                hi = hi.max(p);
            }
        }
        thickness = thickness.min(hi - lo);
    }
    let required = TRUST_BAND_MULTIPLE * near_band_from_extent(operand_extent(a, b));
    if thickness < required {
        return IntersectionSolid::Degenerate(DegenerateReason::BelowKernelResolution {
            thickness_m: thickness,
            required_m: required,
        });
    }

    // Weld to an indexed mesh on exact f64 bit patterns. The kernel's output
    // already shares vertex coordinates exactly between adjacent triangles
    // (it is an arrangement, not independently rounded facets), so a bitwise
    // key welds the seam without a tolerance — and a tolerance here could weld
    // two genuinely distinct vertices of a thin solid.
    let mut positions: Vec<f64> = Vec::new();
    let mut indices: Vec<u32> = Vec::with_capacity(tris.len() * 3);
    let mut seen: std::collections::HashMap<[u64; 3], u32> = std::collections::HashMap::new();
    for t in &tris {
        for v in t {
            let key = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
            let idx = *seen.entry(key).or_insert_with(|| {
                let i = (positions.len() / 3) as u32;
                positions.extend_from_slice(v);
                i
            });
            indices.push(idx);
        }
    }

    IntersectionSolid::Solid {
        positions,
        indices,
        volume_m3: tri_volume(&tris),
    }
}
