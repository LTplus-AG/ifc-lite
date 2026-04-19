// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::GeometryRouter;
use ifc_lite_core::EntityDecoder;

#[test]
fn test_router_creation() {
    let router = GeometryRouter::new();
    // Router registers default processors on creation
    assert!(!router.processors.is_empty());
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
    use crate::router::GeometryRouter;
    use crate::Point3;
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

    /// Test 2: Coordinate System Analysis
    ///
    /// Document and verify the three coordinate spaces:
    /// - IFC Profile Space: 2D (length, thickness) - chamfered footprint
    /// - Wall Face Space: 2D (length, height) - rectangular face where openings go
    /// - World Space: 3D (x, y, z)
    #[test]
    fn test_coordinate_system_analysis() {
        // IFC Profile Space (footprint, XY plane)
        // Represents wall footprint looking from above
        let footprint_profile = Profile2D::new(vec![
            Point2::new(0.3, -0.3), // chamfer
            Point2::new(9.7, -0.3), // chamfer
            Point2::new(10.0, 0.0), // corner
            Point2::new(0.0, 0.0),  // corner
        ]);
        // X = length (10m), Y = thickness (0.3m)

        // Wall Face Space (face, XZ plane)
        // Represents wall face looking from side - where openings are positioned
        let wall_face_profile = Profile2D::new(vec![
            Point2::new(0.0, 0.0),  // bottom-left
            Point2::new(10.0, 0.0), // bottom-right
            Point2::new(10.0, 2.7), // top-right
            Point2::new(0.0, 2.7),  // top-left
        ]);
        // X = length (10m), Z = height (2.7m) - NO CHAMFERS

        // Key insight: Chamfers exist only in footprint (XY), not in face (XZ)
        // The face is always rectangular because chamfers only affect horizontal edges

        // Verify both profiles have correct dimensions
        let footprint_bounds = footprint_profile.outer.iter().fold(
            (f64::MAX, f64::MAX, f64::MIN, f64::MIN),
            |(min_x, min_y, max_x, max_y), p| {
                (
                    min_x.min(p.x),
                    min_y.min(p.y),
                    max_x.max(p.x),
                    max_y.max(p.y),
                )
            },
        );

        let face_bounds = wall_face_profile.outer.iter().fold(
            (f64::MAX, f64::MAX, f64::MIN, f64::MIN),
            |(min_x, min_y, max_x, max_y), p| {
                (
                    min_x.min(p.x),
                    min_y.min(p.y),
                    max_x.max(p.x),
                    max_y.max(p.y),
                )
            },
        );

        let _footprint_bounds = footprint_bounds; // Suppress unused warning
        let _face_bounds = face_bounds;

        // Both should span same length (10m)
        assert!((footprint_bounds.2 - footprint_bounds.0 - 10.0).abs() < 0.01);
        assert!((face_bounds.2 - face_bounds.0 - 10.0).abs() < 0.01);

        // Footprint has thickness dimension (Y), face has height dimension (Z)
        // These are perpendicular - footprint is XY plane, face is XZ plane
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

    /// Test 5: Hybrid Approach - Plane Clipping
    ///
    /// Prototype using plane clipping instead of full 3D CSG.
    /// For rectangular openings, we can clip the chamfered wall mesh with
    /// 4 planes (top, bottom, left, right) instead of full CSG subtraction.
    #[test]
    fn test_hybrid_plane_clipping_approach() {
        use crate::csg::ClippingProcessor;

        // Start with chamfered wall mesh
        let chamfered_footprint = Profile2D::new(vec![
            Point2::new(0.3, -0.3),
            Point2::new(9.7, -0.3),
            Point2::new(10.0, 0.0),
            Point2::new(0.0, 0.0),
        ]);

        let chamfered_wall = extrude_profile(&chamfered_footprint, 2.7, None).unwrap();
        let initial_vertex_count = chamfered_wall.vertex_count();
        let initial_triangle_count = chamfered_wall.triangle_count();

        // Opening bounds in wall-face coordinates
        // Assuming wall is aligned: X = length (u), Z = height (v), Y = thickness
        let opening_min_u = 6.495;
        let opening_max_u = 8.495;
        let opening_min_v = 0.8;
        let opening_max_v = 2.0;

        // For plane clipping approach, we need to subtract a box defined by the opening
        // The opening is a rectangular prism cutting through the wall thickness
        // We can use subtract_box which is more efficient than individual plane clips

        let clipper = ClippingProcessor::new();

        // Define opening box in world coordinates
        // For a wall aligned with XZ plane (face), Y is thickness
        let opening_min = Point3::new(opening_min_u, -0.3, opening_min_v);
        let opening_max = Point3::new(opening_max_u, 0.0, opening_max_v);

        // Subtract the opening box from chamfered wall
        let result = clipper
            .subtract_box(&chamfered_wall, opening_min, opening_max)
            .unwrap();

        let final_vertex_count = result.vertex_count();
        let final_triangle_count = result.triangle_count();

        // Verify opening was cut
        assert!(final_vertex_count > initial_vertex_count);

        // Verify chamfers are preserved (mesh should still span full length)
        let (_min, max) = result.bounds();
        assert!((max.x - 10.0).abs() < 0.1); // Full length preserved

        // The hybrid approach should be more efficient than full CSG
        // but still generate reasonable geometry
        println!(
            "Hybrid approach: {} verts, {} tris (was {} verts, {} tris)",
            final_vertex_count, final_triangle_count, initial_vertex_count, initial_triangle_count
        );
    }

    /// Test 6: Benchmark Comparison
    ///
    /// Compare vertex and triangle counts between approaches:
    /// - Approach A: Chamfered footprint, no openings (baseline)
    /// - Approach B: 2D boolean + extrusion (loses chamfers)
    /// - Approach C: Hybrid plane clipping (preserves chamfers, efficient)
    #[test]
    fn test_benchmark_comparison() {
        use crate::csg::ClippingProcessor;

        // Test wall: 10m length, 0.3m thickness, 2.7m height
        // 3 openings: (1.2, 0.8) to (2.2, 2.0), (4.5, 0.8) to (5.5, 2.0), (7.8, 0.8) to (8.8, 2.0)

        // Approach A: Chamfered footprint (preserves chamfers, no openings)
        let chamfered_footprint = Profile2D::new(vec![
            Point2::new(0.3, -0.3),
            Point2::new(9.7, -0.3),
            Point2::new(10.0, 0.0),
            Point2::new(0.0, 0.0),
        ]);
        let mesh_a = extrude_profile(&chamfered_footprint, 2.7, None).unwrap();
        let verts_a = mesh_a.vertex_count();
        let tris_a = mesh_a.triangle_count();

        // Approach B: Rectangular face with openings (loses chamfers)
        let mut wall_face = Profile2D::new(vec![
            Point2::new(0.0, 0.0),
            Point2::new(10.0, 0.0),
            Point2::new(10.0, 2.7),
            Point2::new(0.0, 2.7),
        ]);
        wall_face.add_hole(vec![
            Point2::new(1.2, 0.8),
            Point2::new(2.2, 0.8),
            Point2::new(2.2, 2.0),
            Point2::new(1.2, 2.0),
        ]);
        wall_face.add_hole(vec![
            Point2::new(4.5, 0.8),
            Point2::new(5.5, 0.8),
            Point2::new(5.5, 2.0),
            Point2::new(4.5, 2.0),
        ]);
        wall_face.add_hole(vec![
            Point2::new(7.8, 0.8),
            Point2::new(8.8, 0.8),
            Point2::new(8.8, 2.0),
            Point2::new(7.8, 2.0),
        ]);
        let mesh_b = extrude_profile(&wall_face, 0.3, None).unwrap();
        let verts_b = mesh_b.vertex_count();
        let tris_b = mesh_b.triangle_count();

        // Approach C: Hybrid - chamfered wall with box subtraction
        let clipper = ClippingProcessor::new();
        let mut mesh_c = mesh_a.clone();

        // Subtract 3 opening boxes
        let openings = vec![
            (1.2, 0.8, 2.2, 2.0),
            (4.5, 0.8, 5.5, 2.0),
            (7.8, 0.8, 8.8, 2.0),
        ];

        for (min_u, min_v, max_u, max_v) in openings {
            let opening_min = Point3::new(min_u, -0.3, min_v);
            let opening_max = Point3::new(max_u, 0.0, max_v);
            mesh_c = clipper
                .subtract_box(&mesh_c, opening_min, opening_max)
                .unwrap();
        }

        let verts_c = mesh_c.vertex_count();
        let tris_c = mesh_c.triangle_count();

        // Document the comparison
        println!("\n=== Benchmark Comparison ===");
        println!(
            "Approach A (chamfered, no openings): {} verts, {} tris",
            verts_a, tris_a
        );
        println!(
            "Approach B (rectangular, with openings): {} verts, {} tris",
            verts_b, tris_b
        );
        println!(
            "Approach C (hybrid, chamfered + openings): {} verts, {} tris",
            verts_c, tris_c
        );
        println!("\nKey Insights:");
        println!("- Approach B loses chamfers (not acceptable)");
        println!("- Approach C preserves chamfers AND adds openings");
        println!(
            "- Approach C vertex count: {} (target: <200 for efficiency)",
            verts_c
        );

        // Approach B should have more vertices due to openings
        assert!(verts_b > verts_a);

        // Approach C should preserve chamfers (check bounds)
        let (_min_c, max_c) = mesh_c.bounds();
        assert!((max_c.x - 10.0).abs() < 0.1); // Full length preserved

        // Approach C should be more efficient than full 3D CSG
        // Current CSG generates ~650 verts for 3 openings
        // Target: ~150-200 verts
        assert!(
            verts_c < 700,
            "Hybrid approach should be more efficient than full CSG"
        );
    }

    /// Test 7: Optimized Implementation Benchmark
    ///
    /// Compare the new optimized plane-clipping approach with the CSG approach
    #[test]
    fn test_optimized_implementation_benchmark() {
        use crate::csg::ClippingProcessor;

        // Create chamfered wall
        let chamfered_footprint = Profile2D::new(vec![
            Point2::new(0.3, -0.3),
            Point2::new(9.7, -0.3),
            Point2::new(10.0, 0.0),
            Point2::new(0.0, 0.0),
        ]);
        let wall_mesh = extrude_profile(&chamfered_footprint, 2.7, None).unwrap();
        let initial_verts = wall_mesh.vertex_count();
        let initial_tris = wall_mesh.triangle_count();

        // Opening bounds
        let open_min = Point3::new(6.495, -0.3, 0.8);
        let open_max = Point3::new(8.495, 0.0, 2.0);

        // Get wall bounds for the optimized function
        let (wall_min_f32, wall_max_f32) = wall_mesh.bounds();
        let wall_min = Point3::new(
            wall_min_f32.x as f64,
            wall_min_f32.y as f64,
            wall_min_f32.z as f64,
        );
        let wall_max = Point3::new(
            wall_max_f32.x as f64,
            wall_max_f32.y as f64,
            wall_max_f32.z as f64,
        );

        // Test CSG approach (old)
        let clipper = ClippingProcessor::new();
        let csg_result = clipper
            .subtract_box(&wall_mesh, open_min, open_max)
            .unwrap();
        let csg_verts = csg_result.vertex_count();
        let csg_tris = csg_result.triangle_count();

        // Test optimized approach (new)
        let router = GeometryRouter::new();
        let opt_result = router.cut_rectangular_opening(&wall_mesh, open_min, open_max);
        let opt_verts = opt_result.vertex_count();
        let opt_tris = opt_result.triangle_count();

        println!("\n=== Optimized vs CSG Comparison ===");
        println!(
            "Initial wall: {} verts, {} tris",
            initial_verts, initial_tris
        );
        println!("CSG approach: {} verts, {} tris", csg_verts, csg_tris);
        println!("Optimized approach: {} verts, {} tris", opt_verts, opt_tris);

        // Both should produce valid geometry
        assert!(csg_result.vertex_count() > 0);
        assert!(opt_result.vertex_count() > 0);

        // Check bounds are preserved
        let (_csg_min, csg_max) = csg_result.bounds();
        let (_opt_min, opt_max) = opt_result.bounds();

        // Both should preserve chamfers (full length)
        assert!((csg_max.x - 10.0).abs() < 0.1);
        assert!((opt_max.x - 10.0).abs() < 0.1);
    }

    /// Test 8: Chamfer Preservation Analysis
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
/// Regression test for <https://github.com/louistrue/ifc-lite/issues/335>.
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
        let delta_z = offset_a.2 - offset_b.2;

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
