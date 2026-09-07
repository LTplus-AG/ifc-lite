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

    /// #4056: the proper frame rotation must retain source triangle order.
    #[test]
    fn obj_faces_preserve_the_source_mesh_winding_4056() {
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
        let expected = format!("f {} {} {}", idx(tri[0]), idx(tri[1]), idx(tri[2]));

        let obj = export_obj(&bytes, &ObjOptions { include_normals: false, ..ObjOptions::default() });
        let first_face = obj.lines().find(|l| l.starts_with("f ")).expect("a face line");

        // A triangle whose 2nd and 3rd source indices coincide would make the
        // reversal unobservable; assert the fixture is not that degenerate case.
        assert_ne!(tri[1], tri[2], "fixture triangle must distinguish b from c");
        assert_eq!(first_face, expected, "OBJ must preserve source winding");
    }

    /// #4056: inspect real exported positions, normals and both OBJ face syntaxes.
    #[test]
    fn obj_triangle_keeps_outward_face_orientation_4056() {
        let bytes = br#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Orientation witness'),'2;1');
FILE_NAME('triangle.ifc','2026-09-07T00:00:00',('Test'),('Test'),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#4,$);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCUNITASSIGNMENT((#7));
#9=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#6),#8);
#12=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#13=IFCTRIANGULATEDFACESET(#12,((0.,0.,1.),(0.,0.,1.),(0.,0.,1.)),.F.,((1,2,3)),$);
#14=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#13));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#1000=IFCWALL('0000000000000000001000',$,'Triangle',$,$,#5,#15,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;
"#;
        for include_normals in [false, true] {
            let (obj, stats) = export_obj_with_stats(bytes, &ObjOptions {
                include_normals, ..ObjOptions::default()
            });
            assert_eq!(stats.triangles, 1);
            let vectors = |prefix: &str| -> Vec<Vec<f64>> {
                obj.lines().filter_map(|line| line.strip_prefix(prefix))
                    .map(|line| line.split_whitespace().map(|n| n.parse().unwrap()).collect())
                    .collect()
            };
            let positions = vectors("v ");
            let normals = vectors("vn ");
            let face = obj.lines().find_map(|line| line.strip_prefix("f ")).unwrap();
            let refs: Vec<Vec<usize>> = face.split_whitespace()
                .map(|token| token.split("//").map(|n| n.parse::<usize>().unwrap() - 1).collect())
                .collect();
            assert_eq!(refs.len(), 3);
            let a = &positions[refs[0][0]];
            let b = &positions[refs[1][0]];
            let c = &positions[refs[2][0]];
            // Original face is +Z; the proper rotation takes its outward normal
            // to +Y. Compute from exported vertex references, independently of
            // the implementation's index ordering and normal conversion.
            let cross_y = (b[2] - a[2]) * (c[0] - a[0])
                - (b[0] - a[0]) * (c[2] - a[2]);
            assert!(cross_y > 0.0, "exported face points inward: {face}");
            for reference in refs {
                if include_normals {
                    assert_eq!(reference.len(), 2);
                    assert_eq!(normals[reference[1]], [0.0, 1.0, 0.0]);
                } else {
                    assert_eq!(reference.len(), 1);
                    assert!(normals.is_empty());
                }
            }
        }
    }

    /// A minimal, otherwise-valid mesh — mirrors the fixture in
    /// `usd::tests::mesh_emittable_rejects_pathological_meshes`.
    fn good_mesh() -> MeshData {
        MeshData {
            express_id: 1,
            ifc_type: "IfcWall".into(),
            global_id: None,
            name: None,
            presentation_layer: None,
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            normals: vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            indices: vec![0, 1, 2],
            color: [0.5, 0.5, 0.5, 1.0],
            material_name: None,
            geometry_item_id: None,
            material_id: None,
            properties: None,
            uvs: None,
            texture: None,
            geometry_class: 0,
            origin: [0.0, 0.0, 0.0],
            instance: None,
            local_bounds: None,
            local_to_world: None,
        }
    }

    /// `mesh_visible` must reject a mesh carrying a non-finite position, normal, or
    /// origin — OBJ's `v`/`vn` tokens have no lexical form for `NaN`/`inf`/`-inf`, and
    /// unlike `mesh_input::scrub_nonfinite` (the from-meshes GLB/COLLADA gate) or
    /// `usd::mesh_emittable` (the sibling from-bytes exporter), this function let one
    /// through untouched. Before the fix each of these five cases wrote the offending
    /// float straight into a `v`/`vn` line (Rust's `Display` renders `NaN`/`inf`/`-inf`,
    /// none of which OBJ readers accept as a number).
    #[test]
    fn mesh_visible_rejects_non_finite_geometry() {
        let good = good_mesh();
        assert!(mesh_visible(&good, &[], &[]), "the baseline fixture must itself be visible");

        let mut bad = good.clone();
        bad.positions[0] = f32::NAN;
        assert!(!mesh_visible(&bad, &[], &[]), "NaN position must be rejected");

        let mut bad = good.clone();
        bad.positions[3] = f32::INFINITY;
        assert!(!mesh_visible(&bad, &[], &[]), "Infinity position must be rejected");

        let mut bad = good.clone();
        bad.normals[1] = f32::NEG_INFINITY;
        assert!(!mesh_visible(&bad, &[], &[]), "non-finite normal must be rejected");

        let mut bad = good.clone();
        bad.origin = [f64::NAN, 0.0, 0.0];
        assert!(!mesh_visible(&bad, &[], &[]), "non-finite origin must be rejected — it poisons every vertex");
    }
}
