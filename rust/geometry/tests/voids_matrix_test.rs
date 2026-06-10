// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Consolidated void-subtraction test matrix.
//!
//! Merges the former `csg_void_test.rs`, `submesh_voids_test.rs` and
//! `production_void_path_test.rs` into table-driven suites. Every input
//! configuration and assertion from the three originals is preserved:
//!
//! * [`inline_void_matrix`] — inline-IFC configs driven through
//!   `process_element_with_voids`, with shared structural invariants plus
//!   per-case checks (direct CSG subtraction, mesh merge/bounds, the
//!   issue #547 trapezoid over-cut regression, and the CSG-budget
//!   regression for many tessellated-box openings).
//! * [`submesh_void_matrix`] — `process_element_with_submeshes_and_voids`
//!   preserves per-item geometry IDs (per-layer `IfcStyledItem` colors)
//!   while still cutting openings through every material layer.
//! * [`production_fixture_walls_have_holes`] /
//!   [`production_smiley_all_host_walls_have_holes`] — end-to-end
//!   fixture reproductions of issues #604 and #584 that mimic the exact
//!   `IfcAPI::process_geometry_batch` path and ray-cast through opening
//!   footprints. These soft-skip when `tests/models` fixtures are absent.

use ifc_lite_core::{EntityDecoder, EntityScanner};
use ifc_lite_geometry::{
    csg::ClippingProcessor, propagate_voids_to_parts, GeometryRouter, Mesh, SubMeshCollection,
};
use rustc_hash::FxHashMap;
use std::fs;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Inline IFC fixtures
// ---------------------------------------------------------------------------

/// Simple slab (4m × 3m × 0.3m) with a rectangular opening.
fn slab_with_opening_ifc() -> String {
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

/// Three-layer wall (3× `IfcExtrudedAreaSolid` in one `IfcShapeRepresentation`)
/// with one `IfcOpeningElement` linked via `IfcRelVoidsElement`.
///
/// The opening cuts through all three layers so every sub-mesh must lose
/// triangles after CSG — a regression guard against the single-mesh
/// void path that collapsed per-layer identity.
fn multi_layer_wall_with_opening_ifc() -> String {
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
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'Layer1',#31,4.0,0.1);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,3.0);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCRECTANGLEPROFILEDEF(.AREA.,'Layer2',#51,4.0,0.1);
#51=IFCAXIS2PLACEMENT2D(#52,#53);
#52=IFCCARTESIANPOINT((0.,0.));
#53=IFCDIRECTION((1.,0.));
#60=IFCEXTRUDEDAREASOLID(#50,#61,#62,3.0);
#61=IFCAXIS2PLACEMENT3D(#63,$,$);
#62=IFCDIRECTION((0.,0.,1.));
#63=IFCCARTESIANPOINT((0.,0.1,0.));
#70=IFCRECTANGLEPROFILEDEF(.AREA.,'Layer3',#71,4.0,0.1);
#71=IFCAXIS2PLACEMENT2D(#72,#73);
#72=IFCCARTESIANPOINT((0.,0.));
#73=IFCDIRECTION((1.,0.));
#80=IFCEXTRUDEDAREASOLID(#70,#81,#82,3.0);
#81=IFCAXIS2PLACEMENT3D(#83,$,$);
#82=IFCDIRECTION((0.,0.,1.));
#83=IFCCARTESIANPOINT((0.,0.2,0.));
#90=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40,#60,#80));
#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#90));
#100=IFCWALL('0001234567890123456789',#2,'TestWall',$,$,#20,#91,'Test',$);
#110=IFCLOCALPLACEMENT(#20,#111);
#111=IFCAXIS2PLACEMENT3D(#112,#113,#114);
#112=IFCCARTESIANPOINT((1.5,0.1,0.5));
#113=IFCDIRECTION((0.,0.,1.));
#114=IFCDIRECTION((1.,0.,0.));
#120=IFCRECTANGLEPROFILEDEF(.AREA.,'OpeningProfile',#121,1.0,0.5);
#121=IFCAXIS2PLACEMENT2D(#122,#123);
#122=IFCCARTESIANPOINT((0.,0.));
#123=IFCDIRECTION((1.,0.));
#130=IFCEXTRUDEDAREASOLID(#120,#131,#132,1.5);
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

// ---------------------------------------------------------------------------
// Inline matrix: configs driven through `process_element_with_voids`
// ---------------------------------------------------------------------------

/// Context handed to each case's extra check.
struct InlineCtx<'a> {
    content: &'a str,
    uncut: &'a Mesh,
    voided: &'a Mesh,
}

struct InlineCase {
    name: &'static str,
    /// Returns (IFC content, host express ID, opening express IDs).
    build: fn() -> (String, u32, Vec<u32>),
    /// Case-specific invariant beyond the shared structural checks.
    check: fn(&InlineCtx),
}

/// Shared structural invariants every voided result must satisfy.
fn assert_structural_invariants(name: &str, uncut: &Mesh, voided: &Mesh) {
    assert!(!uncut.is_empty(), "[{name}] host mesh should not be empty");
    assert!(
        !voided.is_empty(),
        "[{name}] voided mesh should not be empty"
    );
    assert!(
        !voided.positions.is_empty(),
        "[{name}] voided positions should not be empty"
    );
    assert!(
        !voided.normals.is_empty(),
        "[{name}] voided normals should not be empty"
    );
    assert_eq!(
        voided.normals.len(),
        voided.positions.len(),
        "[{name}] normals and positions should have matching lengths"
    );
    assert!(
        voided.positions.iter().all(|v| v.is_finite()),
        "[{name}] all positions should be finite"
    );
    assert!(
        voided.normals.iter().all(|v| v.is_finite()),
        "[{name}] all normals should be finite"
    );

    // The cut only removes material — bounds must stay within the host's.
    let (host_min, host_max) = uncut.bounds();
    let (cut_min, cut_max) = voided.bounds();
    assert!(
        cut_min.x >= host_min.x - 0.01 && cut_max.x <= host_max.x + 0.01,
        "[{name}] voided X bounds should be within host bounds"
    );
    assert!(
        cut_min.y >= host_min.y - 0.01 && cut_max.y <= host_max.y + 0.01,
        "[{name}] voided Y bounds should be within host bounds"
    );
}

/// Former `test_csg_void_subtraction_basic` + `test_mesh_merge` +
/// `test_mesh_bounds`: direct `ClippingProcessor::subtract_mesh` on the
/// slab/opening pair, mesh merge triangle accounting, and slab bounds.
fn check_slab_direct_subtract_merge_bounds(ctx: &InlineCtx) {
    let mut decoder = EntityDecoder::new(ctx.content);
    let router = GeometryRouter::with_units(ctx.content, &mut decoder);

    let slab = decoder.decode_by_id(100).expect("Failed to decode slab");
    let slab_mesh = router
        .process_element(&slab, &mut decoder)
        .expect("Failed to process slab");
    let opening = decoder.decode_by_id(200).expect("Failed to decode opening");
    let opening_mesh = router
        .process_element(&opening, &mut decoder)
        .expect("Failed to process opening");

    assert!(!slab_mesh.is_empty(), "Slab mesh should not be empty");
    assert!(!opening_mesh.is_empty(), "Opening mesh should not be empty");

    // --- Slab bounds: approximately 4m × 3m × 0.3m ---
    let (min, max) = slab_mesh.bounds();
    let width = max.x - min.x;
    let depth = max.y - min.y;
    let height = max.z - min.z;
    assert!(
        (width - 4.0).abs() < 0.1,
        "Slab width should be ~4m, got {width:.2}"
    );
    assert!(
        (depth - 3.0).abs() < 0.1,
        "Slab depth should be ~3m, got {depth:.2}"
    );
    assert!(
        (height - 0.3).abs() < 0.1,
        "Slab height should be ~0.3m, got {height:.2}"
    );

    // --- Direct CSG subtraction ---
    let clipper = ClippingProcessor::new();
    let result_mesh = clipper
        .subtract_mesh(&slab_mesh, &opening_mesh)
        .unwrap_or_else(|e| panic!("CSG subtraction failed: {e}"));

    assert!(!result_mesh.is_empty(), "CSG result should not be empty");
    assert!(
        !result_mesh.positions.is_empty(),
        "Result mesh positions should not be empty"
    );
    assert!(
        !result_mesh.normals.is_empty(),
        "Result mesh normals should not be empty"
    );
    assert_eq!(
        result_mesh.normals.len(),
        result_mesh.positions.len(),
        "Normals and positions should have matching lengths"
    );
    assert!(
        result_mesh.positions.iter().all(|v| v.is_finite()),
        "All positions should be finite"
    );
    assert!(
        result_mesh.normals.iter().all(|v| v.is_finite()),
        "All normals should be finite"
    );
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

    // --- Mesh merge triangle accounting ---
    let mut combined = Mesh::new();
    combined.merge(&slab_mesh);
    combined.merge(&opening_mesh);
    assert_eq!(
        combined.triangle_count(),
        slab_mesh.triangle_count() + opening_mesh.triangle_count(),
        "Combined mesh should have sum of triangles"
    );
}

/// Regression check for issue #547: a low-tessellation non-rectangular
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
fn check_trapezoid_not_overcut(ctx: &InlineCtx) {
    // The trapezoid's narrow edge (z ≈ 0) only reaches x ∈ [-0.3, 0.3].
    // A true trapezoid cut introduces boundary vertices at (±0.3, ±0.15, 0).
    // An AABB cut would instead carve the bounding box [-0.5, 0.5] × [0, 2]
    // and put its narrow-end boundary vertices at x ≈ ±0.5. Finding vertices
    // at (±0.3, ±0.15, 0) proves the cut respected the trapezoid shape.
    let mut narrow_edge_vertices = 0usize;
    for chunk in ctx.voided.positions.chunks_exact(3) {
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

/// With many tessellated-box openings on one wall, every opening must
/// be cut. If `mesh_fills_axis_aligned_box` rejected tessellated boxes,
/// all of them would route to CSG and the `MAX_CSG_OPERATIONS = 10`
/// cap inside `apply_void_context` would silently skip the 11th+
/// openings — leaving uncut wall at their positions.
fn check_all_tessellated_openings_cut(ctx: &InlineCtx) {
    const N: usize = 15;
    let voided = ctx.voided;

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
            let x_in =
                (cxt as f64) > cx - 0.5 + margin as f64 && (cxt as f64) < cx + 0.5 - margin as f64;
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

#[test]
fn inline_void_matrix() {
    let cases = [
        InlineCase {
            name: "slab_with_rect_opening__direct_subtract_merge_bounds",
            build: || (slab_with_opening_ifc(), 100, vec![200]),
            check: check_slab_direct_subtract_merge_bounds,
        },
        InlineCase {
            name: "wall_with_trapezoid_opening__issue_547_no_aabb_overcut",
            build: || (wall_with_trapezoid_opening_ifc(), 100, vec![200]),
            check: check_trapezoid_not_overcut,
        },
        InlineCase {
            name: "long_wall_15_tessellated_openings__no_csg_budget_skip",
            build: || {
                const N: usize = 15;
                let opening_ids = (0..N).map(|i| 1000 + i as u32 * 20 + 17).collect();
                (
                    long_wall_with_many_tessellated_openings(N),
                    100,
                    opening_ids,
                )
            },
            check: check_all_tessellated_openings_cut,
        },
    ];

    for case in &cases {
        let (content, host_id, opening_ids) = (case.build)();
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::with_units(&content, &mut decoder);

        let host = decoder
            .decode_by_id(host_id)
            .unwrap_or_else(|e| panic!("[{}] decode host: {e:?}", case.name));
        let uncut = router
            .process_element(&host, &mut decoder)
            .unwrap_or_else(|e| panic!("[{}] process host: {e:?}", case.name));

        let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        void_index.insert(host_id, opening_ids);
        let voided = router
            .process_element_with_voids(&host, &mut decoder, &void_index)
            .unwrap_or_else(|e| panic!("[{}] process host with voids: {e:?}", case.name));

        assert_structural_invariants(case.name, &uncut, &voided);
        (case.check)(&InlineCtx {
            content: &content,
            uncut: &uncut,
            voided: &voided,
        });
    }
}

// ---------------------------------------------------------------------------
// Sub-mesh matrix: per-item identity through the void path
// ---------------------------------------------------------------------------

struct SubmeshCase {
    name: &'static str,
    /// Openings to register for wall #100 (empty = no voids apply).
    opening_ids: &'static [u32],
    check: fn(name: &str, uncut: &SubMeshCollection, cut: &SubMeshCollection),
}

/// Former `submeshes_with_voids_preserves_one_mesh_per_extrusion_item` +
/// `submeshes_with_voids_actually_removes_triangles`.
fn check_submesh_ids_preserved_and_triangles_removed(
    name: &str,
    uncut: &SubMeshCollection,
    cut: &SubMeshCollection,
) {
    // All three extrusion items must survive — the opening only removes a
    // local block, not an entire layer.
    assert_eq!(
        cut.sub_meshes.len(),
        3,
        "[{name}] expected 3 sub-meshes (one per extrusion layer), got {}",
        cut.sub_meshes.len()
    );

    // Each sub-mesh must carry the original IfcExtrudedAreaSolid express ID
    // so that callers can look up the per-item IfcStyledItem color. This is
    // the entire point of the per-sub-mesh void path: layer colors survive.
    let mut ids: Vec<u32> = cut.sub_meshes.iter().map(|s| s.geometry_id).collect();
    ids.sort();
    assert_eq!(
        ids,
        vec![40, 60, 80],
        "[{name}] sub-mesh geometry_ids must match extrusion IDs"
    );

    for sub in &cut.sub_meshes {
        assert!(
            !sub.mesh.is_empty(),
            "[{name}] sub-mesh #{} should not be empty after void subtraction",
            sub.geometry_id
        );
    }

    // At least one layer must lose triangles to the opening — otherwise CSG
    // never ran, which would indicate the void path silently no-ops.
    let uncut_tris: usize = uncut
        .sub_meshes
        .iter()
        .map(|s| s.mesh.triangle_count())
        .sum();
    let cut_tris: usize = cut.sub_meshes.iter().map(|s| s.mesh.triangle_count()).sum();
    assert!(
        cut_tris != uncut_tris,
        "[{name}] void subtraction should change triangle count: uncut={uncut_tris} cut={cut_tris}"
    );
}

/// Former `submeshes_with_voids_returns_empty_without_opening_ids`.
fn check_submesh_empty_without_openings(
    name: &str,
    _uncut: &SubMeshCollection,
    cut: &SubMeshCollection,
) {
    // No openings → return empty so the caller can fall back to the
    // void-less sub-mesh path (or merged mesh path) without duplicating work.
    assert!(
        cut.is_empty(),
        "[{name}] expected empty collection when no openings apply"
    );
}

#[test]
fn submesh_void_matrix() {
    let cases = [
        SubmeshCase {
            name: "opening_through_all_layers",
            opening_ids: &[200],
            check: check_submesh_ids_preserved_and_triangles_removed,
        },
        SubmeshCase {
            name: "no_openings_registered",
            opening_ids: &[],
            check: check_submesh_empty_without_openings,
        },
    ];

    for case in &cases {
        let content = multi_layer_wall_with_opening_ifc();
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::with_units(&content, &mut decoder);

        let wall = decoder.decode_by_id(100).expect("decode wall");
        let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        if !case.opening_ids.is_empty() {
            void_index.insert(100, case.opening_ids.to_vec());
        }

        let uncut = router
            .process_element_with_submeshes(&wall, &mut decoder)
            .expect("submesh uncut");
        let cut = router
            .process_element_with_submeshes_and_voids(&wall, &mut decoder, &void_index)
            .expect("submesh voids");

        (case.check)(case.name, &uncut, &cut);
    }
}

// ---------------------------------------------------------------------------
// Production fixture matrix (end-to-end `process_geometry_batch` path)
// ---------------------------------------------------------------------------
//
// This mimics the *exact* path that `IfcAPI::process_geometry_batch`
// exercises in production:
//   1. Parse the IFC bytes
//   2. Build `void_index` from `IfcRelVoidsElement` (no manual ID injection)
//   3. Drive each host element through `process_element_with_voids`
//   4. Ray-cast through the opening footprint along the wall thickness axis
//      to assert the wall actually has a hole. A SOLID UNCUT wall fails.
//
// Fixtures are reported regression cases:
//   - `tests/models/various/issue-604-door.ifc` (issue #604, PR #605 head)
//   - `tests/models/ara3d/AC-20-Smiley-West-10-Bldg.ifc` (issue #584)
//
// These tests are gated on the fixtures being present so CI without
// large model downloads does not flake.

/// Resolve a fixture path relative to the workspace root.
fn fixture_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(relative)
}

/// Load a fixture if present; return `None` so callers can skip gracefully.
fn load_fixture(relative: &str) -> Option<String> {
    let path = fixture_path(relative);
    fs::read_to_string(&path).ok()
}

/// Find the express ID of an entity by GUID (attribute index 0).
fn find_entity_by_guid(content: &str, guid: &str) -> Option<u32> {
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, _type_name, start, end)) = scanner.next_entity() {
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            if let Some(attr) = entity.get(0) {
                if let Some(g) = attr.as_string() {
                    if g == guid {
                        return Some(id);
                    }
                }
            }
        }
    }
    None
}

/// Build the void index the same way production does in
/// `process_geometry_batch` and `build_pre_pass_streaming`.
fn build_void_index_like_production(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    // Combined (non-streaming) path also propagates to parts, so we
    // mirror that. The streaming path SKIPS this — we run both modes.
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

/// Ray-triangle intersection (Möller–Trumbore).
fn ray_hits_triangle(
    ray_origin: [f32; 3],
    ray_dir: [f32; 3],
    v0: [f32; 3],
    v1: [f32; 3],
    v2: [f32; 3],
) -> Option<f32> {
    let edge1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    let edge2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    let h = [
        ray_dir[1] * edge2[2] - ray_dir[2] * edge2[1],
        ray_dir[2] * edge2[0] - ray_dir[0] * edge2[2],
        ray_dir[0] * edge2[1] - ray_dir[1] * edge2[0],
    ];
    let a = edge1[0] * h[0] + edge1[1] * h[1] + edge1[2] * h[2];
    if a.abs() < 1e-7 {
        return None;
    }
    let f = 1.0 / a;
    let s = [
        ray_origin[0] - v0[0],
        ray_origin[1] - v0[1],
        ray_origin[2] - v0[2],
    ];
    let u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = [
        s[1] * edge1[2] - s[2] * edge1[1],
        s[2] * edge1[0] - s[0] * edge1[2],
        s[0] * edge1[1] - s[1] * edge1[0],
    ];
    let v = f * (ray_dir[0] * q[0] + ray_dir[1] * q[1] + ray_dir[2] * q[2]);
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = f * (edge2[0] * q[0] + edge2[1] * q[1] + edge2[2] * q[2]);
    if t > 1e-5 {
        Some(t)
    } else {
        None
    }
}

/// Count how many wall triangles a ray pierces. A perfectly cut wall
/// at the opening footprint should return 0.
fn count_ray_hits(mesh: &Mesh, ray_origin: [f32; 3], ray_dir: [f32; 3]) -> usize {
    let mut hits = 0;
    for tri in mesh.indices.chunks_exact(3) {
        let i0 = tri[0] as usize * 3;
        let i1 = tri[1] as usize * 3;
        let i2 = tri[2] as usize * 3;
        if i0 + 2 >= mesh.positions.len()
            || i1 + 2 >= mesh.positions.len()
            || i2 + 2 >= mesh.positions.len()
        {
            continue;
        }
        let v0 = [
            mesh.positions[i0],
            mesh.positions[i0 + 1],
            mesh.positions[i0 + 2],
        ];
        let v1 = [
            mesh.positions[i1],
            mesh.positions[i1 + 1],
            mesh.positions[i1 + 2],
        ];
        let v2 = [
            mesh.positions[i2],
            mesh.positions[i2 + 1],
            mesh.positions[i2 + 2],
        ];
        if ray_hits_triangle(ray_origin, ray_dir, v0, v1, v2).is_some() {
            hits += 1;
        }
    }
    hits
}

/// Compute the AABB of an opening as seen by the production void path —
/// `process_element` on the opening then take its bounds.
fn opening_world_aabb(
    router: &GeometryRouter,
    opening_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<([f32; 3], [f32; 3])> {
    let opening = decoder.decode_by_id(opening_id).ok()?;
    let mesh = router.process_element(&opening, decoder).ok()?;
    if mesh.is_empty() {
        return None;
    }
    let (min, max) = mesh.bounds();
    Some(([min.x, min.y, min.z], [max.x, max.y, max.z]))
}

/// Cast a 3×3 grid of rays through the opening footprint along the wall's
/// thickness axis. The thickness axis is whichever wall AABB axis has
/// the smallest extent. Returns the total number of wall-triangle hits
/// across the 9 rays. A correctly cut wall returns 0.
fn count_hits_through_opening(
    wall_mesh: &Mesh,
    opening_min: [f32; 3],
    opening_max: [f32; 3],
) -> usize {
    let (wall_min, wall_max) = wall_mesh.bounds();
    let extents = [
        wall_max.x - wall_min.x,
        wall_max.y - wall_min.y,
        wall_max.z - wall_min.z,
    ];
    // Thickness axis = smallest wall extent.
    let mut thickness_axis = 0;
    for i in 1..3 {
        if extents[i] < extents[thickness_axis] {
            thickness_axis = i;
        }
    }

    // Pick the two non-thickness axes for the 3×3 grid inside the opening.
    let grid_axes: [usize; 2] = match thickness_axis {
        0 => [1, 2],
        1 => [0, 2],
        _ => [0, 1],
    };
    // Inset by 10% on each side so we sample inside the opening interior.
    let inset = 0.10;
    let lo_a =
        opening_min[grid_axes[0]] + inset * (opening_max[grid_axes[0]] - opening_min[grid_axes[0]]);
    let hi_a =
        opening_max[grid_axes[0]] - inset * (opening_max[grid_axes[0]] - opening_min[grid_axes[0]]);
    let lo_b =
        opening_min[grid_axes[1]] + inset * (opening_max[grid_axes[1]] - opening_min[grid_axes[1]]);
    let hi_b =
        opening_max[grid_axes[1]] - inset * (opening_max[grid_axes[1]] - opening_min[grid_axes[1]]);

    // Cast from outside the wall on the negative thickness side, towards
    // the positive side. Wall extent + slack ensures we start outside.
    let slack = 1.0;
    let mut origin = [0f32, 0f32, 0f32];
    origin[thickness_axis] = match thickness_axis {
        0 => wall_min.x - slack,
        1 => wall_min.y - slack,
        _ => wall_min.z - slack,
    };
    let mut dir = [0f32, 0f32, 0f32];
    dir[thickness_axis] = 1.0;

    let mut total_hits = 0;
    for ai in 0..3 {
        let a = lo_a + (hi_a - lo_a) * (ai as f32 / 2.0);
        for bi in 0..3 {
            let b = lo_b + (hi_b - lo_b) * (bi as f32 / 2.0);
            origin[grid_axes[0]] = a;
            origin[grid_axes[1]] = b;
            total_hits += count_ray_hits(wall_mesh, origin, dir);
        }
    }
    total_hits
}

/// Drive a single host wall through the production code path
/// (`process_element_with_voids`) and return the resulting mesh.
fn process_host_like_production(
    content: &str,
    host_id: u32,
    void_index: &FxHashMap<u32, Vec<u32>>,
) -> Option<Mesh> {
    use ifc_lite_core::build_entity_index;
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_scale(1.0);
    router
        .process_element_with_voids(&entity, &mut decoder, void_index)
        .ok()
}

/// How a production fixture case locates its host wall.
enum HostLocator {
    ById(u32),
    ByGuid(&'static str),
}

struct FixtureWallCase {
    name: &'static str,
    fixture: &'static str,
    host: HostLocator,
    /// When known, the exact opening IDs expected for the host.
    expected_openings: Option<&'static [u32]>,
}

/// Reproducers for issues #604 (single-wall door fixture, wall #55 /
/// opening #2438) and #584 (the user's host wall in Smiley-West, GUID
/// `0NQVcwUgj2fup5UuFaDTfC` → express #137010 with voids #137081/#137149).
#[test]
fn production_fixture_walls_have_holes() {
    let cases = [
        FixtureWallCase {
            name: "issue_604_door_wall_55",
            fixture: "tests/models/various/issue-604-door.ifc",
            host: HostLocator::ById(55),
            expected_openings: Some(&[2438]),
        },
        FixtureWallCase {
            name: "issue_584_smiley_wall_0NQVcwUgj2fup5UuFaDTfC",
            fixture: "tests/models/ara3d/AC-20-Smiley-West-10-Bldg.ifc",
            host: HostLocator::ByGuid("0NQVcwUgj2fup5UuFaDTfC"),
            expected_openings: None,
        },
    ];

    for case in &cases {
        let content = match load_fixture(case.fixture) {
            Some(c) => c,
            None => {
                eprintln!(
                    "[{}] fixture {} missing — skipping production void test",
                    case.name, case.fixture
                );
                continue;
            }
        };

        let host_id = match case.host {
            HostLocator::ById(id) => id,
            HostLocator::ByGuid(guid) => find_entity_by_guid(&content, guid)
                .unwrap_or_else(|| panic!("[{}] host GUID {guid} should be present", case.name)),
        };

        let void_index = build_void_index_like_production(&content);
        let opening_ids = void_index.get(&host_id).cloned().unwrap_or_else(|| {
            panic!(
                "[{}] host #{host_id} should be in void_index built from IfcRelVoidsElement",
                case.name
            )
        });
        assert!(
            !opening_ids.is_empty(),
            "[{}] host should have at least one opening in IfcRelVoidsElement",
            case.name
        );
        if let Some(expected) = case.expected_openings {
            assert_eq!(
                opening_ids, expected,
                "[{}] expected openings {expected:?} for host #{host_id}",
                case.name
            );
        }

        let wall_mesh = process_host_like_production(&content, host_id, &void_index)
            .unwrap_or_else(|| panic!("[{}] host #{host_id} should produce a mesh", case.name));
        assert!(
            !wall_mesh.is_empty(),
            "[{}] host #{host_id} produced an empty mesh — pre-existing regression",
            case.name
        );

        // Compute each opening AABB through the production opening path and
        // ray-cast its footprint; every opening must have a hole.
        use ifc_lite_core::build_entity_index;
        let entity_index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let router = GeometryRouter::with_scale(1.0);

        let mut total_hits = 0usize;
        let mut checked = 0usize;
        for &opening_id in &opening_ids {
            let (op_min, op_max) = match opening_world_aabb(&router, opening_id, &mut decoder) {
                Some(b) => b,
                None => continue,
            };
            let hits = count_hits_through_opening(&wall_mesh, op_min, op_max);
            eprintln!(
                "[{}] opening #{opening_id}: {hits} ray-hits inside footprint",
                case.name
            );
            total_hits += hits;
            checked += 1;
        }
        assert!(
            checked > 0,
            "[{}] no opening footprints could be sampled",
            case.name
        );
        assert_eq!(
            total_hits,
            0,
            "[{}] wall (express #{host_id}) still has triangles inside opening footprints — \
             void cut was NOT applied. wall_tris={} openings={:?}",
            case.name,
            wall_mesh.triangle_count(),
            opening_ids,
        );
    }
}

/// Sweep ALL host walls in Smiley-West and report how many fail the
/// "wall has a hole" test. This is the production-coverage canary —
/// PR #626's "0 fallbacks" claim should mean `failed == 0` here.
#[test]
fn production_smiley_all_host_walls_have_holes() {
    let content = match load_fixture("tests/models/ara3d/AC-20-Smiley-West-10-Bldg.ifc") {
        Some(c) => c,
        None => {
            eprintln!(
                "AC-20-Smiley-West-10-Bldg.ifc fixture missing — \
                 skipping production void sweep"
            );
            return;
        }
    };

    let void_index = build_void_index_like_production(&content);
    use ifc_lite_core::build_entity_index;
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_scale(1.0);

    let mut total_hosts = 0usize;
    let mut failed_hosts: Vec<(u32, usize, usize)> = Vec::new();
    let mut empty_meshes = 0usize;
    let mut skipped_no_opening_mesh = 0usize;

    for (&host_id, opening_ids) in void_index.iter() {
        let entity = match decoder.decode_by_id(host_id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        // Only process host elements with their own representation; the
        // production code does the same gate.
        let has_repr = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
        if !has_repr {
            continue;
        }
        total_hosts += 1;

        let wall_mesh = match router.process_element_with_voids(&entity, &mut decoder, &void_index)
        {
            Ok(m) => m,
            Err(_) => continue,
        };
        if wall_mesh.is_empty() {
            empty_meshes += 1;
            continue;
        }

        let mut host_total_hits = 0usize;
        let mut host_checked = 0usize;
        for &opening_id in opening_ids {
            let (op_min, op_max) = match opening_world_aabb(&router, opening_id, &mut decoder) {
                Some(b) => b,
                None => {
                    skipped_no_opening_mesh += 1;
                    continue;
                }
            };
            let hits = count_hits_through_opening(&wall_mesh, op_min, op_max);
            host_total_hits += hits;
            host_checked += 1;
        }
        if host_checked > 0 && host_total_hits > 0 {
            failed_hosts.push((host_id, host_total_hits, host_checked));
        }
    }

    eprintln!(
        "[smiley sweep] hosts={} failed={} empty={} skipped_opening={}",
        total_hosts,
        failed_hosts.len(),
        empty_meshes,
        skipped_no_opening_mesh,
    );
    if !failed_hosts.is_empty() {
        eprintln!("first 20 failing hosts (express_id, total_hits, openings_checked):");
        for (id, hits, n) in failed_hosts.iter().take(20) {
            eprintln!("  #{}: {} hits across {} openings", id, hits, n);
        }
    }

    assert_eq!(
        failed_hosts.len(),
        0,
        "{}/{} host walls in Smiley-West are still uncut around their openings — \
         the production void path is not being applied",
        failed_hosts.len(),
        total_hosts,
    );
}
