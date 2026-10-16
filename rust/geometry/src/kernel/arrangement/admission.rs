// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Operand admission: the coordinate range the arrangement answers correctly
//! (#7677, KERNEL-30). Out-of-range operands are refused through the
//! arrangement's existing non-conformity signal, never answered wrongly.

use super::{Arrangement, MultiArrangement, Tri};
use super::super::interner::Interner;

/// Largest `|coordinate|` an arrangement operand may carry: 2^128.
///
/// 2^128 is the overflow bound only. It is NOT the range the arrangement
/// answers correctly: the kernel's tolerances (bands) are absolute, in the
/// caller's units, so very small scales (about 2^-8 and below) can still give
/// wrong results, sometimes with `conforming == true`. File input cannot reach
/// those scales, because operands are snapped to a 2^-16 grid
/// (`mesh_bridge::SNAP_GRID`).
///
/// Derivation. With every coordinate in `±M`, a coordinate difference is at
/// most `D = 2M`. The kernel's deepest plain-f64 product chain (not counting
/// the interval and fixed-width filters, which only escalate on overflow, nor
/// the exact BigRational tier) is the near-coplanar band test in
/// `classify::near_on_surface_tri` and `tritri::near_coplanar`:
/// `n = (b-a)×(c-a)` is at most `2D²` per axis, `d = (p-a)·n` at most `6D³`,
/// and the comparison is `d² ≤ band²·|n|²`, degree 6, at most `2^6·D^6`. The
/// other f64 chains are shallower: Shewchuk's `orient3d` expansions and error
/// bound are degree 3 (and exact only while no product overflows),
/// `tritri::line_direction`'s `n1×n2` is degree 4 (`8D⁴`), and the ray-parity
/// endpoints are degree 1. With `M = 2^128`, `D ≤ 2^129` and the worst
/// intermediate is `2^6·2^774 = 2^780`, which leaves a 2^243 margin below
/// `f64::MAX ≈ 2^1024`. Measured: boxes stay exact up to coordinates of
/// 2^161, and the degree-6 chain overflows past about 2^168.
///
/// `f32::MAX < 2^128`, so every operand built from a `Mesh` (f32 positions,
/// `mesh_bridge::mesh_to_tris`) is admitted; only direct f64 callers can be
/// refused. Real IFC coordinates are below 1e10 even in millimetres.
pub const MAX_OPERAND_COORD: f64 = 340_282_366_920_938_463_463_374_607_431_768_211_456.0;

/// True when every coordinate of every operand is finite and within
/// [`MAX_OPERAND_COORD`]. `NaN` fails the comparison, so it is refused too.
pub fn operands_admitted(operands: &[&[Tri]]) -> bool {
    operands.iter().all(|tris| tris.iter().flatten().flatten().all(|v| v.abs() <= MAX_OPERAND_COORD))
}

/// The refusal: an empty arrangement flagged non-conforming (`unrecovered`),
/// the same signal `difference_all` rejects on and `boolean_with_conformity`
/// and `union_all` report, so no caller can read it as a real empty result.
pub(super) fn refused() -> Arrangement {
    Arrangement {
        interner: Interner::new(),
        tris_a: Vec::new(),
        tris_b: Vec::new(),
        unrecovered: 1,
        coplanar_a: Vec::new(),
        coplanar_b: Vec::new(),
        f64_cache: std::cell::RefCell::new(Vec::new()),
    }
}

/// [`refused`] for the N-ary arrangement: one empty sub-triangle list per mesh.
pub(super) fn refused_many(meshes: usize) -> MultiArrangement {
    MultiArrangement { interner: Interner::new(), subtris: vec![Vec::new(); meshes], unrecovered: 1 }
}
