// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #900 parity follow-up: the server's geometry pipeline must surface
//! georeferencing (`IfcMapConversion` / `IfcProjectedCRS`) and the length-unit
//! scale on `ModelMetadata`, matching the browser parser's `extractGeoreferencing`
//! / `extractLengthUnitScale`. Every server geometry endpoint embeds the
//! `ModelMetadata` built by `process_geometry_filtered`, so asserting it here
//! covers all of them at once.

use ifc_lite_processing::{process_geometry_filtered, OpeningFilterMode};

/// Metre-unit model with a georeferenced map conversion + a small extruded wall.
const GEOREF_MODEL: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-900 georef fixture'),'2;1');
FILE_NAME('georef.ifc','2026-06-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCPROJECTEDCRS('EPSG:32632','WGS84 / UTM zone 32N','WGS84',$,'UTM','32N',$);
#11=IFCMAPCONVERSION(#2,#10,1000.5,2000.25,42.0,0.866025,0.5,1.0);
#20=IFCCARTESIANPOINT((0.,0.));
#21=IFCAXIS2PLACEMENT2D(#20,$);
#22=IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,1.0,0.2);
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCEXTRUDEDAREASOLID(#22,#5,#23,3.0);
#25=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#24));
#26=IFCPRODUCTDEFINITIONSHAPE($,$,(#25));
#27=IFCLOCALPLACEMENT($,#5);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,#27,#26,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

/// Millimetre-unit model with geometry but no georeferencing.
const PLAIN_MM_MODEL: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-900 plain mm fixture'),'2;1');
FILE_NAME('plain.ifc','2026-06-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#20=IFCCARTESIANPOINT((0.,0.));
#21=IFCAXIS2PLACEMENT2D(#20,$);
#22=IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,1000.,200.);
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCEXTRUDEDAREASOLID(#22,#5,#23,3000.);
#25=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#24));
#26=IFCPRODUCTDEFINITIONSHAPE($,$,(#25));
#27=IFCLOCALPLACEMENT($,#5);
#28=IFCWALL('Wall00000000000000002',$,'W2',$,$,#27,#26,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn metadata_surfaces_georeferencing_and_metre_unit_scale() {
    let result = process_geometry_filtered(GEOREF_MODEL, OpeningFilterMode::Default);
    let md = &result.metadata;

    assert_eq!(
        md.length_unit_scale,
        Some(1.0),
        "metre file should report a length unit scale of 1.0"
    );

    let geo = md
        .georeferencing
        .as_ref()
        .expect("georeferencing should be present for a model with IfcMapConversion");
    assert_eq!(geo.crs_name.as_deref(), Some("EPSG:32632"));
    assert_eq!(geo.geodetic_datum.as_deref(), Some("WGS84"));
    assert_eq!(geo.map_projection.as_deref(), Some("UTM"));
    assert!((geo.eastings - 1000.5).abs() < 1e-6);
    assert!((geo.northings - 2000.25).abs() < 1e-6);
    assert!((geo.orthogonal_height - 42.0).abs() < 1e-6);
    // cos/sin(30°) → ~30° rotation to grid north.
    assert!(
        (geo.rotation_degrees - 30.0).abs() < 1e-3,
        "expected ~30° grid-north rotation, got {}",
        geo.rotation_degrees
    );
    // Local→map matrix translation column carries the offsets.
    assert!((geo.transform_matrix[12] - 1000.5).abs() < 1e-6);
    assert!((geo.transform_matrix[13] - 2000.25).abs() < 1e-6);
}

#[test]
fn metadata_reports_millimetre_unit_scale_and_no_georef() {
    let result = process_geometry_filtered(PLAIN_MM_MODEL, OpeningFilterMode::Default);
    let md = &result.metadata;

    assert_eq!(
        md.length_unit_scale,
        Some(0.001),
        "millimetre file should report a length unit scale of 0.001"
    );
    assert!(
        md.georeferencing.is_none(),
        "model without IfcMapConversion should not report georeferencing"
    );
}
