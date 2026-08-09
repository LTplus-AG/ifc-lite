// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The IFC Z-up → WebGL Y-up conversion, in one place.
//!
//! Everything the producer emits is in the IFC frame; everything that crosses
//! the JS boundary is in the viewer's. Positions, normals and origins are a
//! plain per-component `(x,y,z) -> (x,z,-y)`, applied inline where they are
//! copied. Boxes and matrices are NOT: each needs a correction that is easy to
//! get subtly wrong and impossible to notice from the shape of the output, so
//! both live here with the reasoning stated once.

/// Swap an axis-aligned box's corners from IFC Z-up to WebGL Y-up
/// (`(x,y,z) -> (x,z,-y)`). A per-component swap of `min`/`max` independently
/// is WRONG: negating the Y axis flips which corner is the min/max along the
/// new Z, so the new Z range is `[-maxY, -minY]`, not `[-minY, -maxY]`.
///
/// Generic over the component type so the two boxes that cross this boundary
/// share ONE copy of that reversal and cannot drift apart: `MeshDataJs`'s
/// `f32` local bounds and `MeshCollection`'s `f64` world AABBs. The world box
/// must stay `f64` — it carries absolute world coordinates that can sit
/// kilometres from the origin, which is exactly the precision an `f32` helper
/// would throw away.
pub(super) fn swap_zup_to_yup_aabb<T: Copy + std::ops::Neg<Output = T>>(b: [T; 6]) -> [T; 6] {
    let [min_x, min_y, min_z, max_x, max_y, max_z] = b;
    [min_x, min_z, -max_y, max_x, max_z, -min_y]
}

/// Conjugate a row-major 4×4 matrix by the fixed IFC Z-up → WebGL Y-up swap
/// `S`: `(x,y,z,w) -> (x,z,-y,w)`, so a placement/rotation matrix expressed in
/// the IFC frame becomes valid in the Y-up frame the renderer uses:
/// `M' = S · M · Sᵀ` (S is orthogonal, so `S⁻¹ = Sᵀ`).
pub(super) fn swap_zup_to_yup_mat4(m: &[f64; 16]) -> [f64; 16] {
    #[rustfmt::skip]
    const S: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, -1.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    #[rustfmt::skip]
    const ST: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, -1.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    fn matmul(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
        let mut out = [0.0; 16];
        for r in 0..4 {
            for c in 0..4 {
                let mut sum = 0.0;
                for k in 0..4 {
                    sum += a[r * 4 + k] * b[k * 4 + c];
                }
                out[r * 4 + c] = sum;
            }
        }
        out
    }
    matmul(&matmul(&S, m), &ST)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The stored world boxes are IFC Z-up and JS is Y-up, so the
    /// `geometryAabbValues` getter runs this on the way out — and it is NOT a
    /// component-wise swap: negating Y flips which corner is the min along the
    /// new Z. The getter itself needs a JS realm, so the shared helper is
    /// pinned here for both component types it serves.
    #[test]
    fn zup_to_yup_reverses_min_max_on_the_negated_axis() {
        // y spans [2, 5] in IFC ⇒ the new z spans [-5, -2], not [-2, -5].
        let world = swap_zup_to_yup_aabb([1.0f64, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(world, [1.0, 3.0, -5.0, 4.0, 6.0, -2.0]);
        assert!(world[2] <= world[5], "min must stay <= max on the negated axis");

        // MeshDataJs's f32 local bounds take the identical path.
        let local = swap_zup_to_yup_aabb([1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(local, [1.0, 3.0, -5.0, 4.0, 6.0, -2.0]);
    }

    /// The world box is `f64` precisely so a box at national-grid coordinates
    /// keeps sub-millimetre resolution — finer than the 1 mm grid the companion
    /// geometry hash quantizes on. Routing it through an `f32` helper would
    /// destroy that, so the conversion must be exact.
    #[test]
    fn the_world_box_survives_the_swap_at_national_grid_coordinates() {
        let ifc = [
            2_600_000.000_5_f64,
            1_200_000.000_5,
            0.0,
            2_600_001.000_5,
            1_200_001.000_5,
            3.0,
        ];
        let out = swap_zup_to_yup_aabb(ifc);
        assert_eq!(out, [ifc[0], ifc[2], -ifc[4], ifc[3], ifc[5], -ifc[1]]);
        assert_ne!(
            out[2], out[2] as f32 as f64,
            "the fixture must be one an f32 round-trip would visibly move"
        );
    }
}
