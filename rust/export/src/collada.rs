// SPDX-License-Identifier: MPL-2.0
//! **COLLADA 1.4.1** (`.dae`) exporter — the model format Google Earth's KML
//! `<Model>` actually loads (it does NOT accept glTF/GLB; a `.glb` in `<Model>`
//! fails with "Unsupported element: Model"). Used to build the KMZ payload (#1427).
//!
//! Input is the viewer's already-produced **Y-up** `MeshData` (the from-meshes
//! path), identical to the GLB exporter. Two Google-Earth-specific choices make
//! the model render correctly:
//!
//! - **Orientation:** vertices are converted back to the IFC-native **Z-up** frame
//!   (`(x, y, z)_yup -> (x, -z, y)_zup`) and the document declares `<up_axis>Z_UP</up_axis>`,
//!   so the building stands upright. Horizontal grid-north alignment is carried by
//!   the KML `<Model><Orientation><heading>` (computed elsewhere), exactly as the
//!   GLB path did, so X/Y placement matches the (already-correct) GLB output.
//! - **Brightness:** Google Earth has no ambient/IBL and a single hard sun, so a
//!   plain diffuse material renders near-black. Each material sets `<emission>` to
//!   its colour (the well-known "make Google Earth models glow" trick) so the model
//!   shows its true colour. Faces are flagged `double_sided` via the `GOOGLEEARTH`
//!   profile extra (IFC winding isn't reliably outward).

use std::collections::HashMap;

use crate::collada_document::write_dae;
use crate::error::ExportError;

/// Material dedup key: RGBA rounded to 2 decimals (matches the glTF exporter).
fn color_key(c: [f32; 4]) -> (i32, i32, i32, i32) {
    let r = |v: f32| (v * 100.0).round() as i32;
    (r(c[0]), r(c[1]), r(c[2]), r(c[3]))
}

/// Convert a Y-up vector back to the IFC-native Z-up frame: `(x, y, z) -> (x, -z, y)`.
#[inline]
fn to_zup(x: f64, y: f64, z: f64) -> [f64; 3] {
    [x, -z, y]
}

/// Vertex dedup key: position quantised to 0.1 mm + normal to ~1e-3 (the emitted
/// precision), so vertices that serialise identically collapse to one. Quantises in
/// f64→i64 so large world coordinates (e.g. a national-grid model not RTC-shifted,
/// hundreds of km) can't overflow the key and merge unrelated vertices. The position
/// is kept in f64 end-to-end (only normals, which are unit-scale, are f32) so a
/// large-georef world coordinate is not quantised by an early f32 downcast.
#[inline]
fn vert_key(p: [f64; 3], n: [f32; 3]) -> [i64; 6] {
    let qp = |v: f64| (v * 10_000.0).round() as i64;
    let qn = |v: f32| (v as f64 * 1_000.0).round() as i64;
    [qp(p[0]), qp(p[1]), qp(p[2]), qn(n[0]), qn(n[1]), qn(n[2])]
}

/// Build a Google-Earth-compatible COLLADA 1.4.1 `.dae` from already-produced
/// (Y-up) meshes, flattened into parallel arrays exactly like
/// `export_glb_from_meshes`. Per mesh `i`: `vertex_counts[i]` vertices +
/// `index_counts[i]` indices taken in order from the concatenated
/// `positions`/`normals`/`indices`; `colors` is RGBA per mesh, `origins` xyz per
/// mesh (`world = origin + position`). Returns the `.dae` bytes (UTF-8 XML).
///
/// Fails closed when no triangle survives. An empty document is not merely
/// useless, it is SCHEMA-INVALID: COLLADA 1.4.1 declares `<library_effects>`,
/// `<library_materials>`, `<library_geometries>` and `<visual_scene>` each with
/// `minOccurs="1"` children, and `write_dae` emits all four regardless. Two
/// inputs reach it: an empty visible set, and a mesh whose only triangle is
/// degenerate (the vertex dedup collapses two of its corners and the triangle
/// is dropped AFTER its material was registered, so effects and materials are
/// non-empty while geometries is empty). The GLB twin fails closed on the same
/// condition (`gltf::from_meshes`, #1438/#1516). The count that decides is
/// taken from the material buckets AFTER every drop rule has run, not from the
/// caller's `index_counts`, which says only what was offered.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::needless_range_loop)]
pub fn try_export_collada_from_meshes(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    vertex_counts: &[u32],
    index_counts: &[u32],
    colors: &[f32],
    origins: &[f64],
) -> Result<Vec<u8>, ExportError> {
    // Gate every float BEFORE any of it is read. `<float_array>` is `xs:float`,
    // which has no lexical form matching Rust's `inf`/`-inf`, and the AABB
    // re-centring below spreads a single non-finite vertex over every other
    // vertex in the document. See `crate::mesh_input`.
    let scrubbed = crate::mesh_input::scrub_nonfinite(positions, normals, colors, origins);
    let (positions, normals, colors, origins) = (
        &*scrubbed.positions,
        &*scrubbed.normals,
        &*scrubbed.colors,
        &*scrubbed.origins,
    );
    // Concatenated Z-up vertex buffers (one shared POSITION + NORMAL source) and,
    // per material, the triangle indices into that shared buffer. Positions are
    // accumulated in f64 so `world = origin + position` and the subsequent AABB
    // re-centering keep full precision at georef scale; the buffer is downcast to
    // f32 only once, after centering, just before serialisation.
    let mut pos: Vec<f64> = Vec::new();
    let mut nrm: Vec<f32> = Vec::new();
    let mut mat_colors: Vec<[f32; 4]> = Vec::new();
    let mut mat_tris: Vec<Vec<u32>> = Vec::new();
    let mut mat_map: HashMap<(i32, i32, i32, i32), usize> = HashMap::new();
    // Global vertex dedup: quantised (position, normal) → index into pos/nrm. Merges
    // identical vertices within and across meshes so a non-indexed IFC mesh (per-face
    // vertices) doesn't blow past Google Earth's render limits.
    let mut dedup: HashMap<[i64; 6], u32> = HashMap::new();

    let n = vertex_counts.len();
    let mut vbase = 0usize; // running vertex offset into the flat input
    let mut ibase = 0usize; // running index offset into the flat input
    for i in 0..n {
        let vc = vertex_counts[i] as usize;
        // A missing `index_counts` slot or a count running past its buffer is
        // a caller bug, and the GLB twin refuses both; reading the slot as 0
        // or stopping here instead shipped a document with that mesh (or
        // every later one) missing as success.
        let Some(&ic) = index_counts.get(i) else {
            return Err(ExportError::MalformedMeshInput {
                detail: format!(
                    "`index_counts` has {} entries but `vertex_counts` declares {n} meshes",
                    index_counts.len()
                ),
            });
        };
        let ic = ic as usize;
        // `u64` like the GLB twin: on wasm32 an absurd u32 count times 3 wraps
        // `usize` past this check and the slices below.
        if (vbase as u64 + vc as u64) * 3 > positions.len() as u64
            || ibase as u64 + ic as u64 > indices.len() as u64
        {
            return Err(ExportError::MalformedMeshInput {
                detail: format!(
                    "mesh {i} declares {vc} vertices and {ic} indices but `positions` has {} \
                     floats and `indices` has {} entries at offsets {vbase}/{ibase}",
                    positions.len(),
                    indices.len()
                ),
            });
        }
        let pslice = &positions[vbase * 3..(vbase + vc) * 3];
        let nslice: &[f32] = if normals.len() >= (vbase + vc) * 3 {
            &normals[vbase * 3..(vbase + vc) * 3]
        } else {
            &[]
        };
        let islice = &indices[ibase..ibase + ic];
        let color = [
            colors.get(i * 4).copied().unwrap_or(0.8),
            colors.get(i * 4 + 1).copied().unwrap_or(0.8),
            colors.get(i * 4 + 2).copied().unwrap_or(0.8),
            colors.get(i * 4 + 3).copied().unwrap_or(1.0),
        ];
        let origin = [
            origins.get(i * 3).copied().unwrap_or(0.0),
            origins.get(i * 3 + 1).copied().unwrap_or(0.0),
            origins.get(i * 3 + 2).copied().unwrap_or(0.0),
        ];

        // Skip degenerate meshes (mirrors the glTF `view_ok` guard).
        if islice.is_empty() || pslice.len() < 9 || !pslice.len().is_multiple_of(3) {
            vbase += vc;
            ibase += ic;
            continue;
        }

        // Bake world = origin + position into Z-up, deduplicating by (position,
        // normal). The world position is accumulated in f64 so a large-georef
        // coordinate is not quantised by an f32 downcast before centering. `l2g`
        // maps this mesh's local vertex index → the shared deduped index. A hard
        // edge keeps distinct normals, so its vertices are NOT merged → flat shading
        // is preserved; only redundant same-position-same-normal vertices collapse.
        let has_normals = nslice.len() == pslice.len();
        let mut l2g = vec![0u32; vc];
        for vi in 0..vc {
            let p = &pslice[vi * 3..vi * 3 + 3];
            let zp = to_zup(
                p[0] as f64 + origin[0],
                p[1] as f64 + origin[1],
                p[2] as f64 + origin[2],
            );
            // Normals are unit-scale direction vectors; f32 carries them losslessly.
            let zn = if has_normals {
                let nv = &nslice[vi * 3..vi * 3 + 3];
                let z = to_zup(nv[0] as f64, nv[1] as f64, nv[2] as f64);
                [z[0] as f32, z[1] as f32, z[2] as f32]
            } else {
                [0.0, 0.0, 1.0]
            };
            l2g[vi] = *dedup.entry(vert_key(zp, zn)).or_insert_with(|| {
                let g = (pos.len() / 3) as u32;
                pos.extend_from_slice(&zp);
                nrm.extend_from_slice(&zn);
                g
            });
        }

        let mi = *mat_map.entry(color_key(color)).or_insert_with(|| {
            mat_colors.push(color);
            mat_tris.push(Vec::new());
            mat_colors.len() - 1
        });
        // Keep only whole triangles (a trailing partial triangle would desync
        // `<triangles count>` from `<p>`); drop indices outside this mesh's vertex
        // range; remap each to its deduped global index, dropping any triangle that
        // dedup collapsed to zero area (two corners merged).
        let tri_len = islice.len() - islice.len() % 3;
        for tri in islice[..tri_len].chunks_exact(3) {
            if tri.iter().all(|&idx| (idx as usize) < vc) {
                let (a, b, c) = (l2g[tri[0] as usize], l2g[tri[1] as usize], l2g[tri[2] as usize]);
                if a != b && b != c && a != c {
                    mat_tris[mi].extend_from_slice(&[a, b, c]);
                }
            }
        }

        vbase += vc;
        ibase += ic;
    }

    // Read AFTER every drop rule above has run: a degenerate-only mesh registers
    // its material and then loses its triangle, so the material count cannot
    // see this.
    if mat_tris.iter().all(Vec::is_empty) {
        return Err(ExportError::NoRenderGeometry);
    }

    // Center the model on its horizontal (X,Y) AABB centre so the .dae origin
    // coincides with the geometry centre. The KMZ <Model> pins the .dae origin to
    // <Location>, and that lat/lon is computed for the geometry's AABB centre (the
    // viewer's reproject adds the model centre to the MapConversion eastings/northings).
    // Without this the model lands offset by however far its geometry sits from the
    // local/survey origin — e.g. a CH1903+/LV95 model whose structure is 200 m from
    // the project origin appeared ~250 m away in Google Earth (#1427). Z is left alone
    // so clampToGround rests project-zero on the terrain (foundations below, frame above).
    if pos.len() >= 3 {
        let mut min_x = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for v in pos.chunks_exact(3) {
            min_x = min_x.min(v[0]);
            max_x = max_x.max(v[0]);
            min_y = min_y.min(v[1]);
            max_y = max_y.max(v[1]);
        }
        let cx = (min_x + max_x) * 0.5;
        let cy = (min_y + max_y) * 0.5;
        for v in pos.chunks_exact_mut(3) {
            v[0] -= cx;
            v[1] -= cy;
        }
    }

    // Downcast the centered (small, origin-local) coordinates to f32 only now — the
    // accumulation + AABB centering above ran in f64 to survive georef magnitudes.
    let pos_f32: Vec<f32> = pos.iter().map(|&c| c as f32).collect();
    Ok(write_dae(&pos_f32, &nrm, &mat_colors, &mat_tris))
}

#[cfg(test)]
#[path = "collada_tests.rs"]
mod tests;
