// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for geometry processors.

use super::*;
use crate::router::GeometryProcessor;
use ifc_lite_core::{EntityDecoder, IfcSchema, IfcType};

/// Read a fixture under `tests/models/`, returning `None` and printing a
/// `pnpm fixtures` hint if the file isn't present yet — either because it's
/// missing on a fresh clone, or because it's still a leftover Git LFS
/// pointer from before the move to `tests/models/manifest.json`.
fn read_fixture(rel: &str) -> Option<String> {
    let path = format!("../../tests/models/{}", rel);
    match std::fs::read_to_string(&path) {
        Ok(s) if s.starts_with("version https://git-lfs.github.com/spec/") => {
            eprintln!(
                "skipping: fixture {} is still a Git LFS pointer — run `pnpm fixtures` from the repo root to download the real bytes",
                path,
            );
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping: fixture {} not present — run `pnpm fixtures` to download (sha256 in tests/models/manifest.json)",
                path,
            );
            None
        }
        Err(e) => panic!("failed to read fixture {}: {}", path, e),
    }
}

#[test]
fn test_advanced_brep_file() {
    use crate::router::GeometryRouter;

    let Some(content) = read_fixture("ifcopenshell/advanced_brep.ifc") else { return };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    // Process IFCBUILDINGELEMENTPROXY #181 which contains the AdvancedBrep geometry
    let element = decoder.decode_by_id(181).expect("Failed to decode element");
    assert_eq!(element.ifc_type, IfcType::IfcBuildingElementProxy);

    let mesh = router
        .process_element(&element, &mut decoder)
        .expect("Failed to process advanced brep");

    // Should produce geometry (B-spline surfaces tessellated)
    assert!(!mesh.is_empty(), "AdvancedBrep should produce geometry");
    assert!(
        mesh.positions.len() >= 3 * 100,
        "Should have significant geometry"
    );
    assert!(mesh.indices.len() >= 3 * 100, "Should have many triangles");
}

#[test]
fn test_extruded_area_solid() {
    let content = r#"
#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,100.0,200.0);
#2=IFCDIRECTION((0.0,0.0,1.0));
#3=IFCEXTRUDEDAREASOLID(#1,$,#2,300.0);
"#;

    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let processor = ExtrudedAreaSolidProcessor::new(schema.clone());

    let entity = decoder.decode_by_id(3).unwrap();
    let mesh = processor.process(&entity, &mut decoder, &schema).unwrap();

    assert!(!mesh.is_empty());
    assert!(!mesh.positions.is_empty());
    assert!(!mesh.indices.is_empty());
}

#[test]
fn test_triangulated_face_set() {
    let content = r#"
#1=IFCCARTESIANPOINTLIST3D(((0.0,0.0,0.0),(100.0,0.0,0.0),(50.0,100.0,0.0)));
#2=IFCTRIANGULATEDFACESET(#1,$,$,((1,2,3)),$);
"#;

    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let processor = TriangulatedFaceSetProcessor::new();

    let entity = decoder.decode_by_id(2).unwrap();
    let mesh = processor.process(&entity, &mut decoder, &schema).unwrap();

    assert_eq!(mesh.positions.len(), 9); // 3 vertices * 3 coordinates
    assert_eq!(mesh.indices.len(), 3); // 1 triangle
}

#[test]
fn test_boolean_result_with_half_space() {
    // Simplified version of the 764--column.ifc structure
    let content = r#"
#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,100.0,200.0);
#2=IFCDIRECTION((0.0,0.0,1.0));
#3=IFCEXTRUDEDAREASOLID(#1,$,#2,300.0);
#4=IFCCARTESIANPOINT((0.0,0.0,150.0));
#5=IFCDIRECTION((0.0,0.0,1.0));
#6=IFCAXIS2PLACEMENT3D(#4,#5,$);
#7=IFCPLANE(#6);
#8=IFCHALFSPACESOLID(#7,.T.);
#9=IFCBOOLEANRESULT(.DIFFERENCE.,#3,#8);
"#;

    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let processor = BooleanClippingProcessor::new();

    // First verify the entity types are parsed correctly
    let bool_result = decoder.decode_by_id(9).unwrap();
    println!("BooleanResult type: {:?}", bool_result.ifc_type);
    assert_eq!(bool_result.ifc_type, IfcType::IfcBooleanResult);

    let half_space = decoder.decode_by_id(8).unwrap();
    println!("HalfSpaceSolid type: {:?}", half_space.ifc_type);
    assert_eq!(half_space.ifc_type, IfcType::IfcHalfSpaceSolid);

    // Now process the boolean result
    let mesh = processor
        .process(&bool_result, &mut decoder, &schema)
        .unwrap();
    println!("Mesh vertices: {}", mesh.positions.len() / 3);
    println!("Mesh triangles: {}", mesh.indices.len() / 3);

    // The mesh should have geometry (base extrusion clipped)
    assert!(!mesh.is_empty(), "BooleanResult should produce geometry");
    assert!(!mesh.positions.is_empty());
}

#[test]
fn test_polygonal_bounded_half_space_respects_boundary() {
    let content = r#"
#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,10.0,4.0);
#2=IFCDIRECTION((0.0,0.0,1.0));
#3=IFCEXTRUDEDAREASOLID(#1,$,#2,5.0);
#4=IFCCARTESIANPOINT((-5.0,0.0));
#5=IFCCARTESIANPOINT((5.0,0.0));
#6=IFCCARTESIANPOINT((5.0,3.0));
#7=IFCCARTESIANPOINT((-5.0,3.0));
#8=IFCPOLYLINE((#4,#5,#6,#7,#4));
#9=IFCCARTESIANPOINT((0.0,0.0,5.0));
#10=IFCDIRECTION((0.0,1.0,0.0));
#11=IFCDIRECTION((1.0,0.0,0.0));
#12=IFCAXIS2PLACEMENT3D(#9,#10,#11);
#13=IFCPLANE(#12);
#14=IFCAXIS2PLACEMENT3D(#9,#10,#11);
#15=IFCPOLYGONALBOUNDEDHALFSPACE(#13,.F.,#14,#8);
#16=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#3,#15);
"#;

    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let processor = BooleanClippingProcessor::new();

    let entity = decoder.decode_by_id(16).unwrap();
    let mesh = processor.process(&entity, &mut decoder, &schema).unwrap();

    assert!(
        !mesh.is_empty(),
        "Bounded half-space should still produce geometry"
    );

    let mut has_outer_base = false;
    let mut has_outer_top = false;
    let mut has_clipped_top = false;

    for position in mesh.positions.chunks_exact(3) {
        let y = position[1] as f64;
        let z = position[2] as f64;

        if y > 1.9 && z < 0.1 {
            has_outer_base = true;
        }
        if y > 1.9 && z > 4.9 {
            has_outer_top = true;
        }
        if y.abs() < 0.1 && z > 4.9 {
            has_clipped_top = true;
        }
    }

    assert!(
        has_outer_base,
        "The polygon boundary should only clip the upper strip, not the whole wall side"
    );
    assert!(
        !has_outer_top,
        "The clipped strip should be removed at the top of the bounded region"
    );
    assert!(
        has_clipped_top,
        "The bounded clip should create a new top edge at the cut boundary"
    );
}

#[test]
fn test_764_column_file() {
    use crate::router::GeometryRouter;

    let Some(content) = read_fixture(
        "ifcopenshell/764--column--no-materials-or-surface-styles-found--augmented.ifc",
    ) else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    // Decode IFCCOLUMN #8930
    let column = decoder.decode_by_id(8930).expect("Failed to decode column");
    println!("Column type: {:?}", column.ifc_type);
    assert_eq!(column.ifc_type, IfcType::IfcColumn);

    // Check representation attribute
    let rep_attr = column
        .get(6)
        .expect("Column missing representation attribute");
    println!("Representation attr: {:?}", rep_attr);

    // Try process_element
    match router.process_element(&column, &mut decoder) {
        Ok(mesh) => {
            println!("Mesh vertices: {}", mesh.positions.len() / 3);
            println!("Mesh triangles: {}", mesh.indices.len() / 3);
            assert!(!mesh.is_empty(), "Column should produce geometry");
        }
        Err(e) => {
            panic!("Failed to process column: {:?}", e);
        }
    }
}

#[test]
fn test_wall_with_opening_file() {
    use crate::router::GeometryRouter;

    let Some(content) = read_fixture("buildingsmart/wall-with-opening-and-window.ifc") else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    // Decode IFCWALL #45
    let wall = match decoder.decode_by_id(45) {
        Ok(w) => w,
        Err(e) => panic!("Failed to decode wall: {:?}", e),
    };
    println!("Wall type: {:?}", wall.ifc_type);
    assert_eq!(wall.ifc_type, IfcType::IfcWall);

    // Check representation attribute (should be at index 6)
    let rep_attr = wall.get(6).expect("Wall missing representation attribute");
    println!("Representation attr: {:?}", rep_attr);

    // Try process_element
    match router.process_element(&wall, &mut decoder) {
        Ok(mesh) => {
            println!("Wall mesh vertices: {}", mesh.positions.len() / 3);
            println!("Wall mesh triangles: {}", mesh.indices.len() / 3);
            assert!(!mesh.is_empty(), "Wall should produce geometry");
        }
        Err(e) => {
            panic!("Failed to process wall: {:?}", e);
        }
    }

    // Also test window
    let window = decoder.decode_by_id(102).expect("Failed to decode window");
    println!("Window type: {:?}", window.ifc_type);
    assert_eq!(window.ifc_type, IfcType::IfcWindow);

    match router.process_element(&window, &mut decoder) {
        Ok(mesh) => {
            println!("Window mesh vertices: {}", mesh.positions.len() / 3);
            println!("Window mesh triangles: {}", mesh.indices.len() / 3);
        }
        Err(e) => {
            println!("Window error (might be expected): {:?}", e);
        }
    }
}

/// Test that ShellBasedSurfaceModel with IfcAdvancedFace produces geometry.
///
/// CATIA and similar NURBS-based CAD exporters produce SurfaceModel representations
/// containing IfcOpenShell with IfcAdvancedFace entities (B-spline surfaces, planes,
/// cylindrical surfaces). This test verifies the processor handles that correctly
/// instead of silently skipping the faces.
///
/// Addresses: https://github.com/louistrue/ifc-lite/issues/472
#[test]
fn test_shell_based_surface_model_with_advanced_faces() {
    // Minimal IFC snippet: ShellBasedSurfaceModel -> OpenShell -> AdvancedFace (planar)
    // This mimics the CATIA export pattern from issue #472
    let content = r#"
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((100.,0.,0.));
#3=IFCCARTESIANPOINT((100.,100.,0.));
#4=IFCCARTESIANPOINT((0.,100.,0.));
#5=IFCVERTEXPOINT(#1);
#6=IFCVERTEXPOINT(#2);
#7=IFCVERTEXPOINT(#3);
#8=IFCVERTEXPOINT(#4);
#9=IFCDIRECTION((0.,0.,1.));
#10=IFCDIRECTION((1.,0.,0.));
#11=IFCAXIS2PLACEMENT3D(#1,#9,#10);
#12=IFCPLANE(#11);
#13=IFCLINE(#1,#20);
#14=IFCLINE(#2,#21);
#15=IFCLINE(#3,#22);
#16=IFCLINE(#4,#23);
#20=IFCVECTOR(#24,1.);
#21=IFCVECTOR(#25,1.);
#22=IFCVECTOR(#26,1.);
#23=IFCVECTOR(#27,1.);
#24=IFCDIRECTION((1.,0.,0.));
#25=IFCDIRECTION((0.,1.,0.));
#26=IFCDIRECTION((-1.,0.,0.));
#27=IFCDIRECTION((0.,-1.,0.));
#30=IFCEDGECURVE(#5,#6,#13,.T.);
#31=IFCEDGECURVE(#6,#7,#14,.T.);
#32=IFCEDGECURVE(#7,#8,#15,.T.);
#33=IFCEDGECURVE(#8,#5,#16,.T.);
#40=IFCORIENTEDEDGE(*,*,#30,.T.);
#41=IFCORIENTEDEDGE(*,*,#31,.T.);
#42=IFCORIENTEDEDGE(*,*,#32,.T.);
#43=IFCORIENTEDEDGE(*,*,#33,.T.);
#50=IFCEDGELOOP((#40,#41,#42,#43));
#51=IFCFACEOUTERBOUND(#50,.T.);
#52=IFCADVANCEDFACE((#51),#12,.T.);
#53=IFCOPENSHELL((#52));
#54=IFCSHELLBASEDSURFACEMODEL((#53));
"#;

    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let processor = ShellBasedSurfaceModelProcessor::new();

    let entity = decoder.decode_by_id(54).unwrap();
    assert_eq!(entity.ifc_type, IfcType::IfcShellBasedSurfaceModel);

    let mesh = processor
        .process(&entity, &mut decoder, &schema)
        .expect("Failed to process ShellBasedSurfaceModel with AdvancedFace");

    // Should produce geometry from the planar AdvancedFace
    assert!(
        !mesh.is_empty(),
        "ShellBasedSurfaceModel with AdvancedFace should produce geometry"
    );
    assert!(
        mesh.positions.len() >= 12,
        "Should have at least 4 vertices (quad face): got {} floats",
        mesh.positions.len()
    );
    assert!(
        mesh.indices.len() >= 6,
        "Should have at least 2 triangles: got {} indices",
        mesh.indices.len()
    );
}

/// Test that ShellBasedSurfaceModel still works with simple PolyLoop faces
/// (regression test to ensure AdvancedFace support doesn't break simple faces)
#[test]
fn test_shell_based_surface_model_with_polyloop() {
    let content = r#"
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((100.,0.,0.));
#3=IFCCARTESIANPOINT((100.,100.,0.));
#4=IFCCARTESIANPOINT((0.,100.,0.));
#10=IFCPOLYLOOP((#1,#2,#3,#4));
#11=IFCFACEOUTERBOUND(#10,.T.);
#12=IFCFACE((#11));
#13=IFCOPENSHELL((#12));
#14=IFCSHELLBASEDSURFACEMODEL((#13));
"#;

    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let processor = ShellBasedSurfaceModelProcessor::new();

    let entity = decoder.decode_by_id(14).unwrap();
    let mesh = processor
        .process(&entity, &mut decoder, &schema)
        .expect("Failed to process ShellBasedSurfaceModel with PolyLoop");

    assert!(
        !mesh.is_empty(),
        "ShellBasedSurfaceModel with PolyLoop should still produce geometry"
    );
    assert_eq!(
        mesh.positions.len(),
        12,
        "Should have 4 vertices (12 floats)"
    );
    assert_eq!(mesh.indices.len(), 6, "Should have 2 triangles (6 indices)");
}

/// Test with the actual CATIA file from issue #472.
/// Verifies that all 306 AdvancedFaces (145 B-spline, 115 planar,
/// 38 linear extrusion, 8 cylindrical) produce geometry.
#[test]
fn test_catia_surface_model_file() {
    use crate::router::GeometryRouter;

    let path = "../../tests/models/various/2222.ifc";
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => {
            eprintln!("Skipping test_catia_surface_model_file: {} not found", path);
            return;
        }
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // IfcRamp #7963 has SurfaceModel with AdvancedFaces (B-spline, plane,
    // linear extrusion, cylindrical surfaces)
    let ramp = decoder.decode_by_id(7963).expect("Failed to decode IfcRamp #7963");
    assert_eq!(ramp.ifc_type, IfcType::IfcRamp);

    let mesh = router
        .process_element(&ramp, &mut decoder)
        .expect("Failed to process CATIA IfcRamp SurfaceModel");

    println!(
        "CATIA IfcRamp: {} vertices, {} triangles",
        mesh.positions.len() / 3,
        mesh.indices.len() / 3
    );

    // Should produce significant geometry from all surface types
    assert!(
        !mesh.is_empty(),
        "CATIA SurfaceModel should produce geometry"
    );
    assert!(
        mesh.positions.len() / 3 > 500,
        "Should have >500 vertices from AdvancedFaces, got {}",
        mesh.positions.len() / 3
    );
}

#[test]
fn test_triangulated_face_set_out_of_bounds_indices() {
    // Simulates a Revit export with indices beyond vertex count (issue #471)
    let content = r#"
#1=IFCCARTESIANPOINTLIST3D(((0.0,0.0,0.0),(100.0,0.0,0.0),(50.0,100.0,0.0)));
#2=IFCTRIANGULATEDFACESET(#1,$,$,((1,2,3),(1,2,99)),$);
"#;

    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let processor = TriangulatedFaceSetProcessor::new();

    let entity = decoder.decode_by_id(2).unwrap();
    let mesh = processor.process(&entity, &mut decoder, &schema).unwrap();

    // Should produce valid mesh — the out-of-bounds triangle (1,2,99) is stripped
    assert!(!mesh.is_empty());
    // Only 1 valid triangle should remain (indices 0,1,2)
    assert_eq!(mesh.indices.len(), 3, "Should have exactly 1 valid triangle");
    assert!(mesh.indices.iter().all(|&i| (i as usize) < mesh.positions.len() / 3));
}

#[test]
fn test_triangulated_face_set_all_invalid_indices() {
    // All indices are beyond vertex count — should produce empty mesh
    let content = r#"
#1=IFCCARTESIANPOINTLIST3D(((0.0,0.0,0.0),(1.0,0.0,0.0),(0.0,1.0,0.0)));
#2=IFCTRIANGULATEDFACESET(#1,$,$,((10,20,30)),$);
"#;

    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let processor = TriangulatedFaceSetProcessor::new();

    let entity = decoder.decode_by_id(2).unwrap();
    let mesh = processor.process(&entity, &mut decoder, &schema).unwrap();

    // All indices invalid — mesh should have positions but no valid triangles
    assert!(mesh.indices.is_empty(), "All invalid indices should be stripped");
}
