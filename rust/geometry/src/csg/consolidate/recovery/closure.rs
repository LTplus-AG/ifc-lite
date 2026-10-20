// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact, private admission certificate for the optional remote-plane retry.

use crate::kernel::mesh_bridge::SNAP_GRID;
use crate::mesh::Mesh;
use bnum::cast::CastFrom;
use bnum::types::I256;
use num_traits::ConstZero;
use rustc_hash::FxHashMap;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Signature {
    bounds: [i64; 6],
    volume6: I256,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Rejected {
    Empty,
    Invalid,
    Collapsed,
    RepeatedDirection,
    Unpaired,
    ZeroVolume,
    Overflow,
}

pub(super) fn is_closed(mesh: &Mesh) -> bool {
    analyze(mesh, false).is_ok()
}

pub(super) fn closed_signature(mesh: &Mesh) -> Result<Signature, Rejected> {
    analyze(mesh, true)
}

/// Match the kernel's actual fixed grid in incoming caller coordinates. It
/// is 15 micrometres only when those coordinates are metres. No physical-unit
/// tolerance is introduced here.
fn point(mesh: &Mesh, index: u32) -> Result<[i64; 3], Rejected> {
    let base = (index as usize).checked_mul(3).ok_or(Rejected::Invalid)?;
    let mut point = [0; 3];
    for (axis, coordinate) in point.iter_mut().enumerate() {
        let value = f64::from(*mesh.positions.get(base + axis).ok_or(Rejected::Invalid)?);
        let grid = (value / SNAP_GRID).round();
        // The upper endpoint is excluded: i64::MAX rounds to 2^63 as f64.
        if !grid.is_finite() || grid < i64::MIN as f64 || grid >= -(i64::MIN as f64) {
            return Err(Rejected::Invalid);
        }
        *coordinate = grid as i64;
    }
    Ok(point)
}

fn analyze(mesh: &Mesh, include_volume: bool) -> Result<Signature, Rejected> {
    if mesh.indices.is_empty() {
        return Err(Rejected::Empty);
    }
    if !mesh.indices.len().is_multiple_of(3) || !mesh.positions.len().is_multiple_of(3) {
        return Err(Rejected::Invalid);
    }
    let mut edges: FxHashMap<([i64; 3], [i64; 3]), [u8; 2]> = Default::default();
    let mut bounds = [i64::MAX, i64::MAX, i64::MAX, i64::MIN, i64::MIN, i64::MIN];
    let mut volume6 = I256::ZERO;
    for triangle in mesh.indices.chunks_exact(3) {
        let [a, b, c] = [
            point(mesh, triangle[0])?,
            point(mesh, triangle[1])?,
            point(mesh, triangle[2])?,
        ];
        let ab: [I256; 3] = std::array::from_fn(|k| I256::cast_from(b[k]) - I256::cast_from(a[k]));
        let ac: [I256; 3] = std::array::from_fn(|k| I256::cast_from(c[k]) - I256::cast_from(a[k]));
        let cross = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];
        if cross == [I256::ZERO; 3] {
            return Err(Rejected::Collapsed);
        }
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let counts = edges.entry((x.min(y), x.max(y))).or_default();
            let direction = usize::from(x > y);
            if counts[direction] != 0 {
                return Err(Rejected::RepeatedDirection);
            }
            counts[direction] = 1;
        }
        if include_volume {
            for p in [a, b, c] {
                for k in 0..3 {
                    bounds[k] = bounds[k].min(p[k]);
                    bounds[k + 3] = bounds[k + 3].max(p[k]);
                }
            }
            // a dot ((b-a) cross (c-a)) is the exact grid tetrahedron
            // determinant. I256 products fit for i64 inputs; checked summation
            // declines rather than wrapping. On a closed surface this exact
            // integer sum is translation invariant, without a floating
            // cancellation bound or a new volume allowance.
            let determinant = I256::cast_from(a[0]) * cross[0]
                + I256::cast_from(a[1]) * cross[1]
                + I256::cast_from(a[2]) * cross[2];
            volume6 = volume6.checked_add(determinant).ok_or(Rejected::Overflow)?;
        }
    }
    if edges.values().any(|counts| *counts != [1, 1]) {
        return Err(Rejected::Unpaired);
    }
    if include_volume && volume6 == I256::ZERO {
        return Err(Rejected::ZeroVolume);
    }
    Ok(Signature { bounds, volume6 })
}

#[cfg(test)]
#[path = "closure_tests.rs"]
mod tests;
