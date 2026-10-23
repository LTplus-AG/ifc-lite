// SPDX-License-Identifier: MPL-2.0
//! Profiles with voids and representations of several solids: what the
//! check refuses, what the executor writes in each schema, and what the
//! geometry engine makes of it. Synthetic fixtures only.

use super::validate_extrusion;
use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::index::FileIndex;
use crate::plan::test_fixtures::storey_with_typed_wall;
use crate::plan::types::*;

fn square(x: f64, y: f64, s: f64) -> Vec<[f64; 2]> {
    vec![[x, y], [x + s, y], [x + s, y + s], [x, y + s]]
}

/// A 4 x 3 slab profile with `voids`, extruded 2 up.
fn slab(voids: Vec<Vec<[f64; 2]>>) -> Extrusion {
    Extrusion { voids, ..block(4.0, 3.0, 2.0) }
}

fn reason(e: Extrusion) -> String {
    validate_extrusion(&e).expect_err("refused")
}

#[test]
fn a_void_must_lie_strictly_inside_and_apart_from_the_others() {
    let cases = [
        (slab(vec![square(3.5, 1.0, 1.0)]), "not strictly inside"),
        (slab(vec![square(5.0, 1.0, 1.0)]), "not strictly inside"),
        // Touching the outer boundary at an edge, and at a corner.
        (slab(vec![square(3.0, 1.0, 1.0)]), "not strictly inside"),
        (slab(vec![vec![[4.0, 3.0], [3.0, 2.5], [3.5, 2.0]]]), "not strictly inside"),
        (slab(vec![square(1.0, 1.0, 1.0), square(1.5, 1.5, 1.0)]), "overlap"),
        (slab(vec![square(1.0, 1.0, 1.0), square(2.0, 1.0, 1.0)]), "overlap"),
        (slab(vec![square(0.5, 0.5, 2.0), square(1.0, 1.0, 0.5)]), "overlap"),
        (slab(vec![vec![[1.0, 1.0], [2.5, 2.0], [1.0, 2.0], [2.0, 1.0]]]), "crosses itself"),
        (slab(vec![vec![[1.0, 1.0], [2.0, 1.0]]]), "at least 3"),
        (slab(vec![vec![[1.0, 1.0], [2.0, 1.0], [3.0, 1.0]]]), "no area"),
        (slab(vec![vec![[1.0, 1.0], [f64::NAN, 1.0], [1.0, 2.0]]]), "not finite"),
        (slab((0..1100).map(|i| square(0.1 + (i % 33) as f64 * 0.11, 0.1 + (i / 33) as f64 * 0.08, 0.05)).collect()), "more than 4096"),
    ];
    for (e, expected) in cases {
        let got = reason(e);
        assert!(got.contains(expected), "expected {expected:?}, got {got:?}");
    }
    // A hole closed by repeating its first point, and holes wound either way.
    let mut closed = square(1.0, 1.0, 1.0);
    closed.push([1.0, 1.0]);
    let mut clockwise = square(2.5, 1.0, 0.5);
    clockwise.reverse();
    validate_extrusion(&slab(vec![closed, clockwise])).expect("valid voids");
}

fn ids_named(out: &[u8], entity: &str) -> Vec<u32> {
    let index = FileIndex::scan(out, &Default::default());
    index.records().filter(|(_, t, _, _)| t.eq_ignore_ascii_case(entity)).map(|(id, _, _, _)| id).collect()
}

/// Signed volume and X extent of every mesh the engine made for `id`.
fn engine_volume(out: &[u8], id: u32) -> (f64, f64) {
    let result = ifc_lite_processing::process_geometry(out);
    let (mut volume, mut lo, mut hi) = (0.0, f64::INFINITY, f64::NEG_INFINITY);
    let meshes: Vec<_> = result.meshes.iter().filter(|m| m.express_id == id).collect();
    assert!(!meshes.is_empty(), "#{id} not meshed");
    for m in meshes {
        let p = |i: u32| {
            let i = i as usize * 3;
            [f64::from(m.positions[i]), f64::from(m.positions[i + 1]), f64::from(m.positions[i + 2])]
        };
        for t in m.indices.chunks_exact(3) {
            let [a, b, c] = [p(t[0]), p(t[1]), p(t[2])];
            volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0;
        }
        for v in m.positions.chunks_exact(3) {
            lo = lo.min(f64::from(v[0]));
            hi = hi.max(f64::from(v[0]));
        }
    }
    (volume.abs(), hi - lo)
}

#[test]
fn a_profile_with_voids_is_written_with_its_inner_curves_and_meshed_with_its_holes() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let mut clockwise = square(2.5, 1.0, 1.0);
        clockwise.reverse();
        let e = slab(vec![square(1.0, 1.0, 1.0), clockwise]);
        let wall = object(IfcClass::Named("IfcSlab".into()), gid(1), Some(ObjectRef::Id(70)), Representation::Extrusion(e));
        let (out, report) = run(&source, vec![add(wall)]);
        assert_clean(&report, schema);
        assert!(crate::plan::validate::validate(&out, schema).is_empty(), "{schema}");
        let profiles = ids_named(&out, "IFCARBITRARYPROFILEDEFWITHVOIDS");
        assert_eq!(profiles.len(), 1, "{schema}");
        assert_eq!(count(&out, "IFCARBITRARYCLOSEDPROFILEDEF"), 0, "{schema}");
        let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
        let inner = decoder.decode_by_id(profiles[0]).unwrap().get_refs(3).unwrap();
        assert_eq!(inner.len(), 2, "{schema}: two inner curves");
        assert!(inner.iter().all(|&c| type_in(&out, c) == "IFCPOLYLINE"), "{schema}");

        // 4 x 3 less two 1 x 1 holes, 2 deep.
        let (volume, _) = engine_volume(&out, id_in(&out, gid(1)));
        assert!((volume - 20.0).abs() < 1e-3, "{schema}: volume {volume}");
    }
}

#[test]
fn disjoint_regions_are_several_solids_in_one_body_representation() {
    let colour = SurfaceColour { rgb: [0.2, 0.4, 0.6], transparency: 0.0 };
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let far = Extrusion { profile: square(3.0, 0.0, 1.0), ..block(1.0, 1.0, 1.0) };
        let holed = Extrusion { voids: vec![square(0.25, 0.25, 0.5)], ..block(1.0, 1.0, 1.0) };
        let mut proxy = object(IfcClass::BuildingElementProxy, gid(2), Some(ObjectRef::Id(70)), Representation::Extrusions(vec![holed, far]));
        proxy.style = Some(colour);
        let (out, report) = run(&source, vec![add(proxy)]);
        assert_clean(&report, schema);
        assert!(crate::plan::validate::validate(&out, schema).is_empty(), "{schema}");
        assert_eq!(count(&out, "IFCSHAPEREPRESENTATION"), 1, "{schema}: one Body representation");
        let reps = ids_named(&out, "IFCSHAPEREPRESENTATION");
        let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
        let items = decoder.decode_by_id(reps[0]).unwrap().get_refs(3).unwrap();
        assert_eq!(items.len(), 2, "{schema}");
        assert!(items.iter().all(|&i| type_in(&out, i) == "IFCEXTRUDEDAREASOLID"), "{schema}");
        assert_eq!(count(&out, "IFCSTYLEDITEM"), 2, "{schema}: each solid in the colour");
        assert_eq!(count(&out, "IFCARBITRARYPROFILEDEFWITHVOIDS"), 1, "{schema}");
        assert_eq!(count(&out, "IFCARBITRARYCLOSEDPROFILEDEF"), 1, "{schema}");

        let (volume, extent) = engine_volume(&out, id_in(&out, gid(2)));
        assert!((volume - 1.75).abs() < 1e-3, "{schema}: volume {volume}");
        assert!((extent - 4.0).abs() < 1e-4, "{schema}: X extent {extent}");
    }
}

#[test]
fn a_representation_of_extrusions_is_refused_when_empty_or_when_one_is_invalid() {
    let source = storey_with_typed_wall("IFC4");
    for (rep, expected) in [
        (Representation::Extrusions(Vec::new()), "at least one"),
        (Representation::Extrusions(vec![block(1.0, 1.0, 1.0), slab(vec![square(9.0, 9.0, 1.0)])]), "extrusion 1: void 0"),
    ] {
        let (_, report) = run(&source, vec![add(object(IfcClass::BuildingElementProxy, gid(3), None, rep))]);
        assert_eq!(report.added, 0);
        assert!(report.refusals[0].reason.contains(expected), "{expected}: {:?}", report.refusals);
    }
}

/// An opening's cutter may have voids: an annular cut leaves the host's core.
#[test]
fn an_opening_with_a_void_cuts_a_ring() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let mut niche = object(IfcClass::Wall, gid(4), Some(ObjectRef::Id(70)), Representation::None);
        let ring = Extrusion { voids: vec![square(0.25, 0.25, 0.5)], ..block(1.0, 1.0, 0.2) };
        niche.opening = Some(NewOpening { host: ObjectRef::Id(10), matrix: IDENTITY, shape: ring });
        let (out, report) = run(&source, vec![add(niche)]);
        assert_clean(&report, schema);
        assert!(crate::plan::validate::validate(&out, schema).is_empty(), "{schema}");
        let opening = id_in(&out, gid(4).derive("opening"));
        assert_eq!(type_in(&out, opening), "IFCOPENINGELEMENT", "{schema}");
        assert_eq!(count(&out, "IFCARBITRARYPROFILEDEFWITHVOIDS"), 1, "{schema}");
    }
}
