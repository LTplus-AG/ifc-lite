// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! CSG void subtraction tests using inline IFC content.
//! These tests verify that opening subtraction works correctly.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{csg::ClippingProcessor, GeometryRouter, Mesh};

/// Create a simple slab with a rectangular opening for testing
fn create_slab_with_opening_ifc() -> String {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'SlabProfile',#31,4.0,3.0);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,0.3);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCSLAB('0001234567890123456789',#2,'TestSlab',$,$,#20,#51,'Test',.FLOOR.);
#110=IFCLOCALPLACEMENT(#20,#111);
#111=IFCAXIS2PLACEMENT3D(#112,#113,#114);
#112=IFCCARTESIANPOINT((0.5,0.5,0.));
#113=IFCDIRECTION((0.,0.,1.));
#114=IFCDIRECTION((1.,0.,0.));
#120=IFCRECTANGLEPROFILEDEF(.AREA.,'OpeningProfile',#121,1.0,1.0);
#121=IFCAXIS2PLACEMENT2D(#122,#123);
#122=IFCCARTESIANPOINT((0.,0.));
#123=IFCDIRECTION((1.,0.));
#130=IFCEXTRUDEDAREASOLID(#120,#131,#132,0.5);
#131=IFCAXIS2PLACEMENT3D(#133,$,$);
#132=IFCDIRECTION((0.,0.,1.));
#133=IFCCARTESIANPOINT((0.,0.,-0.1));
#140=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#130));
#141=IFCPRODUCTDEFINITIONSHAPE($,$,(#140));
#200=IFCOPENINGELEMENT('0001234567890123456790',#2,'TestOpening',$,$,#110,#141,$,.OPENING.);
#300=IFCRELVOIDSELEMENT('0001234567890123456791',#2,$,$,#100,#200);
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

/// Test that CSG subtraction produces valid geometry
#[test]
fn test_csg_void_subtraction_basic() {
    let content = create_slab_with_opening_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Get the slab entity (#100)
    let slab = decoder.decode_by_id(100).expect("Failed to decode slab");
    let slab_mesh = router
        .process_element(&slab, &mut decoder)
        .expect("Failed to process slab");

    // Get the opening entity (#200)
    let opening = decoder.decode_by_id(200).expect("Failed to decode opening");
    let opening_mesh = router
        .process_element(&opening, &mut decoder)
        .expect("Failed to process opening");

    // Both meshes should have geometry
    assert!(!slab_mesh.is_empty(), "Slab mesh should not be empty");
    assert!(!opening_mesh.is_empty(), "Opening mesh should not be empty");

    // Perform CSG subtraction
    let clipper = ClippingProcessor::new();
    let result = clipper.subtract_mesh(&slab_mesh, &opening_mesh);

    match result {
        Ok(result_mesh) => {
            // Result should have valid geometry
            assert!(!result_mesh.is_empty(), "CSG result should not be empty");

            // Positions and normals must be non-empty
            assert!(
                !result_mesh.positions.is_empty(),
                "Result mesh positions should not be empty"
            );
            assert!(
                !result_mesh.normals.is_empty(),
                "Result mesh normals should not be empty"
            );

            // Normals and positions should have matching lengths (per-vertex normals)
            assert_eq!(
                result_mesh.normals.len(),
                result_mesh.positions.len(),
                "Normals and positions should have matching lengths"
            );

            // All positions should be finite
            assert!(
                result_mesh.positions.iter().all(|v| v.is_finite()),
                "All positions should be finite"
            );

            // All normals should be finite
            assert!(
                result_mesh.normals.iter().all(|v| v.is_finite()),
                "All normals should be finite"
            );

            // Bounds should be reasonable (within original slab bounds)
            let (slab_min, slab_max) = slab_mesh.bounds();
            let (result_min, result_max) = result_mesh.bounds();

            assert!(
                result_min.x >= slab_min.x - 0.01 && result_max.x <= slab_max.x + 0.01,
                "Result X bounds should be within slab bounds"
            );
            assert!(
                result_min.y >= slab_min.y - 0.01 && result_max.y <= slab_max.y + 0.01,
                "Result Y bounds should be within slab bounds"
            );
        }
        Err(e) => {
            // CSG can fail for some edge cases, but we should at least get the original mesh back
            panic!("CSG subtraction failed: {}", e);
        }
    }
}

/// Test that meshes can be merged correctly
#[test]
fn test_mesh_merge() {
    let content = create_slab_with_opening_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Get slab mesh
    let slab = decoder.decode_by_id(100).expect("Failed to decode slab");
    let slab_mesh = router
        .process_element(&slab, &mut decoder)
        .expect("Failed to process slab");

    // Get opening mesh
    let opening = decoder.decode_by_id(200).expect("Failed to decode opening");
    let opening_mesh = router
        .process_element(&opening, &mut decoder)
        .expect("Failed to process opening");

    // Merge meshes
    let mut combined = Mesh::new();
    combined.merge(&slab_mesh);
    combined.merge(&opening_mesh);

    // Combined should have both meshes' triangles
    assert_eq!(
        combined.triangle_count(),
        slab_mesh.triangle_count() + opening_mesh.triangle_count(),
        "Combined mesh should have sum of triangles"
    );
}

/// Wall (4m × 0.3m × 2.5m) with an IfcOpeningElement whose SweptArea is a
/// trapezoid (5 corners). Vertex count is well under 100, which used to
/// trip `classify_openings` into picking the rectangular AABB path and
/// cutting a cuboid hole instead of the actual trapezoid — producing
/// visibly oversized voids ("cutting voids sometimes misses the right
/// shape", issue #547).
fn wall_with_trapezoid_opening_ifc() -> String {
    // Trapezoid polyline points: narrow top, wide bottom.
    //   (-0.5,-1.0) → ( 0.5,-1.0) → ( 0.3, 1.0) → (-0.3, 1.0) → close.
    // Extruded 0.3 m along +Z (opening's local Z), placed inside the wall
    // so the opening bridges it. The opening's world placement rotates
    // its local Z to world Y so the opening cuts through the wall's Y
    // thickness.
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'WallProfile',#31,4.0,0.3);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,2.5);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',#2,'TestWall',$,$,#20,#51,'Test',$);
#110=IFCLOCALPLACEMENT(#20,#111);
#111=IFCAXIS2PLACEMENT3D(#112,#113,#114);
#112=IFCCARTESIANPOINT((0.,-0.5,1.0));
#113=IFCDIRECTION((0.,1.,0.));
#114=IFCDIRECTION((1.,0.,0.));
#120=IFCCARTESIANPOINT((-0.5,-1.0));
#121=IFCCARTESIANPOINT((0.5,-1.0));
#122=IFCCARTESIANPOINT((0.3,1.0));
#123=IFCCARTESIANPOINT((-0.3,1.0));
#124=IFCPOLYLINE((#120,#121,#122,#123,#120));
#125=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'TrapezoidOpening',#124);
#130=IFCEXTRUDEDAREASOLID(#125,#131,#132,0.6);
#131=IFCAXIS2PLACEMENT3D(#133,$,$);
#132=IFCDIRECTION((0.,0.,1.));
#133=IFCCARTESIANPOINT((0.,0.,0.));
#140=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#130));
#141=IFCPRODUCTDEFINITIONSHAPE($,$,(#140));
#200=IFCOPENINGELEMENT('0001234567890123456790',#2,'TestOpening',$,$,#110,#141,$,.OPENING.);
#300=IFCRELVOIDSELEMENT('0001234567890123456791',#2,$,$,#100,#200);
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

/// Regression test for issue #547: a low-tessellation non-rectangular
/// opening (trapezoid extrusion) used to be classified as rectangular
/// purely because its vertex count fell below the 100-vertex threshold.
/// The AABB cut removed the trapezoid's entire bounding rectangle from
/// the wall, so the voided wall was missing material outside the actual
/// trapezoid — visible as oversized voids around windows/doors.
///
/// The opening's trapezoid (after placement) spans world
///   x ∈ [-0.5, 0.5] at z = 2.0 (wide top)
///   x ∈ [-0.3, 0.3] at z = 0.0 (narrow bottom)
/// so at z ≈ 0.3 the actual opening only reaches |x| ≲ 0.33 but the
/// AABB cut would have cleared material all the way to |x| = 0.5.
#[test]
fn non_rectangular_opening_does_not_over_cut_wall() {
    use ifc_lite_geometry::GeometryRouter;
    use rustc_hash::FxHashMap;

    let content = wall_with_trapezoid_opening_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    void_index.insert(100, vec![200]);

    let voided = router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("wall with voids");
    assert!(!voided.is_empty(), "voided wall must have geometry");

    // The trapezoid's narrow edge (z ≈ 0) only reaches x ∈ [-0.3, 0.3].
    // A true trapezoid cut introduces boundary vertices at (±0.3, ±0.15, 0).
    // An AABB cut would instead carve the bounding box [-0.5, 0.5] × [0, 2]
    // and put its narrow-end boundary vertices at x ≈ ±0.5. Finding vertices
    // at (±0.3, ±0.15, 0) proves the cut respected the trapezoid shape.
    let mut narrow_edge_vertices = 0usize;
    for chunk in voided.positions.chunks_exact(3) {
        let x = chunk[0];
        let y = chunk[1];
        let z = chunk[2];
        let on_face = y.abs() > 0.14 && z.abs() < 0.01;
        if on_face && (x.abs() - 0.3).abs() < 0.01 {
            narrow_edge_vertices += 1;
        }
    }

    assert!(
        narrow_edge_vertices > 0,
        "trapezoid cut must introduce boundary vertices at (±0.3, ±0.15, 0) — \
         the narrow end of the opening. The opening was cut as its AABB \
         (bounding rectangle) instead of its trapezoid shape."
    );
}

/// Build a long wall with `n` tessellated-box openings (each a rectangle
/// polyline with a collinear midpoint on its long edges, so the opening
/// mesh has extra non-corner vertices). Openings are spaced so they do
/// not merge.
fn long_wall_with_many_tessellated_openings(n: usize) -> String {
    let mut s = String::new();
    s.push_str(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'WallProfile',#31,100.0,0.3);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,2.5);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',#2,'TestWall',$,$,#20,#51,'Test',$);
"#,
    );

    // Opening template: tessellated 1m × 1m × 0.6m box centred on wall
    // thickness, with a midpoint on each long edge of the swept profile
    // so the mesh has extra face-interior vertices.
    let mut rel_voids = String::new();
    for i in 0..n {
        let base = 1000 + i as u32 * 20;
        let pl = base;
        let ap = base + 1;
        let lr = base + 2;
        let lp = base + 3;
        let p_a = base + 4;
        let p_b = base + 5;
        let p_c = base + 6;
        let p_d = base + 7;
        let p_e = base + 8;
        let p_f = base + 9;
        let line = base + 10;
        let prof = base + 11;
        let solid = base + 12;
        let sap = base + 13;
        let sloc = base + 14;
        let rep = base + 15;
        let pds = base + 16;
        let opening = base + 17;
        let rel = base + 18;

        // Openings start at x = -45 and step by 5 metres
        let cx = -45.0 + (i as f64) * 5.0;
        s.push_str(&format!(
            "#{pl}=IFCLOCALPLACEMENT(#20,#{ap});\n\
             #{ap}=IFCAXIS2PLACEMENT3D(#{lr},#{lp},#24);\n\
             #{lr}=IFCCARTESIANPOINT(({cx},-0.5,1.0));\n\
             #{lp}=IFCDIRECTION((0.,1.,0.));\n\
             #{p_a}=IFCCARTESIANPOINT((-0.5,-1.0));\n\
             #{p_b}=IFCCARTESIANPOINT((0.,-1.0));\n\
             #{p_c}=IFCCARTESIANPOINT((0.5,-1.0));\n\
             #{p_d}=IFCCARTESIANPOINT((0.5,1.0));\n\
             #{p_e}=IFCCARTESIANPOINT((0.,1.0));\n\
             #{p_f}=IFCCARTESIANPOINT((-0.5,1.0));\n\
             #{line}=IFCPOLYLINE((#{p_a},#{p_b},#{p_c},#{p_d},#{p_e},#{p_f},#{p_a}));\n\
             #{prof}=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'Tess',#{line});\n\
             #{solid}=IFCEXTRUDEDAREASOLID(#{prof},#{sap},#42,0.6);\n\
             #{sap}=IFCAXIS2PLACEMENT3D(#{sloc},$,$);\n\
             #{sloc}=IFCCARTESIANPOINT((0.,0.,0.));\n\
             #{rep}=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#{solid}));\n\
             #{pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));\n\
             #{opening}=IFCOPENINGELEMENT('{guid:022}',#2,'Op{i}',$,$,#{pl},#{pds},$,.OPENING.);\n",
            guid = i,
        ));
        rel_voids.push_str(&format!(
            "#{rel}=IFCRELVOIDSELEMENT('{guid:021}V',#2,$,$,#100,#{opening});\n",
            guid = i,
        ));
    }

    s.push_str(&rel_voids);
    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

/// With many tessellated-box openings on one wall, every opening must
/// be cut. If `mesh_fills_axis_aligned_box` rejected tessellated boxes,
/// all of them would route to CSG and the `MAX_CSG_OPERATIONS = 10`
/// cap inside `apply_void_context` would silently skip the 11th+
/// openings — leaving uncut wall at their positions.
#[test]
fn many_tessellated_box_openings_are_all_cut() {
    use ifc_lite_geometry::GeometryRouter;
    use rustc_hash::FxHashMap;

    const N: usize = 15;
    let content = long_wall_with_many_tessellated_openings(N);
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let opening_ids: Vec<u32> = (0..N).map(|i| 1000 + i as u32 * 20 + 17).collect();
    void_index.insert(100, opening_ids);

    let voided = router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("wall with voids");

    // Each opening is at x = -45 + 5·i, y-range [-0.5, 0.1], z-range [0, 2],
    // so the wall front face (y = -0.15) should have NO triangle whose
    // centroid falls inside any opening's AABB footprint. Skipped CSG
    // cuts would leave the original wall face intact, so at least one
    // triangle centroid would land inside the skipped opening.
    let centroid = |chunk: &[u32]| {
        let p = |i: u32| {
            let idx = i as usize * 3;
            (
                voided.positions[idx],
                voided.positions[idx + 1],
                voided.positions[idx + 2],
            )
        };
        let (a, b, c) = (p(chunk[0]), p(chunk[1]), p(chunk[2]));
        (
            (a.0 + b.0 + c.0) / 3.0,
            (a.1 + b.1 + c.1) / 3.0,
            (a.2 + b.2 + c.2) / 3.0,
        )
    };

    for i in 0..N {
        let cx = -45.0 + (i as f64) * 5.0;
        let mut covering_triangles = 0usize;
        for tri in voided.indices.chunks_exact(3) {
            let (cxt, cyt, czt) = centroid(tri);
            // Shrink opening bounds slightly to avoid boundary
            // triangles that are legitimately on the hole's edge.
            let margin = 0.05_f32;
            let x_in = (cxt as f64) > cx - 0.5 + margin as f64
                && (cxt as f64) < cx + 0.5 - margin as f64;
            let z_in = czt > 0.0 + margin && czt < 2.0 - margin;
            let on_front = (cyt + 0.15).abs() < 0.02;
            if on_front && x_in && z_in {
                covering_triangles += 1;
            }
        }
        assert_eq!(
            covering_triangles, 0,
            "opening #{i} (x centre {cx:.1}) has {covering_triangles} wall-front \
             triangles inside its footprint — the cut was skipped (likely due to \
             CSG budget exhaustion from misrouting tessellated boxes to CSG)."
        );
    }
}

/// Test mesh bounds calculation
#[test]
fn test_mesh_bounds() {
    let content = create_slab_with_opening_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Get slab mesh (4m x 3m x 0.3m slab)
    let slab = decoder.decode_by_id(100).expect("Failed to decode slab");
    let slab_mesh = router
        .process_element(&slab, &mut decoder)
        .expect("Failed to process slab");

    let (min, max) = slab_mesh.bounds();

    // Slab should be approximately 4m x 3m x 0.3m
    let width = max.x - min.x;
    let depth = max.y - min.y;
    let height = max.z - min.z;

    assert!(
        (width - 4.0).abs() < 0.1,
        "Slab width should be ~4m, got {:.2}",
        width
    );
    assert!(
        (depth - 3.0).abs() < 0.1,
        "Slab depth should be ~3m, got {:.2}",
        depth
    );
    assert!(
        (height - 0.3).abs() < 0.1,
        "Slab height should be ~0.3m, got {:.2}",
        height
    );
}
