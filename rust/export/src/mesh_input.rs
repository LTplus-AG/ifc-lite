// SPDX-License-Identifier: MPL-2.0
//! The one gate every from-meshes exporter passes its numeric input through.
//!
//! `export_glb_from_meshes`, `export_collada_from_meshes` and (through the latter)
//! `export_kmz_collada_from_meshes` all take the same flattened parallel arrays —
//! the viewer's `MeshData`, handed across the wasm FFI by
//! `GeometryProcessor.exportGlbFromMeshes` / `exportKmzFromMeshes`. Those buffers
//! reach the FFI from whatever produced the meshes (the geometry pipeline, the
//! demesher, or a caller's own `addMeshes`), and no layer between there and the
//! bytes established that a coordinate was finite.
//!
//! It matters because neither target format can carry a non-finite number:
//!
//! * **glTF/GLB.** The glTF 2.0 spec forbids `NaN`/`Infinity` in the JSON, and
//!   `serde_json` renders one as `null` — an accessor `min` of `[null,-0.5,0.0]`
//!   or a node `translation` of `[null,0.5,0.0]` is schema-invalid, and every
//!   validator and loader rejects it. Worse, a `NaN` *position* used to reach the
//!   BIN chunk while `min`/`max` stayed finite, because `NaN < min` and
//!   `NaN > max` are both false: a bounding box that lies about its own buffer.
//! * **COLLADA/KMZ.** `<float_array>` is `xs:float`, whose only non-finite lexical
//!   forms are `INF`, `-INF` and `NaN`; Rust's `Display` writes `inf`/`-inf`,
//!   which are not even that. And because the exporter re-centres on the mesh
//!   AABB, ONE non-finite vertex turned every OTHER vertex in the document into
//!   `inf`/`NaN` — one bad vertex, no surviving geometry.
//!
//! So the rule is enforced once, here, on the whole input, before either exporter's
//! per-mesh loop runs — rather than at each of the several places a value becomes
//! bytes, where it is one edit away from covering three call sites out of four.
//!
//! **Scrub, not reject.** A non-finite component is replaced with `0.0` (alpha with
//! `1.0`), matching what the USD writer already does (`usd::fmt::fmt_f32`). Zeroing
//! one component leaves a spike toward the mesh origin, which is visibly wrong in
//! the one degenerate face that produced it; letting it through costs the entire
//! file. Alpha is the exception: scrubbing it to `0` would turn a colour defect into
//! an invisible mesh, trading a loud failure for a silent one.

use std::borrow::Cow;

/// Non-finite → `0.0`, everything else untouched (including `-0.0`).
#[inline]
fn finite_or_zero_f32(v: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

#[inline]
fn finite_or_zero_f64(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

/// Borrow the slice when every element is already finite; otherwise return an owned
/// copy with the offenders zeroed. The all-finite path — the only one a well-formed
/// model takes — allocates nothing and copies nothing.
fn scrub_f32(v: &[f32]) -> Cow<'_, [f32]> {
    if v.iter().all(|x| x.is_finite()) {
        Cow::Borrowed(v)
    } else {
        Cow::Owned(v.iter().copied().map(finite_or_zero_f32).collect())
    }
}

fn scrub_f64(v: &[f64]) -> Cow<'_, [f64]> {
    if v.iter().all(|x| x.is_finite()) {
        Cow::Borrowed(v)
    } else {
        Cow::Owned(v.iter().copied().map(finite_or_zero_f64).collect())
    }
}

/// RGBA quads: a non-finite R/G/B becomes `0.0`, a non-finite A becomes `1.0`.
///
/// The array is RGBA per mesh, so alpha is every fourth element. A trailing partial
/// quad (a caller passing fewer floats than `4 * meshes`) is scrubbed by the same
/// positional rule; the exporters already default any missing component themselves.
fn scrub_colors(v: &[f32]) -> Cow<'_, [f32]> {
    if v.iter().all(|x| x.is_finite()) {
        Cow::Borrowed(v)
    } else {
        Cow::Owned(
            v.iter()
                .copied()
                .enumerate()
                .map(|(i, x)| {
                    if x.is_finite() {
                        x
                    } else if i % 4 == 3 {
                        1.0
                    } else {
                        0.0
                    }
                })
                .collect(),
        )
    }
}

/// The scrubbed numeric input of a from-meshes export. Deref each field to a slice.
pub(crate) struct MeshInput<'a> {
    pub(crate) positions: Cow<'a, [f32]>,
    pub(crate) normals: Cow<'a, [f32]>,
    pub(crate) colors: Cow<'a, [f32]>,
    pub(crate) origins: Cow<'a, [f64]>,
}

/// Gate the four float arrays of a from-meshes export. See the module docs for why
/// this exists and why it scrubs rather than rejects.
///
/// Indices and counts are integers and need no gate.
pub(crate) fn scrub_nonfinite<'a>(
    positions: &'a [f32],
    normals: &'a [f32],
    colors: &'a [f32],
    origins: &'a [f64],
) -> MeshInput<'a> {
    MeshInput {
        positions: scrub_f32(positions),
        normals: scrub_f32(normals),
        colors: scrub_colors(colors),
        origins: scrub_f64(origins),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_finite_input_is_borrowed_not_copied() {
        let p = [1.0f32, 2.0, 3.0];
        let o = [4.0f64];
        let input = scrub_nonfinite(&p, &p, &p, &o);
        assert!(matches!(input.positions, Cow::Borrowed(_)));
        assert!(matches!(input.normals, Cow::Borrowed(_)));
        assert!(matches!(input.colors, Cow::Borrowed(_)));
        assert!(matches!(input.origins, Cow::Borrowed(_)));
        assert_eq!(&*input.positions, &p);
        assert_eq!(&*input.origins, &o);
    }

    #[test]
    fn each_non_finite_form_is_zeroed_independently() {
        let p = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -1.5];
        let input = scrub_nonfinite(&p, &[], &[], &[]);
        assert_eq!(&*input.positions, &[0.0, 0.0, 0.0, -1.5]);

        let o = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.5];
        let input = scrub_nonfinite(&[], &[], &[], &o);
        assert_eq!(&*input.origins, &[0.0, 0.0, 0.0, -1.5]);
    }

    #[test]
    fn alpha_scrubs_to_one_so_the_mesh_stays_visible() {
        let c = [f32::NAN, 0.5, f32::INFINITY, f32::NEG_INFINITY];
        let input = scrub_nonfinite(&[], &[], &c, &[]);
        assert_eq!(&*input.colors, &[0.0, 0.5, 0.0, 1.0]);
    }

    #[test]
    fn negative_zero_survives() {
        let p = [-0.0f32];
        let input = scrub_nonfinite(&p, &[], &[], &[]);
        assert!(input.positions[0].is_sign_negative());
    }
}
