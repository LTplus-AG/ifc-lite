// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Inline IFC fixture builders shared by the void-subtraction suites.

/// Simple slab (4m × 3m × 0.3m) with a rectangular opening.
pub fn slab_with_opening_ifc() -> String {
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
pub fn wall_with_trapezoid_opening_ifc() -> String {
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
pub fn long_wall_with_many_tessellated_openings(n: usize) -> String {
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
pub fn multi_layer_wall_with_opening_ifc() -> String {
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
