// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for issue #1526 (IFC4X3 civil model from Quadri rendered with
//! shredded geometry): RTC-offset detection must not be poisoned by
//! origin-placed, curve-only entities (e.g. IfcAlignmentSegment axis curves).
//!
//! These infrastructure files bake large world coordinates directly into a
//! handful of Brep/tessellated solids (identity placement) while carrying many
//! origin-placed alignment segments whose only representation is an axis curve.
//! The RTC sampler could not read a body vertex from those curves, so it used
//! to fall back to the placement translation `(0,0,0)` and let those spurious
//! origin votes dominate the median — dragging the detected offset to zero and
//! leaving the real solids to render as f32 jitter 200 km from the origin.
//!
//! Uses INLINE minimal IFC so the test runs in CI without external fixtures.

use ifc_lite_processing::process_geometry;

/// Large world coordinates the solid is authored at (metres). Well past the
/// 10 km RTC threshold, mirroring the national-grid magnitudes in #1526.
const SOLID_X: f64 = 200_000.0;
const SOLID_Y: f64 = 6_000_000.0;
const SOLID_Z: f64 = 100.0;

/// One origin-placed proxy whose ONLY representation is an axis polyline —
/// the RTC vertex probe cannot read a solid vertex from it. Numbered from a
/// caller-supplied base so several can coexist without id collisions.
fn curve_only_proxy(base: u32, guid: &str) -> String {
    let p0 = base;
    let p1 = base + 1;
    let poly = base + 2;
    let rep = base + 3;
    let pds = base + 4;
    let pt = base + 5;
    let ax = base + 6;
    let plc = base + 7;
    let proxy = base + 8;
    format!(
        "#{p0}=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #{p1}=IFCCARTESIANPOINT((5.,0.,0.));\n\
         #{poly}=IFCPOLYLINE((#{p0},#{p1}));\n\
         #{rep}=IFCSHAPEREPRESENTATION(#6,'Axis','Curve3D',(#{poly}));\n\
         #{pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));\n\
         #{pt}=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #{ax}=IFCAXIS2PLACEMENT3D(#{pt},$,$);\n\
         #{plc}=IFCLOCALPLACEMENT($,#{ax});\n\
         #{proxy}=IFCBUILDINGELEMENTPROXY('{guid}',$,'seg',$,$,#{plc},#{pds},$,$);\n"
    )
}

fn model() -> String {
    // Header + shared context/units. One tessellated solid at large world
    // coordinates (identity placement), then four origin-placed curve-only
    // proxies so the origin votes are a strict majority of the samples.
    let mut s = String::from(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('','2026-01-01T00:00:00',(''),(''),'t','t','');\n\
         FILE_SCHEMA(('IFC4X3_ADD2'));\n\
         ENDSEC;\n\
         DATA;\n\
         #1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
         #2=IFCUNITASSIGNMENT((#1));\n\
         #3=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #4=IFCAXIS2PLACEMENT3D(#3,$,$);\n\
         #5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);\n\
         #6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);\n\
         #7=IFCPROJECT('01tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);\n",
    );

    // Tessellated solid (a small tetra-ish faceset) at the large anchor.
    s.push_str(&format!(
        "#20=IFCCARTESIANPOINTLIST3D((({x},{y},{z}),({x1},{y},{z}),({x},{y1},{z}),({x},{y},{z1})));\n\
         #21=IFCTRIANGULATEDFACESET(#20,$,$,((1,2,3),(1,2,4),(1,3,4),(2,3,4)),$);\n\
         #22=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#21));\n\
         #23=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));\n\
         #24=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #25=IFCAXIS2PLACEMENT3D(#24,$,$);\n\
         #26=IFCLOCALPLACEMENT($,#25);\n\
         #27=IFCBUILDINGELEMENTPROXY('11tEAnIV5BixApwp1YzpwS',$,'solid',$,$,#26,#23,$,$);\n",
        x = SOLID_X,
        y = SOLID_Y,
        z = SOLID_Z,
        x1 = SOLID_X + 1.0,
        y1 = SOLID_Y + 1.0,
        z1 = SOLID_Z + 1.0,
    ));

    for (i, guid) in [
        "21tEAnIV5BixApwp1YzpwS",
        "31tEAnIV5BixApwp1YzpwS",
        "41tEAnIV5BixApwp1YzpwS",
        "51tEAnIV5BixApwp1YzpwS",
    ]
    .iter()
    .enumerate()
    {
        s.push_str(&curve_only_proxy(100 + (i as u32) * 20, guid));
    }

    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

#[test]
fn rtc_offset_survives_curve_only_origin_entities() {
    let result = process_geometry(&model());
    let shift = result.metadata.coordinate_info.origin_shift;

    // The offset must anchor on the large-coordinate solid, NOT be dragged to
    // (0,0,0) by the four origin-placed axis-curve proxies.
    assert!(
        result.metadata.coordinate_info.is_geo_referenced,
        "model with 200 km solid must be flagged geo-referenced"
    );
    assert!(
        (shift[0] - SOLID_X).abs() < 10.0,
        "RTC X should anchor near the solid ({SOLID_X}), got {}",
        shift[0]
    );
    assert!(
        (shift[1] - SOLID_Y).abs() < 10.0,
        "RTC Y should anchor near the solid ({SOLID_Y}), got {}",
        shift[1]
    );
}
