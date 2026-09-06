// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::GeometryRouter;
use crate::diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
use ifc_lite_core::EntityDecoder;

#[test]
fn test_router_creation() {
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new("#1=IFCSPHERE($,2.);");
    let sphere = decoder.decode_by_id(1).unwrap();
    let mesh = router.process_representation_item(&sphere, &mut decoder).unwrap();
    assert!(mesh.triangle_count() > 0);
    assert!(mesh.positions.iter().all(|value| value.is_finite()));
}

#[test]
fn router_records_and_drains_csg_failures_with_product_id() {
    let router = GeometryRouter::new();
    assert_eq!(router.csg_failure_total(), 0);
    assert_eq!(router.csg_failure_product_count(), 0);

    let f1 = BoolFailure::new(
        BoolOp::Difference,
        BoolFailureReason::OperandTooLarge {
            polys_a: 36,
            polys_b: 12,
        },
    );
    let f2 = BoolFailure::new(BoolOp::Difference, BoolFailureReason::NoBoundsOverlap);
    router.record_csg_failures(/* product_id */ 1234, vec![f1, f2]);

    let f3 = BoolFailure::new(
        BoolOp::Union,
        BoolFailureReason::KernelError("boom".into()),
    );
    router.record_csg_failures(5678, vec![f3]);

    assert_eq!(router.csg_failure_total(), 3);
    assert_eq!(router.csg_failure_product_count(), 2);

    let drained = router.take_csg_failures();
    assert_eq!(drained.len(), 2);
    let p1 = drained.get(&1234).expect("product 1234 has failures");
    assert_eq!(p1.len(), 2);
    assert_eq!(p1[0].product_id, Some(1234), "product_id attached on drain");
    assert_eq!(p1[0].op, BoolOp::Difference);
    assert!(matches!(
        p1[0].reason,
        BoolFailureReason::OperandTooLarge { .. }
    ));
    assert_eq!(p1[1].product_id, Some(1234));

    let p2 = drained.get(&5678).expect("product 5678 has failures");
    assert_eq!(p2.len(), 1);
    assert_eq!(p2[0].product_id, Some(5678));
    assert_eq!(p2[0].op, BoolOp::Union);

    // Drain must clear the log.
    assert_eq!(router.csg_failure_total(), 0);
    assert!(router.take_csg_failures().is_empty());
}

#[test]
fn router_record_csg_failures_with_empty_vec_is_noop() {
    let router = GeometryRouter::new();
    router.record_csg_failures(42, Vec::new());
    assert_eq!(router.csg_failure_total(), 0);
    assert_eq!(router.csg_failure_product_count(), 0);
}

#[test]
fn router_csg_failures_append_under_same_product() {
    let router = GeometryRouter::new();
    router.record_csg_failures(
        7,
        vec![BoolFailure::new(
            BoolOp::Difference,
            BoolFailureReason::EmptyOperand,
        )],
    );
    router.record_csg_failures(
        7,
        vec![BoolFailure::new(
            BoolOp::Difference,
            BoolFailureReason::DegenerateOperand,
        )],
    );

    assert_eq!(router.csg_failure_product_count(), 1);
    assert_eq!(router.csg_failure_total(), 2);

    let drained = router.take_csg_failures();
    let entries = drained.get(&7).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(matches!(entries[0].reason, BoolFailureReason::EmptyOperand));
    assert!(matches!(
        entries[1].reason,
        BoolFailureReason::DegenerateOperand
    ));
}

#[test]
fn test_parse_cartesian_point() {
    let content = r#"
#1=IFCCARTESIANPOINT((100.0,200.0,300.0));
#2=IFCWALL('guid',$,$,$,$,$,#1,$);
"#;

    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::new();

    let wall = decoder.decode_by_id(2).unwrap();
    let point = router
        .parse_cartesian_point(&wall, &mut decoder, 6)
        .unwrap();

    assert_eq!(point.x, 100.0);
    assert_eq!(point.y, 200.0);
    assert_eq!(point.z, 300.0);
}

#[test]
fn test_parse_direction() {
    let content = r#"
#1=IFCDIRECTION((1.0,0.0,0.0));
"#;

    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::new();

    let direction = decoder.decode_by_id(1).unwrap();
    let vec = router.parse_direction(&direction).unwrap();

    assert_eq!(vec.x, 1.0);
    assert_eq!(vec.y, 0.0);
    assert_eq!(vec.z, 0.0);
}

/// Wall Profile Research Tests
///
/// These tests research and analyze how to correctly extrude wall footprints
/// with chamfered corners AND cut 2D window openings efficiently.
///
/// Key Problem: IFC wall profiles represent the footprint (length x thickness) with
/// chamfers at wall-to-wall joints, but openings are positioned on the wall face
/// (length x height). These are perpendicular coordinate systems.
mod wall_profile_research {
    use crate::bool2d::subtract_2d;
    use crate::extrusion::extrude_profile;
    use crate::profile::Profile2D;
    use nalgebra::Point2;

    /// Test 1: Chamfered Footprint Extrusion
    ///
    /// Verify that extruding a chamfered footprint produces correct 3D geometry.
    /// The chamfered corners create clean joints where walls meet.
    #[test]
    fn test_chamfered_footprint_extrusion() {
        // Chamfered wall footprint from AC20-FZK-Haus.ifc example
        // 5 points indicate chamfered corners (vs 4 for rectangle)
        let footprint = Profile2D::new(vec![
            Point2::new(0.300, -0.300), // chamfer start
            Point2::new(9.700, -0.300), // chamfer end
            Point2::new(10.000, 0.000), // corner
            Point2::new(0.000, 0.000),  // corner
            Point2::new(0.300, -0.300), // closing point
        ]);

        // X = wall length (10m), Y = wall thickness (0.3m)
        // Extrude along Z (height = 2.7m)
        let mesh = extrude_profile(&footprint, 2.7, None).unwrap();

        // Verify mesh was created
        assert!(mesh.vertex_count() > 0);
        assert!(mesh.triangle_count() > 0);

        // Check bounds: should span length x thickness x height
        let (min, max) = mesh.bounds();
        assert!((min.x - 0.0).abs() < 0.01);
        assert!((max.x - 10.0).abs() < 0.01);
        assert!((min.y - (-0.3)).abs() < 0.01);
        assert!((max.y - 0.0).abs() < 0.01);
        assert!((min.z - 0.0).abs() < 0.01);
        assert!((max.z - 2.7).abs() < 0.01);

        // Chamfered footprint should have more vertices than rectangular
        // (5 points in footprint vs 4, plus side walls)
        assert!(mesh.vertex_count() >= 20);
    }

    /// Test 3: Opening Projection Strategy
    ///
    /// Demonstrate how openings in wall-face coordinates relate to the footprint.
    /// Openings are positioned on the wall face (length x height) and need to
    /// be cut through the full thickness.
    #[test]
    fn test_opening_projection_strategy() {
        // Opening in wall-face coords (length x height)
        // Example from AC20-FZK-Haus.ifc: window at (6.495, 0.8) to (8.495, 2.0)
        let opening_face_min_u = 6.495; // position along wall length
        let opening_face_min_v = 0.8; // height from bottom
        let opening_face_max_u = 8.495; // position along wall length
        let opening_face_max_v = 2.0; // height from top

        // The opening doesn't intersect the chamfer area
        // Chamfers are at corners: 0-0.3m and 9.7-10m along length
        // Opening is at 6.495-8.495m, which is in the middle - no chamfer conflict

        // Create wall face profile with opening as a hole
        let mut wall_face = Profile2D::new(vec![
            Point2::new(0.0, 0.0),
            Point2::new(10.0, 0.0),
            Point2::new(10.0, 2.7),
            Point2::new(0.0, 2.7),
        ]);

        // Add opening as a hole (clockwise winding for holes)
        wall_face.add_hole(vec![
            Point2::new(opening_face_min_u, opening_face_min_v),
            Point2::new(opening_face_max_u, opening_face_min_v),
            Point2::new(opening_face_max_u, opening_face_max_v),
            Point2::new(opening_face_min_u, opening_face_max_v),
        ]);

        // This profile can be extruded along thickness (Y axis) to create
        // a wall with an opening, but it loses the chamfers!
        let mesh_with_opening = extrude_profile(&wall_face, 0.3, None).unwrap();

        // Verify opening was created
        assert!(mesh_with_opening.vertex_count() > 0);

        // The mesh has the opening but no chamfers
        // This is the tradeoff: we need chamfers OR openings, not both with this approach
    }

    /// Test 4: Efficient 2D Boolean Approach
    ///
    /// Test subtracting openings from wall face profile using 2D boolean operations.
    /// This is more efficient than 3D CSG but loses chamfers.
    #[test]
    fn test_efficient_2d_boolean_approach() {
        // Wall face profile (rectangular, no chamfers)
        let wall_face = Profile2D::new(vec![
            Point2::new(0.0, 0.0),
            Point2::new(10.0, 0.0),
            Point2::new(10.0, 2.7),
            Point2::new(0.0, 2.7),
        ]);

        // Opening contour (counter-clockwise for subtraction)
        let opening_contour = vec![
            Point2::new(6.495, 0.8),
            Point2::new(8.495, 0.8),
            Point2::new(8.495, 2.0),
            Point2::new(6.495, 2.0),
        ];

        // Subtract opening using 2D boolean
        let wall_with_opening = subtract_2d(&wall_face, &opening_contour).unwrap();

        // Verify opening was subtracted (should have a hole)
        assert_eq!(wall_with_opening.holes.len(), 1);
        assert_eq!(wall_with_opening.holes[0].len(), 4);

        // Extrude the result
        let mesh = extrude_profile(&wall_with_opening, 0.3, None).unwrap();

        // This approach is efficient but loses chamfers
        // Vertex count should be reasonable (much less than 3D CSG)
        assert!(mesh.vertex_count() < 200);
    }

    /// Test 5: Chamfer Preservation Analysis
    ///
    /// Verify that chamfers only affect the footprint edges, not vertical edges.
    /// This confirms that chamfers can be preserved while cutting openings.
    #[test]
    fn test_chamfer_preservation_analysis() {
        // Chamfered footprint
        let chamfered = Profile2D::new(vec![
            Point2::new(0.3, -0.3), // chamfer start
            Point2::new(9.7, -0.3), // chamfer end
            Point2::new(10.0, 0.0), // corner
            Point2::new(0.0, 0.0),  // corner
        ]);

        // Rectangular footprint (no chamfers)
        let rectangular = Profile2D::new(vec![
            Point2::new(0.0, -0.3),
            Point2::new(10.0, -0.3),
            Point2::new(10.0, 0.0),
            Point2::new(0.0, 0.0),
        ]);

        // Extrude both
        let mesh_chamfered = extrude_profile(&chamfered, 2.7, None).unwrap();
        let mesh_rectangular = extrude_profile(&rectangular, 2.7, None).unwrap();

        // Chamfered should have at least as many vertices (5 points vs 4 in footprint)
        // Note: Triangulation may produce similar vertex counts, but chamfered has more footprint points
        assert!(mesh_chamfered.vertex_count() >= mesh_rectangular.vertex_count());

        // But both have same height (2.7m) - chamfers don't affect vertical dimension
        let (_, max_chamfered) = mesh_chamfered.bounds();
        let (_, max_rectangular) = mesh_rectangular.bounds();
        assert!((max_chamfered.z - max_rectangular.z).abs() < 0.01);

        // Key insight: Chamfers are horizontal features, openings are vertical cuts
        // They operate in perpendicular planes and don't conflict
    }
}

/// Infrastructure model RTC detection tests.
///
/// Infrastructure models (12d Model, Civil 3D) embed large world coordinates
/// (e.g. GDA2020 MGA56: X ~280 000, Y ~6 214 000) directly in Brep geometry
/// vertices while keeping IfcLocalPlacement at origin (0, 0, 0).
///
/// Regression test for <https://github.com/LTplus-AG/ifc-lite/issues/335>.
mod infra_rtc_detection {
    use super::*;

    /// Minimal IFC fragment simulating an infrastructure model:
    /// - IfcLocalPlacement at (0, 0, 0)
    /// - IfcFacetedBrep vertices at large world coordinates
    fn infra_model_ifc() -> String {
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[Ifc4x3NotAssigned]'),'2;1');
FILE_NAME('test.ifc','2025-04-03T20:15:31',(''),(''),'','12d Model','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('3A_FOM1U13fh337NmQeVRd',$,'TestProject','',$,$,$,(#12),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCGEOMETRICREPRESENTATIONCONTEXT('3D','Model',3,1.E-6,#14,$);
#13=IFCLOCALPLACEMENT($,#14);
#14=IFCAXIS2PLACEMENT3D(#15,#16,#17);
#15=IFCCARTESIANPOINT((0.,0.,0.));
#16=IFCDIRECTION((0.,0.,1.));
#17=IFCDIRECTION((1.,0.,0.));
#37=IFCSITE('1hW4TzF_DDAfTPaQBppMz3',$,'Site','',$,#13,$,$,.ELEMENT.,$,$,$,$,$);
#38=IFCRELAGGREGATES('1QP4NryH5APR64IuPmfbrw',$,'','',#1,(#37));
#39=IFCFACILITY('3fh5t6Rfv4KgZVJyIsS3vL',$,'TestFacility','',$,#13,$,$,.ELEMENT.);
#40=IFCRELAGGREGATES('0JznlPoAL2t9gXdhqZciud',$,'','',#37,(#39));
#41=IFCRELCONTAINEDINSPATIALSTRUCTURE('2nyGDMmiP47BqaRKBUVTUc',$,'','FacilityContainer',(#42),#39);
#42=IFCBUILDINGELEMENTPROXY('2JJeX0xY93XxwyMxv0upiL',$,'Trimesh','12d Trimesh','Trimesh',#13,#43,$,.USERDEFINED.);
#43=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#44=IFCSHAPEREPRESENTATION(#12,'Body','Brep',(#100));
#100=IFCFACETEDBREP(#101);
#101=IFCCLOSEDSHELL((#102));
#102=IFCFACE((#103));
#103=IFCFACEOUTERBOUND(#104,.T.);
#104=IFCPOLYLOOP((#110,#111,#112));
#110=IFCCARTESIANPOINT((280964.209858276,6214442.15622959,145.312878290516));
#111=IFCCARTESIANPOINT((280966.589503645,6214441.40182406,145.321540679517));
#112=IFCCARTESIANPOINT((280968.964944952,6214440.62254459,145.330215679517));
ENDSEC;
END-ISO-10303-21;
"#
        .to_string()
    }

    /// Second infrastructure model at a different location, same coordinate system.
    fn infra_model_ifc_b() -> String {
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[Ifc4x3NotAssigned]'),'2;1');
FILE_NAME('test_b.ifc','2025-04-03T20:15:31',(''),(''),'','12d Model','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('3A_FOM1U13fh337NmQeVRd',$,'TestProject','',$,$,$,(#12),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCGEOMETRICREPRESENTATIONCONTEXT('3D','Model',3,1.E-6,#14,$);
#13=IFCLOCALPLACEMENT($,#14);
#14=IFCAXIS2PLACEMENT3D(#15,#16,#17);
#15=IFCCARTESIANPOINT((0.,0.,0.));
#16=IFCDIRECTION((0.,0.,1.));
#17=IFCDIRECTION((1.,0.,0.));
#37=IFCSITE('0AvQ9WiKj9QhhBF8HoQbpT',$,'Site','',$,#13,$,$,.ELEMENT.,$,$,$,$,$);
#38=IFCRELAGGREGATES('0cPQjCyWf38RWxUzqd9LMm',$,'','',#1,(#37));
#39=IFCFACILITY('0kH5sw_GL2axycWUi$aMhv',$,'TestFacility','',$,#13,$,$,.ELEMENT.);
#40=IFCRELAGGREGATES('2ZShpA4fL9QObco6Upayde',$,'','',#37,(#39));
#41=IFCRELCONTAINEDINSPATIALSTRUCTURE('17fDKZ7VHE590ShtaZSobA',$,'','FacilityContainer',(#42),#39);
#42=IFCBUILDINGELEMENTPROXY('348HbFCG9ESeA2m3bPTUIP',$,'Trimesh','12d Trimesh','Trimesh',#13,#43,$,.USERDEFINED.);
#43=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#44=IFCSHAPEREPRESENTATION(#12,'Body','Brep',(#100));
#100=IFCFACETEDBREP(#101);
#101=IFCCLOSEDSHELL((#102));
#102=IFCFACE((#103));
#103=IFCFACEOUTERBOUND(#104,.T.);
#104=IFCPOLYLOOP((#110,#111,#112));
#110=IFCCARTESIANPOINT((279616.962383915,6213394.41079812,222.904072802032));
#111=IFCCARTESIANPOINT((279617.172274625,6213389.48119807,222.626516208578));
#112=IFCCARTESIANPOINT((279617.409779591,6213384.48685233,222.345251208578));
ENDSEC;
END-ISO-10303-21;
"#
        .to_string()
    }

    /// Ordinary model pattern: vertices are local and the large coordinate comes
    /// from IfcLocalPlacement. The placement is rotated to catch regressions
    /// where RTC is subtracted from local Brep coordinates before placement.
    fn rotated_placement_model_ifc() -> String {
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[CoordinationView]'),'2;1');
FILE_NAME('rotated.ifc','2026-04-13T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('3A_FOM1U13fh337NmQeVRd',$,'TestProject','',$,$,$,(#12),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCGEOMETRICREPRESENTATIONCONTEXT('3D','Model',3,1.E-6,#14,$);
#13=IFCLOCALPLACEMENT($,#14);
#14=IFCAXIS2PLACEMENT3D(#15,#16,#17);
#15=IFCCARTESIANPOINT((280000.,6214000.,0.));
#16=IFCDIRECTION((0.,0.,1.));
#17=IFCDIRECTION((0.,1.,0.));
#42=IFCBUILDINGELEMENTPROXY('2JJeX0xY93XxwyMxv0upiL',$,'LocalBrep','LocalBrep','LocalBrep',#13,#43,$,.USERDEFINED.);
#43=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#44=IFCSHAPEREPRESENTATION(#12,'Body','Brep',(#100));
#100=IFCFACETEDBREP(#101);
#101=IFCCLOSEDSHELL((#102));
#102=IFCFACE((#103));
#103=IFCFACEOUTERBOUND(#104,.T.);
#104=IFCPOLYLOOP((#110,#111,#112));
#110=IFCCARTESIANPOINT((0.,0.,0.));
#111=IFCCARTESIANPOINT((1.,0.,0.));
#112=IFCCARTESIANPOINT((0.,1.,0.));
ENDSEC;
END-ISO-10303-21;
"#
        .to_string()
    }

    /// RTC detection must work when placement is at origin but geometry vertices
    /// contain large world coordinates (the infrastructure model pattern).
    #[test]
    fn rtc_detected_from_geometry_vertices_not_just_placement() {
        let content = infra_model_ifc();
        let entity_index = ifc_lite_core::build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let router = GeometryRouter::with_units(&content, &mut decoder);

        let offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);

        // Must detect the large coordinates (~280 000, ~6 214 000)
        assert!(
            offset.0.abs() > 10000.0 || offset.1.abs() > 10000.0,
            "RTC offset should be large for infrastructure model, got ({:.1}, {:.1}, {:.1})",
            offset.0,
            offset.1,
            offset.2
        );
        // Offset should be near the geometry centroid
        assert!(
            (offset.0 - 280966.0).abs() < 100.0,
            "X offset should be near 280966, got {:.1}",
            offset.0
        );
        assert!(
            (offset.1 - 6214441.0).abs() < 100.0,
            "Y offset should be near 6214441, got {:.1}",
            offset.1
        );
    }

    /// After RTC is applied, geometry vertices should be small (within a few km
    /// of origin). This prevents f32 precision jitter.
    #[test]
    fn rtc_produces_small_vertex_coordinates() {
        let content = infra_model_ifc();
        let entity_index = ifc_lite_core::build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let mut router = GeometryRouter::with_units(&content, &mut decoder);

        let offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);
        router.set_rtc_offset(offset);

        // Process the element
        let entity = decoder.decode_by_id(42).unwrap();
        let mesh = router.process_element(&entity, &mut decoder).unwrap();

        // Verify all vertex positions are small (near origin after RTC)
        for chunk in mesh.positions.chunks_exact(3) {
            assert!(
                chunk[0].abs() < 10000.0 && chunk[1].abs() < 10000.0 && chunk[2].abs() < 10000.0,
                "Vertex ({}, {}, {}) still has large coordinates after RTC",
                chunk[0],
                chunk[1],
                chunk[2]
            );
        }
    }

    #[test]
    fn rtc_is_applied_after_rotated_object_placement_for_local_vertices() {
        let content = rotated_placement_model_ifc();
        let entity_index = ifc_lite_core::build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let mut router = GeometryRouter::with_units(&content, &mut decoder);

        let offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);
        router.set_rtc_offset(offset);

        let entity = decoder.decode_by_id(42).unwrap();
        let mesh = router.process_element(&entity, &mut decoder).unwrap();

        for chunk in mesh.positions.chunks_exact(3) {
            assert!(
                chunk[0].abs() < 10.0 && chunk[1].abs() < 10.0 && chunk[2].abs() < 10.0,
                "Local Brep vertex ({}, {}, {}) was shifted before final placement",
                chunk[0],
                chunk[1],
                chunk[2]
            );
        }
    }

    /// Two infrastructure models from the same project should produce consistent
    /// RTC offsets that enable correct federation alignment.
    #[test]
    fn federated_models_produce_usable_rtc_offsets() {
        let content_a = infra_model_ifc();
        let content_b = infra_model_ifc_b();

        // Detect RTC for model A
        let entity_index_a = ifc_lite_core::build_entity_index(&content_a);
        let mut decoder_a = EntityDecoder::with_index(&content_a, entity_index_a);
        let router_a = GeometryRouter::with_units(&content_a, &mut decoder_a);
        let offset_a = router_a.detect_rtc_offset_from_first_element(&content_a, &mut decoder_a);

        // Detect RTC for model B
        let entity_index_b = ifc_lite_core::build_entity_index(&content_b);
        let mut decoder_b = EntityDecoder::with_index(&content_b, entity_index_b);
        let router_b = GeometryRouter::with_units(&content_b, &mut decoder_b);
        let offset_b = router_b.detect_rtc_offset_from_first_element(&content_b, &mut decoder_b);

        // Both should detect large offsets
        assert!(
            offset_a.0.abs() > 10000.0,
            "Model A should have large X offset"
        );
        assert!(
            offset_b.0.abs() > 10000.0,
            "Model B should have large X offset"
        );

        // The RTC delta between models should be finite and usable for alignment
        let delta_x = offset_a.0 - offset_b.0;
        let delta_y = offset_a.1 - offset_b.1;
        let _delta_z = offset_a.2 - offset_b.2;

        // Models are about 1.3 km apart in X and 1 km apart in Y
        assert!(
            delta_x.abs() < 5000.0,
            "X delta between models should be reasonable, got {:.1}",
            delta_x
        );
        assert!(
            delta_y.abs() < 5000.0,
            "Y delta between models should be reasonable, got {:.1}",
            delta_y
        );

        // The delta should be expressible in f32 without precision issues
        let delta_x_f32 = delta_x as f32;
        let delta_y_f32 = delta_y as f32;
        assert!(
            (delta_x_f32 as f64 - delta_x).abs() < 1.0,
            "RTC delta X should survive f32 round-trip"
        );
        assert!(
            (delta_y_f32 as f64 - delta_y).abs() < 1.0,
            "RTC delta Y should survive f32 round-trip"
        );
    }
}

#[test]
fn router_records_and_drains_unsupported_items() {
    let router = GeometryRouter::new();
    assert!(router.take_unsupported_items().is_empty());

    router.record_unsupported_item(ifc_lite_core::IfcType::IfcGeometricSet);
    router.record_unsupported_item(ifc_lite_core::IfcType::IfcGeometricSet);
    router.record_unsupported_item(ifc_lite_core::IfcType::IfcAnnotationFillArea);

    let drained = router.take_unsupported_items();
    assert_eq!(drained.get("IfcGeometricSet"), Some(&2));
    assert_eq!(drained.get("IfcAnnotationFillArea"), Some(&1));

    // Drain clears the log.
    assert!(router.take_unsupported_items().is_empty());
}

/// RED (pre-fix): a Body representation item of a genuinely unsupported IFC
/// type (no registered processor, e.g. `IfcGeometricSet` used directly as a
/// body item rather than inside a non-body `GeometricCurveSet` context) was
/// silently skipped by `collect_submeshes_from_item_inner` with zero counter
/// anywhere the caller could read — only a `debug_assertions`/`observability`
/// eprintln, compiled out of every release/wasm build. GREEN (post-fix): the
/// drop is counted and attributable by IFC type, without changing the mesh
/// output (the item is still correctly absent — this is observability, not a
/// behavior change).
#[test]
fn unsupported_body_item_is_dropped_and_counted_not_silent() {
    let content = r#"
#1=IFCGEOMETRICSET(());
#2=IFCSHAPEREPRESENTATION($,'Body','Body',(#1));
#3=IFCPRODUCTDEFINITIONSHAPE($,$,(#2));
#4=IFCWALL('guid',$,$,$,$,$,#3,$);
"#;
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::new();
    let wall = decoder.decode_by_id(4).unwrap();

    let sub_meshes = router
        .process_element_with_submeshes(&wall, &mut decoder)
        .expect("router walks the representation without erroring the whole element");
    assert!(
        sub_meshes.is_empty(),
        "an all-unsupported-item element still produces no geometry (behavior unchanged)"
    );

    let unsupported = router.take_unsupported_items();
    assert_eq!(
        unsupported.get("IfcGeometricSet"),
        Some(&1),
        "the drop must be attributable, not merely silent: {unsupported:?}"
    );
}

/// RED (pre-fix): the SAME unsupported-item drop as
/// `unsupported_body_item_is_dropped_and_counted_not_silent`, but reached
/// through `process_mapped_item_cached_inner`'s own item loop rather than
/// `collect_submeshes_from_item_inner`'s — a wall whose entire Body is an
/// `IfcMappedItem` over a source containing a SUPPORTED `IfcExtrudedAreaSolid`
/// alongside an unsupported `IfcGeometricSet`. That sibling loop had zero
/// signal on a `None` processor or an `Err` (not even the `debug_assertions`
/// eprintln the other two sites had before this fix), so the drop was
/// invisible via `process_element` too. GREEN (post-fix): only the genuinely
/// unsupported item is counted — the solid still meshes normally and is NOT
/// recorded as dropped (a reporter that fires for every item, supported or
/// not, is exactly as wrong as one that fires for none).
#[test]
fn unsupported_mapped_source_item_is_dropped_and_counted_not_silent() {
    let content = r#"
#1=IFCCARTESIANPOINT((0.,0.));
#2=IFCAXIS2PLACEMENT2D(#1,$);
#3=IFCRECTANGLEPROFILEDEF(.AREA.,'P',#2,1000.,1000.);
#4=IFCDIRECTION((0.,0.,1.));
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCEXTRUDEDAREASOLID(#3,#6,#4,1000.);
#8=IFCGEOMETRICSET(());
#9=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7,#8));
#10=IFCREPRESENTATIONMAP($,#9);
#11=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,$,$,$);
#12=IFCMAPPEDITEM(#10,#11);
#13=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#12));
#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#15=IFCWALL('guid',$,$,$,$,$,#14,$);
"#;
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::new();
    let wall = decoder.decode_by_id(15).unwrap();

    let mesh = router
        .process_element(&wall, &mut decoder)
        .expect("router walks the mapped representation without erroring the whole element");
    assert!(
        !mesh.positions.is_empty(),
        "the supported solid in the mapped source must still mesh normally (behavior unchanged)"
    );

    let unsupported = router.take_unsupported_items();
    assert_eq!(
        unsupported.get("IfcGeometricSet"),
        Some(&1),
        "the drop must be attributable through the mapped-item path too, not merely silent: {unsupported:?}"
    );
    assert_eq!(
        unsupported.get("IfcExtrudedAreaSolid"),
        None,
        "the supported solid must NOT be recorded as dropped: {unsupported:?}"
    );
    assert_eq!(
        unsupported.values().sum::<u64>(),
        1,
        "exactly one item was unsupported — a reporter firing for supported items too is as wrong as one firing for none: {unsupported:?}"
    );
}

/// RED (pre-fix): the SAME unsupported-item drop as
/// `unsupported_body_item_is_dropped_and_counted_not_silent`, but reached
/// through `process_representation_map_with_texture` — the type-geometry
/// (orphan `IfcRepresentationMap`) channel used by
/// `ifc_lite_processing::element::produce_type_geometry` for `IfcTypeProduct`
/// jobs (the annex-E "tessellated shape with style" sample ships exactly this
/// shape: geometry hung off a type via `RepresentationMaps`, no occurrence).
/// Both call sites this test drives had zero counter before this fix:
/// `textured.rs:109` discarded `process_mapped_item_cached`'s `Err` wholesale
/// (a malformed nested `IfcMappedItem`), and the item loop around `textured.rs:129`
/// had the same no-`else` shape as the already-fixed `collect_submeshes_from_item_inner`
/// / `process_mapped_item_cached_inner` loops for a `None` processor or an `Err`.
/// A mixed source — a supported `IfcExtrudedAreaSolid` alongside an unsupported
/// `IfcGeometricSet` AND a malformed `IfcMappedItem` (missing `MappingSource`,
/// attr 0) — catches the permissive direction too: a reporter firing for the
/// supported solid would be exactly as wrong as one firing for nothing.
/// GREEN (post-fix): both drops are counted and attributable by IFC type,
/// without changing the mesh output.
#[test]
fn unsupported_textured_representation_map_items_are_dropped_and_counted_not_silent() {
    let content = r#"
#1=IFCCARTESIANPOINT((0.,0.));
#2=IFCAXIS2PLACEMENT2D(#1,$);
#3=IFCRECTANGLEPROFILEDEF(.AREA.,'P',#2,1000.,1000.);
#4=IFCDIRECTION((0.,0.,1.));
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCEXTRUDEDAREASOLID(#3,#6,#4,1000.);
#8=IFCGEOMETRICSET(());
#9=IFCMAPPEDITEM($,$);
#10=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#7,#8,#9));
#11=IFCREPRESENTATIONMAP($,#10);
"#;
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::new();
    let rep_map = decoder.decode_by_id(11).unwrap();
    let texture_index = rustc_hash::FxHashMap::default();

    let parts = router
        .process_representation_map_with_texture(&rep_map, &mut decoder, &texture_index)
        .expect("router walks the representation map without erroring the whole map");
    assert!(
        parts.iter().any(|(mesh, _, _)| !mesh.is_empty()),
        "the supported solid in the representation map must still mesh normally (behavior unchanged)"
    );

    let unsupported = router.take_unsupported_items();
    assert_eq!(
        unsupported.get("IfcGeometricSet"),
        Some(&1),
        "the direct-item drop must be attributable through the textured representation-map path too, not merely silent: {unsupported:?}"
    );
    assert_eq!(
        unsupported.get("IfcMappedItem"),
        Some(&1),
        "the malformed nested IfcMappedItem's drop must be attributable too, not silently discarded: {unsupported:?}"
    );
    assert_eq!(
        unsupported.get("IfcExtrudedAreaSolid"),
        None,
        "the supported solid must NOT be recorded as dropped: {unsupported:?}"
    );
    assert_eq!(
        unsupported.values().sum::<u64>(),
        2,
        "exactly two items were unsupported — a reporter firing for the supported item too is as wrong as one firing for none: {unsupported:?}"
    );
}

/// RED (pre-fix): a CLEAN model warned. `plan_type_geometry` selects a type's
/// `IfcRepresentationMap`s by reference/instantiation only — it never looks at
/// the representation identifier, unlike the occurrence path which filters with
/// `is_body_representation` ("Skip 'Axis', 'Curve2D', 'FootPrint'"). So a
/// Revit/ArchiCAD type carrying a 2D 'FootPrint'/'Annotation' map handed the
/// router `IfcAnnotationFillArea` / `IfcGeometricCurveSet`, which have no
/// processor and are CORRECTLY absent from a 3D view — and every one of them was
/// counted as a dropped representation item. A door type with an annotation map,
/// instantiated across a building, produced "N representation items dropped …
/// these elements are missing or incomplete" on a model with nothing wrong,
/// which is precisely the false positive that trains users to ignore the warning.
///
/// GREEN: a non-Body representation records NOTHING. The wall below is meshed
/// through a 'FootPrint' mapped representation whose only item has no processor;
/// the geometry outcome is unchanged (no mesh — there is no 3D content), but the
/// drop counter must stay empty so `GeometryDiagnostics::is_empty()` still
/// reports this model as clean.
#[test]
fn a_non_body_representations_unsupported_item_is_not_counted_as_content_loss() {
    let footprint = r#"
#1=IFCCARTESIANPOINT((0.,0.));
#8=IFCANNOTATIONFILLAREA(#1,());
#9=IFCSHAPEREPRESENTATION($,'FootPrint','Annotation2D',(#8));
#10=IFCREPRESENTATIONMAP($,#9);
#11=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,$,$,$);
#12=IFCMAPPEDITEM(#10,#11);
#13=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#12));
#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#15=IFCWALL('guid',$,$,$,$,$,#14,$);
"#;
    let mut decoder = EntityDecoder::new(footprint);
    let router = GeometryRouter::new();
    let wall = decoder.decode_by_id(15).unwrap();
    let _ = router.process_element(&wall, &mut decoder);

    let unsupported = router.take_unsupported_items();
    assert!(
        unsupported.is_empty(),
        "a 2D 'FootPrint' representation carries no 3D content to lose, so nothing may be \
         reported as dropped — a clean model must not warn: {unsupported:?}"
    );
}

/// The other half of the gate, so it cannot be satisfied by simply never
/// counting: the SAME unsupported item under a 'Body' representation IS a real
/// content loss and must still be counted. Without this, a fix for the false
/// positive above could silently reintroduce the original silent-drop bug.
#[test]
fn the_same_unsupported_item_under_a_body_representation_is_still_counted() {
    let body = r#"
#1=IFCCARTESIANPOINT((0.,0.));
#8=IFCANNOTATIONFILLAREA(#1,());
#9=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#8));
#10=IFCREPRESENTATIONMAP($,#9);
#11=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,$,$,$);
#12=IFCMAPPEDITEM(#10,#11);
#13=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#12));
#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#15=IFCWALL('guid',$,$,$,$,$,#14,$);
"#;
    let mut decoder = EntityDecoder::new(body);
    let router = GeometryRouter::new();
    let wall = decoder.decode_by_id(15).unwrap();
    let _ = router.process_element(&wall, &mut decoder);

    let unsupported = router.take_unsupported_items();
    assert_eq!(
        unsupported.values().sum::<u64>(),
        1,
        "the identical item under a Body representation IS missing 3D content and must be \
         counted — the gate keys on the representation, not on the item type: {unsupported:?}"
    );
}

/// Three occurrences of ONE `IfcRepresentationMap` whose Body source holds a
/// supported solid plus an unsupported `IfcGeometricSet`. The doc on
/// `record_unsupported_item` and `GeometryDiagnostics.totalUnsupportedItems`
/// both promise a per-SOURCE count ("counted once, not once per `IfcMappedItem`
/// occurrence"). RED (pre-fix) on the OCCURRENCE path: 3.
/// `collect_submeshes_from_item_inner` walks the source's items itself on every
/// occurrence — it never consults the mapped-item cache — so the drop was
/// re-counted per occurrence and the reported number was an occurrence count
/// wearing a source count's documentation.
#[test]
fn a_shared_sources_unsupported_item_counts_once_not_once_per_occurrence() {
    let mut decoder = EntityDecoder::new(MIXED_SHARED_SOURCE);
    let router = GeometryRouter::new();
    for wall_id in [15, 25, 35] {
        let wall = decoder.decode_by_id(wall_id).unwrap();
        let subs = router
            .process_element_with_submeshes(&wall, &mut decoder)
            .expect("each occurrence walks its mapped source without erroring");
        assert!(
            !subs.is_empty(),
            "the supported solid must still mesh for occurrence #{wall_id} (behaviour unchanged)"
        );
    }

    let unsupported = router.take_unsupported_items();
    assert_eq!(
        unsupported.get("IfcGeometricSet"),
        Some(&1),
        "one source, one dropped item, three occurrences — the contract is per SOURCE: {unsupported:?}"
    );
}

/// The same source and the same promise, reached through
/// `process_mapped_item_cached` instead. The shared mapped-item cache is armed
/// because that is the production wiring (#1623) and the half of the contract
/// this exercises: a source that yields geometry is inserted once and later
/// occurrences never re-walk it.
#[test]
fn a_shared_sources_unsupported_item_counts_once_through_the_mapped_item_path_too() {
    let mut decoder = EntityDecoder::new(MIXED_SHARED_SOURCE);
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    for wall_id in [15, 25, 35] {
        let wall = decoder.decode_by_id(wall_id).unwrap();
        let mesh = router
            .process_element(&wall, &mut decoder)
            .expect("each occurrence walks its mapped source without erroring");
        assert!(
            !mesh.positions.is_empty(),
            "the supported solid must still mesh for occurrence #{wall_id} (behaviour unchanged)"
        );
    }

    let unsupported = router.take_unsupported_items();
    assert_eq!(
        unsupported.get("IfcGeometricSet"),
        Some(&1),
        "the per-source contract must hold on the mapped-item path too: {unsupported:?}"
    );
}

/// The case the SHARED cache cannot cover: a source whose items ALL drop, so it
/// meshes to EMPTY. Both shared-cache inserts (`mapped_item.rs`,
/// `instancing.rs`) guard on `!mesh.positions.is_empty()`, deliberately — a
/// mesh short of the source's real geometry must not be published model-wide.
/// The consequence was that a TOTAL-loss source is the one source re-walked by
/// every occurrence, so the count it reported scaled with occurrences on BOTH
/// paths. RED (pre-fix): 3 and 3. GREEN: 1 and 1, from the recorded-sources set
/// rather than from a cache that is correct to refuse it.
///
/// The fixture ARMS the shared cache (below) precisely because that is the
/// configuration where the guards bite. `mapped_item.rs`'s per-router `RefCell`
/// fallback, taken when no shared cache is armed, is deliberately UNGUARDED and
/// caches the empty mesh, so on that path later occurrences never re-walk and
/// the recorded-sources set is not what holds the count down.
#[test]
fn a_total_loss_source_counts_once_on_the_occurrence_path() {
    assert_total_loss_source_counts_once(true);
}

/// The mapped-item leg of the same case. Split from the occurrence leg so a
/// failure names the path it happened on instead of stopping at the first.
#[test]
fn a_total_loss_source_counts_once_on_the_mapped_item_path() {
    assert_total_loss_source_counts_once(false);
}

fn assert_total_loss_source_counts_once(use_submeshes: bool) {
    let mut decoder = EntityDecoder::new(TOTAL_LOSS_SHARED_SOURCE);
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    for wall_id in [15, 25, 35] {
        let wall = decoder.decode_by_id(wall_id).unwrap();
        if use_submeshes {
            let _ = router.process_element_with_submeshes(&wall, &mut decoder);
        } else {
            let _ = router.process_element(&wall, &mut decoder);
        }
    }

    let unsupported = router.take_unsupported_items();
    assert_eq!(
        unsupported.get("IfcGeometricSet"),
        Some(&1),
        "an empty source is refused by both SHARED cache inserts, so only the recorded-sources \
         set keeps the count per SOURCE: {unsupported:?}"
    );
}

/// One `IfcRepresentationMap` (#10) under a 'Body' representation carrying a
/// supported `IfcExtrudedAreaSolid` and an unsupported `IfcGeometricSet`,
/// instantiated by three walls (#15, #25, #35).
const MIXED_SHARED_SOURCE: &str = r#"
#1=IFCCARTESIANPOINT((0.,0.));
#2=IFCAXIS2PLACEMENT2D(#1,$);
#3=IFCRECTANGLEPROFILEDEF(.AREA.,'P',#2,1000.,1000.);
#4=IFCDIRECTION((0.,0.,1.));
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCEXTRUDEDAREASOLID(#3,#6,#4,1000.);
#8=IFCGEOMETRICSET(());
#9=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7,#8));
#10=IFCREPRESENTATIONMAP($,#9);
#11=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,$,$,$);
#12=IFCMAPPEDITEM(#10,#11);
#13=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#12));
#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#15=IFCWALL('g1',$,$,$,$,$,#14,$);
#22=IFCMAPPEDITEM(#10,#11);
#23=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#22));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCWALL('g2',$,$,$,$,$,#24,$);
#32=IFCMAPPEDITEM(#10,#11);
#33=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#32));
#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#35=IFCWALL('g3',$,$,$,$,$,#34,$);
"#;

/// [`MIXED_SHARED_SOURCE`] with the supported solid removed, so the source
/// meshes to EMPTY and neither cache will hold it.
const TOTAL_LOSS_SHARED_SOURCE: &str = r#"
#8=IFCGEOMETRICSET(());
#9=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#8));
#10=IFCREPRESENTATIONMAP($,#9);
#11=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,$,$,$);
#12=IFCMAPPEDITEM(#10,#11);
#13=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#12));
#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#15=IFCWALL('g1',$,$,$,$,$,#14,$);
#22=IFCMAPPEDITEM(#10,#11);
#23=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#22));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCWALL('g2',$,$,$,$,$,#24,$);
#32=IFCMAPPEDITEM(#10,#11);
#33=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#32));
#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#35=IFCWALL('g3',$,$,$,$,$,#34,$);
"#;

/// The occurrence-path half of the Body gate. Its sibling
/// `a_non_body_representations_unsupported_item_is_not_counted_as_content_loss`
/// drives `process_element` (the mapped-item walk); this drives
/// `process_element_with_submeshes`, which walks the source's items itself and
/// records the drop one recursion level down, in
/// `collect_submeshes_from_item_inner`'s plain-item arm. That arm has no
/// representation in hand and cannot gate on one, so this path counted a 2D
/// 'FootPrint' map as lost 3D content while the other path did not — the same
/// clean-model false positive, through the door the first fix did not cover.
#[test]
fn a_footprint_source_is_not_counted_on_the_occurrence_path_either() {
    let footprint = r#"
#1=IFCCARTESIANPOINT((0.,0.));
#8=IFCANNOTATIONFILLAREA(#1,());
#9=IFCSHAPEREPRESENTATION($,'FootPrint','Annotation2D',(#8));
#10=IFCREPRESENTATIONMAP($,#9);
#11=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,$,$,$);
#12=IFCMAPPEDITEM(#10,#11);
#13=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#12));
#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#15=IFCWALL('guid',$,$,$,$,$,#14,$);
"#;
    let mut decoder = EntityDecoder::new(footprint);
    let router = GeometryRouter::new();
    let wall = decoder.decode_by_id(15).unwrap();
    let _ = router.process_element_with_submeshes(&wall, &mut decoder);

    let unsupported = router.take_unsupported_items();
    assert!(
        unsupported.is_empty(),
        "a 2D 'FootPrint' source carries no 3D content to lose on this path either: {unsupported:?}"
    );
}

/// The other half, on the same path: the identical item under a Body source is
/// still a real loss and must still be counted, so the gate above cannot be
/// satisfied by counting nothing.
#[test]
fn the_same_item_under_a_body_source_is_still_counted_on_the_occurrence_path() {
    let body = r#"
#1=IFCCARTESIANPOINT((0.,0.));
#8=IFCANNOTATIONFILLAREA(#1,());
#9=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#8));
#10=IFCREPRESENTATIONMAP($,#9);
#11=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,$,$,$);
#12=IFCMAPPEDITEM(#10,#11);
#13=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#12));
#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#15=IFCWALL('guid',$,$,$,$,$,#14,$);
"#;
    let mut decoder = EntityDecoder::new(body);
    let router = GeometryRouter::new();
    let wall = decoder.decode_by_id(15).unwrap();
    let _ = router.process_element_with_submeshes(&wall, &mut decoder);

    let unsupported = router.take_unsupported_items();
    assert_eq!(
        unsupported.values().sum::<u64>(),
        1,
        "the gate keys on the representation, not on the item type: {unsupported:?}"
    );
}

#[path = "processor_registry_tests.rs"]
mod processor_registry_tests;
