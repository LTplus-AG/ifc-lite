// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7690: actual don't-bake placeholder children share selected item execution,
//! precise source frames and cache publication with the merged mapping machine.

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
    let mut router = shared_rtc_router();
    let output=crate::router::instancing::drive_placeholder(&mut router,&mut decoder,1003,1005);
    assert_eq!(output.len(),1);
    assert!(output.sub_meshes[0].mesh.positions.is_empty());
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
        #106=IFCEXTRUDEDAREASOLID(#102,#105,#9,1000.);        #60=IFCREPRESENTATIONMAP(#105,#55);#61=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#3,1.,$);        #62=IFCMAPPEDITEM(#60,#61);";
    let mut decoder = EntityDecoder::new(content);
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    crate::router::instancing::drive_placeholder(&mut router,&mut decoder,60,62);
    let after_source = router.take_unsupported_items();
    assert_eq!(after_source.get("IfcBSplineCurveWithKnots"), Some(&1), "{after_source:?}");

    let plain = decoder.decode_by_id(106).unwrap();
    router.process_representation_item(&plain, &mut decoder).expect("the plain solid meshes");
    let after_plain = router.take_unsupported_items();
    assert!(after_plain.is_empty(), "the plain item inherited a drop: {after_plain:?}");
}
