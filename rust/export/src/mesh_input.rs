// SPDX-License-Identifier: MPL-2.0
//! The one gate every from-meshes exporter passes its numeric input through.
//!
//! `export_glb_from_meshes`, `try_export_collada_from_meshes` and (through the latter)
//! `try_export_kmz_collada_from_meshes` all take the same flattened parallel arrays —
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

use crate::error::ExportError;

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
/// Indices and counts are integers and need no scrub; the index VALUES have
/// their own gate, [`first_index_out_of_range`].
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

/// Refuse one mesh's index block unless it is whole triangles that each name a
/// vertex of that mesh.
///
/// Both from-meshes writers call this, so they refuse the same inputs with the
/// same [`ExportError::MalformedMeshInput`] (#4684). Two shapes fail:
///
/// * a block whose length is not a multiple of 3. glTF 2.0 requires a
///   `TRIANGLES` index count divisible by 3, and the GLB assembler writes
///   `count: indices.len()`; COLLADA used to trim the partial triangle and
///   report success.
/// * an index at or past the mesh's vertex count (glTF 2.0 3.7.2.1). The GLB
///   assembler copies indices into the BIN chunk verbatim; COLLADA used to drop
///   the triangle and report success with the face missing.
///
/// The caller has already established that the block lies inside `indices`.
/// The max over the block rather than an early-exit `find`: the fold
/// vectorises, and the reported value is still a concrete offender.
pub(crate) fn check_index_block(
    mesh: usize,
    block: &[u32],
    vertex_count: u32,
) -> Result<(), ExportError> {
    if !block.len().is_multiple_of(3) {
        return Err(ExportError::MalformedMeshInput {
            detail: format!(
                "mesh {mesh} has {} indices, which is not a whole number of triangles",
                block.len()
            ),
        });
    }
    match block.iter().max() {
        Some(&largest) if largest >= vertex_count => Err(ExportError::MalformedMeshInput {
            detail: format!(
                "mesh {mesh} has index {largest} but only {vertex_count} vertices (an index \
                 must be less than its mesh's vertex count)"
            ),
        }),
        _ => Ok(()),
    }
}

/// [`check_index_block`] over every mesh's block, in order. The caller has
/// already established that `index_counts` covers every mesh and that the
/// blocks fit inside `indices`.
pub(crate) fn check_index_blocks(
    indices: &[u32],
    vertex_counts: &[u32],
    index_counts: &[u32],
) -> Result<(), ExportError> {
    let mut ibase = 0usize;
    for (mesh, (&vertex_count, &ic)) in vertex_counts.iter().zip(index_counts).enumerate() {
        check_index_block(mesh, &indices[ibase..ibase + ic as usize], vertex_count)?;
        ibase += ic as usize;
    }
    Ok(())
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

    /// One mesh of three vertices through both from-meshes writers.
    fn both_writers(
        indices: &[u32],
    ) -> (Result<(), crate::ExportError>, Result<(), crate::ExportError>) {
        let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let normals = [0.0f32, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let (vc, ic) = ([3u32], [indices.len() as u32]);
        let (color, origin) = ([0.5f32, 0.5, 0.5, 1.0], [0.0f64; 3]);
        let glb = crate::try_export_glb_from_meshes(
            &positions, &normals, indices, &vc, &ic, &color, &origin, &[1], false, true, false,
        )
        .map(drop);
        let dae = crate::try_export_collada_from_meshes(
            &positions, &normals, indices, &vc, &ic, &color, &origin,
        )
        .map(drop);
        (glb, dae)
    }

    /// #4684: the GLB and COLLADA writers refuse the same malformed index blocks
    /// with the same error. GLB used to ship a partial triangle as a TRIANGLES
    /// primitive whose count is not a multiple of 3; COLLADA used to trim that
    /// partial triangle and drop a triangle naming a vertex outside its mesh,
    /// then report success with the face missing.
    #[test]
    fn both_from_meshes_writers_refuse_the_same_malformed_index_blocks() {
        for (label, indices) in [
            ("partial triangle", &[0u32, 1, 2, 0, 1][..]),
            ("index past the mesh beside a valid triangle", &[0, 1, 2, 0, 1, 7][..]),
            ("index equal to the vertex count", &[0, 1, 2, 0, 1, 3][..]),
        ] {
            let (glb, dae) = both_writers(indices);
            assert!(
                matches!(glb, Err(crate::ExportError::MalformedMeshInput { .. })),
                "{label}: GLB must refuse, got {glb:?}"
            );
            assert_eq!(dae, glb, "{label}: COLLADA must refuse exactly as GLB does");
        }
        assert_eq!(both_writers(&[0, 1, 2]), (Ok(()), Ok(())), "a whole in-range triangle exports");
    }
}
