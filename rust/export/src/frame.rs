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
//! - triangle winding reversed (mirrors `MeshDataJs::new`, keeps front faces)
//! - per-element `origin` swapped the same way
//!
//! The from-meshes GLB path (the viewer's own `MeshData`) is already Y-up and
//! must NOT be re-swapped — only this from-bytes path applies it.

/// Convert a single IFC Z-up point/vector to WebGL Y-up: `(x, y, z) -> (x, z, -y)`.
#[inline]
pub(crate) fn yup_f32(p: [f32; 3]) -> [f32; 3] {
    [p[0], p[2], -p[1]]
}

/// Same conversion for an f64 point (the per-element `origin`).
#[inline]
pub(crate) fn yup_f64(p: [f64; 3]) -> [f64; 3] {
    [p[0], p[2], -p[1]]
}

/// The same frame change applied to a whole column-major 4x4, so a placement
/// authored in IFC Z-up can ride on a glTF node.
///
/// Converting the translation column alone is not enough. `yup_f64` is `C * p`
/// for the basis change `C: (x, y, z) -> (x, z, -y)`; a *transform* in the new
/// frame is `C * M * C_inv`, because the vector it acts on has to be carried
/// back into the old frame, transformed, and brought forward again. Skipping
/// the `C_inv` half leaves a rotation about the wrong axis, which still looks
/// like a rotation and is not one.
#[inline]
pub(crate) fn yup_matrix4(m: &[f64]) -> [f64; 16] {
    debug_assert!(m.len() >= 16);
    // Column-major: element (row r, col c) is m[c * 4 + r].
    let at = |r: usize, c: usize| m[c * 4 + r];
    // Left-multiplying by C permutes rows: new row 0 = row 0, 1 = row 2,
    // 2 = -row 1. Row 3 is not part of the basis change; folding it into the
    // `-row 1` arm leaves the bottom row as (-r10, -r12, r11, -ty) instead of
    // (0, 0, 0, 1), which no current caller reads and the first one to compose
    // or invert this would inherit in silence.
    let row = |r: usize, c: usize| match r {
        0 => at(0, c),
        1 => at(2, c),
        2 => -at(1, c),
        _ => at(3, c),
    };
    // Right-multiplying by C_inv permutes columns. C_inv's columns are e0, e2
    // and -e1, so new col 0 = col 0, col 1 = col 2, col 2 = -col 1.
    let cell = |r: usize, c: usize| match c {
        0 => row(r, 0),
        1 => row(r, 2),
        2 => -row(r, 1),
        _ => row(r, 3),
    };
    let mut out = [0.0f64; 16];
    for c in 0..4 {
        for r in 0..4 {
            out[c * 4 + r] = cell(r, c);
        }
    }
    out
}

/// Reusable owned buffers for the streaming Y-up conversion. The streaming/bounded
/// export passes convert one mesh at a time and drop it; reusing a single scratch across
/// meshes (clear + refill, capacity persists) avoids the 3 fresh heap allocations per
/// mesh that per-call [`to_yup`] incurred — on a million-submesh model, per pass.
pub(crate) struct YUpScratch {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub origin: [f64; 3],
}

impl YUpScratch {
    pub(crate) fn new() -> Self {
        Self {
            positions: Vec::new(),
            normals: Vec::new(),
            indices: Vec::new(),
            origin: [0.0; 3],
        }
    }
}

/// [`to_yup`] into a reusable [`YUpScratch`] instead of freshly allocated buffers. The
/// scratch is cleared and refilled, so its capacity is retained across calls; every value
/// is identical to [`to_yup`], so output is unchanged.
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
        scratch
            .positions
            .extend_from_slice(&yup_f32([c[0], c[1], c[2]]));
    }
    scratch.normals.clear();
    scratch.normals.reserve(normals.len());
    for c in normals.chunks_exact(3) {
        scratch
            .normals
            .extend_from_slice(&yup_f32([c[0], c[1], c[2]]));
    }
    scratch.indices.clear();
    scratch.indices.extend_from_slice(indices);
    let tri_end = scratch.indices.len() - scratch.indices.len() % 3;
    let mut i = 0;
    while i < tri_end {
        scratch.indices.swap(i + 1, i + 2);
        i += 3;
    }
    scratch.origin = yup_f64(origin);
}

/// In-place variant of [`to_yup`]: rewrites `positions` / `normals` / `indices` /
/// `origin` from IFC Z-up to WebGL Y-up WITHOUT allocating new buffers. The in-memory
/// GLB path owns its `MeshData` and drops it immediately after assembly, so mutating it
/// is invisible to any other consumer. Every value matches [`to_yup`]
/// (`(x,y,z) -> (x,z,-y)`, winding reversed), so the emitted GLB is byte-for-byte
/// unchanged — it just skips the full second copy of the model's geometry.
pub(crate) fn to_yup_in_place(
    positions: &mut [f32],
    normals: &mut [f32],
    indices: &mut [u32],
    origin: &mut [f64; 3],
) {
    for c in positions.chunks_exact_mut(3) {
        // new = (x, z, -y); read y and z before overwriting.
        let (y, z) = (c[1], c[2]);
        c[1] = z;
        c[2] = -y;
    }
    for c in normals.chunks_exact_mut(3) {
        let (y, z) = (c[1], c[2]);
        c[1] = z;
        c[2] = -y;
    }
    let tri_end = indices.len() - indices.len() % 3;
    let mut i = 0;
    while i < tri_end {
        indices.swap(i + 1, i + 2);
        i += 3;
    }
    *origin = yup_f64(*origin);
}

#[cfg(test)]
#[path = "frame_tests.rs"]
mod frame_tests;
