// SPDX-License-Identifier: MPL-2.0
//! Wavefront **OBJ** exporter — triangulated render geometry as a single `.obj` text.
//!
//! Source = `ifc_lite_processing::process_geometry` (the same per-element `MeshData`
//! the viewer renders, produced by the one unified Rust pipeline). Per-mesh `origin`
//! is folded into world positions so building / georef-scale placements export without
//! f32 collapse. Vertices and normals are emitted once per mesh with a running global
//! index; each element becomes an OBJ `o`/`g` group (`IfcWall_1234`) so downstream DCC
//! tools keep per-element traceability.
//!
//! Instanced type-library meshes (`geometry_class == 2`) are skipped — their geometry is
//! already drawn by the real occurrences, so emitting them would duplicate shapes at the
//! type origin (the Model/Types orphan-gate footgun).

use std::fmt::Write as _;

use ifc_lite_processing::{process_geometry, MeshData};

use crate::frame::{yup_f32, yup_f64};

/// Options for OBJ export.
pub struct ObjOptions {
    /// Emit per-vertex normals (`vn` + `f a//na`). Most DCC tools expect them.
    pub include_normals: bool,
    /// Restrict to these express ids (isolation allowlist). `None` ⇒ no filter,
    /// every mesh is a candidate; `Some(empty)` ⇒ the filter is ACTIVE and
    /// matched nothing, so every mesh is excluded. Do not collapse the two —
    /// an active isolation that matches zero elements must export nothing, not
    /// silently fall back to the whole model (matches the null-vs-empty
    /// convention used by `GltfOptions::isolated` and by
    /// `packages/export/src/reference-collector.ts` on the TS side).
    pub isolated: Option<Vec<u32>>,
    /// Exclude these express ids (hidden in the viewer).
    pub hidden: Vec<u32>,
}

impl Default for ObjOptions {
    fn default() -> Self {
        Self { include_normals: true, isolated: None, hidden: Vec::new() }
    }
}

/// Coverage stats for an OBJ export.
pub struct ObjStats {
    /// Meshes written.
    pub meshes: usize,
    /// Vertices written.
    pub vertices: usize,
    /// Triangles written.
    pub triangles: usize,
}

/// True when `mesh` should be written given the isolation/hidden filters.
fn mesh_visible(mesh: &MeshData, isolated: &Option<Vec<u32>>, hidden: &[u32]) -> bool {
    // Instanced type-library shapes duplicate real occurrence geometry — never export.
    if mesh.geometry_class == 2 {
        return false;
    }
    if hidden.contains(&mesh.express_id) {
        return false;
    }
    // `Some(ids)` = isolation is ACTIVE — an empty allowlist must exclude every
    // mesh here, not read the same as "no filter" (`None`). See `ObjOptions::isolated`.
    if let Some(ids) = isolated {
        if !ids.contains(&mesh.express_id) {
            return false;
        }
    }
    if mesh.indices.is_empty() || mesh.positions.len() < 9 {
        return false;
    }
    // OBJ's `v`/`vn` tokens have no lexical form for a non-finite number (unlike
    // `mesh_input::scrub_nonfinite`'s target formats, nothing here even reads
    // "nan"/"inf" back as a number), and this exporter folds `mesh.origin` into
    // every position before writing it, so a non-finite origin would poison every
    // otherwise-good vertex in the mesh. `process_geometry` can hand back such a
    // value only for a derived quantity like the mid-vertex normal of a
    // zero-area face (see `usd::fmt::fmt_f32`'s comment on the same source).
    // Gate the whole mesh out rather than write a token no reader accepts —
    // mirrors `usd::mesh_emittable`, the sibling from-bytes exporter over the
    // same `process_geometry` output.
    if !mesh.origin.iter().all(|v| v.is_finite()) || !mesh.positions.iter().all(|v| v.is_finite()) {
        return false;
    }
    if mesh.normals.len() == mesh.positions.len() && !mesh.normals.iter().all(|v| v.is_finite()) {
        return false;
    }
    true
}

/// Export the render geometry in `content` (raw IFC/STEP bytes) as a Wavefront OBJ string.
pub fn export_obj(content: &[u8], opts: &ObjOptions) -> String {
    export_obj_with_stats(content, opts).0
}

/// Like [`export_obj`] but also returns coverage stats.
pub fn export_obj_with_stats(content: &[u8], opts: &ObjOptions) -> (String, ObjStats) {
    let result = process_geometry(content);

    let mut out = String::new();
    let _ = writeln!(out, "# ifc-lite OBJ export");
    let _ = writeln!(out, "# units: metres (renderer Y-up frame, origin-folded world coords)");

    let mut vert_base: usize = 0; // 0-based count of vertices written so far
    let mut stats = ObjStats { meshes: 0, vertices: 0, triangles: 0 };

    for mesh in &result.meshes {
        if !mesh_visible(mesh, &opts.isolated, &opts.hidden) {
            continue;
        }
        let nverts = mesh.positions.len() / 3;
        let has_normals = opts.include_normals && mesh.normals.len() == mesh.positions.len();

        let group = format!("{}_{}", mesh.ifc_type, mesh.express_id);
        let _ = writeln!(out, "o {group}");
        let _ = writeln!(out, "g {group}");

        // Vertices — fold the per-mesh f64 origin so georef-scale placements survive,
        // then convert the producer-native IFC Z-up world point to WebGL Y-up
        // (`(x,y,z) -> (x,z,-y)`) so OBJ matches the header's declared frame and the
        // GLB exporter (`process_geometry` itself is Z-up; the swap is normally done
        // at the wasm FFI, which this path never crosses).
        let [ox, oy, oz] = mesh.origin;
        for i in 0..nverts {
            let wx = mesh.positions[i * 3] as f64 + ox;
            let wy = mesh.positions[i * 3 + 1] as f64 + oy;
            let wz = mesh.positions[i * 3 + 2] as f64 + oz;
            let [x, y, z] = yup_f64([wx, wy, wz]);
            let _ = writeln!(out, "v {x:.6} {y:.6} {z:.6}");
        }
        if has_normals {
            for i in 0..nverts {
                let [nx, ny, nz] = yup_f32([
                    mesh.normals[i * 3],
                    mesh.normals[i * 3 + 1],
                    mesh.normals[i * 3 + 2],
                ]);
                let _ = writeln!(out, "vn {nx:.6} {ny:.6} {nz:.6}");
            }
        }

        // Faces — OBJ indices are 1-based and global; offset by vert_base. Winding is
        // preserved: (x,y,z) -> (x,z,-y) has determinant +1, so this frame
        // rotation does not change handedness.
        for tri in mesh.indices.chunks_exact(3) {
            let a = vert_base + tri[0] as usize + 1;
            let b = vert_base + tri[1] as usize + 1;
            let c = vert_base + tri[2] as usize + 1;
            if has_normals {
                let _ = writeln!(out, "f {a}//{a} {b}//{b} {c}//{c}");
            } else {
                let _ = writeln!(out, "f {a} {b} {c}");
            }
            stats.triangles += 1;
        }

        vert_base += nverts;
        stats.vertices += nverts;
        stats.meshes += 1;
    }

    (out, stats)
}

#[cfg(test)]
#[path = "obj_tests.rs"]
mod tests;
