// SPDX-License-Identifier: MPL-2.0
//! The void program: host walk, one context capture, then owned numerical
//! cuts whose diagnostics publish only when their reply is accepted.
use crate::program::{GeometryProgram, ProgramStage};
use crate::{GeometryRouter, SubMeshCollection};
use ifc_lite_core::EntityDecoder;

/// A 10×1×3 extruded wall #10 with one block opening #21 through it.
const SOURCE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCDIRECTION((0.,0.,1.));#5=IFCCARTESIANPOINT((0.,0.));#6=IFCAXIS2PLACEMENT2D(#5,$);\
    #4=IFCRECTANGLEPROFILEDEF(.AREA.,$,#6,10.,1.);#7=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);\
    #8=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7));#9=IFCPRODUCTDEFINITIONSHAPE($,$,(#8));\
    #10=IFCWALL('host',$,$,$,$,$,#9,$);#30=IFCCARTESIANPOINT((0.,-1.,0.5));\
    #31=IFCAXIS2PLACEMENT3D(#30,$,$);#32=IFCBLOCK(#31,1.,2.,1.);\
    #33=IFCSHAPEREPRESENTATION($,'Body','CSG',(#32));#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));\
    #21=IFCOPENINGELEMENT('block',$,$,$,$,$,#34,$);";

fn cut_recorded(router: &GeometryRouter) -> bool {
    router.host_opening_diagnostics.borrow().get(&10).is_some_and(|entry| entry.tris_before.is_some())
}

/// Each cut is a numerical step; its host diagnostics reach the router only
/// at accept, and the cut host comes back as the gateway's bytes.
#[test]
fn a_cut_publishes_its_diagnostics_at_accept() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::new();
    let host = decoder.decode_by_id(10).unwrap();
    let ids = [21];
    let mut program = GeometryProgram::voided(&host, &ids);
    let mut numerical_cut = false;
    while let Some(request) = program.request().unwrap() {
        let before = cut_recorded(&router);
        let reply = program.execute(request, &router, &mut decoder).unwrap();
        assert_eq!(cut_recorded(&router), before, "execution publishes nothing");
        program.accept(reply, &router).ok().unwrap();
        if !before && cut_recorded(&router) {
            assert_eq!(request.stage(), ProgramStage::Numerical);
            numerical_cut = true;
        }
    }
    assert!(numerical_cut);
    let parts = program.finish_parts().unwrap();
    let mut decoder = EntityDecoder::new(SOURCE);
    let gateway = GeometryRouter::new();
    let void_index = [(10, vec![21])].into_iter().collect();
    let expected = gateway.process_element_with_voids_parts(&host, &mut decoder, &void_index).unwrap();
    assert_eq!(parts.len(), 1);
    assert!(parts[0].triangle_count() > 12, "the opening was cut");
    assert_eq!(parts[0].positions, expected[0].positions);
    assert_eq!(parts[0].indices, expected[0].indices);
    assert!(parts[0].instance_meta.is_none());
}

/// A stop reached while the host is walked ends the program before any
/// opening is classified or any part cut.
#[test]
fn a_stop_in_the_host_walk_classifies_and_cuts_nothing() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::new();
    let host = decoder.decode_by_id(10).unwrap();
    let void_index = [(10, vec![21])].into_iter().collect();
    let limited = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(0),
        ..Default::default()
    }));
    let result = limited.scope(|| router.process_element_with_submeshes_and_voids(&host, &mut decoder, &void_index));
    assert!(matches!(result, Err(crate::Error::ProgramStopped(_))), "{:?}", result.err());
    let stats = router.take_classification_stats();
    assert_eq!(stats.rectangular + stats.diagonal + stats.non_rectangular, 0);
    assert!(!cut_recorded(&router));
}

/// The styled void program cuts each sub-mesh under its own geometry id and
/// keeps an empty host empty without capturing a context.
#[test]
fn styled_cuts_keep_geometry_ids_and_an_empty_host_captures_nothing() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::new();
    let host = decoder.decode_by_id(10).unwrap();
    let ids = [21];
    let cut = GeometryProgram::voided_styled(&host, &ids, None).drain_styled(&router, &mut decoder).unwrap();
    let geometry: Vec<u32> = cut.sub_meshes.iter().map(|sub| sub.geometry_id).collect();
    assert_eq!(geometry, [7]);
    let _ = router.take_classification_stats();
    let empty = GeometryProgram::voided_styled(&host, &ids, Some(SubMeshCollection::new()))
        .drain_styled(&router, &mut decoder)
        .unwrap();
    assert!(empty.is_empty());
    let stats = router.take_classification_stats();
    assert_eq!(stats.rectangular + stats.diagonal + stats.non_rectangular, 0);
}
