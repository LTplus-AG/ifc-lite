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
//! - **occurrences only**: type-product RepresentationMap geometry
//!   (`geometry_class` 1 and 2) is omitted, matching what occurrence-based
//!   tessellators emit. A material-layer wall's slices (class 3,
//!   `GEOM_CLASS_LAYER_SLICE`) are that occurrence's own body and are kept.
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

/// Color-aware geometry. The existing `ExportedElement` remains unchanged for callers.
#[derive(Debug, Clone, Serialize)]
pub struct ColoredExportedElement {
    #[serde(flatten)]
    pub geometry: ExportedElement,
    /// Distinct RGBA values in first-submesh order; omitted when `color` suffices.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub palette: Vec<[f32; 4]>,
    /// One palette index per surviving face; omitted with `palette` when `color` suffices.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub face_colors: Vec<u64>,
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

/// Additive color-aware document. Uniform JSON stays compatible with version 1.
#[derive(Debug, Clone, Serialize)]
pub struct ColoredGeometryDataExport {
    pub schema: &'static str,
    pub version: u32,
    pub up_axis: &'static str,
    pub units: &'static str,
    pub rtc_offset: [f64; 3],
    pub element_count: usize,
    pub elements: BTreeMap<u32, ColoredExportedElement>,
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
    let elements = build_elements(meshes, rtc_offset, site_rotation, false, |el| el.geometry);
    GeometryDataExport {
        schema: "ifc-lite-geometry-data",
        version: 1,
        up_axis: "Z",
        units: "m",
        rtc_offset,
        element_count: elements.len(),
        elements,
    }
}

/// Build geometry with optional palette indices, preserving face materials through welding.
pub fn build_colored_geometry_data_export(
    meshes: &[MeshData],
    rtc_offset: [f64; 3],
    site_rotation: Option<&[f64]>,
) -> ColoredGeometryDataExport {
    let elements = build_elements(meshes, rtc_offset, site_rotation, true, |el| el);
    ColoredGeometryDataExport {
        schema: "ifc-lite-geometry-data",
        version: 1,
        up_axis: "Z",
        units: "m",
        rtc_offset,
        element_count: elements.len(),
        elements,
    }
}

fn build_elements<T>(
    meshes: &[MeshData],
    rtc_offset: [f64; 3],
    site_rotation: Option<&[f64]>,
    include_colors: bool,
    finish: impl Fn(ColoredExportedElement) -> T,
) -> BTreeMap<u32, T> {
    let mut builders: BTreeMap<u32, ElementBuilder> = BTreeMap::new();
    let rot = match site_rotation {
        Some(m) if m.len() >= 16 => Some(m),
        _ => None,
    };

    for m in meshes {
        // Occurrences only: skip type-product RepresentationMap geometry. Class 3
        // is a layered wall's body, which has no class-0 mesh to fall back on.
        if matches!(m.geometry_class, 1 | 2) || m.indices.is_empty() {
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

        let builder = builders
            .entry(m.express_id)
            .or_insert_with(|| ElementBuilder {
                indices: BTreeMap::new(),
                element: ColoredExportedElement {
                    geometry: ExportedElement {
                        ifc_type: m.ifc_type.clone(),
                        global_id: m.global_id.clone(),
                        name: m.name.clone(),
                        vertices: Vec::new(),
                        faces: Vec::new(),
                        color: m.color,
                    },
                    palette: Vec::new(),
                    face_colors: Vec::new(),
                },
            });
        if include_colors {
            builder.append_color(m.color, m.indices.len() / 3);
        }
        let entry = &mut builder.element.geometry;

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

    // Keep each surviving face's material while dropping welded degenerates.
    builders
        .into_iter()
        .map(|(id, builder)| {
            let mut el = builder.element;
            let (vertices, faces, colors) = weld_positions(
                &el.geometry.vertices,
                &el.geometry.faces,
                &el.face_colors,
                1e-6,
            );
            el.geometry.vertices = vertices;
            el.geometry.faces = faces;
            if !el.face_colors.is_empty() {
                el.face_colors = colors;
                // Omit metadata when surviving faces use the existing fallback color.
                if !el.face_colors.is_empty() {
                    if el.face_colors.iter().all(|&color| color == 0) {
                        el.palette.clear();
                        el.face_colors.clear();
                    }
                } else {
                    el.palette.clear();
                }
            }
            (id, finish(el))
        })
        .collect()
}

/// Private material accumulator. Uniform elements allocate no per-face color array.
struct ElementBuilder {
    element: ColoredExportedElement,
    indices: BTreeMap<[u32; 4], u64>,
}

impl ElementBuilder {
    fn append_color(&mut self, color: [f32; 4], face_count: usize) {
        let el = &mut self.element;
        if el.palette.is_empty() {
            if el.geometry.color == color {
                return;
            }
            el.palette.push(el.geometry.color);
            self.indices.insert(color_key(el.geometry.color), 0);
            el.face_colors.resize(el.geometry.faces.len(), 0);
        }
        let next = el.palette.len() as u64;
        let index = *self.indices.entry(color_key(color)).or_insert_with(|| {
            el.palette.push(color);
            next
        });
        el.face_colors
            .resize(el.face_colors.len() + face_count, index);
    }
}

fn color_key(color: [f32; 4]) -> [u32; 4] {
    // Match IEEE equality for signed zero while retaining deterministic bit keys.
    color.map(|value| if value == 0.0 { 0 } else { value.to_bits() })
}

/// Merge coincident vertices on a `1/eps` grid and remap faces, dropping any
/// triangle that collapses to a degenerate after the merge.
fn weld_positions(
    verts: &[[f64; 3]],
    faces: &[[u32; 3]],
    colors: &[u64],
    eps: f64,
) -> (Vec<[f64; 3]>, Vec<[u32; 3]>, Vec<u64>) {
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
    let mut kept = Vec::with_capacity(colors.len());
    for (face_index, f) in faces.iter().enumerate() {
        let (a, b, c) = (
            remap[f[0] as usize],
            remap[f[1] as usize],
            remap[f[2] as usize],
        );
        if a != b && b != c && a != c {
            out_faces.push([a, b, c]);
            if !colors.is_empty() {
                kept.push(colors[face_index]);
            }
        }
    }
    (out_verts, out_faces, kept)
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

impl ColoredGeometryDataExport {
    /// Serialize color-aware elements as the version-1 JSON document with optional fields.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}
