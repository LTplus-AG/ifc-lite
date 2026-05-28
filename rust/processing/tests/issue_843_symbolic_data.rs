// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #843 — the server's geometric response
//! now exposes 2D symbol data (IfcGrid axes + IfcAnnotation polylines)
//! that previously only the browser-side parser could see.

use ifc_lite_processing::extract_symbolic_data;

const SYNTHETIC_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-843 fixture'),'2;1');
FILE_NAME('test.ifc','2026-05-28T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCCARTESIANPOINT((10.,0.));
#12=IFCCARTESIANPOINT((0.,10.));
#13=IFCCARTESIANPOINT((10.,10.));
#14=IFCCARTESIANPOINT((5.,0.));
#15=IFCCARTESIANPOINT((5.,10.));
#16=IFCCARTESIANPOINT((0.,5.));
#17=IFCCARTESIANPOINT((10.,5.));
#20=IFCPOLYLINE((#10,#11));
#21=IFCPOLYLINE((#12,#13));
#22=IFCPOLYLINE((#14,#15));
#23=IFCPOLYLINE((#16,#17));
#30=IFCGRIDAXIS('A',#20,.T.);
#31=IFCGRIDAXIS('B',#21,.T.);
#32=IFCGRIDAXIS('1',#22,.T.);
#33=IFCGRIDAXIS('2',#23,.T.);
#40=IFCLOCALPLACEMENT($,#5);
#41=IFCGRID('1xScRe4drECQ4DMSqUjd6d',$,'Grid',$,$,#40,$,(#30,#31),(#32,#33),$);
#50=IFCCARTESIANPOINT((0.,0.));
#51=IFCCARTESIANPOINT((1.,0.));
#52=IFCCARTESIANPOINT((1.,1.));
#53=IFCCARTESIANPOINT((0.,1.));
#54=IFCCARTESIANPOINT((0.,0.));
#55=IFCPOLYLINE((#50,#51,#52,#53,#54));
#60=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#55));
#61=IFCPRODUCTDEFINITIONSHAPE($,$,(#60));
#62=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'Note',$,$,#40,#61);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn extracts_grid_axes_from_ifcgrid() {
    let data = extract_symbolic_data(SYNTHETIC_IFC);
    assert_eq!(
        data.grid_axes.len(),
        4,
        "expected 4 axes (A, B, 1, 2), got {} (axes: {:?})",
        data.grid_axes.len(),
        data.grid_axes.iter().map(|a| &a.tag).collect::<Vec<_>>(),
    );

    let tags: Vec<&str> = data.grid_axes.iter().map(|a| a.tag.as_str()).collect();
    assert!(tags.contains(&"A"));
    assert!(tags.contains(&"B"));
    assert!(tags.contains(&"1"));
    assert!(tags.contains(&"2"));

    // Axis A endpoints are (0,0)→(10,0). File is in metres so unit scale
    // is identity; the extractor must not warp the values.
    let axis_a = data.grid_axes.iter().find(|a| a.tag == "A").unwrap();
    assert_eq!(axis_a.endpoints[0], 0.0);
    assert_eq!(axis_a.endpoints[1], 0.0);
    assert_eq!(axis_a.endpoints[2], 10.0);
    assert_eq!(axis_a.endpoints[3], 0.0);

    // Each axis carries its grid's express_id so clients can group axes
    // by grid in a multi-grid model.
    for axis in &data.grid_axes {
        assert_eq!(axis.grid_express_id, 41);
    }
}

#[test]
fn extracts_polylines_from_ifcannotation() {
    let data = extract_symbolic_data(SYNTHETIC_IFC);
    assert_eq!(
        data.polylines.len(),
        1,
        "expected 1 annotation polyline, got {}",
        data.polylines.len(),
    );

    let pl = &data.polylines[0];
    assert_eq!(pl.ifc_type, "IfcAnnotation");
    assert_eq!(pl.representation, "Annotation");
    // 5 points × 2 coords = 10 floats; the loop closes back on the start.
    assert_eq!(pl.points.len(), 10);
    assert_eq!((pl.points[0], pl.points[1]), (0.0, 0.0));
    assert_eq!((pl.points[8], pl.points[9]), (0.0, 0.0));
    assert!(pl.closed, "unit-square polyline should be recognised as closed");
}

#[test]
fn empty_when_no_grids_or_annotations() {
    let minimal = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('empty'),'2;1');
FILE_NAME('','2026-05-28T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
ENDSEC;
END-ISO-10303-21;
"#;
    let data = extract_symbolic_data(minimal);
    assert!(data.is_empty(), "empty IFC should produce no symbol data");
}
