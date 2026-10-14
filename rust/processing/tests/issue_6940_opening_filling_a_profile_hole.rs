// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #6940 through the shared producer: floor slabs whose profile already
//! carries its holes (`IfcArbitraryProfileDefWithVoids`) and whose
//! `IfcOpeningElement`s fill those holes exactly, footprint and depth. The
//! openings remove nothing, so each slab must come back closed.
//!
//! They tore where a second hole had a wall a few micrometres off collinear
//! with a wall of a filled one: the router extends the opening cutter through
//! the slab, and the subtract weld then moved the extended corner off its own
//! hole wall onto the other hole's wall plane. The kernel-level reproduction
//! is `rust/geometry/tests/issue_6940_hole_wall_cutter_weld.rs` and needs no
//! fixture. This one enters through `process_geometry`, the native
//! orchestrator over `produce_element_meshes`, so it covers the path every
//! consumer shares rather than the kernel entry point alone.
//!
//! It needs the fixture because a hand-written slab of this shape does not
//! tear here: measured with the guard switched off, a two-hole slab with one
//! or both holes filled has its cutter welded 18 vertices off its walls and
//! still comes back closed through the router. The seven slabs below do tear
//! without the guard (39 open edges each on `main`).
//!
//! # Every vertex frame
//!
//! The result used to depend on the frame the vertices are stored in. The
//! native pipeline subtracts the `IfcSite` translation and stores world
//! coordinates; the browser batch path subtracts nothing for this model and
//! stores each element relative to its own origin. Whichever frame is used
//! decides which hole corners and opening corners, authored as one point,
//! round onto neighbouring positions of the kernel grid; a corner one grid
//! step off its hole tears the slab
//! (`rust/geometry/src/router/voids/synthesis/host_vertices.rs`). Measured on
//! slab 137627 with the weld guard alone: 0 open edges in the native frame,
//! 12 in the browser's, 3 with no offset and no local frame.
//!
//! So the second test drives `produce_element_meshes` itself over the four
//! combinations of model offset and per-element local frame, by an explicit
//! router policy, the way `issue_5739_local_frame_voided_wall.rs` does. The
//! combination with no offset and a local frame reproduces the mesh the wasm
//! bundle emitted for these slabs before the reconcile (416 triangles, 12
//! open edges through `buildPrePassOnce` and `processGeometryBatch`).
//!
//! # Without the fixture
//!
//! Fixtures are not committed, and by the repository's rule a test whose
//! fixture is absent skips: both tests here then print why and return, which
//! the harness counts as a pass (`IFC_LITE_REQUIRE_FIXTURES=1` turns the skip
//! into a failure on the lanes that fetch fixtures). A lane without fixtures
//! therefore learns nothing from this file. The witnesses that need no
//! fixture are `rust/geometry/tests/issue_6940_hole_wall_cutter_weld.rs` for
//! the weld guard and `rust/geometry/tests/issue_6940_opening_corner_one_step_off.rs`
//! for the corner reconcile.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext,
    MeshProductionOptions,
};
use ifc_lite_processing::{process_geometry, MeshData};
use rustc_hash::FxHashMap;
use std::collections::HashMap;

// Stated oracle invariant (#6940): one kernel snap step is exactly 1/65536 m.
// Integration tests do not reach into crate-private implementation constants.
const KERNEL_GRID: f64 = 1.0 / 65536.0;

const FIXTURE: &str = "tests/models/georeferencer/MiniBIM-3.1-DO_01_VORM.ifc";

/// The slabs every one of whose openings fills a hole of its own profile.
const SLABS: [u32; 7] = [137627, 139545, 141434, 143323, 145212, 151760, 154626];

/// `IFC_LITE_REQUIRE_FIXTURES`, read as `rust/export/src/test_support.rs`
/// documents it: unset, empty or `"0"` skips a missing fixture, `"1"` (CI)
/// makes it a failure, anything else panics.
fn require_fixtures() -> bool {
    match std::env::var("IFC_LITE_REQUIRE_FIXTURES") {
        Err(std::env::VarError::NotPresent) => false,
        Ok(v) if v.is_empty() || v == "0" => false,
        Ok(v) if v == "1" => true,
        other => {
            panic!("IFC_LITE_REQUIRE_FIXTURES must be unset, \"\", \"0\" or \"1\"; got {other:?}")
        }
    }
}

/// Undirected edges not used exactly once in each direction, vertices welded
/// at the 1/65536 m kernel grid: 0 iff the triangles close consistently wound. Collapsed triangles
/// are skipped, as the watertightness census skips them.
fn open_edges(triangles: &[[[i64; 3]; 3]]) -> usize {
    let mut edges: HashMap<([i64; 3], [i64; 3]), (u32, u32)> = HashMap::new();
    for [a, b, c] in triangles {
        if a == b || b == c || c == a {
            continue;
        }
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let uses = edges.entry((*x.min(y), *x.max(y))).or_insert((0, 0));
            if x < y {
                uses.0 += 1;
            } else {
                uses.1 += 1;
            }
        }
    }
    edges.values().filter(|&&(f, r)| f != 1 || r != 1).count()
}

/// The fixture's bytes, or `None` (after the `IFC_LITE_REQUIRE_FIXTURES`
/// check) when it has not been fetched.
fn fixture() -> Option<Vec<u8>> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(FIXTURE);
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) => {
            assert!(
                !require_fixtures(),
                "{FIXTURE} is missing ({e}) and IFC_LITE_REQUIRE_FIXTURES=1"
            );
            eprintln!("{FIXTURE} missing, skipping; fetch it with `pnpm fixtures`");
            None
        }
    }
}

/// One element's triangles on the 1/65536 m kernel grid of WORLD positions (the per-mesh
/// origin folded in), over every mesh it produced.
fn world_triangles<'a>(meshes: impl Iterator<Item = &'a MeshData>) -> Vec<[[i64; 3]; 3]> {
    let mut triangles = Vec::new();
    for mesh in meshes {
        let key = |i: u32| {
            let b = i as usize * 3;
            [0, 1, 2]
                .map(|k| ((mesh.positions[b + k] as f64 + mesh.origin[k]) / KERNEL_GRID).round() as i64)
        };
        triangles.extend(
            mesh.indices
                .chunks_exact(3)
                .map(|t| [key(t[0]), key(t[1]), key(t[2])]),
        );
    }
    triangles
}

fn assert_closed(id: u32, triangles: &[[[i64; 3]; 3]], frame: &str) {
    assert!(
        !triangles.is_empty(),
        "slab {id}, {frame}: no mesh was produced"
    );
    assert_eq!(
        open_edges(triangles),
        0,
        "slab {id}, {frame}: openings that fill its profile holes tore it ({} triangles)",
        triangles.len()
    );
}

#[test]
fn issue_6940_openings_filling_profile_holes_leave_the_slabs_closed() {
    let Some(bytes) = fixture() else { return };
    let result = process_geometry(&bytes);
    for id in SLABS {
        let triangles = world_triangles(result.meshes.iter().filter(|m| m.express_id == id));
        assert_closed(id, &triangles, "the native pipeline");
    }
}

/// The `IfcSite` placement's translation in metres: what the native pipeline
/// subtracts for this model (`MeshFrame::select`'s site tier).
fn site_translation(
    content: &[u8],
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> (f64, f64, f64) {
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCSITE" {
            let site = decoder
                .decode_at_with_id(id, start, end)
                .expect("IfcSite decodes");
            let m = router
                .resolve_scaled_placement(&site, decoder)
                .expect("IfcSite placement resolves");
            return (m[12], m[13], m[14]);
        }
    }
    panic!("{FIXTURE} has no IfcSite");
}

fn void_index(content: &[u8], decoder: &mut EntityDecoder) -> FxHashMap<u32, Vec<u32>> {
    let mut index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCRELVOIDSELEMENT" {
            let rel = decoder
                .decode_at_with_id(id, start, end)
                .expect("the relation decodes");
            if let (Some(host), Some(opening)) = (rel.get_ref(4), rel.get_ref(5)) {
                index.entry(host).or_default().push(opening);
            }
        }
    }
    index
}

/// The slabs through `produce_element_meshes` in each of the four vertex
/// frames a pipeline can put them in. The frame is a router policy, not a
/// process-global switch, so this cannot disturb another test.
#[test]
fn issue_6940_the_slabs_are_closed_in_every_vertex_frame() {
    let Some(bytes) = fixture() else { return };
    let index = std::sync::Arc::new(build_entity_index(&bytes));
    let mut decoder = EntityDecoder::with_arc_index(&bytes, index);
    let units = GeometryRouter::with_units(&bytes, &mut decoder);
    let site = site_translation(&bytes, &units, &mut decoder);
    assert!(
        site.0.abs() > 1.0 && site.1.abs() > 1.0,
        "the site offset must be a real one for the frames to differ; got {site:?}"
    );
    let voids = void_index(&bytes, &mut decoder);
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
    let frames = [
        (
            "site offset, world coordinates (native default)",
            site,
            false,
        ),
        ("site offset, per-element local frame", site, true),
        (
            "no offset, per-element local frame (browser batch)",
            (0.0, 0.0, 0.0),
            true,
        ),
        ("no offset, world coordinates", (0.0, 0.0, 0.0), false),
    ];
    for (frame, offset, local_frame) in frames {
        let mut router =
            GeometryRouter::with_scale_and_local_frame(units.unit_scale(), local_frame);
        router.set_rtc_offset(offset);
        for id in SLABS {
            let entity = decoder.decode_by_id(id).expect("the slab decodes");
            assert!(
                voids.contains_key(&id),
                "slab {id} has openings in the void index"
            );
            let job = ElementMeshJob {
                id,
                ifc_type: entity.ifc_type.clone(),
                entity: &entity,
                kind: ElementJobKind::Product,
                element_color: None,
                metadata: None,
            };
            let opts = MeshProductionOptions::default();
            let meshes = produce_element_meshes(&job, &ctx, &opts, &mut decoder, &router).meshes;
            assert_closed(id, &world_triangles(meshes.iter()), frame);
        }
    }
}
