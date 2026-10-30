// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #8233: plan symbols held only on a type's `RepresentationMaps`.
//!
//! An integration test through the public `extract_symbolic_data`, so the
//! revert oracle still compiles it with the production change reverted.
//!
//! An occurrence typed through `IfcRelDefinesByType` often carries only a Body
//! representation while the Plan / FootPrint symbol lives on the type. The
//! symbolic walk used to read only the occurrence's own `Representation`.

use ifc_lite_processing::extract_symbolic_data;

fn file(body: &str) -> Vec<u8> {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('t'),'2;1');\n\
         FILE_NAME('t.ifc','2026-01-01',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\n\
         ENDSEC;\nDATA;\n{body}ENDSEC;\nEND-ISO-10303-21;\n"
    )
    .into_bytes()
}

/// Occurrence at (10,20), typed by a furniture type whose FootPrint map has
/// MappingOrigin (1,2) and a polyline (0,0)-(1,0). `occurrence_rep` is the
/// occurrence's own `IfcProductDefinitionShape` reference (`#40` Body only,
/// `#41` Body + Plan).
fn fixture(occurrence_rep: &str) -> Vec<u8> {
    file(&format!(
        "#1=IFCCARTESIANPOINT((10.,20.,0.));\n\
         #2=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
         #3=IFCLOCALPLACEMENT($,#2);\n\
         #10=IFCFURNITURE('g',$,'F',$,$,#3,{occurrence_rep},$,$);\n\
         #40=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));\n\
         #45=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#80));\n\
         #41=IFCPRODUCTDEFINITIONSHAPE($,$,(#45,#46));\n\
         #46=IFCSHAPEREPRESENTATION($,'Plan','Curve2D',(#81));\n\
         #80=IFCPOLYLINE((#82,#83));\n\
         #81=IFCPOLYLINE((#84,#85));\n\
         #82=IFCCARTESIANPOINT((0.,0.));\n\
         #83=IFCCARTESIANPOINT((9.,9.));\n\
         #84=IFCCARTESIANPOINT((0.,0.));\n\
         #85=IFCCARTESIANPOINT((0.5,0.));\n\
         #20=IFCFURNITURETYPE('t',$,'FT',$,$,$,(#30,#31),$,$,.NOTDEFINED.);\n\
         #21=IFCRELDEFINESBYTYPE('r',$,$,$,(#10),#20);\n\
         #30=IFCREPRESENTATIONMAP(#32,#33);\n\
         #31=IFCREPRESENTATIONMAP(#32,#34);\n\
         #32=IFCAXIS2PLACEMENT2D(#35,$);\n\
         #35=IFCCARTESIANPOINT((1.,2.));\n\
         #33=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#36));\n\
         #34=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#80));\n\
         #36=IFCPOLYLINE((#37,#38));\n\
         #37=IFCCARTESIANPOINT((0.,0.));\n\
         #38=IFCCARTESIANPOINT((1.,0.));\n"
    ))
}

/// Plan-pair x values (the plan Y axis is flipped by the overlay frame).
fn xs(points: &[f32]) -> Vec<f32> {
    points.chunks_exact(2).map(|p| p[0]).collect()
}

/// The type's FootPrint polyline lands at the occurrence placement composed
/// with the map's MappingOrigin: (10,20) + (1,2) + (0..1, 0).
#[test]
fn type_footprint_is_drawn_for_an_occurrence_with_only_a_body() {
    let data = extract_symbolic_data(&fixture("#40")).expect("extraction completes");
    assert_eq!(data.polylines.len(), 1, "exactly the type's FootPrint polyline: {:?}", data.polylines);
    let line = &data.polylines[0];
    assert_eq!(line.express_id, 10, "attributed to the occurrence, not the type");
    assert_eq!(line.representation, "FootPrint");
    let x = xs(&line.points);
    assert!((x[0] - 11.0).abs() < 1e-4 && (x[1] - 12.0).abs() < 1e-4, "x: {x:?}");
    let y: Vec<f32> = line.points.chunks_exact(2).map(|p| p[1].abs()).collect();
    assert!((y[0] - 22.0).abs() < 1e-4 && (y[1] - 22.0).abs() < 1e-4, "|y|: {y:?}");
}

/// Counter-case: an occurrence with its own Plan representation keeps it and
/// does not also receive the type's symbol.
#[test]
fn own_plan_representation_wins_over_the_type() {
    let data = extract_symbolic_data(&fixture("#41")).expect("extraction completes");
    assert_eq!(data.polylines.len(), 1, "{:?}", data.polylines);
    assert_eq!(data.polylines[0].representation, "Plan");
    let x = xs(&data.polylines[0].points);
    assert!((x[0] - 10.0).abs() < 1e-4 && (x[1] - 10.5).abs() < 1e-4, "x: {x:?}");
}

/// The type fallback draws in the same frame as the map wrapped in the
/// occurrence's own representation. The model context's WorldCoordinateSystem
/// is offset (100, 0, 0) AND rotated 90° about Z, so the composition order of
/// context, placement and MappingOrigin is observable (pure translations would
/// commute). Two files differ only in where the map is reached from:
/// - `fallback`: the occurrence has only a Body, so the type's FootPrint map
///   is drawn through the #8233 fallback;
/// - `wrapped`: the occurrence's own Plan representation, in the same context,
///   holds an `IfcMappedItem` of that map with an identity target.
///
/// Both must give the same points.
#[test]
fn type_symbol_matches_the_same_map_wrapped_in_the_occurrence() {
    let context = "#50=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#51,$);\n\
                   #51=IFCAXIS2PLACEMENT3D(#52,#53,#54);\n\
                   #52=IFCCARTESIANPOINT((100.,0.,0.));\n\
                   #53=IFCDIRECTION((0.,0.,1.));\n\
                   #54=IFCDIRECTION((0.,1.,0.));\n\
                   #60=IFCPRODUCTDEFINITIONSHAPE($,$,(#45,#61));\n\
                   #61=IFCSHAPEREPRESENTATION(#50,'Plan','MappedRepresentation',(#62));\n\
                   #62=IFCMAPPEDITEM(#30,#63);\n\
                   #63=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#64,$,$);\n\
                   #64=IFCCARTESIANPOINT((0.,0.,0.));\n";
    let with_context = |occurrence_rep: &str| {
        String::from_utf8(fixture(occurrence_rep))
            .unwrap()
            .replace("#33=IFCSHAPEREPRESENTATION($,'FootPrint'", "#33=IFCSHAPEREPRESENTATION(#50,'FootPrint'")
            .replace("ENDSEC;\nEND-ISO", &format!("{context}ENDSEC;\nEND-ISO"))
    };
    let fallback = with_context("#40");
    let wrapped = with_context("#60");
    assert!(fallback.contains("#33=IFCSHAPEREPRESENTATION(#50,") && fallback.contains("#54="), "fixture rewired");

    let points = |source: &str, representation: &str| {
        let data = extract_symbolic_data(source).expect("extraction completes");
        assert_eq!(data.polylines.len(), 1, "{representation}: {:?}", data.polylines);
        assert_eq!(data.polylines[0].representation, representation);
        data.polylines[0].points.clone()
    };
    let via_type = points(&fallback, "FootPrint");
    let via_own = points(&wrapped, "Plan");
    assert_eq!(via_type.len(), via_own.len());
    for (a, b) in via_type.iter().zip(&via_own) {
        assert!((a - b).abs() < 1e-4, "type fallback {via_type:?} vs wrapped map {via_own:?}");
    }
    // And not merely equal by accident: the rotation moved the symbol off the
    // translation-only answer (x = 111..112).
    let x = xs(&via_type);
    assert!(x.iter().all(|v| (v - 111.0).abs() > 1.0 && (v - 112.0).abs() > 1.0), "rotation had no effect: {x:?}");
}
