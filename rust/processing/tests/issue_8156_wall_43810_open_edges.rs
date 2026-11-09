// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #8156: gable wall #43810 of the ISSUE_068 school model came back with
//! 6 open edges at a 10 µm vertex weld (a 1 mm weld hid them).
//!
//! The void cut hands `build_mesh_data` a strictly closed mesh: every edge used
//! exactly once in each direction, bit for bit. Its ridge carries two vertices
//! 140 µm apart, so each side face has one triangle with a 140 µm edge and a
//! ~21 m one, an edge ratio of about 1.5e5. The f32-collapse degenerate backstop
//! dropped every triangle above 1e5 by edge ratio alone, so it removed those two
//! real face triangles and opened their three edges each.
//!
//! `tests/fixtures/issue_8156_wall_43810.ifc` is the wall, its 38 openings and
//! their `IfcRelVoidsElement`s, with everything they reference, cut out of
//! `tests/models/ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc` (project and person
//! names blanked). On `main` it gives the same mesh through `process_geometry`
//! as the full model: 1584 triangles, 6 open edges, 565.540 m2. The area
//! assertion keeps a fix from closing the wall by dropping faces: 565.540 m2 is
//! the IfcOpenShell reference area recorded in #8186.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext,
    MeshProductionOptions,
};
use ifc_lite_processing::{process_geometry, MeshData};
use rustc_hash::FxHashMap;
use std::collections::HashMap;

const WALL: u32 = 43810;
const REFERENCE_AREA_M2: f64 = 565.540;
/// A dropped face of 0.01 m2 or more fails; the frames below agree to 1e-3.
const AREA_TOLERANCE_M2: f64 = 0.01;

fn fixture() -> Vec<u8> {
    let path = format!(
        "{}/tests/fixtures/issue_8156_wall_43810.ifc",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// World position of a vertex: the per-mesh origin folded in, in f64.
fn world(mesh: &MeshData, i: u32) -> [f64; 3] {
    let b = i as usize * 3;
    [0, 1, 2].map(|k| mesh.positions[b + k] as f64 + mesh.origin[k])
}

/// Vertices welded at `quantum` metres: (undirected edges whose forward and
/// reverse use counts differ, triangles that collapsed under the weld).
fn open_edges(meshes: &[MeshData], quantum: f64) -> (usize, usize) {
    let mut edges: HashMap<([i64; 3], [i64; 3]), (u32, u32)> = HashMap::new();
    let mut collapsed = 0;
    for mesh in meshes {
        for t in mesh.indices.chunks_exact(3) {
            let [a, b, c] =
                [t[0], t[1], t[2]].map(|i| world(mesh, i).map(|v| (v / quantum).round() as i64));
            if a == b || b == c || c == a {
                collapsed += 1;
                continue;
            }
            for (x, y) in [(a, b), (b, c), (c, a)] {
                let uses = edges.entry((x.min(y), x.max(y))).or_insert((0, 0));
                if x < y {
                    uses.0 += 1;
                } else {
                    uses.1 += 1;
                }
            }
        }
    }
    (edges.values().filter(|(f, r)| f != r).count(), collapsed)
}

fn area(meshes: &[MeshData]) -> f64 {
    let mut sum = 0.0;
    for mesh in meshes {
        for t in mesh.indices.chunks_exact(3) {
            let [a, b, c] = [t[0], t[1], t[2]].map(|i| world(mesh, i));
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            sum += 0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        }
    }
    sum
}

/// What is wrong with the wall's mesh in one frame, if anything.
fn wall_defects(meshes: &[MeshData], frame: &str) -> Option<String> {
    if meshes.is_empty() {
        return Some(format!("{frame}: wall #{WALL} produced no mesh"));
    }
    let tris: usize = meshes.iter().map(|m| m.indices.len() / 3).sum();
    let mut defects = Vec::new();
    for quantum in [1.0e-5, 1.0e-7] {
        let (open, collapsed) = open_edges(meshes, quantum);
        if (open, collapsed) != (0, 0) {
            defects.push(format!(
                "{open} open edges and {collapsed} collapsed triangles at a {quantum} m weld"
            ));
        }
    }
    let area = area(meshes);
    if (area - REFERENCE_AREA_M2).abs() > AREA_TOLERANCE_M2 {
        defects.push(format!("area {area:.4} m2, reference {REFERENCE_AREA_M2} m2"));
    }
    (!defects.is_empty())
        .then(|| format!("{frame} ({tris} triangles): {}", defects.join("; ")))
}

#[test]
fn issue_8156_wall_43810_is_closed_through_the_native_pipeline() {
    let result = process_geometry(&fixture());
    let meshes: Vec<MeshData> =
        result.meshes.into_iter().filter(|m| m.express_id == WALL).collect();
    if let Some(defect) = wall_defects(&meshes, "process_geometry (native default)") {
        panic!("wall #{WALL} (#8156): {defect}");
    }
}

/// The `IfcSite` placement's translation in metres: the offset the native
/// pipeline subtracts for this model.
fn site_translation(
    content: &[u8],
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> (f64, f64, f64) {
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCSITE" {
            let site = decoder.decode_at_with_id(id, start, end).expect("IfcSite decodes");
            let m = router
                .resolve_scaled_placement(&site, decoder)
                .expect("IfcSite placement resolves");
            return (m[12], m[13], m[14]);
        }
    }
    panic!("the fixture has no IfcSite");
}

fn void_index(content: &[u8], decoder: &mut EntityDecoder) -> FxHashMap<u32, Vec<u32>> {
    let mut index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCRELVOIDSELEMENT" {
            let rel = decoder.decode_at_with_id(id, start, end).expect("the relation decodes");
            if let (Some(host), Some(opening)) = (rel.get_ref(4), rel.get_ref(5)) {
                index.entry(host).or_default().push(opening);
            }
        }
    }
    index
}

#[derive(Clone, Copy)]
enum Offset {
    Site,
    None,
}

/// The wall through `produce_element_meshes` in each listed vertex frame, by
/// explicit router policy (see `issue_6940_opening_filling_a_profile_hole.rs`):
/// the defects found, one line per frame.
fn frame_defects(frames: &[(&str, Offset, bool)]) -> Vec<String> {
    let bytes = fixture();
    let index = std::sync::Arc::new(build_entity_index(&bytes));
    let mut decoder = EntityDecoder::with_arc_index(&bytes, index);
    let units = GeometryRouter::with_units(&bytes, &mut decoder);
    let site = site_translation(&bytes, &units, &mut decoder);
    let voids = void_index(&bytes, &mut decoder);
    assert_eq!(voids.get(&WALL).map(Vec::len), Some(38), "the wall's 38 openings");
    let (styles, colours, materials, textures) = (
        FxHashMap::default(),
        FxHashMap::default(),
        FxHashMap::default(),
        FxHashMap::default(),
    );
    let ctx = MeshProductionContext {
        void_index: &voids,
        geometry_style_index: &styles,
        indexed_colour_full: &colours,
        element_material_colors: &materials,
        texture_index: &textures,
        site_local_rotation: None,
    };
    let mut defects = Vec::new();
    for &(frame, offset, local_frame) in frames {
        let mut router = GeometryRouter::with_scale_and_local_frame(units.unit_scale(), local_frame);
        router.set_rtc_offset(match offset {
            Offset::Site => site,
            Offset::None => (0.0, 0.0, 0.0),
        });
        let entity = decoder.decode_by_id(WALL).expect("the wall decodes");
        let job = ElementMeshJob {
            id: WALL,
            ifc_type: entity.ifc_type.clone(),
            entity: &entity,
            kind: ElementJobKind::Product,
            element_color: None,
            metadata: None,
        };
        let opts = MeshProductionOptions::default();
        let meshes = produce_element_meshes(&job, &ctx, &opts, &mut decoder, &router).meshes;
        defects.extend(wall_defects(&meshes, frame));
    }
    defects
}

/// The native pipeline's frame and the browser batch frame ("no offset,
/// per-element local frame": this model needs no RTC shift), plus world
/// coordinates with no offset.
#[test]
fn issue_8156_wall_43810_is_closed_in_the_native_and_browser_frames() {
    let defects = frame_defects(&[
        ("site offset, world coordinates", Offset::Site, false),
        ("no offset, per-element local frame (browser batch)", Offset::None, true),
        ("no offset, world coordinates", Offset::None, false),
    ]);
    assert!(defects.is_empty(), "wall #{WALL} (#8156):\n{}", defects.join("\n"));
}

/// The site offset AND a per-element local frame: the frame of the appearance
/// `Context::evaluated_router`, and of `process_geometry` compiled to wasm.
/// Here the two abutting openings' footprints reach the void cut 7.6 µm apart,
/// so the coaxial union hands the batched subtract two prisms and the kernel's
/// abutting merge unions them first. That union put a vertex of the shared
/// jamb one ulp off the jamb's plane: the fixed-width materialisation divided
/// f64-rounded operands, and the exact coordinate (the plane's) was lost. The jamb
/// was no longer planar, the next subtract split its diagonal on one side of
/// the seam only, and the cut came back with a T-junction (3 open edges), which
/// `clean_void_output`'s hygiene widened to 15.
#[test]
fn issue_8156_wall_43810_is_closed_in_the_site_offset_local_frame() {
    let defects = frame_defects(&[("site offset, per-element local frame", Offset::Site, true)]);
    assert!(defects.is_empty(), "wall #{WALL} (#8156):\n{}", defects.join("\n"));
}
