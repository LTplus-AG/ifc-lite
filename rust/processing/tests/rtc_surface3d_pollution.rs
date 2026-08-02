// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for the Surface3D variant of issue #1526: RTC-offset detection
//! must not be poisoned by origin-placed elements whose ONLY representation is
//! a `Surface3D` (B-spline / sectioned / trimmed surface).
//!
//! `Surface3D` geometry is MESHABLE (so the router's canonical
//! `is_body_representation` counts it), but it stores its coordinates in
//! absolute model-space control points that the cheap RTC vertex probe
//! (`sample_first_geometry_vertex`) cannot navigate. If such a near-origin,
//! identity-placed element were treated as RTC-votable it would fall through
//! to voting its placement translation `(0,0,0)` — a spurious "no shift" vote.
//! On IFC4X3 corridor models with many such surface elements ahead of a few
//! national-grid tessellated/Brep solids, those origin votes drag the per-axis
//! median to zero (and/or exhaust the 50-sample budget), suppressing a
//! legitimate rebase and leaving the real solids to render as f32 jitter
//! hundreds of km from the origin.
//!
//! This is the exact shape of the curve-only pollution regression
//! (`rtc_curve_only_pollution.rs`), rebuilt via `Surface3D`. It FAILS if
//! `Surface3D` is RTC-votable and PASSES once the RTC vote gate excludes it
//! (`is_rtc_votable_representation` in `router/rtc_offset.rs`), while the
//! meshing / void / layer paths keep treating `Surface3D` as body geometry.
//!
//! Uses INLINE minimal IFC so the test runs in CI without external fixtures.

use ifc_lite_processing::process_geometry;

/// Large world coordinates the real solid is authored at (metres). Well past
/// the 10 km RTC threshold, mirroring the national-grid magnitudes in #1526.
const SOLID_X: f64 = 200_000.0;
const SOLID_Y: f64 = 6_000_000.0;
const SOLID_Z: f64 = 100.0;

/// One origin-placed proxy whose ONLY representation is a `Surface3D`
/// containing a bare bilinear `IfcBSplineSurfaceWithKnots`. The RTC vertex
/// probe has no case for B-spline surfaces, so it cannot read a coordinate and
/// (correctly) the element must ABSTAIN rather than vote its `(0,0,0)`
/// placement. Numbered from a caller-supplied base so several can coexist
/// without id collisions.
fn surface3d_proxy(base: u32, guid: &str) -> String {
    let c0 = base;
    let c1 = base + 1;
    let c2 = base + 2;
    let c3 = base + 3;
    let bspline = base + 4;
    let rep = base + 5;
    let pds = base + 6;
    let pt = base + 7;
    let ax = base + 8;
    let plc = base + 9;
    let proxy = base + 10;
    format!(
        "#{c0}=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #{c1}=IFCCARTESIANPOINT((1.,0.,0.));\n\
         #{c2}=IFCCARTESIANPOINT((0.,1.,0.));\n\
         #{c3}=IFCCARTESIANPOINT((1.,1.,0.));\n\
         #{bspline}=IFCBSPLINESURFACEWITHKNOTS(1,1,((#{c0},#{c1}),(#{c2},#{c3})),\
.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);\n\
         #{rep}=IFCSHAPEREPRESENTATION(#6,'Surface','Surface3D',(#{bspline}));\n\
         #{pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));\n\
         #{pt}=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #{ax}=IFCAXIS2PLACEMENT3D(#{pt},$,$);\n\
         #{plc}=IFCLOCALPLACEMENT($,#{ax});\n\
         #{proxy}=IFCBUILDINGELEMENTPROXY('{guid}',$,'surf',$,$,#{plc},#{pds},$,$);\n"
    )
}

fn model() -> String {
    // Header + shared context/units. Six origin-placed Surface3D-only proxies
    // (a strict majority of the samples) followed by one tessellated solid at
    // large world coordinates with identity placement.
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

    // Many origin-placed Surface3D-only proxies FIRST — if they were votable
    // their (0,0,0) placement votes would dominate the median (and, in a real
    // corridor, exhaust the sample budget) before the solid is ever seen.
    for (i, guid) in [
        "21tEAnIV5BixApwp1YzpwS",
        "31tEAnIV5BixApwp1YzpwS",
        "41tEAnIV5BixApwp1YzpwS",
        "51tEAnIV5BixApwp1YzpwS",
        "61tEAnIV5BixApwp1YzpwS",
        "71tEAnIV5BixApwp1YzpwS",
    ]
    .iter()
    .enumerate()
    {
        s.push_str(&surface3d_proxy(100 + (i as u32) * 20, guid));
    }

    // Tessellated solid (a small tetra-ish faceset) at the large anchor. Its
    // vertices ARE readable by the RTC probe, so it should drive the offset.
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

    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

#[test]
fn rtc_offset_survives_surface3d_origin_entities() {
    let result = process_geometry(&model());
    let shift = result.metadata.coordinate_info.origin_shift;

    // The offset must anchor on the large-coordinate tessellated solid, NOT be
    // dragged to (0,0,0) by the six origin-placed Surface3D proxies. This fails
    // if Surface3D is RTC-votable (their spurious (0,0,0) votes win the median).
    assert!(
        result.metadata.coordinate_info.is_geo_referenced,
        "model with a 200 km solid must be flagged geo-referenced despite the Surface3D proxies"
    );
    assert!(
        (shift[0] - SOLID_X).abs() < 10.0,
        "RTC X should anchor near the solid ({SOLID_X}), got {} (Surface3D origin votes polluted the median)",
        shift[0]
    );
    assert!(
        (shift[1] - SOLID_Y).abs() < 10.0,
        "RTC Y should anchor near the solid ({SOLID_Y}), got {} (Surface3D origin votes polluted the median)",
        shift[1]
    );
}
