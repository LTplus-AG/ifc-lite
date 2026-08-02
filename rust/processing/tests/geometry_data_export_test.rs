// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Verifies the analysis geometry-data export: welded, IFC Z-up, absolute-world
//! metres, occurrences only. Uses an INLINE minimal IFC (a unit cube at the
//! origin) so the test runs in CI without any external fixture.

use ifc_lite_processing::{build_geometry_data_export, process_geometry};

/// Minimal IFC4: one IfcBuildingElementProxy, a unit cube extruded over
/// [0,0,0]..[1,1,1], identity placement, metre units.
const CUBE_IFC: &str = r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-01-01T00:00:00',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);
#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);
#7=IFCPROJECT('11tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);
#8=IFCCARTESIANPOINT((0.,0.));
#9=IFCCARTESIANPOINT((1.,0.));
#10=IFCCARTESIANPOINT((1.,1.));
#11=IFCCARTESIANPOINT((0.,1.));
#12=IFCPOLYLINE((#8,#9,#10,#11,#8));
#13=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#12);
#14=IFCCARTESIANPOINT((0.,0.,0.));
#15=IFCAXIS2PLACEMENT3D(#14,$,$);
#16=IFCDIRECTION((0.,0.,1.));
#17=IFCEXTRUDEDAREASOLID(#13,#15,#16,1.);
#18=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#17));
#19=IFCPRODUCTDEFINITIONSHAPE($,$,(#18));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCLOCALPLACEMENT($,#21);
#23=IFCBUILDINGELEMENTPROXY('36FTsOKg956eWgO6DwnT8U',$,'cube',$,$,#22,#19,$,$);
ENDSEC;
END-ISO-10303-21;
"##;

fn bbox(v: &[[f64; 3]]) -> ([f64; 3], [f64; 3]) {
    let mut mn = [f64::INFINITY; 3];
    let mut mx = [f64::NEG_INFINITY; 3];
    for p in v {
        for i in 0..3 {
            mn[i] = mn[i].min(p[i]);
            mx[i] = mx[i].max(p[i]);
        }
    }
    (mn, mx)
}

fn approx(got: [f64; 3], want: [f64; 3], what: &str) {
    for i in 0..3 {
        assert!(
            (got[i] - want[i]).abs() < 1e-4,
            "{what}: axis {i} got {} want {}",
            got[i],
            want[i]
        );
    }
}

#[test]
fn geometry_data_export_is_welded_zup_world() {
    let result = process_geometry(CUBE_IFC);
    let rtc = result.metadata.coordinate_info.origin_shift;
    // No site-local rotation for this identity-placement model.
    let export = build_geometry_data_export(&result.meshes, rtc, None);

    assert_eq!(export.schema, "ifc-lite-geometry-data");
    assert_eq!(export.up_axis, "Z");
    assert_eq!(export.units, "m");
    assert_eq!(export.element_count, 1, "expected the single cube occurrence");

    let cube = export.elements.values().next().expect("cube present");
    assert_eq!(cube.ifc_type, "IfcBuildingElementProxy");
    // Position-welded: a box collapses to its 8 corners / 12 triangles (not the
    // ~24 normal-split or ~36 unwelded verts).
    assert_eq!(
        cube.vertices.len(),
        8,
        "cube should weld to 8 corners, got {}",
        cube.vertices.len()
    );
    assert_eq!(cube.faces.len(), 12, "cube = 12 triangles, got {}", cube.faces.len());

    // Absolute world, IFC Z-up: [0,0,0]..[1,1,1].
    let (mn, mx) = bbox(&cube.vertices);
    approx(mn, [0.0, 0.0, 0.0], "cube min");
    approx(mx, [1.0, 1.0, 1.0], "cube max");

    // Faces index in range, non-degenerate.
    let n = cube.vertices.len() as u32;
    for f in &cube.faces {
        assert!(f[0] < n && f[1] < n && f[2] < n, "face index out of range");
        assert!(f[0] != f[1] && f[1] != f[2] && f[0] != f[2], "degenerate face");
    }

    // JSON contract round-trips.
    let json = export.to_json().expect("serialize");
    assert!(json.contains("ifc-lite-geometry-data"));
}
