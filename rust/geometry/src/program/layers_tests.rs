// SPDX-License-Identifier: MPL-2.0
//! The layer control: the canonical void-program host, numerical planes,
//! slice and cleanup publishing at accept, the styled entries' attempt order
//! and a returned stop.
use crate::material_layer_index::MaterialLayerIndex;
use crate::program::{GeometryProgram, ProgramStage};
use crate::router::processing::SourceHygiene;
use crate::GeometryRouter;
use ifc_lite_core::EntityDecoder;
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// A 4×0.3×3 extruded wall #9 and a block opening #21 through its middle.
const WALL: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCLOCALPLACEMENT($,#2);#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,0.3);\
    #5=IFCDIRECTION((0.,0.,1.));#6=IFCEXTRUDEDAREASOLID(#4,#2,#5,3.);\
    #7=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#6));#8=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));\
    #9=IFCWALL('wall',$,$,$,$,#3,#8,$,$);#30=IFCCARTESIANPOINT((-0.5,-1.,0.5));\
    #31=IFCAXIS2PLACEMENT3D(#30,$,$);#32=IFCBLOCK(#31,1.,2.,1.);\
    #33=IFCSHAPEREPRESENTATION($,'Body','CSG',(#32));#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));\
    #21=IFCOPENINGELEMENT('block',$,$,$,$,$,#34,$);";

/// Two 0.15 layers across the wall's thickness.
fn router() -> GeometryRouter {
    let index = MaterialLayerIndex::from_flat(&[9], &[2], &[2], &[1.], &[-0.15], &[100, 101], &[0.15, 0.15]);
    let mut router = GeometryRouter::new();
    router.set_material_layer_index(Arc::new(index.unwrap()));
    router
}

fn voids() -> FxHashMap<u32, Vec<u32>> {
    [(9, vec![21])].into_iter().collect()
}

/// The planes, the slice and the cleanup are numerical steps; the slice
/// diagnostic reaches the router only when its reply is accepted, and the
/// program's slices are the gateway's bytes.
#[test]
fn a_layer_attempt_slices_numerically_and_publishes_at_accept() {
    let router = router();
    let mut decoder = EntityDecoder::new(WALL);
    let wall = decoder.decode_by_id(9).unwrap();
    let mut program = GeometryProgram::styled_product(&wall, true, None, SourceHygiene::Watertight);
    let mut stages = Vec::new();
    let mut published = Vec::new();
    while let Some(request) = program.request().unwrap() {
        stages.push(request.stage());
        let reply = program.execute(request, &router, &mut decoder).unwrap();
        assert!(router.take_layer_slice_diag().is_empty(), "execution publishes nothing");
        program.accept(reply, &router).ok().unwrap();
        published.extend(router.take_layer_slice_diag().into_iter().map(|entry| (entry, request.stage())));
    }
    assert_eq!(published, [((9, "ok:sliced"), ProgramStage::Numerical)]);
    // The late frame is the last source step: planes, slice and cleanup follow.
    let tail = &stages[stages.len() - 4..];
    assert_eq!(tail, [ProgramStage::Source, ProgramStage::Numerical, ProgramStage::Numerical, ProgramStage::Numerical]);
    let sliced = program.drain_styled(&router, &mut decoder).unwrap();
    let ids: Vec<u32> = sliced.sub_meshes.iter().map(|sub| sub.geometry_id).collect();
    assert_eq!(ids, [100, 101]);
    let expected = router.process_element_with_submeshes(&wall, &mut decoder).unwrap();
    for (sub, gateway) in sliced.sub_meshes.iter().zip(&expected.sub_meshes) {
        assert_eq!(sub.mesh.positions, gateway.mesh.positions);
        assert_eq!(sub.mesh.indices, gateway.mesh.indices);
    }
}

/// The voided entry slices the opening-cut host; with no openings a declined
/// attempt is all, and the result is empty.
#[test]
fn the_voided_entry_slices_the_cut_host_through_the_canonical_void_child() {
    let router = router();
    let mut decoder = EntityDecoder::new(WALL);
    let wall = decoder.decode_by_id(9).unwrap();
    let sliced = router.process_element_with_submeshes_and_voids(&wall, &mut decoder, &voids()).unwrap();
    assert_eq!(router.take_layer_slice_diag(), [(9, "ok:sliced")]);
    let uncut = router.process_element_with_submeshes(&wall, &mut decoder).unwrap();
    assert_eq!(router.take_layer_slice_diag(), [(9, "ok:sliced")]);
    let triangles = |meshes: &crate::SubMeshCollection| -> usize {
        meshes.sub_meshes.iter().map(|sub| sub.mesh.triangle_count()).sum()
    };
    assert_eq!(sliced.sub_meshes.len(), 2);
    assert!(triangles(&sliced) > triangles(&uncut), "the slices carry the opening's cut");

    let shifted = WALL.replace("#6=IFCEXTRUDEDAREASOLID(#4,#2,#5,3.)", "#6=IFCEXTRUDEDAREASOLID(#4,#31,#5,3.)");
    let mut decoder = EntityDecoder::new(&shifted);
    let wall = decoder.decode_by_id(9).unwrap();
    let none = router.process_element_with_submeshes_and_voids(&wall, &mut decoder, &FxHashMap::default()).unwrap();
    assert!(none.is_empty());
    assert_eq!(router.take_layer_slice_diag(), [(9, "skip:not-single-unshifted-item")]);
}

/// Both voided attempts run, in order, each recording its own diagnostic:
/// an engulfing opening consumes the cut host, the uncut host still slices,
/// and each slice is then cut by the opening.
#[test]
fn the_voided_entry_keeps_both_layer_attempts_in_order() {
    let router = router();
    let engulfing = WALL
        .replace("#30=IFCCARTESIANPOINT((-0.5,-1.,0.5))", "#30=IFCCARTESIANPOINT((-3.,-1.,-1.))")
        .replace("#32=IFCBLOCK(#31,1.,2.,1.)", "#32=IFCBLOCK(#31,6.,2.,5.)");
    let mut decoder = EntityDecoder::new(&engulfing);
    let wall = decoder.decode_by_id(9).unwrap();
    let result = router.process_element_with_submeshes_and_voids(&wall, &mut decoder, &voids()).unwrap();
    assert!(result.is_empty(), "every uncut slice is consumed by the opening");
    assert_eq!(router.take_layer_slice_diag(), [(9, "skip:empty-base-mesh"), (9, "ok:sliced")]);

    // An ineligible voided element is refused by each attempt.
    let shifted = WALL.replace("#6=IFCEXTRUDEDAREASOLID(#4,#2,#5,3.)", "#6=IFCEXTRUDEDAREASOLID(#4,#31,#5,3.)");
    let mut decoder = EntityDecoder::new(&shifted);
    let wall = decoder.decode_by_id(9).unwrap();
    let cut = router.process_element_with_submeshes_and_voids(&wall, &mut decoder, &voids()).unwrap();
    assert_eq!(cut.sub_meshes.iter().map(|sub| sub.geometry_id).collect::<Vec<_>>(), [6]);
    let skip = (9, "skip:not-single-unshifted-item");
    assert_eq!(router.take_layer_slice_diag(), [skip, skip]);
}

/// A stop reached while the layer host is walked is returned by both styled
/// entries and the explicit-buildup entry; it is never recorded as a
/// base-mesh skip, and no walk runs after it.
#[test]
fn a_stop_in_the_layer_host_is_returned_not_recorded() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let router = router();
    let mut decoder = EntityDecoder::new(WALL);
    let wall = decoder.decode_by_id(9).unwrap();
    let buildup = router.material_layer_index().and_then(|index| index.get(9)).unwrap().clone();
    let limited = || {
        ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits { live_bytes: Some(0), ..Default::default() }))
    };
    for entry in 0..3 {
        let result = limited().scope(|| match entry {
            0 => router.process_element_with_submeshes(&wall, &mut decoder).map(drop),
            1 => router.process_element_with_submeshes_and_voids(&wall, &mut decoder, &voids()).map(drop),
            _ => router.process_element_with_material_layers(&wall, &mut decoder, &buildup, &voids()).map(drop),
        });
        assert!(matches!(result, Err(crate::Error::ProgramStopped(_))), "{entry}: {:?}", result.err());
        assert!(router.take_layer_slice_diag().is_empty(), "{entry}: a stop is no layer skip");
        let stats = router.take_classification_stats();
        assert_eq!(stats.rectangular + stats.diagonal + stats.non_rectangular, 0);
    }
}

#[test]
fn issue_7781_early_layer_content_error_keeps_indexed_fallback_and_explicit_error() {
    let content = WALL.replace("IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#6))",
        "IFCSHAPEREPRESENTATION($,'Body','SweptSolid')");
    let router = router();
    let mut decoder = EntityDecoder::new(&content);
    let wall = decoder.decode_by_id(9).unwrap();
    let no_openings = FxHashMap::default();
    let result = router.process_element_with_submeshes_and_voids(&wall, &mut decoder, &no_openings).unwrap();
    assert!(result.is_empty());
    assert_eq!(router.take_layer_slice_diag(), [(9, "skip:base-mesh-error")]);
    let buildup = router.material_layer_index().and_then(|index| index.get(9)).unwrap();
    assert!(router.process_element_with_material_layers(&wall, &mut decoder, buildup, &no_openings).is_err());
    assert!(router.take_layer_slice_diag().is_empty());
}

#[test]
fn issue_7781_terminal_after_layer_eligibility_never_becomes_content_fallback() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
    for malformed in [false, true] {
        let content = if malformed {
            WALL.replace("IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#6))",
                "IFCSHAPEREPRESENTATION($,'Body','SweptSolid')")
        } else { WALL.to_string() };
        let router = router();
        let mut decoder = EntityDecoder::new(&content);
        let wall = decoder.decode_by_id(9).unwrap();
        let mut program = GeometryProgram::voided_styled(&wall, &[]);
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        account.scope(|| {
            let request = program.request().unwrap().unwrap();
            let reply = program.execute(request, &router, &mut decoder).unwrap();
            account.cancel();
            program.accept(reply, &router).ok().unwrap();
            assert!(matches!(program.drain_styled(&router, &mut decoder),
                Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
            assert!(router.take_layer_slice_diag().is_empty());
        });
    }
}

#[test]
fn issue_7781_every_completed_layer_step_observes_stop_before_acceptance() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
    let count = {
        let router = router();
        let mut decoder = EntityDecoder::new(WALL);
        let wall = decoder.decode_by_id(9).unwrap();
        let buildup = router.material_layer_index().and_then(|index| index.get(9)).unwrap();
        let mut program = GeometryProgram::material_layers(&wall, buildup, &[]);
        let mut count = 0;
        while let Some(request) = program.request().unwrap() {
            let reply = program.execute(request, &router, &mut decoder).unwrap();
            program.accept(reply, &router).ok().unwrap();
            count += 1;
        }
        assert!(program.drain_layers(&router, &mut decoder).unwrap().is_some());
        count
    };
    assert!(count > 3, "eligibility, host, frame, planes and slice are exercised");
    for cancel_at in 0..count {
        let router = router();
        let mut decoder = EntityDecoder::new(WALL);
        let wall = decoder.decode_by_id(9).unwrap();
        let buildup = router.material_layer_index().and_then(|index| index.get(9)).unwrap();
        let mut program = GeometryProgram::material_layers(&wall, buildup, &[]);
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        account.scope(|| {
            for step in 0..=cancel_at {
                let request = program.request().unwrap().expect("step exists in unstopped run");
                let reply = program.execute(request, &router, &mut decoder).unwrap();
                if step == cancel_at {
                    router.take_layer_slice_diag();
                    account.cancel();
                }
                program.accept(reply, &router).ok().unwrap();
            }
            assert!(matches!(program.drain_layers(&router, &mut decoder),
                Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))), "step {cancel_at}");
            assert!(router.take_layer_slice_diag().is_empty(), "step {cancel_at} published after stop");
        });
    }
}
