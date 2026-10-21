// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7690: the don't-bake shared-source walk (`ensure_shared_mapped_source`)
//! meshes its item through the same per-item step as `mapped_item.rs`, which
//! writes the same model-wide cache entry. The public-API walks are covered by
//! `tests/issue_7690_mapped_source_walks.rs`.

use crate::router::GeometryRouter;
use ifc_lite_core::EntityDecoder;

const SITE: [f64; 3] = [2_600_000.0, 1_200_000.0, 0.0];

/// A 12 x 7 x 5 mm tetrahedron at LV95 (#900, map #1003 over rep #1000),
/// mapped by #1005 with an identity target.
const RAW_WORLD_MAP: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #700=IFCCARTESIANPOINTLIST3D(((2600000.4,1200000.3,0.2),(2600000.412,1200000.3,0.2),\
    (2600000.4,1200000.307,0.2),(2600000.4,1200000.3,0.205)),$);\
    #900=IFCTRIANGULATEDFACESET(#700,$,.T.,((1,3,2),(1,2,4),(2,3,4),(1,4,3)),$);\
    #1000=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#900));#1003=IFCREPRESENTATIONMAP(#2,#1000);\
    #1004=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#1005=IFCMAPPEDITEM(#1003,#1004);";

const CORNERS: [[f64; 3]; 4] =
    [[0.4, 0.3, 0.2], [0.412, 0.3, 0.2], [0.4, 0.307, 0.2], [0.4, 0.3, 0.205]];

fn shared_rtc_router() -> GeometryRouter {
    let mut router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    router.set_rtc_offset((SITE[0], SITE[1], SITE[2]));
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    router
}

fn cached_source(router: &GeometryRouter, source_id: u32) -> crate::Mesh {
    let shared = router.shared_mapped_item_cache.as_ref().expect("shared cache");
    let cache = shared.lock().unwrap_or_else(|e| e.into_inner());
    cache.get(&source_id).expect("source published").as_ref().clone()
}

/// ROUTER-27: the shared source is rebased in f64 before narrowing, and it is
/// byte-identical to the entry `mapped_item.rs` publishes for the same map.
#[test]
fn router_27_shared_source_rebases_like_the_mapped_item_walk() {
    let mut decoder = EntityDecoder::new(RAW_WORLD_MAP);
    let router = shared_rtc_router();
    let rep = decoder.decode_by_id(1000).unwrap();
    router.ensure_shared_mapped_source(&rep, 1003, &mut decoder).unwrap();
    let shared = cached_source(&router, 1003);
    // Rebased before narrowing, with the offset kept as the f64 origin: the
    // mapping target and the placement still apply to a source (#7690).
    assert!(!shared.rtc_applied && shared.origin == SITE, "{:?}", shared.origin);
    for p in CORNERS {
        let found = shared.positions.chunks_exact(3).any(|v| {
            (0..3).all(|axis| (v[axis] as f64 + shared.origin[axis] - SITE[axis] - p[axis]).abs() < 1e-5)
        });
        assert!(found, "corner {p:?} lost: {:?}", shared.positions);
    }

    let walked = shared_rtc_router();
    let item = decoder.decode_by_id(1005).unwrap();
    walked.process_mapped_item_parts(&item, &mut decoder).unwrap();
    let cached = cached_source(&walked, 1003);
    assert_eq!(
        (&cached.positions, &cached.indices, cached.origin, cached.rtc_applied, cached.local_bounds),
        (&shared.positions, &shared.indices, shared.origin, shared.rtc_applied, shared.local_bounds),
        "both walks must publish the same source mesh"
    );
}

/// ROUTER-26: a capped B-spline edge in a shared source is reported for that
/// source, and the next unrelated item does not inherit it.
#[test]
fn router_26_capped_curve_in_a_shared_source_is_reported_for_that_source() {
    let content = "#1=IFCCARTESIANPOINT((50.,0.,0.));#2=IFCCARTESIANPOINT((-50.,0.,0.));\
        #3=IFCCARTESIANPOINT((0.,0.,0.));#4=IFCCARTESIANPOINT((0.,60.,0.));\
        #5=IFCVERTEXPOINT(#1);#6=IFCVERTEXPOINT(#2);#9=IFCDIRECTION((0.,0.,1.));\
        #10=IFCDIRECTION((1.,0.,0.));#11=IFCAXIS2PLACEMENT3D(#3,#9,#10);#12=IFCPLANE(#11);\
        #13=IFCBSPLINECURVEWITHKNOTS(999999,(#1,#4,#2),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.));\
        #15=IFCLINE(#2,#20);#20=IFCVECTOR(#21,1.);#21=IFCDIRECTION((1.,0.,0.));\
        #30=IFCEDGECURVE(#5,#6,#13,.T.);#31=IFCEDGECURVE(#6,#5,#15,.T.);\
        #40=IFCORIENTEDEDGE(*,*,#30,.T.);#41=IFCORIENTEDEDGE(*,*,#31,.T.);#50=IFCEDGELOOP((#40,#41));\
        #51=IFCFACEOUTERBOUND(#50,.T.);#52=IFCADVANCEDFACE((#51),#12,.T.);#53=IFCOPENSHELL((#52));\
        #54=IFCSHELLBASEDSURFACEMODEL((#53));#55=IFCSHAPEREPRESENTATION($,'Body','SurfaceModel',(#54));\
        #100=IFCCARTESIANPOINT((0.,0.));#101=IFCAXIS2PLACEMENT2D(#100,$);\
        #102=IFCRECTANGLEPROFILEDEF(.AREA.,'P',#101,1000.,1000.);#105=IFCAXIS2PLACEMENT3D(#3,$,$);\
        #106=IFCEXTRUDEDAREASOLID(#102,#105,#9,1000.);";
    let mut decoder = EntityDecoder::new(content);
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    let rep = decoder.decode_by_id(55).unwrap();
    router.ensure_shared_mapped_source(&rep, 60, &mut decoder).unwrap();
    let after_source = router.take_unsupported_items();
    assert_eq!(after_source.get("IfcBSplineCurveWithKnots"), Some(&1), "{after_source:?}");

    let plain = decoder.decode_by_id(106).unwrap();
    router.process_representation_item(&plain, &mut decoder).expect("the plain solid meshes");
    let after_plain = router.take_unsupported_items();
    assert!(after_plain.is_empty(), "the plain item inherited a drop: {after_plain:?}");
}

/// #7781 / #7873 r4303907552: refusing an unentered repeat of the current
/// item must retain both earlier and later solid siblings in that frame.
#[test]
fn issue_7781_current_item_cycle_retains_solid_siblings() {
    for items in ["#900,#1005", "#1005,#900"] {
        let content = RAW_WORLD_MAP.replace("(#900)", &format!("({items})"));
        let mut decoder = EntityDecoder::new(&content);
        let router = shared_rtc_router();
        let item = decoder.decode_by_id(1005).unwrap();
        let parts = router.process_mapped_item_parts(&item, &mut decoder).unwrap();
        assert_eq!(parts.len(), 1, "the valid tetrahedron was discarded: {items}");
        assert_eq!(parts[0].indices.len(), 12, "one reachable tetrahedron: {items}");
        let drops = router.take_unsupported_items();
        assert_eq!(drops.get("IfcMappedItem"), Some(&1), "one cycle refusal: {drops:?}");
        let cache = router.shared_mapped_item_cache.as_ref().unwrap().lock().unwrap();
        assert!(!cache.contains_key(&1003), "a cycle-truncated source is not shared");
    }
}

/// Positive control for #7781: reaching the same source down separate paths
/// contributes twice; the cycle set is scoped to the active path.
#[test]
fn issue_7781_shared_source_siblings_both_contribute() {
    let content = format!("{RAW_WORLD_MAP}#2000=IFCMAPPEDITEM(#2001,#1004);\
        #2001=IFCREPRESENTATIONMAP(#2,#2002);\
        #2002=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#1005,#1005));");
    let mut decoder = EntityDecoder::new(&content);
    let router = shared_rtc_router();
    let item = decoder.decode_by_id(2000).unwrap();
    let parts = router.process_mapped_item_parts(&item, &mut decoder).unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].indices.len(), 24, "both tetrahedron occurrences survive");
    assert!(router.take_unsupported_items().is_empty());
}

/// The cycle correction must keep the entered-frame failure policy (#7781):
/// missing Items fails the top call, or drops just that nested frame.
#[test]
fn issue_7781_entered_frame_missing_items_keeps_its_failure_scope() {
    let content = RAW_WORLD_MAP.replace("'Tessellation',(#900)", "'Tessellation'");
    let mut decoder = EntityDecoder::new(&content);
    let router = shared_rtc_router();
    let item = decoder.decode_by_id(1005).unwrap();
    let error = router.process_mapped_item_parts(&item, &mut decoder).unwrap_err();
    assert!(error.to_string().contains("missing Items"), "{error}");

    let content = format!("{content}#2000=IFCMAPPEDITEM(#2001,#1004);\
        #2001=IFCREPRESENTATIONMAP(#2,#2002);\
        #2002=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#900,#1005));");
    let mut decoder = EntityDecoder::new(&content);
    let router = shared_rtc_router();
    let item = decoder.decode_by_id(2000).unwrap();
    let parts = router.process_mapped_item_parts(&item, &mut decoder).unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].indices.len(), 12);
    assert_eq!(router.take_unsupported_items().get("IfcMappedItem"), Some(&1));
}

/// #7873: the submesh visitor retains siblings around a refused cycle.
#[test]
fn issue_7873_submesh_current_item_cycle_retains_solid_siblings() {
    for items in ["#900,#1005", "#1005,#900"] {
        let content = RAW_WORLD_MAP.replace("(#900)", &format!("({items})"));
        let mut decoder = EntityDecoder::new(&content);
        let router = shared_rtc_router();
        let item = decoder.decode_by_id(1005).unwrap();
        let mut collection = crate::SubMeshCollection::new();
        router.collect_submeshes_from_item(&item, &mut decoder, &mut collection, false, None).unwrap();
        let parts: Vec<_> = collection.sub_meshes.into_iter().map(|part| part.mesh).collect();
        assert_eq!(parts.len(), 1, "the valid tetrahedron was discarded: {items}");
        assert_eq!(parts[0].indices.len(), 12, "one reachable tetrahedron: {items}");
        let drops = router.take_unsupported_items();
        assert_eq!(drops.get("IfcMappedItem"), Some(&1), "one cycle refusal: {drops:?}");
    }
}

/// Positive control for #7781: reaching the same source down separate paths
/// contributes twice; the cycle set is scoped to the active path.
#[test]
fn issue_7873_submesh_shared_source_siblings_both_contribute() {
    let content = format!("{RAW_WORLD_MAP}#2000=IFCMAPPEDITEM(#2001,#1004);\
        #2001=IFCREPRESENTATIONMAP(#2,#2002);\
        #2002=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#1005,#1005));");
    let mut decoder = EntityDecoder::new(&content);
    let router = shared_rtc_router();
    let item = decoder.decode_by_id(2000).unwrap();
    let mut collection = crate::SubMeshCollection::new();
    router.collect_submeshes_from_item(&item, &mut decoder, &mut collection, false, None).unwrap();
    let parts: Vec<_> = collection.sub_meshes.into_iter().map(|part| part.mesh).collect();
    assert_eq!(parts.len(), 2);
    assert_eq!(parts.iter().map(|part| part.indices.len()).sum::<usize>(), 24, "both tetrahedron occurrences survive");
    assert!(router.take_unsupported_items().is_empty());
}

/// #7873 Class X: the occurrence walk now admits Items against the real
/// shared structural allowance. No resource account or synthetic small cap.
fn over_allowance_items() -> String {
    // A readable sentinel followed by dangling references: absent admission,
    // resolve_ref_list caches #8000 before failing on #999999. No large mesh.
    let mut items = String::from("#8000");
    for _ in 0..crate::representation::MAX_WALK_LEVELS {
        items.push_str(",#999999");
    }
    items
}

fn collect_occurrence(
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
    id: u32,
) -> crate::Result<crate::SubMeshCollection> {
    let item = decoder.decode_by_id(id).unwrap();
    let mut collection = crate::SubMeshCollection::new();
    router.collect_submeshes_from_item(&item, decoder, &mut collection, false, None)?;
    Ok(collection)
}

#[test]
fn issue_7873_submesh_root_structural_allowance_refuses_before_member_decode() {
    let content = format!("{}#8000=IFCGEOMETRICSET(());", RAW_WORLD_MAP.replace(
        "(#900)", &format!("({})", over_allowance_items()),
    ));
    let mut decoder = EntityDecoder::new(&content);
    let router = shared_rtc_router();
    let item = decoder.decode_by_id(1005).unwrap();
    let mut collection = crate::SubMeshCollection::new();
    let error = router.collect_submeshes_from_item(
        &item, &mut decoder, &mut collection, false, None,
    ).unwrap_err();
    assert_eq!(error.to_string(), crate::representation::WalkRefusal::Budget {
        max_levels: crate::representation::MAX_WALK_LEVELS,
    }.into_error(1005).to_string(), "must report budget, not a dangling-reference error");
    assert!(decoder.get_cached(8000).is_none(), "no Items member may be decoded before admission");
    assert!(collection.sub_meshes.is_empty(), "refusal must not fabricate geometry");
    assert!(router.take_unsupported_items().is_empty(), "root refusal is returned, not a nested drop");
    assert_eq!(router.unsupported_scope_depth(), 0);

    let mut decoder = EntityDecoder::new(RAW_WORLD_MAP);
    let parts = collect_occurrence(&router, &mut decoder, 1005).unwrap();
    assert_eq!(parts.sub_meshes.len(), 1, "a small valid root still meshes");
    assert_eq!(parts.sub_meshes[0].mesh.indices.len(), 12);
    assert!(router.take_unsupported_items().is_empty());
}

// Nested refusal consumes Error into an IFC-type-only counter. Capture the
// EXISTING structured diagnostic to assert the actual refusal classification;
// an IfcMappedItem count alone could equally mean a member decode failed.
#[cfg(feature = "observability")]
mod structural_allowance_diagnostics {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracing::{span, Event, Metadata, Subscriber};

    #[derive(Clone, Default)]
    struct Refusals(Arc<Mutex<Vec<(String, String)>>>);

    #[derive(Default)]
    struct Fields {
        item: String,
        error: String,
    }

    impl tracing::field::Visit for Fields {
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            match field.name() {
                "item_id" => self.item = format!("{value:?}"),
                "error" => self.error = format!("{value:?}"),
                _ => {}
            }
        }
    }

    impl Subscriber for Refusals {
        fn enabled(&self, _: &Metadata<'_>) -> bool { true }
        fn new_span(&self, _: &span::Attributes<'_>) -> span::Id { span::Id::from_u64(1) }
        fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
        fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
        fn enter(&self, _: &span::Id) {}
        fn exit(&self, _: &span::Id) {}
        fn event(&self, event: &Event<'_>) {
            let mut fields = Fields::default();
            event.record(&mut fields);
            if !fields.error.is_empty() {
                self.0.lock().unwrap().push((fields.item, fields.error));
            }
        }
    }

    fn nested_fixture(parent: &str, child: &str, items: &str) -> String {
        format!("{RAW_WORLD_MAP}\
            #8000=IFCGEOMETRICSET(());\
            #2010=IFCCARTESIANPOINT((10.,0.,0.));\
            #2011=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#2010,1.,$);\
            #2110=IFCCARTESIANPOINT((3.,0.,0.));\
            #2111=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#2110,1.,$);\
            #2100=IFCMAPPEDITEM(#1003,#2111);\
            #2000=IFCMAPPEDITEM(#2001,#2011);\
            #2001=IFCREPRESENTATIONMAP(#2,#2002);\
            #2002=IFCSHAPEREPRESENTATION($,'{parent}','MappedRepresentation',(#2100,#3000,#4000));\
            #3000=IFCMAPPEDITEM(#3001,#1004);\
            #3001=IFCREPRESENTATIONMAP(#2,#3002);\
            #3002=IFCSHAPEREPRESENTATION($,'{child}','Tessellation',({items}));\
            #4000=IFCMAPPEDITEM(#1003,#1004);")
    }

    fn assert_tetrahedron_at(mesh: &crate::Mesh, dx: f64) {
        assert_eq!(mesh.indices.len(), 12);
        for p in CORNERS {
            assert!(mesh.positions.chunks_exact(3).any(|v| {
                (0..3).all(|axis| {
                    let shift = if axis == 0 { dx } else { 0.0 };
                    (v[axis] as f64 + mesh.origin[axis] - SITE[axis] - p[axis] - shift).abs() < 1e-5
                })
            }), "transformed corner {p:?} missing at x+{dx}");
        }
    }

    /// #7873 Class X bounded recovery: a nested budget refusal stops the
    /// remaining root siblings, unwinds transforms, and reports under PARENT
    /// source policy (not the refused child's already-entered source policy).
    #[test]
    fn issue_7873_submesh_nested_structural_allowance_retains_prefix_and_reports_budget() {
        for (parent, child, expected_count) in [("Body", "FootPrint", 1), ("FootPrint", "Body", 0)] {
            let content = nested_fixture(parent, child, &over_allowance_items());
            let router = shared_rtc_router();
            for expected_count in [expected_count, 0] {
                let mut decoder = EntityDecoder::new(&content);
                let log = Refusals::default();
                let parts = tracing::subscriber::with_default(log.clone(), || {
                    collect_occurrence(&router, &mut decoder, 2000).unwrap()
                });
                assert_eq!(parts.sub_meshes.len(), 1, "later mapped-root siblings must stop");
                assert_eq!(parts.sub_meshes[0].geometry_id, 900);
                assert_tetrahedron_at(&parts.sub_meshes[0].mesh, 13.0);
                assert!(decoder.get_cached(8000).is_none(), "refused members were not decoded");
                assert!(decoder.get_cached(3000).is_some(), "the refused level was reached");
                // The parent's list is eagerly decoded, so #4000 itself may be
                // cached. Its geometry/transform must still never be visited.
                let drops = router.take_unsupported_items();
                assert_eq!(drops.values().sum::<u64>(), expected_count, "{parent}/{child}: {drops:?}");
                assert_eq!(drops.get("IfcMappedItem").copied().unwrap_or(0), expected_count);
                let expected_error = crate::representation::WalkRefusal::Budget {
                    max_levels: crate::representation::MAX_WALK_LEVELS,
                }.into_error(3000).to_string();
                assert_eq!(*log.0.lock().unwrap(), [("3000".to_string(), expected_error)],
                    "one actual budget refusal, independent of count suppression");
                assert_eq!(router.unsupported_scope_depth(), 0);
            }

            // Same parsed structure with a small valid nested source: both the
            // nested mesh and the later root sibling contribute, with transforms.
            let content = nested_fixture(parent, child, "#900");
            let mut decoder = EntityDecoder::new(&content);
            let router = shared_rtc_router();
            let log = Refusals::default();
            let parts = tracing::subscriber::with_default(log.clone(), || {
                collect_occurrence(&router, &mut decoder, 2000).unwrap()
            });
            assert_eq!(parts.sub_meshes.len(), 3);
            for (part, dx) in parts.sub_meshes.iter().zip([13.0, 10.0, 10.0]) {
                assert_tetrahedron_at(&part.mesh, dx);
            }
            assert!(router.take_unsupported_items().is_empty());
            assert!(log.0.lock().unwrap().is_empty());
            assert_eq!(router.unsupported_scope_depth(), 0);
        }
    }
}
