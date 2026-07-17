// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Demesher session core: simplify already-produced element meshes and hand
//! back BOTH a render-ready replacement mesh and the same vertices in the
//! element's IFC object-placement frame (file units) for tessellated IFC
//! re-export.
//!
//! Operates on the meshes the consumer already holds (the viewer's / SDK's
//! `MeshData`), NOT on file bytes: a button press must not re-parse and
//! re-mesh the whole model, and the placement capture the inverse transform
//! needs (`origin`, `local_to_world`, #1474) rides on those meshes.
//!
//! Frames: consumer meshes arrive in the wasm boundary convention — WebGL
//! Y-up positions/normals/origin, winding reversed, `local_to_world`
//! conjugated (`zero_copy::mesh::MeshDataJs::new`) — with `y_up = true`;
//! native in-memory meshes (IFC Z-up, untouched winding) pass `y_up = false`.
//! `rtc_offset` is the model's origin shift in IFC Z-up metres
//! (`coordinateInfo.originShift`); reconstruction per vertex is
//! `true_world = origin + position + rtc_offset` in the Z-up frame, then
//! `local = inv(local_to_world) * true_world`, then `/ unit_scale` into file
//! units.

use crate::simplify_math::{
    averaged_vertex_normals, conjugate_yup_to_zup, invert_affine_row_major,
    transform_point_row_major, yup_to_zup, zup_to_yup,
};
use ifc_lite_geometry::simplify::{simplify_mesh, SimplifyOptions};
use ifc_lite_geometry::Mesh;

/// One already-produced mesh record of an element (an element may carry
/// several: per-material submesh splits).
#[derive(Debug, Clone)]
pub struct SimplifyRecordInput<'a> {
    /// Vertex positions relative to `origin` (frame per `y_up`).
    pub positions: &'a [f32],
    /// Vertex normals, 1:1 with positions (may be empty).
    pub normals: &'a [f32],
    /// Triangle indices (winding per `y_up`).
    pub indices: &'a [u32],
    /// Per-mesh local origin (frame per `y_up`); world = origin + position.
    pub origin: [f64; 3],
    /// Resolved placement chain (row-major; conjugated when `y_up`), see
    /// `Mesh::local_to_world`. Required on at least one record.
    pub local_to_world: Option<[f64; 16]>,
}

/// Why an element could not be simplified. The caller keeps the original
/// geometry for these — a skip is never destructive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimplifySkip {
    /// No records / no triangles.
    NoGeometry,
    /// No record carries the #1474 placement capture (synthetic meshes, or a
    /// consumer that dropped `localToWorld`); the IFC-local frame cannot be
    /// reconstructed.
    MissingPlacement,
    /// The placement matrix is not invertible.
    SingularPlacement,
    /// Simplification emptied the mesh (should not happen; guarded anyway —
    /// an element must never disappear).
    EmptyResult,
    /// `unit_scale` is zero, negative or non-finite. Silently assuming
    /// metres would export tessellation at the wrong size while reporting
    /// success, so the element is skipped instead.
    InvalidUnitScale,
}

impl SimplifySkip {
    pub fn as_str(&self) -> &'static str {
        match self {
            SimplifySkip::NoGeometry => "no-geometry",
            SimplifySkip::MissingPlacement => "missing-placement",
            SimplifySkip::SingularPlacement => "singular-placement",
            SimplifySkip::EmptyResult => "empty-result",
            SimplifySkip::InvalidUnitScale => "invalid-unit-scale",
        }
    }
}

/// Simplified element: one render mesh (input frame convention) + the same
/// triangles in the element's IFC object-placement frame in file units.
#[derive(Debug, Clone)]
pub struct SimplifiedElement {
    /// Render positions relative to `render_origin` (frame per `y_up`).
    pub render_positions: Vec<f32>,
    pub render_normals: Vec<f32>,
    /// Render indices (winding per `y_up`).
    pub render_indices: Vec<u32>,
    /// Per-mesh origin for the render positions (frame per `y_up`).
    pub render_origin: [f64; 3],
    /// The same vertices in the element's object-placement frame, FILE units,
    /// IFC Z-up. 1:1 with `render_positions` triplets.
    pub local_positions: Vec<f64>,
    /// Triangle indices over `local_positions` in the IFC frame's winding
    /// (counter-clockwise outward).
    pub local_indices: Vec<u32>,
    pub tris_before: u32,
    pub tris_after: u32,
    pub cavity_components_dropped: u32,
}

/// Simplify one element from its already-produced mesh records at the given
/// demesher level (see `SimplifyOptions::for_level`).
///
/// `unit_scale` is metres per project length unit (the prepass/export unit
/// scale); `rtc_offset` is the model origin shift in IFC Z-up metres.
pub fn simplify_element(
    records: &[SimplifyRecordInput<'_>],
    level: u8,
    rtc_offset: [f64; 3],
    unit_scale: f64,
    y_up: bool,
) -> Result<SimplifiedElement, SimplifySkip> {
    // -- Placement: first record that carries the capture (submeshes of one
    // element share the element's placement chain).
    let l2w_raw = records
        .iter()
        .find_map(|r| r.local_to_world)
        .ok_or(SimplifySkip::MissingPlacement)?;
    let l2w = if y_up {
        conjugate_yup_to_zup(&l2w_raw)
    } else {
        l2w_raw
    };
    let inv_l2w = invert_affine_row_major(&l2w).ok_or(SimplifySkip::SingularPlacement)?;
    if !(unit_scale.is_finite() && unit_scale > 0.0) {
        return Err(SimplifySkip::InvalidUnitScale);
    }

    // -- Merge records into one IFC Z-up soup in the RTC-shifted world frame
    // (f64), restoring the IFC winding when the input is the Y-up boundary
    // convention.
    let mut world: Vec<[f64; 3]> = Vec::new();
    let mut normals: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut have_normals = true;
    for rec in records {
        let base = world.len() as u32;
        let n_verts = rec.positions.len() / 3;
        let origin = if y_up {
            yup_to_zup(rec.origin)
        } else {
            rec.origin
        };
        for chunk in rec.positions.chunks_exact(3) {
            let p = [chunk[0] as f64, chunk[1] as f64, chunk[2] as f64];
            let p = if y_up { yup_to_zup(p) } else { p };
            world.push([p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]]);
        }
        if rec.normals.len() == rec.positions.len() {
            for chunk in rec.normals.chunks_exact(3) {
                let n = [chunk[0] as f64, chunk[1] as f64, chunk[2] as f64];
                let n = if y_up { yup_to_zup(n) } else { n };
                normals.extend_from_slice(&[n[0] as f32, n[1] as f32, n[2] as f32]);
            }
        } else {
            have_normals = false;
        }
        for tri in rec.indices.chunks_exact(3) {
            if (tri[0] as usize) >= n_verts
                || (tri[1] as usize) >= n_verts
                || (tri[2] as usize) >= n_verts
            {
                continue;
            }
            // The boundary reversed winding for the Y-up handedness flip;
            // restore the IFC order for frame-consistent processing.
            if y_up {
                indices.extend_from_slice(&[tri[0] + base, tri[2] + base, tri[1] + base]);
            } else {
                indices.extend_from_slice(&[tri[0] + base, tri[1] + base, tri[2] + base]);
            }
        }
    }
    if world.is_empty() || indices.is_empty() {
        return Err(SimplifySkip::NoGeometry);
    }

    // -- Rebase to the element AABB centre so f32 mesh positions stay small
    // and precise at building/georef scale (same trick as the pipeline's
    // per-mesh `origin`).
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for w in &world {
        for k in 0..3 {
            min[k] = min[k].min(w[k]);
            max[k] = max[k].max(w[k]);
        }
    }
    let centre = [
        0.5 * (min[0] + max[0]),
        0.5 * (min[1] + max[1]),
        0.5 * (min[2] + max[2]),
    ];
    let mut mesh = Mesh::new();
    mesh.positions = world
        .iter()
        .flat_map(|w| {
            [
                (w[0] - centre[0]) as f32,
                (w[1] - centre[1]) as f32,
                (w[2] - centre[2]) as f32,
            ]
        })
        .collect();
    mesh.normals = if have_normals && normals.len() == mesh.positions.len() {
        normals
    } else {
        Vec::new()
    };
    mesh.indices = indices;
    mesh.origin = centre;
    mesh.local_to_world = Some(l2w);

    // -- Simplify.
    let (mut out, stats) = simplify_mesh(&mesh, &SimplifyOptions::for_level(level));
    if out.indices.is_empty() || out.positions.is_empty() {
        return Err(SimplifySkip::EmptyResult);
    }
    if out.normals.len() != out.positions.len() {
        out.normals = averaged_vertex_normals(&out.positions, &out.indices);
    }

    // -- IFC-local output: true world -> inverse placement -> file units.
    let n_out = out.positions.len() / 3;
    let mut local_positions: Vec<f64> = Vec::with_capacity(n_out * 3);
    for chunk in out.positions.chunks_exact(3) {
        let tw = [
            chunk[0] as f64 + out.origin[0] + rtc_offset[0],
            chunk[1] as f64 + out.origin[1] + rtc_offset[1],
            chunk[2] as f64 + out.origin[2] + rtc_offset[2],
        ];
        let local = transform_point_row_major(&inv_l2w, tw);
        local_positions.extend_from_slice(&[
            local[0] / unit_scale,
            local[1] / unit_scale,
            local[2] / unit_scale,
        ]);
    }
    let local_indices = out.indices.clone();

    // -- Render output back in the caller's frame convention.
    let (render_positions, render_normals, render_indices, render_origin) = if y_up {
        let positions = out
            .positions
            .chunks_exact(3)
            .flat_map(|c| {
                let p = zup_to_yup([c[0] as f64, c[1] as f64, c[2] as f64]);
                [p[0] as f32, p[1] as f32, p[2] as f32]
            })
            .collect();
        let normals = out
            .normals
            .chunks_exact(3)
            .flat_map(|c| {
                let n = zup_to_yup([c[0] as f64, c[1] as f64, c[2] as f64]);
                [n[0] as f32, n[1] as f32, n[2] as f32]
            })
            .collect();
        let mut indices = out.indices.clone();
        for tri in indices.chunks_exact_mut(3) {
            tri.swap(1, 2);
        }
        (positions, normals, indices, zup_to_yup(out.origin))
    } else {
        (out.positions, out.normals, out.indices, out.origin)
    };

    Ok(SimplifiedElement {
        render_positions,
        render_normals,
        render_indices,
        render_origin,
        local_positions,
        local_indices,
        tris_before: stats.tris_before,
        tris_after: stats.tris_after,
        cavity_components_dropped: stats.cavity_components_dropped,
    })
}

