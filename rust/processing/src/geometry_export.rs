// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Analysis-ready geometry-data export.
//!
//! A per-entity geometry dump distinct from the render-oriented GLB. Where the
//! GLB is glTF Y-up, recentred, and vertex-duplicated for flat shading, this
//! export is what an *analysis* consumer wants:
//!
//! - **IFC Z-up** (no Y-up rotation — we read [`MeshData`] before the wasm
//!   boundary applies it),
//! - **absolute world coordinates** in metres: `vertex = position + origin +
//!   rtc_offset` (the per-element local-frame `origin` and the model `rtc_offset`
//!   are folded back in, and the offset is recorded so geo-referenced consumers
//!   can recover or re-localise),
//! - **welded / indexed** triangles straight from the kernel mesh (the GLB's
//!   per-face duplication happens later, in the glTF exporter),
//! - **occurrences only** (`geometry_class == 0`); type-product RepresentationMap
//!   geometry is omitted, matching what occurrence-based tessellators emit.
//!
//! Keyed by IFC STEP/express id. Submeshes of one element (per-material splits)
//! are merged into a single triangle soup per id. f64 throughout so building- and
//! geo-referenced-scale coordinates keep full precision.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::MeshData;

/// One IFC entity's merged geometry, in IFC Z-up absolute-world metres.
#[derive(Debug, Clone, Serialize)]
pub struct ExportedElement {
    pub ifc_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Welded vertices, `[x, y, z]` triplets, IFC Z-up absolute world (metres).
    pub vertices: Vec<[f64; 3]>,
    /// Triangle indices into `vertices`.
    pub faces: Vec<[u32; 3]>,
    /// RGBA in 0..1 (first submesh's colour when an element has several).
    pub color: [f32; 4],
}

/// Top-level geometry-data document. Serializes to the `ifc-lite-geometry-data`
/// JSON contract.
#[derive(Debug, Clone, Serialize)]
pub struct GeometryDataExport {
    pub schema: &'static str,
    pub version: u32,
    /// Vertical axis convention of `vertices`. Always `"Z"` (IFC native).
    pub up_axis: &'static str,
    /// Length unit of `vertices`. Always `"m"` (SI metres).
    pub units: &'static str,
    /// The RTC offset already folded into `vertices`. `[0,0,0]` for models near
    /// the origin; non-zero for geo-referenced models (so a consumer can choose
    /// to re-localise by subtracting it for f32-friendly local coordinates).
    pub rtc_offset: [f64; 3],
    pub element_count: usize,
    /// Per-entity geometry, keyed by IFC STEP/express id (JSON object key is the
    /// id as a string).
    pub elements: BTreeMap<u32, ExportedElement>,
}

/// Build the geometry-data export from a processed model's meshes.
///
/// `rtc_offset` is `ProcessingResult.metadata.coordinate_info.origin_shift`.
///
/// `site_rotation` is the IfcSite placement (column-major 4x4) **only when the
/// model was processed into the `site_local` coordinate space** — there the
/// pipeline inverse-rotates positions + origin into site-local axes, so to emit
/// true IFC world coordinates we reapply the forward 3x3 rotation:
/// `world = R * (position + origin) + rtc_offset`. Pass `None` for the
/// `model_rtc` / `raw_ifc` spaces (R = identity), which is the common case.
pub fn build_geometry_data_export(
    meshes: &[MeshData],
    rtc_offset: [f64; 3],
    site_rotation: Option<&[f64]>,
) -> GeometryDataExport {
    let mut elements: BTreeMap<u32, ExportedElement> = BTreeMap::new();
    let rot = match site_rotation {
        Some(m) if m.len() >= 16 => Some(m),
        _ => None,
    };

    for m in meshes {
        // Occurrences only — skip type-product RepresentationMap geometry.
        if m.geometry_class != 0 || m.indices.is_empty() {
            continue;
        }

        let o = m.origin;
        let verts: Vec<[f64; 3]> = m
            .positions
            .chunks_exact(3)
            .map(|p| {
                // World point in (possibly site-local) axes: position + origin.
                let (x, y, z) = (p[0] as f64 + o[0], p[1] as f64 + o[1], p[2] as f64 + o[2]);
                match rot {
                    // Reapply the site forward rotation (column-major R), then RTC.
                    Some(r) => [
                        r[0] * x + r[4] * y + r[8] * z + rtc_offset[0],
                        r[1] * x + r[5] * y + r[9] * z + rtc_offset[1],
                        r[2] * x + r[6] * y + r[10] * z + rtc_offset[2],
                    ],
                    None => [x + rtc_offset[0], y + rtc_offset[1], z + rtc_offset[2]],
                }
            })
            .collect();

        let entry = elements
            .entry(m.express_id)
            .or_insert_with(|| ExportedElement {
                ifc_type: m.ifc_type.clone(),
                global_id: m.global_id.clone(),
                name: m.name.clone(),
                vertices: Vec::new(),
                faces: Vec::new(),
                color: m.color,
            });

        // Merge this submesh: rebase its face indices onto the element's
        // accumulated vertex list.
        let base = entry.vertices.len() as u32;
        entry.vertices.extend_from_slice(&verts);
        entry.faces.extend(
            m.indices
                .chunks_exact(3)
                .map(|t| [t[0] + base, t[1] + base, t[2] + base]),
        );
    }

    // Position-weld each element. The kernel mesh splits vertices per face (for
    // flat-shading normals), so coincident corners aren't shared and the mesh
    // reads as "open". Merging by position (1 um grid) yields a properly
    // indexed solid so closed-mesh consumers (volume, watertightness) work.
    for el in elements.values_mut() {
        let (v, f) = weld_positions(&el.vertices, &el.faces, 1.0e-6);
        el.vertices = v;
        el.faces = f;
    }

    let element_count = elements.len();
    GeometryDataExport {
        schema: "ifc-lite-geometry-data",
        version: 1,
        up_axis: "Z",
        units: "m",
        rtc_offset,
        element_count,
        elements,
    }
}

/// Merge coincident vertices on a `1/eps` grid and remap faces, dropping any
/// triangle that collapses to a degenerate after the merge.
fn weld_positions(
    verts: &[[f64; 3]],
    faces: &[[u32; 3]],
    eps: f64,
) -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
    let inv = 1.0 / eps;
    let key = |v: &[f64; 3]| -> (i64, i64, i64) {
        (
            (v[0] * inv).round() as i64,
            (v[1] * inv).round() as i64,
            (v[2] * inv).round() as i64,
        )
    };
    let mut map: BTreeMap<(i64, i64, i64), u32> = BTreeMap::new();
    let mut out_verts: Vec<[f64; 3]> = Vec::new();
    let mut remap: Vec<u32> = Vec::with_capacity(verts.len());
    for v in verts {
        let k = key(v);
        let idx = *map.entry(k).or_insert_with(|| {
            out_verts.push(*v);
            (out_verts.len() - 1) as u32
        });
        remap.push(idx);
    }
    let mut out_faces: Vec<[u32; 3]> = Vec::with_capacity(faces.len());
    for f in faces {
        let (a, b, c) = (
            remap[f[0] as usize],
            remap[f[1] as usize],
            remap[f[2] as usize],
        );
        if a != b && b != c && a != c {
            out_faces.push([a, b, c]);
        }
    }
    (out_verts, out_faces)
}

impl GeometryDataExport {
    /// Serialize to pretty JSON.
    pub fn to_json_pretty(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    /// Serialize to compact JSON.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}
