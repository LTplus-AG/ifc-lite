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
    /// Restrict to these express ids (isolation). Empty ⇒ all visible elements.
    pub isolated: Vec<u32>,
    /// Exclude these express ids (hidden in the viewer).
    pub hidden: Vec<u32>,
}

impl Default for ObjOptions {
    fn default() -> Self {
        Self { include_normals: true, isolated: Vec::new(), hidden: Vec::new() }
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
fn mesh_visible(mesh: &MeshData, isolated: &[u32], hidden: &[u32]) -> bool {
    // Instanced type-library shapes duplicate real occurrence geometry — never export.
    if mesh.geometry_class == 2 {
        return false;
    }
    if hidden.contains(&mesh.express_id) {
        return false;
    }
    if !isolated.is_empty() && !isolated.contains(&mesh.express_id) {
        return false;
    }
    !mesh.indices.is_empty() && mesh.positions.len() >= 9
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
        // reversed (2nd/3rd vertex swapped) to compensate the Z-up→Y-up handedness
        // convention, matching the GLB exporter / `MeshDataJs::new`.
        for tri in mesh.indices.chunks_exact(3) {
            let a = vert_base + tri[0] as usize + 1;
            let b = vert_base + tri[1] as usize + 1;
            let c = vert_base + tri[2] as usize + 1;
            if has_normals {
                let _ = writeln!(out, "f {a}//{a} {c}//{c} {b}//{b}");
            } else {
                let _ = writeln!(out, "f {a} {c} {b}");
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
mod tests {
    use super::*;

    #[test]
    fn duplex_exports_well_formed_obj() {
        let (obj, stats) =
            export_obj_with_stats(&fixture_or_skip!("ara3d/duplex.ifc"), &ObjOptions::default());
        assert!(stats.meshes > 0, "expected meshes");
        assert!(stats.vertices > 0, "expected vertices");
        assert!(stats.triangles > 0, "expected triangles");
        assert!(obj.contains("\nv "), "has vertices");
        assert!(obj.contains("\nf "), "has faces");
        assert!(obj.contains("\no Ifc"), "has element object groups");

        // Every face index must reference a written vertex (1..=vertices).
        let max_idx = stats.vertices;
        for line in obj.lines().filter(|l| l.starts_with("f ")) {
            for tok in line[2..].split_whitespace() {
                let v: usize = tok.split("//").next().unwrap().parse().unwrap();
                assert!(v >= 1 && v <= max_idx, "face index {v} out of range 1..={max_idx}");
            }
        }
    }

    #[test]
    fn isolation_filter_limits_output() {
        let all = export_obj_with_stats(&fixture_or_skip!("ara3d/duplex.ifc"), &ObjOptions::default()).1;
        // Find one express id that was emitted by re-reading meshes through the pipeline.
        let result = process_geometry(&fixture_or_skip!("ara3d/duplex.ifc")[..]);
        let some_id = result
            .meshes
            .iter()
            .find(|m| super::mesh_visible(m, &[], &[]))
            .map(|m| m.express_id)
            .expect("at least one visible mesh");

        let isolated = export_obj_with_stats(
            &fixture_or_skip!("ara3d/duplex.ifc"),
            &ObjOptions { isolated: vec![some_id], ..ObjOptions::default() },
        )
        .1;
        assert!(isolated.meshes >= 1);
        assert!(isolated.meshes <= all.meshes);
    }

    /// OBJ hand-writes its own third copy of the Z-up→Y-up winding reversal
    /// (`f {a} {c} {b}`, see the comment above the face loop), alongside
    /// `frame::to_yup_into` and `frame::to_yup_in_place`. Deleting the reversal
    /// from all three at once left the whole crate suite green: glTF materials
    /// are unconditionally `doubleSided: true`, so nothing renderer-facing can
    /// fail on winding, and OBJ had no winding assertion at all.
    ///
    /// Pin it against the SOURCE mesh rather than against the GLB path — an
    /// equivalence test between two copies of the same conversion is blind to a
    /// mutation applied to both.
    #[test]
    fn obj_faces_reverse_the_source_mesh_winding() {
        let bytes = fixture_or_skip!("ara3d/duplex.ifc");
        let result = process_geometry(&bytes);

        // `mesh_visible` only requires a NON-EMPTY index buffer, so a visible
        // mesh may carry one or two indices and emit no face at all (the export
        // loop uses `chunks_exact(3)`). Such a mesh still writes its vertices,
        // advancing `vert_base` — so the first FACE need not belong to the first
        // visible MESH, and its indices need not start at zero. Walk the same
        // sequence the exporter walks and accumulate the offset, instead of
        // assuming both.
        let mut vert_base = 0usize;
        let mut first = None;
        for m in result.meshes.iter().filter(|m| mesh_visible(m, &[], &[])) {
            if m.indices.len() >= 3 {
                first = Some((m, vert_base));
                break;
            }
            vert_base += m.positions.len() / 3;
        }
        let (mesh, vert_base) = first.expect("a visible mesh with a complete triangle");
        let tri = &mesh.indices[0..3];
        // OBJ indices are 1-based and global.
        let idx = |i: u32| vert_base + i as usize + 1;
        let expected = format!("f {} {} {}", idx(tri[0]), idx(tri[2]), idx(tri[1]));

        let obj = export_obj(&bytes, &ObjOptions { include_normals: false, ..ObjOptions::default() });
        let first_face = obj.lines().find(|l| l.starts_with("f ")).expect("a face line");

        // A triangle whose 2nd and 3rd source indices coincide would make the
        // reversal unobservable; assert the fixture is not that degenerate case.
        assert_ne!(tri[1], tri[2], "fixture triangle must distinguish b from c");
        assert_eq!(first_face, expected, "OBJ must emit a, c, b — winding reversed");
    }
}
