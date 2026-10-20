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
    router.ensure_shared_mapped_source(&rep, 1003, &mut decoder);
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
    router.ensure_shared_mapped_source(&rep, 60, &mut decoder);
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

/// #7873: traversal allowance is per walk, not per router. A partial B cannot
/// satisfy a later normal load with fresh allowance, even without a shared cache.
#[test]
fn issue_7873_local_cache_never_publishes_work_or_depth_truncated_source() {
    use crate::representation::{NestedMaps, RepresentationWalk, Select, MAX_WALK_LEVELS};
    let content = format!("{RAW_WORLD_MAP}\
        #2000=IFCMAPPEDITEM(#2001,#1004);#2001=IFCREPRESENTATIONMAP(#2,#2002);\
        #2002=IFCSHAPEREPRESENTATION($,'Body','Brep',(#2100,#2200));\
        #2100=IFCMAPPEDITEM(#2101,#1004);#2101=IFCREPRESENTATIONMAP(#2,#2102);\
        #2102=IFCSHAPEREPRESENTATION($,'Body','Brep',(#900));\
        #2200=IFCMAPPEDITEM(#2201,#1004);#2201=IFCREPRESENTATIONMAP(#2,#2202);\
        #2202=IFCSHAPEREPRESENTATION($,'Body','Brep',(#900,#2300));\
        #2300=IFCMAPPEDITEM(#2301,#1004);#2301=IFCREPRESENTATIONMAP(#2,#2302);\
        #2302=IFCSHAPEREPRESENTATION($,'Body','Brep',(#900));");
    for (max_depth, max_levels) in [(32, 5), (2, MAX_WALK_LEVELS)] {
        let mut decoder = EntityDecoder::new(&content);
        let mut router = GeometryRouter::with_scale_and_local_frame(1.0, false);
        router.set_rtc_offset((SITE[0], SITE[1], SITE[2]));
        let root = decoder.decode_by_id(2000).unwrap();
        let mut sink = crate::router::mapped_sink::MergeSink::new(&router);
        RepresentationWalk { select: Select::Any,
            nested: NestedMaps::Expand { max_depth, max_levels },
        }.mapped_item(&root, &mut decoder, &mut sink);
        assert!(sink.error.is_none(), "nested refusal keeps earlier solids");
        let parts = sink.parts.unwrap();
        assert_eq!(parts.iter().map(|p| p.indices.len()).sum::<usize>(), 24);
        assert!(!router.mapped_item_cache.borrow().contains_key(&2201), "partial B was cached");
        assert_eq!(router.take_unsupported_items().get("IfcMappedItem"), Some(&1));
        // B previously contributed one tetrahedron; a fresh walk reaches both.
        let b = decoder.decode_by_id(2200).unwrap();
        let complete = router.process_mapped_item_parts(&b, &mut decoder).unwrap();
        assert_eq!(complete.iter().map(|p| p.indices.len()).sum::<usize>(), 24);
        assert!(router.take_unsupported_items().is_empty(), "fresh B must be complete");
    }
}

/// #7873: refusing a cycle must also withhold the local cache. Rewalking it
/// retains the valid solid, rather than treating the partial source as complete.
#[test]
fn issue_7873_local_cache_never_publishes_cycle_truncated_source() {
    let content = RAW_WORLD_MAP.replace("(#900)", "(#900,#1005)");
    let mut decoder = EntityDecoder::new(&content);
    let mut router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    router.set_rtc_offset((SITE[0], SITE[1], SITE[2]));
    let item = decoder.decode_by_id(1005).unwrap();
    for _ in 0..2 {
        let parts = router.process_mapped_item_parts(&item, &mut decoder).unwrap();
        assert_eq!(parts.iter().map(|p| p.indices.len()).sum::<usize>(), 12);
        assert!(!router.mapped_item_cache.borrow().contains_key(&1003));
    }
    assert_eq!(router.take_unsupported_items().get("IfcMappedItem"), Some(&1));
}
