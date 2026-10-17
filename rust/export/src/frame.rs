// SPDX-License-Identifier: MPL-2.0
//! IFC Z-up → WebGL Y-up frame conversion for the **from-bytes** exporters.
//!
//! `ifc_lite_processing::process_geometry` emits geometry in the producer-native
//! IFC **Z-up** frame. The Z-up→Y-up swap that every rendered/exported mesh
//! normally undergoes happens at the wasm FFI (`MeshDataJs::new`) — which the
//! from-bytes export path (CLI / MCP / SDK) never crosses. glTF 2.0 *mandates*
//! +Y up, and the viewer / legacy GLTFExporter output is Y-up, so the from-bytes
//! GLB/OBJ exporters must redo the identical conversion to match:
//!
//! - positions + normals: `(x, y, z) -> (x, z, -y)`
//! - triangle winding preserved: this is a determinant +1 rotation, not a reflection
//! - per-element `origin` swapped the same way
//!
//! The from-meshes GLB path (the viewer's own `MeshData`) is already Y-up and
//! must NOT be re-swapped — only this from-bytes path applies it.

use ifc_lite_geometry::math::frame::{self, zup_to_yup};

/// The same frame change applied to a whole column-major 4x4, so a placement
/// authored in IFC Z-up can ride on a glTF node: `C * M * C_inv` for the basis
/// change `C: (x, y, z) -> (x, z, -y)`, not just the translation column.
/// Conjugation is storage-agnostic, so the column-major array goes straight
/// through geometry's `frame::conjugate_zup_to_yup` (the one definition).
#[inline]
pub(crate) fn yup_matrix4(m: &[f64]) -> [f64; 16] {
    debug_assert!(m.len() >= 16);
    let mut a = [0.0f64; 16];
    a.copy_from_slice(&m[..16]);
    frame::conjugate_zup_to_yup(&a)
}

/// The frame a from-meshes writer was told its meshes were baked in: the
/// column-major 4x4 `world = M · baked` (IFC Z-up, metres) as a
/// [`MeshFrame`], so it restores through the same `world_matrix` / `to_world`
/// arithmetic as a `ProcessingResult` does (#7734). `None` is an unshifted
/// model. Refuses anything that is not 16 finite numbers: a NaN here would
/// move the whole model, and glTF JSON has no spelling for it.
pub(crate) fn mesh_frame_from_world_matrix(
    world: Option<&[f64]>,
) -> Result<ifc_lite_processing::MeshFrame, crate::error::ExportError> {
    use ifc_lite_processing::MeshFrame;
    let Some(m) = world else {
        return Ok(MeshFrame::RawIfc);
    };
    if m.len() != 16 || m.iter().any(|v| !v.is_finite()) {
        return Err(crate::error::ExportError::MalformedMeshInput {
            detail: format!(
                "`world_matrix` must be 16 finite numbers (a column-major 4x4); got {} values{}",
                m.len(),
                if m.iter().any(|v| !v.is_finite()) { " including a non-finite one" } else { "" }
            ),
        });
    }
    // The root carries the matrix as glTF TRS, which has no spelling for a
    // projective row, a shear or a mirror, and a frame never is one: a bake
    // only ever subtracts a translation and a site's proper rotation. Anything
    // else would come out as a root whose rotation disagrees with the matrix.
    if !is_rigid(m) {
        return Err(crate::error::ExportError::MalformedMeshInput {
            detail: "`world_matrix` must be a rigid transform (an orthonormal rotation with \
                     determinant +1, a translation, bottom row 0 0 0 1)"
                .to_owned(),
        });
    }
    Ok(MeshFrame::from_world_matrix(m))
}

/// `m` (column-major, 16 finite numbers) is a proper rotation plus a
/// translation, within a tolerance well above f64 placement noise.
fn is_rigid(m: &[f64]) -> bool {
    const TOL: f64 = 1e-6;
    let col = |c: usize| [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let (x, y, z) = (col(0), col(1), col(2));
    let cross = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    let bottom = [m[3], m[7], m[11], m[15] - 1.0];
    bottom.iter().all(|v| v.abs() <= TOL)
        && [(x, x, 1.0), (y, y, 1.0), (z, z, 1.0), (x, y, 0.0), (x, z, 0.0), (y, z, 0.0)]
            .iter()
            .all(|&(a, b, want)| (dot(a, b) - want).abs() <= TOL)
        && dot(cross, z) > 0.0
}

/// Reusable owned buffers for the streaming Y-up conversion. The streaming/bounded
/// export passes convert one mesh at a time and drop it; reusing a single scratch across
/// meshes (clear + refill, capacity persists) avoids the 3 fresh heap allocations per
/// mesh that allocating fresh buffers would incur — on a million-submesh model, per pass.
pub(crate) struct YUpScratch {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub origin: [f64; 3],
}

impl YUpScratch {
    pub(crate) fn new() -> Self {
        Self { positions: Vec::new(), normals: Vec::new(), indices: Vec::new(), origin: [0.0; 3] }
    }
}

/// Convert into reusable buffers, preserving triangle winding. The scratch is
/// cleared and refilled, so its capacity is retained across calls.
pub(crate) fn to_yup_into(
    scratch: &mut YUpScratch,
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    origin: [f64; 3],
) {
    scratch.positions.clear();
    scratch.positions.reserve(positions.len());
    for c in positions.chunks_exact(3) {
        scratch.positions.extend_from_slice(&zup_to_yup([c[0], c[1], c[2]]));
    }
    scratch.normals.clear();
    scratch.normals.reserve(normals.len());
    for c in normals.chunks_exact(3) {
        scratch.normals.extend_from_slice(&zup_to_yup([c[0], c[1], c[2]]));
    }
    scratch.indices.clear();
    scratch.indices.extend_from_slice(indices);
    scratch.origin = zup_to_yup(origin);
}

/// In-place variant of [`to_yup_into`], without allocating new buffers.
/// The determinant +1 frame rotation preserves triangle indices and winding.
pub(crate) fn to_yup_in_place(
    positions: &mut [f32],
    normals: &mut [f32],
    _indices: &mut [u32],
    origin: &mut [f64; 3],
) {
    frame::zup_to_yup_in_place(positions);
    frame::zup_to_yup_in_place(normals);
    *origin = zup_to_yup(*origin);
}

#[cfg(test)]
#[path = "frame_tests.rs"]
mod frame_tests;
