// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The Rhino scene (`ifc_lite_export::rhino`, spec
//! `docs/architecture/rhino-3dm-export.md`, "Testing > Rust"): the wire
//! invariants adapters rely on, units, frame and earth anchor, the instancing
//! exactly-once invariant, layers, user text, and a hash-pinned golden.

#[path = "../src/test_support.rs"]
#[allow(dead_code, unused_macros)]
mod test_support;
#[path = "support/golden.rs"]
mod golden;
#[path = "support/rhino_ifc.rs"]
mod rhino_ifc;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use ifc_lite_export::rhino::*;
use ifc_lite_export::ExportError;
use rhino_ifc::{Ifc, Site, FOOT, METRE, MILLIMETRE};
use serde_json::Value;

/// `(key, path)`: in-tree paths start with `rust/`, the rest are catalogued.
const FIXTURES: &[(&str, &str)] = &[
    ("AC20-FZK-Haus", "ara3d/AC20-FZK-Haus.ifc"),
    ("duplex", "ara3d/duplex.ifc"),
    ("bath_csg_solid", "rust/geometry/tests/fixtures/bath_csg_solid.ifc"),
    ("mapped_instances_synthetic", "rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc"),
    ("mapped_instances_site_rotated", "rust/geometry/tests/fixtures/mapped_instances_site_rotated.ifc"),
    ("mapped_instances_multi_item", "rust/geometry/tests/fixtures/mapped_instances_multi_item.ifc"),
    ("mapped_instances_nested", "rust/geometry/tests/fixtures/mapped_instances_nested.ifc"),
    ("wall_two_openings", "rust/processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc"),
    ("multicolor_element", "rust/processing/tests/fixtures/issue_6601_multicolor_element.ifc"),
    ("c6_data_model_synthetic", "rust/export/tests/fixtures/c6_data_model_synthetic.ifc"),
];

fn load(path: &str) -> Option<Vec<u8>> {
    if path.starts_with("rust/") {
        let abs = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
        Some(std::fs::read(&abs).unwrap_or_else(|e| panic!("in-tree fixture {abs}: {e}")))
    } else {
        test_support::fixture_opt(path)
    }
}

fn fixtures() -> Vec<(&'static str, Vec<u8>)> {
    FIXTURES.iter().filter_map(|(k, p)| load(p).map(|b| (*k, b))).collect()
}

fn scene(bytes: &[u8], opts: &RhinoSceneOptions) -> RhinoScene {
    build_rhino_scene(bytes, opts).unwrap_or_else(|e| panic!("scene: {e}"))
}

fn user<'s>(o: &'s RhinoObject, key: &str) -> Option<&'s str> {
    o.user_strings.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn doc<'s>(s: &'s RhinoScene, key: &str) -> Option<&'s str> {
    s.document_strings.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn express_id(o: &RhinoObject) -> u32 {
    user(o, "IFC::ExpressId").expect("IFC::ExpressId is always written").parse().unwrap()
}

/// Full slash-joined layer path.
fn layer_path(s: &RhinoScene, mut i: usize) -> String {
    let mut parts = vec![s.layers[i].name.clone()];
    while let Some(p) = s.layers[i].parent {
        parts.push(s.layers[p].name.clone());
        i = p;
    }
    parts.reverse();
    parts.join("/")
}

/// Written vertices of an object, instances through their xform.
fn object_vertices(s: &RhinoScene, o: &RhinoObject) -> Vec<[f64; 3]> {
    let (mesh_ids, xform): (Vec<usize>, Option<[f64; 16]>) = match &o.geometry {
        RhinoGeometry::Mesh { mesh } => (vec![*mesh], None),
        RhinoGeometry::Instance { block, xform } => (s.blocks[*block].meshes.clone(), Some(*xform)),
    };
    let mut out = Vec::new();
    for m in mesh_ids {
        for p in s.meshes[m].positions.chunks_exact(3) {
            out.push(match xform {
                None => [p[0], p[1], p[2]],
                Some(x) => std::array::from_fn(|r| x[r * 4] * p[0] + x[r * 4 + 1] * p[1] + x[r * 4 + 2] * p[2] + x[r * 4 + 3]),
            });
        }
    }
    out
}

fn bbox(points: impl IntoIterator<Item = [f64; 3]>) -> ([f64; 3], [f64; 3]) {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in points {
        for a in 0..3 {
            lo[a] = lo[a].min(p[a]);
            hi[a] = hi[a].max(p[a]);
        }
    }
    (lo, hi)
}

/// Every rule the wire format section promises adapters.
fn assert_wire_invariants(key: &str, s: &RhinoScene) {
    assert!(["Millimeters", "Centimeters", "Meters", "Feet", "Inches"].contains(&s.settings.unit_system), "{key}");
    let mut siblings: HashSet<(Option<usize>, &str)> = HashSet::new();
    for (i, l) in s.layers.iter().enumerate() {
        if let Some(p) = l.parent {
            assert!(p < i, "{key}: layer {i} '{}' precedes its parent {p}", l.name);
        }
        assert!(siblings.insert((l.parent, l.name.as_str())), "{key}: sibling layer name '{}' repeats", l.name);
        assert!(!l.name.is_empty() && !l.name.contains("::"), "{key}: layer name '{}'", l.name);
    }
    for m in &s.meshes {
        let vcount = m.positions.len() / 3;
        assert_eq!(m.positions.len() % 3, 0, "{key}");
        assert_eq!(m.indices.len() % 3, 0, "{key}");
        assert!(m.positions.iter().all(|v| v.is_finite()), "{key}: non-finite position");
        assert!(m.indices.iter().all(|&i| (i as usize) < vcount), "{key}: index out of range");
        if let Some(n) = &m.normals {
            assert_eq!(n.len(), m.positions.len(), "{key}");
            assert!(n.iter().all(|v| v.is_finite()), "{key}");
        }
    }
    for b in &s.blocks {
        assert!(b.layer < s.layers.len() && b.meshes.iter().all(|&m| m < s.meshes.len()), "{key}");
    }
    for o in &s.objects {
        assert!(o.layer < s.layers.len() && o.material < s.materials.len(), "{key}");
        assert!(o.groups.iter().all(|&g| g < s.groups.len()), "{key}");
        match &o.geometry {
            RhinoGeometry::Mesh { mesh } => assert!(*mesh < s.meshes.len(), "{key}"),
            RhinoGeometry::Instance { block, xform } => {
                assert!(*block < s.blocks.len(), "{key}");
                assert!(xform.iter().all(|v| v.is_finite()), "{key}");
            }
        }
        assert!(o.user_strings.iter().all(|(k, v)| !v.is_empty() && !k.starts_with('.')), "{key}");
        let keys: HashSet<&str> = o.user_strings.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys.len(), o.user_strings.len(), "{key}: repeated user-text key");
        assert_eq!(o.object_id.len(), 36, "{key}");
    }
    let ids: HashSet<&str> = s.objects.iter().map(|o| o.object_id.as_str()).collect();
    assert_eq!(ids.len(), s.objects.len(), "{key}: objectId repeats");
}

/// The manifest parses, every buffer sits on an 8-byte boundary inside the
/// blob, and decoding the blob gives back the scene's own numbers.
fn assert_encoding_round_trips(key: &str, s: &RhinoScene) {
    let (manifest, blob) = s.clone().encode();
    let v: Value = serde_json::from_str(&manifest).expect("manifest is JSON");
    assert_eq!(v["format"], "ifc-lite.rhino-scene");
    assert_eq!(v["version"], 1);
    for field in ["settings", "warnings", "documentStrings", "layers", "materials", "groups", "meshes", "blocks", "objects"] {
        assert!(!v[field].is_null(), "{key}: manifest lacks {field}");
    }
    let read = |r: &Value, size: usize| -> Vec<u8> {
        let off = r["offset"].as_u64().unwrap() as usize;
        let count = r["count"].as_u64().unwrap() as usize;
        assert_eq!(off % 8, 0, "{key}: section at {off} is not 8-byte aligned");
        blob[off..off + count * size].to_vec()
    };
    for (m, wire) in s.meshes.iter().zip(v["meshes"].as_array().unwrap()) {
        let pos: Vec<f64> = read(&wire["positions"], 8).chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
        assert_eq!(pos, m.positions, "{key}");
        let idx: Vec<u32> = read(&wire["indices"], 4).chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        assert_eq!(idx, m.indices, "{key}");
        match &m.normals {
            Some(n) => {
                let got: Vec<f32> = read(&wire["normals"], 4).chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
                assert_eq!(&got, n, "{key}");
            }
            None => assert!(wire["normals"].is_null(), "{key}"),
        }
    }
    let first = &v["objects"][0];
    assert!(first["kind"] == "mesh" || first["kind"] == "instance", "{key}: {first}");
    for field in ["layer", "name", "objectId", "color", "material", "groups", "userStrings"] {
        assert!(!first[field].is_null(), "{key}: object lacks {field}");
    }
}

#[test]
fn every_fixture_meets_the_wire_invariants_and_is_deterministic() {
    for (key, bytes) in fixtures() {
        for instancing in [true, false] {
            let opts = RhinoSceneOptions { instancing, ..RhinoSceneOptions::default() };
            let s = scene(&bytes, &opts);
            assert_wire_invariants(key, &s);
            assert_encoding_round_trips(key, &s);
            assert_eq!(s.clone().encode(), scene(&bytes, &opts).encode(), "{key}: two builds differ");
        }
    }
}

fn golden_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

/// Fixtures whose meshes differ between arm64 and the x86_64 CI pins today:
/// AC20's `glb` and `usd` pins in `export_golden` already move on Apple
/// silicon at HEAD, so a scene pin taken on either platform fails on the
/// other. They still run every other test here.
const PLATFORM_SENSITIVE: &[&str] = &["AC20-FZK-Haus"];

/// Scene golden (spec "Testing > Rust"): manifest and blob hash-pinned per
/// fixture. The crate version in `IFC::Exporter` is normalised so a release
/// bump does not move the pin.
#[test]
fn rhino_scene_golden() {
    let mut g = golden::Golden::new(&golden_dir(), "rhino-scene", "cargo test -p ifc-lite-export --test rhino_scene -- --exact rhino_scene_golden");
    let mut expected = Vec::new();
    for (key, _) in FIXTURES.iter().filter(|(k, _)| !PLATFORM_SENSITIVE.contains(k)) {
        expected.push(format!("{key}/manifest"));
        expected.push(format!("{key}/blob"));
    }
    for (key, bytes) in fixtures().into_iter().filter(|(k, _)| !PLATFORM_SENSITIVE.contains(k)) {
        let (manifest, blob) = scene(&bytes, &RhinoSceneOptions::default()).encode();
        let version = env!("CARGO_PKG_VERSION");
        assert!(manifest.contains(&format!("ifc-lite {version}")), "{key}: drop the version normalisation");
        g.record(format!("{key}/manifest"), manifest.replace(version, "<CRATE_VERSION>").as_bytes());
        g.record(format!("{key}/blob"), &blob);
    }
    g.finish(&expected);
}

/// One 4 x 0.2 x 3 wall (in file units) on one storey.
fn one_wall(unit: &str) -> Vec<u8> {
    let mut f = Ifc::new(unit, None, Site::default());
    let s = f.storey("0storey000000000000001", Some("Level 1"), None, 0.0);
    f.wall("0wall00000000000000001", "W", s, [1.0, 2.0, 0.0], [4.0, 0.2, 3.0]);
    f.finish("one_wall.ifc")
}

/// Units (spec "Units"): `source` writes the project unit, so the authored
/// numbers come back unchanged; the tolerance is 1 mm in that unit.
#[test]
fn source_units_keep_authored_numbers_in_mm_m_and_ft() {
    for (unit, system, mpu) in [(MILLIMETRE, "Millimeters", 0.001), (METRE, "Meters", 1.0), (FOOT, "Feet", 0.3048)] {
        let s = scene(&one_wall(unit), &RhinoSceneOptions::default());
        assert_eq!((s.settings.unit_system, s.settings.meters_per_unit), (system, mpu));
        assert!((s.settings.absolute_tolerance - 0.001 / mpu).abs() < 1e-15, "{system}");
        assert!(s.warnings.is_empty(), "{system}: {:?}", s.warnings);
        assert_eq!(doc(&s, "IFC::LengthUnit"), Some(system));
        let (lo, hi) = bbox(object_vertices(&s, &s.objects[0]));
        let expect_lo = [1.0, 2.0, 0.0];
        let expect_hi = [5.0, 2.2, 3.0];
        for a in 0..3 {
            assert!((lo[a] - expect_lo[a]).abs() < 1e-6 && (hi[a] - expect_hi[a]).abs() < 1e-6, "{system}: {lo:?} {hi:?}");
        }
    }
    // An explicit unit rescales from the source: 4 m of wall in a metre file is 4000 mm.
    let opts = RhinoSceneOptions { units: RhinoUnits::Millimeters, ..RhinoSceneOptions::default() };
    let s = scene(&one_wall(METRE), &opts);
    let (lo, hi) = bbox(object_vertices(&s, &s.objects[0]));
    assert!((hi[0] - lo[0] - 4000.0).abs() < 1e-3, "{lo:?} {hi:?}");
    assert_eq!(s.settings.absolute_tolerance, 1.0);
}

#[test]
fn a_unit_rhino_cannot_name_falls_back_to_metres_with_one_warning() {
    let decimetre = "IFCSIUNIT(*,.LENGTHUNIT.,.DECI.,.METRE.)";
    let s = scene(&one_wall(decimetre), &RhinoSceneOptions::default());
    assert_eq!(s.settings.unit_system, "Meters");
    assert_eq!(s.warnings, ["length unit scale 0.1 is not a Rhino unit; wrote Meters"]);
    let (lo, hi) = bbox(object_vertices(&s, &s.objects[0]));
    assert!((hi[0] - lo[0] - 0.4).abs() < 1e-6, "4 dm of wall is 0.4 m: {lo:?} {hi:?}");
}

/// Swiss LV95 magnitude, where the f32 step is 0.25 m.
const SITE_AT: [f64; 3] = [2_600_000.3, 1_200_000.7, 410.25];
const WALL_AT: [f64; 3] = [5.0, 3.0, 0.0];
const WALL_SIZE: [f64; 3] = [4.0, 0.2, 3.0];

/// A site translated to LV95 and yawed 30 degrees (the `site_local` tier),
/// with a reference location and a TrueNorth.
fn georeferenced_far_site() -> Vec<u8> {
    let (s30, c30) = (30f64.to_radians().sin(), 30f64.to_radians().cos());
    let site = Site {
        at: SITE_AT,
        x_dir: [c30, s30],
        ref_lat_lon: Some(("(47,22,36,840000)", "(8,32,30,120000)")),
        ref_elevation: Some(408.0),
    };
    let mut f = Ifc::new(METRE, Some([-0.5, 0.866_025_403_784_438_6]), site);
    let s = f.storey("0storey000000000000001", Some("Level 1"), None, 0.0);
    f.wall("0wall00000000000000001", "W", s, WALL_AT, WALL_SIZE);
    f.finish("far.ifc")
}

/// The analytic IFC world box of the wall in [`georeferenced_far_site`].
fn far_world_box() -> ([f64; 3], [f64; 3]) {
    let (s30, c30) = (30f64.to_radians().sin(), 30f64.to_radians().cos());
    let corners = (0..8).map(|i| {
        let c = [
            WALL_AT[0] + if i & 1 == 1 { WALL_SIZE[0] } else { 0.0 },
            WALL_AT[1] + if i & 2 == 2 { WALL_SIZE[1] } else { 0.0 },
            WALL_AT[2] + if i & 4 == 4 { WALL_SIZE[2] } else { 0.0 },
        ];
        [SITE_AT[0] + c30 * c[0] - s30 * c[1], SITE_AT[1] + s30 * c[0] + c30 * c[1], SITE_AT[2] + c[2]]
    });
    bbox(corners)
}

fn apply_row_major(m: &[f64], p: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|r| m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3])
}

/// Frame (spec "Coordinates"): `local` stays small and records the shift;
/// `world` reproduces IFC world coordinates to 1e-6 m.
#[test]
fn local_is_small_with_world_from_model_and_world_matches_ifc_world() {
    let bytes = georeferenced_far_site();
    let local = scene(&bytes, &RhinoSceneOptions::default());
    let world = scene(&bytes, &RhinoSceneOptions { coordinates: RhinoCoordinates::World, ..RhinoSceneOptions::default() });
    assert_eq!(doc(&local, "IFC::Coordinates"), Some("local"));
    assert_eq!(doc(&world, "IFC::Coordinates"), Some("world"));

    let local_pts = object_vertices(&local, &local.objects[0]);
    assert!(local_pts.iter().flatten().all(|v| v.abs() < 100.0), "local vertices stay near the origin");
    let wfm: Vec<f64> = doc(&local, "IFC::WorldFromModel").expect("a shifted frame records its shift")
        .split(' ').map(|v| v.parse().unwrap()).collect();
    assert_eq!(wfm.len(), 16);
    // Applying it to world vertices would move them a second time (found by the import spec).
    assert_eq!(doc(&world, "IFC::WorldFromModel"), None, "world coordinates need no restore");

    let (lo, hi) = far_world_box();
    let (wlo, whi) = bbox(object_vertices(&world, &world.objects[0]));
    let (rlo, rhi) = bbox(local_pts.iter().map(|&p| apply_row_major(&wfm, p)));
    for a in 0..3 {
        for (got, want) in [(wlo[a], lo[a]), (whi[a], hi[a]), (rlo[a], lo[a]), (rhi[a], hi[a])] {
            assert!((got - want).abs() < 1e-6, "axis {a}: {got} vs {want} (off {:e})", got - want);
        }
    }
}

/// Earth anchor (spec "Coordinates"): the site's RefLatitude / RefLongitude,
/// the site origin as the base point, TrueNorth as north, in written frame.
#[test]
fn earth_anchor_reads_the_site_and_true_north_in_the_written_frame() {
    let bytes = georeferenced_far_site();
    let world = scene(&bytes, &RhinoSceneOptions { coordinates: RhinoCoordinates::World, ..RhinoSceneOptions::default() });
    let a = world.settings.earth_anchor.as_ref().expect("site carries RefLatitude/RefLongitude");
    assert!((a.latitude - (47.0 + 22.0 / 60.0 + 36.84 / 3600.0)).abs() < 1e-12, "{}", a.latitude);
    assert!((a.longitude - (8.0 + 32.0 / 60.0 + 30.12 / 3600.0)).abs() < 1e-12, "{}", a.longitude);
    assert_eq!(a.elevation, 408.0);
    assert!(a.model_base_point.iter().zip(SITE_AT).all(|(g, w)| (g - w).abs() < 1e-9), "{:?}", a.model_base_point);
    let close = |v: [f64; 3], w: [f64; 3]| (0..3).all(|i| (v[i] - w[i]).abs() < 1e-9);
    assert!(close(a.model_north, [-0.5, 0.866_025_403_784_438_6, 0.0]), "{:?}", a.model_north);
    assert!(close(a.model_east, [0.866_025_403_784_438_6, 0.5, 0.0]), "{:?}", a.model_east);

    // Local: the frame removed the site translation and its 30 degree yaw, so
    // the base point is the origin and north turns by -30 degrees.
    let local = scene(&bytes, &RhinoSceneOptions::default());
    let a = local.settings.earth_anchor.as_ref().unwrap();
    assert!(a.model_base_point.iter().all(|v| v.abs() < 1e-6), "{:?}", a.model_base_point);
    assert!(close(a.model_north, [0.0, 1.0, 0.0]), "TrueNorth 30 deg west of +Y, site yawed 30 deg: {:?}", a.model_north);

    // No reference location, no anchor.
    assert!(scene(&one_wall(METRE), &RhinoSceneOptions::default()).settings.earth_anchor.is_none());
}

/// The pipeline's site (the first in the file) at (100, 0, 0) without a
/// reference location, and a second site carrying one, placed by `placement`.
fn second_site_model(placement: &str) -> Vec<u8> {
    let mut f = Ifc::new(METRE, None, Site { at: [100.0, 0.0, 0.0], ..Site::default() });
    let s = f.storey("0storey000000000000001", Some("Level 1"), None, 0.0);
    f.wall("0wall00000000000000001", "W", s, WALL_AT, WALL_SIZE);
    let placement = if placement.is_empty() { format!("#{}", f.placement(None, [10.0, 20.0, 5.0])) } else { placement.to_string() };
    let second = f.add(format!(
        "IFCSITE('0site000000000000000002',$,'Second',$,$,{placement},$,$,.ELEMENT.,(47,22,36,840000),(8,32,30,120000),408.,$,$)"
    ));
    f.add(format!("IFCRELAGGREGATES('0aggsecondsite00000001',$,$,$,#{},(#{second}))", f.project));
    f.finish("two-sites.ifc")
}

/// Earth anchor (spec "Coordinates"): location and base point come from the
/// same site. With the reference location on a second site, the base point is
/// that site's placement origin, not the pipeline's site at (100, 0, 0).
#[test]
fn earth_anchor_base_point_comes_from_the_site_with_the_location() {
    let bytes = second_site_model("");
    let want = [10.0, 20.0, 5.0];
    let close = |v: [f64; 3]| (0..3).all(|i| (v[i] - want[i]).abs() < 1e-9);
    let world = scene(&bytes, &RhinoSceneOptions { coordinates: RhinoCoordinates::World, ..RhinoSceneOptions::default() });
    let a = world.settings.earth_anchor.as_ref().expect("the second site carries RefLatitude/RefLongitude");
    assert!((a.latitude - (47.0 + 22.0 / 60.0 + 36.84 / 3600.0)).abs() < 1e-12, "{}", a.latitude);
    assert!(close(a.model_base_point), "{:?}", a.model_base_point);
    assert!(world.warnings.is_empty(), "{:?}", world.warnings);

    // Local: the written base point is the same IFC world point in the written frame.
    let local = scene(&bytes, &RhinoSceneOptions::default());
    let a = local.settings.earth_anchor.as_ref().unwrap();
    let restored = match doc(&local, "IFC::WorldFromModel") {
        Some(m) => apply_row_major(&m.split(' ').map(|v| v.parse().unwrap()).collect::<Vec<f64>>(), a.model_base_point),
        None => a.model_base_point,
    };
    assert!(close(restored), "{restored:?}");

    // A placement that does not resolve: no anchor, one warning, never a guessed base point.
    let broken = scene(&second_site_model("#999999"), &RhinoSceneOptions::default());
    assert!(broken.settings.earth_anchor.is_none());
    assert_eq!(broken.warnings, ["the IfcSite with RefLatitude/RefLongitude has no resolvable placement; wrote no earth anchor"]);
}

/// The pipeline's own site carrying the reference location, with a placement
/// that does not resolve (no `site_transform`): no anchor and one warning, not
/// a base point at the origin.
#[test]
fn an_unresolved_pipeline_site_writes_no_anchor() {
    let site = Site { ref_lat_lon: Some(("(47,22,36,840000)", "(8,32,30,120000)")), ..Site::default() };
    let mut f = Ifc::new(METRE, None, site);
    let s = f.storey("0storey000000000000001", Some("Level 1"), None, 0.0);
    f.wall("0wall00000000000000001", "W", s, WALL_AT, WALL_SIZE);
    let placement = format!("'Site',$,$,#{},", f.site_placement);
    let text = String::from_utf8(f.finish("unresolved-site.ifc")).unwrap();
    assert_eq!(text.matches(&placement).count(), 1);
    let s = scene(text.replace(&placement, "'Site',$,$,#999999,").as_bytes(), &RhinoSceneOptions::default());
    assert!(s.settings.earth_anchor.is_none(), "{:?}", s.settings.earth_anchor);
    assert_eq!(s.warnings, ["the IfcSite with RefLatitude/RefLongitude has no resolvable placement; wrote no earth anchor"]);
}

/// Instancing exactly-once (spec "Blocks"): the geometry-bearing ids of the
/// instanced scene equal the baked scene's, an element is mesh objects or one
/// instance and never both, and each instance lands on the baked vertices.
#[test]
fn instancing_writes_every_element_exactly_once_on_the_baked_vertices() {
    let mut instanced_somewhere = false;
    let mut worst_abs = 0.0f64;
    for (key, bytes) in fixtures() {
        let inst = scene(&bytes, &RhinoSceneOptions::default());
        let baked = scene(&bytes, &RhinoSceneOptions { instancing: false, ..RhinoSceneOptions::default() });
        assert!(baked.blocks.is_empty(), "{key}");
        let ids = |s: &RhinoScene| s.objects.iter().map(express_id).collect::<BTreeSet<u32>>();
        assert_eq!(ids(&inst), ids(&baked), "{key}: instancing changed which elements are written");

        let mut kinds: HashMap<u32, (usize, usize)> = HashMap::new();
        for o in &inst.objects {
            let e = kinds.entry(express_id(o)).or_default();
            match o.geometry {
                RhinoGeometry::Mesh { .. } => e.0 += 1,
                RhinoGeometry::Instance { .. } => e.1 += 1,
            }
        }
        for (id, (meshes, instances)) in &kinds {
            assert!(*instances == 0 || (*instances == 1 && *meshes == 0), "{key}: #{id} has {meshes} meshes and {instances} instances");
        }

        let baked_by_id: HashMap<u32, Vec<[f64; 3]>> = baked.objects.iter().fold(HashMap::new(), |mut m, o| {
            m.entry(express_id(o)).or_default().extend(object_vertices(&baked, o));
            m
        });
        for o in inst.objects.iter().filter(|o| matches!(o.geometry, RhinoGeometry::Instance { .. })) {
            instanced_somewhere = true;
            let got = object_vertices(&inst, o);
            let want = &baked_by_id[&express_id(o)];
            assert_eq!(got.len(), want.len(), "{key}: #{}", express_id(o));
            // Both sides come from f32 pipeline data (the occurrence transform
            // and the baked positions), so they can differ by a few f32 steps at
            // the vertex's magnitude: 1.3e-6 m on duplex. 1e-6 m plus 4 f32 ulps.
            for (g, w) in got.iter().zip(want) {
                for a in 0..3 {
                    let err = (g[a] - w[a]).abs();
                    let bound = 1e-6 + 4.0 * f64::from(f32::EPSILON) * w[a].abs();
                    worst_abs = worst_abs.max(err);
                    assert!(err <= bound, "{key}: instance #{} is {err:e} m from its baked vertex (bound {bound:e})", express_id(o));
                }
            }
        }
        // Every block is used, and its geometry is on the locked block layer.
        let used: BTreeSet<usize> = inst.objects.iter().filter_map(|o| match o.geometry {
            RhinoGeometry::Instance { block, .. } => Some(block),
            RhinoGeometry::Mesh { .. } => None,
        }).collect();
        assert_eq!(used.len(), inst.blocks.len(), "{key}: unused block definition");
        for b in &inst.blocks {
            let l = &inst.layers[b.layer];
            assert!(l.name == "IFC block geometry" && l.parent.is_none() && l.locked && l.visible, "{key}: {l:?}");
        }
    }
    assert!(instanced_somewhere, "no fixture exercised the instanced path");
    eprintln!("worst instance-vs-baked vertex error: {worst_abs:e} m");
}

/// The template occurrence is itself an instance (identity placement), so a
/// hidden template still leaves its block for the other occurrences.
#[test]
fn hiding_the_template_keeps_its_block_for_the_other_occurrences() {
    let bytes = load(FIXTURES[3].1).unwrap();
    let all = scene(&bytes, &RhinoSceneOptions::default());
    let template = all.objects.iter().find(|o| matches!(o.geometry, RhinoGeometry::Instance { xform, .. } if xform == [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0])).expect("template instance");
    let hidden = express_id(template);
    let s = scene(&bytes, &RhinoSceneOptions { hidden: vec![hidden], ..RhinoSceneOptions::default() });
    assert_eq!(s.objects.len(), all.objects.len() - 1);
    assert!(s.objects.iter().all(|o| express_id(o) != hidden));
    assert_eq!(s.blocks.len(), all.blocks.len());
}

#[test]
fn a_model_without_products_is_refused_not_written_empty() {
    let empty = Ifc::new(METRE, None, Site::default()).finish("empty.ifc");
    assert!(matches!(build_rhino_scene(&empty, &RhinoSceneOptions::default()), Err(ExportError::NoRenderGeometry)));
    // A filter that removes every element is refused the same way.
    let opts = RhinoSceneOptions { isolated: Some(vec![]), ..RhinoSceneOptions::default() };
    assert!(matches!(build_rhino_scene(&one_wall(METRE), &opts), Err(ExportError::NoRenderGeometry)));
    let opts = RhinoSceneOptions { hidden_types: vec!["IfcWall".into()], ..RhinoSceneOptions::default() };
    assert!(matches!(build_rhino_scene(&one_wall(METRE), &opts), Err(ExportError::NoRenderGeometry)));
}

/// Two storeys out of elevation order, a `::` name, an unnamed storey with
/// and without a LongName, duplicate sibling names, a space, an element in
/// the building, and a proxy outside the spatial tree.
fn layered_model() -> Vec<u8> {
    layered_model_ids().0
}

/// [`layered_model`] plus the ids of the second `Twin` and the bare storey.
fn layered_model_ids() -> (Vec<u8>, u32, u32) {
    let mut f = Ifc::new(METRE, None, Site::default());
    let upper = f.storey("0storey000000000000003", Some("Level 2"), None, 3.0);
    let lower = f.storey("0storey000000000000002", Some("Level::0"), None, -3.0);
    let dup_a = f.storey("0storey000000000000004", Some("Twin"), None, 6.0);
    let dup_b = f.storey("0storey000000000000005", Some("Twin"), None, 9.0);
    let long = f.storey("0storey000000000000006", None, Some("Roof long name"), 12.0);
    let bare = f.storey("0storey000000000000007", Some("  "), None, 15.0);
    f.wall("0wall00000000000000001", "Upper wall", upper, [0.0; 3], WALL_SIZE);
    f.wall("0wall00000000000000002", "Lower wall", lower, [0.0; 3], WALL_SIZE);
    f.element("IFCSLAB", ("0slab00000000000000001", "Slab"), lower, [5.0, 5.0, 0.2], "$,.FLOOR.");
    f.element("IFCSPACE", ("0space0000000000000001", "Room"), lower, [3.0, 3.0, 2.5], "$,.SPACE.,$");
    f.wall("0wall00000000000000003", "Twin A wall", dup_a, [0.0; 3], WALL_SIZE);
    f.wall("0wall00000000000000004", "Twin B wall", dup_b, [0.0; 3], WALL_SIZE);
    f.wall("0wall00000000000000005", "Roof wall", long, [0.0; 3], WALL_SIZE);
    f.wall("0wall00000000000000006", "Bare wall", bare, [0.0; 3], WALL_SIZE);
    let building = f.building_ref();
    f.element("IFCBUILDINGELEMENTPROXY", ("0prox00000000000000001", "In building"), building, [1.0; 3], "$");
    let orphan_pl = f.placement(None, [20.0, 0.0, 0.0]);
    let shape = f.box_shape([1.0; 3]);
    f.add(format!("IFCFURNITURE('0furn00000000000000001',$,'Loose chair',$,$,#{orphan_pl},#{shape},$,$)"));
    (f.finish("layers.ifc"), dup_b.0, bare.0)
}

/// Layers (spec "Layers"): tree order, storeys by elevation, names
/// sanitised and deduplicated, spaces hidden, `Unassigned` for orphans.
#[test]
fn spatial_name_uses_long_name_after_cleaning_empty_name() {
    // Review finding 1: U+200B is empty under Rhino layer-name cleaning.
    let mut f = Ifc::new(METRE, None, Site::default());
    let storey = f.storey("0storey000000000000001", Some("\u{200B}"), Some("Roof"), 0.0);
    f.wall("0wall00000000000000001", "Wall", storey, [0.0; 3], WALL_SIZE);
    let s = scene(&f.finish("clean_name.ifc"), &RhinoSceneOptions::default());
    assert!(s.layers.iter().any(|layer| layer.name == "Roof"));
}

#[test]
fn spatial_layers_follow_the_tree_and_sanitise_names() {
    let (bytes, twin_b, bare) = layered_model_ids();
    let s = scene(&bytes, &RhinoSceneOptions::default());
    assert_wire_invariants("layers", &s);
    let paths: Vec<String> = (0..s.layers.len()).map(|i| layer_path(&s, i)).collect();
    let storeys: Vec<&str> = s.layers.iter().filter(|l| l.parent == Some(2)).map(|l| l.name.as_str()).collect();
    let twin = format!("Twin #{twin_b}");
    let unnamed = format!("IfcBuildingStorey #{bare}");
    let want = ["Level:0", "Level 2", "Twin", twin.as_str(), "Roof long name", unnamed.as_str(), "IfcBuildingElementProxy"];
    assert_eq!(storeys, want, "{paths:#?}");
    let on = |name: &str| {
        let o = s.objects.iter().find(|o| o.name == name).unwrap_or_else(|| panic!("{name}"));
        paths[o.layer].clone()
    };
    assert_eq!(on("Lower wall"), "Proj/Site/Building/Level:0/IfcWall");
    assert_eq!(on("Slab"), "Proj/Site/Building/Level:0/IfcSlab");
    assert_eq!(on("Room"), "Proj/Site/Building/Level:0/IfcSpace");
    assert_eq!(on("Twin B wall"), format!("Proj/Site/Building/{twin}/IfcWall"));
    assert_eq!(on("In building"), "Proj/Site/Building/IfcBuildingElementProxy");
    assert_eq!(on("Loose chair"), "Unassigned/IfcFurniture");
    let space_layer = &s.layers[s.objects.iter().find(|o| o.name == "Room").unwrap().layer];
    assert!(!space_layer.visible, "IfcSpace sublayer is hidden");
    // Class sublayers sorted, coloured from the shared type table.
    let level0 = paths.iter().position(|p| p == "Proj/Site/Building/Level:0").unwrap();
    let classes: Vec<&str> = s.layers.iter().filter(|l| l.parent == Some(level0)).map(|l| l.name.as_str()).collect();
    assert_eq!(classes, ["IfcSlab", "IfcSpace", "IfcWall"]);
    assert_eq!(s.layers.iter().find(|l| l.name == "IfcWall").unwrap().color, [217, 217, 217, 255]);

    let no_spaces = scene(&layered_model(), &RhinoSceneOptions { include_spaces: false, ..RhinoSceneOptions::default() });
    assert!(no_spaces.objects.iter().all(|o| o.name != "Room"));
    assert!(no_spaces.layers.iter().all(|l| l.name != "IfcSpace"));
}

/// A spatial chain far deeper than a recursive walk survives on a 2 MiB test
/// thread (spec "Layers"; AGENTS.md "Bounding walks over file-supplied
/// references"): every level is a layer, in order, and the scene builds.
#[test]
fn a_deep_spatial_chain_is_walked_without_recursion() {
    const DEPTH: usize = 50_000;
    let mut f = Ifc::new(METRE, None, Site::default());
    let (mut parent, placement) = f.storey("0storey000000000000001", Some("L0"), None, 0.0);
    for i in 1..DEPTH {
        let id = f.add(format!("IFCBUILDINGSTOREY('0deep{i:017}',$,'L{i}',$,$,#{placement},$,$,.ELEMENT.,0.)"));
        f.add(format!("IFCRELAGGREGATES('0deepagg{i:014}',$,$,$,#{parent},(#{id}))"));
        parent = id;
    }
    f.wall("0wall00000000000000001", "Deep wall", (parent, placement), [0.0; 3], WALL_SIZE);
    let s = scene(&f.finish("deep.ifc"), &RhinoSceneOptions::default());
    let wall = s.objects.iter().find(|o| o.name == "Deep wall").expect("the wall is written");
    let mut names = Vec::new();
    let mut at = Some(wall.layer);
    while let Some(i) = at {
        names.push(s.layers[i].name.as_str());
        at = s.layers[i].parent;
    }
    names.reverse();
    assert_eq!(names.len(), 3 + DEPTH + 1, "Proj/Site/Building, every storey, IfcWall");
    assert_eq!(names[..4], ["Proj", "Site", "Building", "L0"]);
    assert_eq!(names[names.len() - 2..], [format!("L{}", DEPTH - 1).as_str(), "IfcWall"]);
}

#[test]
fn class_and_presentation_schemes_hang_under_the_project_root() {
    let s = scene(&layered_model(), &RhinoSceneOptions { layer_scheme: RhinoLayerScheme::Class, ..RhinoSceneOptions::default() });
    assert_wire_invariants("class", &s);
    let paths: BTreeSet<String> = s.objects.iter().map(|o| layer_path(&s, o.layer)).collect();
    let want: BTreeSet<String> = ["IfcBuildingElementProxy", "IfcFurniture", "IfcSlab", "IfcSpace", "IfcWall"].iter().map(|c| format!("Proj/{c}")).collect();
    assert_eq!(paths, want);

    let s = scene(&layered_model(), &RhinoSceneOptions { layer_scheme: RhinoLayerScheme::Presentation, ..RhinoSceneOptions::default() });
    assert_wire_invariants("presentation", &s);
    let paths: BTreeSet<String> = s.objects.iter().map(|o| layer_path(&s, o.layer)).collect();
    let want: BTreeSet<String> = ["Proj/No presentation layer", "Proj/No presentation layer/IfcSpace"].iter().map(|s| s.to_string()).collect();
    assert_eq!(paths, want);
}

/// Two typed walls. The type carries `Pset_WallCommon` (FireRating EI60,
/// IsExternal TRUE); each occurrence overrides FireRating, has a null
/// property, two property sets that are both `Pset_Custom` with a `Code`, a
/// `::` in a set and property name, and a length quantity.
fn user_text_model() -> Vec<u8> {
    let mut f = Ifc::new(METRE, None, Site::default());
    let s = f.storey("0storey000000000000001", Some("Level 1"), None, 0.0);
    let walls: Vec<u32> = (1..=2)
        .map(|i| f.wall(&format!("0wall0000000000000000{i}"), &format!("Wall {i}"), s, [0.0, 3.0 * i as f64, 0.0], WALL_SIZE))
        .collect();
    let p = |f: &mut Ifc, name: &str, value: &str| f.add(format!("IFCPROPERTYSINGLEVALUE('{name}',$,{value},$)"));
    let fire_type = p(&mut f, "FireRating", "IFCLABEL('EI60')");
    let external = p(&mut f, "IsExternal", "IFCBOOLEAN(.T.)");
    let type_set = f.add(format!("IFCPROPERTYSET('0psettype000000000001',$,'Pset_WallCommon',$,(#{fire_type},#{external}))"));
    let ty = f.add(format!("IFCWALLTYPE('0walltype0000000000001',$,'WT 200',$,$,(#{type_set}),$,$,$,.STANDARD.)"));
    let fire = p(&mut f, "FireRating", "IFCLABEL('EI90')");
    let null = p(&mut f, "Null", "$");
    let common = f.add(format!("IFCPROPERTYSET('0psetcommon00000000001',$,'Pset_WallCommon',$,(#{fire},#{null}))"));
    let a = p(&mut f, "Code", "IFCLABEL('A')");
    let b = p(&mut f, "Code", "IFCLABEL('B')");
    let custom_a = f.add(format!("IFCPROPERTYSET('0psetcustoma0000000001',$,'Pset_Custom',$,(#{a}))"));
    let custom_b = f.add(format!("IFCPROPERTYSET('0psetcustomb0000000001',$,'Pset_Custom',$,(#{b}))"));
    let odd = p(&mut f, "Odd::Name", "IFCLABEL('x')");
    let vendor = f.add(format!("IFCPROPERTYSET('0psetvendor00000000001',$,'Vendor::Data',$,(#{odd}))"));
    let len = f.add("IFCQUANTITYLENGTH('Length',$,$,4.,$)".to_string());
    let qto = f.add(format!("IFCELEMENTQUANTITY('0qto000000000000000001',$,'Qto_WallBaseQuantities',$,$,(#{len}))"));
    let list: Vec<String> = walls.iter().map(|w| format!("#{w}")).collect();
    let list = list.join(",");
    for (i, set) in [common, custom_a, custom_b, vendor, qto].into_iter().enumerate() {
        f.add(format!("IFCRELDEFINESBYPROPERTIES('0dbp{i:018}',$,$,$,({list}),#{set})"));
    }
    f.add(format!("IFCRELDEFINESBYTYPE('0dbt000000000000000001',$,$,$,({list}),#{ty})"));
    f.finish("user_text.ifc")
}

/// User text (spec "User text"): `::` keys, occurrence over type, inherited
/// sets, quantities, nulls omitted, collisions suffixed with one warning.
#[test]
fn user_text_keys_inherit_override_and_collide_once() {
    let s = scene(&user_text_model(), &RhinoSceneOptions::default());
    assert_eq!(s.objects.len(), 2);
    let o = &s.objects[0];
    let keys: Vec<&str> = o.user_strings.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(user(o, "IFC::GlobalId"), Some("0wall00000000000000001"));
    assert_eq!(user(o, "IFC::Class"), Some("IfcWall"));
    assert_eq!(user(o, "IFC::Container"), Some("Level 1"));
    assert_eq!(user(o, "IFC::ContainerGlobalId"), Some("0storey000000000000001"));
    assert_eq!(user(o, "IFC::Type"), Some("WT 200"));
    assert_eq!(user(o, "IFC::TypeGlobalId"), Some("0walltype0000000000001"));
    assert_eq!(user(o, "Pset_WallCommon::FireRating"), Some("EI90"), "occurrence wins: {keys:?}");
    assert_eq!(user(o, "Pset_WallCommon::IsExternal"), Some("TRUE"), "inherited from the type: {keys:?}");
    assert!(!keys.iter().any(|k| k.contains("Null")), "a null value is omitted: {keys:?}");
    assert_eq!(user(o, "Pset_Custom::Code"), Some("A"));
    assert_eq!(user(o, "Pset_Custom::Code #2"), Some("B"));
    assert_eq!(user(o, "Vendor:Data::Odd:Name"), Some("x"));
    assert_eq!(user(o, "Qto_WallBaseQuantities::Length"), Some("4"));
    let own = keys.iter().position(|k| *k == "Qto_WallBaseQuantities::Length").unwrap();
    let inherited = keys.iter().position(|k| *k == "Pset_WallCommon::IsExternal").unwrap();
    assert!(own < inherited, "own entries claim keys before inherited ones: {keys:?}");
    assert_eq!(s.warnings.len(), 1, "one collision warning per export, not per object: {:?}", s.warnings);
    assert!(s.warnings[0].contains("Pset_Custom::Code"), "{:?}", s.warnings);

    let attrs = scene(&user_text_model(), &RhinoSceneOptions { properties: RhinoProperties::Attributes, ..RhinoSceneOptions::default() });
    let o = &attrs.objects[0];
    assert!(o.user_strings.iter().all(|(k, _)| k.starts_with("IFC::")), "{:?}", o.user_strings);
    assert_eq!(user(o, "IFC::Name"), Some("Wall 1"));
    assert!(attrs.warnings.is_empty());
    let none = scene(&user_text_model(), &RhinoSceneOptions { properties: RhinoProperties::None, ..RhinoSceneOptions::default() });
    let keys: Vec<&str> = none.objects[0].user_strings.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["IFC::GlobalId", "IFC::Class", "IFC::ExpressId"]);
}

/// Objects (spec "Objects", "Object identity"): one object per element per
/// colour, grouped by GlobalId, every part carrying the full user text, the
/// first part's id the expanded GlobalId.
#[test]
fn a_multi_colour_element_is_one_group_of_fully_labelled_objects() {
    let bytes = load("rust/processing/tests/fixtures/issue_6601_multicolor_element.ifc").unwrap();
    let s = scene(&bytes, &RhinoSceneOptions::default());
    let mut by_id: BTreeMap<u32, Vec<&RhinoObject>> = BTreeMap::new();
    for o in &s.objects {
        by_id.entry(express_id(o)).or_default().push(o);
    }
    let (id, parts) = by_id.iter().find(|(_, p)| p.len() > 1).expect("the fixture has a multi-colour element");
    let gid = user(parts[0], "IFC::GlobalId").unwrap();
    assert_eq!(s.groups.len(), 1);
    assert_eq!(s.groups[0].name, gid);
    let colours: HashSet<[u8; 4]> = parts.iter().map(|o| o.color).collect();
    assert_eq!(colours.len(), parts.len(), "#{id}: same-colour submeshes merge into one object");
    let element_text = |o: &RhinoObject| o.user_strings.iter().filter(|(k, _)| k != "IFC::Material").cloned().collect::<Vec<_>>();
    for o in parts {
        assert_eq!(o.groups, [0]);
        assert_eq!(element_text(o), element_text(parts[0]), "every part carries the element's user text");
    }
    let bits = ifc_lite_core::guid::decode_bits(gid).expect("valid GlobalId");
    assert_eq!(parts[0].object_id.replace('-', ""), format!("{bits:032x}"));
    assert_eq!(&parts[1].object_id[14..15], "8", "later parts are version-8 UUIDs");
}

/// Object identity (spec "Objects", "Object identity"): two multi-part
/// elements sharing a GlobalId (common in bad files) get distinct group names
/// and objectIds, the later one falling back to its express id, with one warning.
#[test]
fn elements_sharing_a_global_id_get_unique_groups_and_object_ids() {
    let text = String::from_utf8(load("rust/processing/tests/fixtures/issue_6601_multicolor_element.ifc").unwrap()).unwrap();
    let gid = "36FTsOKg956eWgO6DwnT8U";
    let end = "ENDSEC;\nEND-ISO";
    assert_eq!(text.matches(end).count(), 1);
    let bytes = text.replace(end, &format!("#33=IFCBUILDINGELEMENTPROXY('{gid}',$,'cube copy',$,$,#22,#19,$,$);\n{end}"));
    let s = scene(bytes.as_bytes(), &RhinoSceneOptions::default());
    assert_wire_invariants("shared GlobalId", &s);
    let names: Vec<&str> = s.groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, [gid.to_string(), format!("{gid} #33")]);
    let parts = |id: u32| s.objects.iter().filter(|o| express_id(o) == id).collect::<Vec<_>>();
    let (first, second) = (parts(23), parts(33));
    assert!(first.len() > 1 && second.len() == first.len(), "{} / {}", first.len(), second.len());
    assert!(second.iter().all(|o| o.groups == [1] && user(o, "IFC::GlobalId") == Some(gid)));
    let bits = ifc_lite_core::guid::decode_bits(gid).unwrap();
    assert_eq!(first[0].object_id.replace('-', ""), format!("{bits:032x}"), "the first element keeps the expanded GlobalId");
    assert_eq!(
        s.warnings,
        ["elements sharing a GlobalId got group names with \" #<express id>\" and objectIds hashed from the express id (first: #33)"]
    );
}

/// The instancing fixture with its storey moved to LV95 magnitude: the site
/// stays identity, so the pipeline takes the `model_rtc` tier and keeps
/// instancing on (only the site tier disables it).
fn far_instances() -> Vec<u8> {
    let bytes = load("rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc").unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let moved = text.replace(
        "#22=IFCLOCALPLACEMENT(#20,#2);",
        "#22=IFCLOCALPLACEMENT(#20,#900);\n#900=IFCAXIS2PLACEMENT3D(#901,$,$);\n#901=IFCCARTESIANPOINT((2600000.3,1200000.7,410.25));",
    );
    assert_ne!(moved, text, "the fixture's storey placement changed; update the replacement");
    moved.into_bytes()
}

/// `S · W · rel · T · S⁻¹` with a real frame shift `W`: instances land on the
/// baked vertices in `local` and in `world`, in metres and in millimetres.
#[test]
fn shifted_instances_land_on_baked_vertices_in_local_and_world() {
    let bytes = far_instances();
    for coordinates in [RhinoCoordinates::Local, RhinoCoordinates::World] {
        for units in [RhinoUnits::Source, RhinoUnits::Millimeters] {
            let opts = RhinoSceneOptions { coordinates, units, ..RhinoSceneOptions::default() };
            let inst = scene(&bytes, &opts);
            let baked = scene(&bytes, &RhinoSceneOptions { instancing: false, ..opts.clone() });
            // Only a local export of the shifted frame records the restore; world is already world.
            assert_eq!(doc(&inst, "IFC::WorldFromModel").is_some(), coordinates == RhinoCoordinates::Local, "{coordinates:?}");
            let instances: Vec<&RhinoObject> = inst.objects.iter().filter(|o| matches!(o.geometry, RhinoGeometry::Instance { .. })).collect();
            assert!(instances.len() >= 2, "{coordinates:?}: instancing stayed on in the model_rtc tier");
            let mpu = inst.settings.meters_per_unit;
            for o in instances {
                let want: Vec<[f64; 3]> = baked.objects.iter().filter(|b| express_id(b) == express_id(o)).flat_map(|b| object_vertices(&baked, b)).collect();
                let got = object_vertices(&inst, o);
                assert_eq!(got.len(), want.len());
                // Both sides are f64 maps of small f32 local data, so the gap
                // stays at local f32 resolution even 2,600 km out.
                let worst = got.iter().zip(&want).flat_map(|(g, w)| (0..3).map(move |a| (g[a] - w[a]).abs())).fold(0.0, f64::max) * mpu;
                assert!(worst < 1e-6, "{coordinates:?} {units:?}: #{} off by {worst:e} m", express_id(o));
                if coordinates == RhinoCoordinates::World {
                    assert!(got[0][0] * mpu > 2_599_000.0, "world vertices are on the survey grid: {:?}", got[0]);
                }
            }
        }
    }
}

/// A real presentation layer that happens to be named like the fallback stays a
/// separate Rhino layer from elements with no assignment (review on #9415).
#[test]
fn a_layer_named_like_the_fallback_is_not_merged_with_unassigned_elements() {
    let mut f = Ifc::new(METRE, None, Site::default());
    let storey = f.storey("0storey000000000000010", Some("Level 1"), None, 0.0);
    let assigned = f.wall("0wall00000000000000010", "Assigned wall", storey, [0.0; 3], WALL_SIZE);
    f.wall("0wall00000000000000011", "Unassigned wall", storey, [3.0, 0.0, 0.0], WALL_SIZE);
    // `element_at` adds the shape representation two entities before the element.
    f.add(format!("IFCPRESENTATIONLAYERASSIGNMENT('No presentation layer',$,(#{}),$)", assigned - 2));
    let s = scene(&f.finish("fallback-name.ifc"), &RhinoSceneOptions { layer_scheme: RhinoLayerScheme::Presentation, ..RhinoSceneOptions::default() });
    assert_wire_invariants("fallback-name", &s);
    let layer_of = |name: &str| s.objects.iter().find(|o| o.name == name).map(|o| o.layer).expect(name);
    assert_ne!(layer_of("Assigned wall"), layer_of("Unassigned wall"), "the named layer and the fallback must not merge");
    let paths: BTreeSet<String> = s.objects.iter().map(|o| layer_path(&s, o.layer)).collect();
    assert_eq!(paths.len(), 2, "{paths:?}");
}
