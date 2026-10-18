// SPDX-License-Identifier: MPL-2.0
//! ProductProgram preservation review: malformed source and live callback order.
use super::tests::{ObservedBlock, BLOCK};
use crate::{GeometryRouter, Mesh};
use ifc_lite_core::EntityDecoder;
use std::{cell::Cell, rc::Rc};

fn observed(repair: bool) -> (GeometryRouter, Rc<Cell<usize>>) {
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(ObservedBlock {
        calls: calls.clone(),
        repair,
    }));
    (router, calls)
}
fn triangles(meshes: &[Mesh]) -> usize {
    meshes.iter().map(|mesh| mesh.indices.len() / 3).sum()
}

#[test]
fn type_origin_is_admitted_after_items_and_wrong_placement_type_is_tolerated() {
    // A real callback repairs #999 into an IfcBlock. The late type-origin
    // read accepts the resolved wrong type as identity; normal mapping rejects it.
    let source = format!(
        "{BLOCK}#1=IFCREPRESENTATIONMAP(#999,#2);
        #2=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
        #20=IFCMAPPEDITEM(#1,$);"
    );
    for repair in [false, true] {
        let (router, calls) = observed(repair);
        let mut decoder = EntityDecoder::new(&source);
        let map = decoder.decode_by_id(1).unwrap();
        let result = router.process_representation_map(&map, &mut decoder);
        assert_eq!(
            calls.get(),
            1,
            "origin failure must follow the real item callback"
        );
        if repair {
            assert_eq!(triangles(&[result.unwrap()]), 12);
        } else {
            assert!(result.unwrap_err().to_string().contains("999"));
        }
    }
    let (router, calls) = observed(true);
    let strict_source = source.replace("#999,#2", "#10,#2");
    let mut decoder = EntityDecoder::new(&strict_source);
    let item = decoder.decode_by_id(20).unwrap();
    assert!(router
        .process_mapped_item_parts(&item, &mut decoder)
        .is_err());
    assert_eq!(
        calls.get(),
        0,
        "ordinary mapped origin validates strictly before Items"
    );
}

#[test]
fn type_map_bulk_failure_precedes_origin_and_every_item_callback() {
    let source = format!(
        "{BLOCK}#1=IFCREPRESENTATIONMAP(#998,#2);
        #2=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10,#999));"
    );
    let (router, calls) = observed(true);
    let mut decoder = EntityDecoder::new(&source);
    let map = decoder.decode_by_id(1).unwrap();
    let error = router
        .process_representation_map(&map, &mut decoder)
        .unwrap_err();
    assert!(
        error.to_string().contains("999"),
        "whole Items fails before late origin: {error}"
    );
    assert_eq!(calls.get(), 0);
}

#[test]
fn opening_bad_whole_lists_and_failed_items_skip_only_their_siblings() {
    let source = format!(
        "{BLOCK}#1=IFCOPENINGELEMENT('o',$,$,$,$,#997,#2,$);
        #2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3,#4,#5,#6));
        #3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10,#999));
        #4=IFCSHAPEREPRESENTATION($,'Body','CSG');
        #5=IFCSHAPEREPRESENTATION($,'Body','CSG',(#90,#10));
        #6=IFCSHAPEREPRESENTATION($,'Body','CSG',(#999));
        #90=IFCPOLYLINE(());"
    );
    for bounds in [false, true] {
        let (router, calls) = observed(true);
        let mut decoder = EntityDecoder::new(&source);
        let opening = decoder.decode_by_id(1).unwrap();
        if bounds {
            let boxes = router
                .get_opening_item_bounds_with_direction(&opening, &mut decoder)
                .unwrap();
            assert_eq!(
                boxes.len(),
                2,
                "a later list sees the earlier live decoder repair"
            );
            assert!(
                boxes.iter().all(|(min, max, direction)| {
                    *min == crate::Point3::new(0., 0., 0.)
                        && *max == crate::Point3::new(2., 3., 4.)
                        && direction.is_none()
                }),
                "failed placement uses identity"
            );
        } else {
            let meshes = router
                .get_opening_item_meshes_world(&opening, &mut decoder)
                .unwrap();
            assert_eq!(triangles(&meshes), 24);
            assert!(meshes.iter().all(|mesh| mesh.origin == [0.; 3]));
        }
        assert_eq!(
            calls.get(),
            2,
            "bad whole first list runs no earlier child; later lists still run"
        );
    }
}

#[test]
fn opening_bulk_representations_fail_before_placement_and_any_item_work() {
    let source = format!(
        "{BLOCK}#1=IFCOPENINGELEMENT('o',$,$,$,$,#998,#2,$);
        #2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3,#999));
        #3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));"
    );
    for bounds in [false, true] {
        let (router, calls) = observed(true);
        let mut decoder = EntityDecoder::new(&source);
        let opening = decoder.decode_by_id(1).unwrap();
        let error = if bounds {
            router
                .get_opening_item_bounds_with_direction(&opening, &mut decoder)
                .unwrap_err()
        } else {
            router
                .get_opening_item_meshes_world(&opening, &mut decoder)
                .unwrap_err()
        };
        assert!(error.to_string().contains("999"));
        assert_eq!(calls.get(), 0);
    }
}

#[test]
fn admitted_annotation_fill_outlives_source_and_keeps_scaled_area() {
    let plan = {
        let mut decoder = EntityDecoder::new(
            "#1=IFCCARTESIANPOINT((0.,0.));
            #2=IFCCARTESIANPOINT((2.,0.));#3=IFCCARTESIANPOINT((0.,3.));
            #4=IFCPOLYLINE((#1,#2,#3,#1));#10=IFCANNOTATIONFILLAREA(#4,$);",
        );
        let item = decoder.decode_by_id(10).unwrap();
        super::annotation::AnnotationFill::admit(&item, &mut decoder, 2.).unwrap()
    };
    let mesh = plan.evaluate().unwrap();
    assert_eq!(mesh.indices.len(), 3);
    let area: f64 = mesh
        .indices
        .chunks_exact(3)
        .map(|indices| {
            let point = |index: u32| {
                let i = index as usize * 3;
                crate::Point3::new(
                    mesh.positions[i] as f64,
                    mesh.positions[i + 1] as f64,
                    mesh.positions[i + 2] as f64,
                )
            };
            (point(indices[1]) - point(indices[0]))
                .cross(&(point(indices[2]) - point(indices[0])))
                .norm()
                * 0.5
        })
        .sum();
    assert_eq!(area, 12.);
}
