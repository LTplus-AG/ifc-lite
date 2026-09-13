// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `extract_profiles` against file-supplied input the 2D drawing extractor
//! must survive: a malformed zero `IfcDirection` in the placement chain, and
//! a STEP keyword spelled in a case other than upper.

use ifc_lite_geometry::extract_profiles;

/// One wall, one extruded rectangle. `{axis}` is the wall placement's
/// `IfcAxis2Placement3D.Axis` and `{project}` the project keyword, so each
/// test varies exactly one thing against the control.
fn fixture(project_keyword: &str, axis_ref: &str) -> String {
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('profile-extractor untrusted input'),'2;1');
FILE_NAME('f.ifc','2026-09-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1={project_keyword}('0UntrustedInputProj0A',$,'P',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCDIRECTION((0.,0.,0.));
#21=IFCDIRECTION((1.,0.,0.));
#110=IFCLOCALPLACEMENT($,#111);
#111=IFCAXIS2PLACEMENT3D(#12,{axis_ref},#21);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#131,4000.,300.);
#131=IFCAXIS2PLACEMENT2D(#132,#133);
#132=IFCCARTESIANPOINT((0.,0.));
#133=IFCDIRECTION((1.,0.));
#140=IFCEXTRUDEDAREASOLID(#130,#141,#142,2500.);
#141=IFCAXIS2PLACEMENT3D(#12,$,$);
#142=IFCDIRECTION((0.,0.,1.));
#150=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));
#151=IFCPRODUCTDEFINITIONSHAPE($,$,(#150));
#100=IFCWALL('0UntrustedInputWall0A',$,'Wall',$,$,#110,#151,$,$);
ENDSEC;
END-ISO-10303-21;
"#
    )
}

fn max_abs_x(points: &[f32]) -> f32 {
    points.chunks_exact(2).map(|p| p[0].abs()).fold(0.0, f32::max)
}

/// `IFCDIRECTION((0.,0.,0.))` as the placement `Axis` was normalised to NaN
/// by the extractor BEFORE `build_axis2_matrix`'s `try_normalize` guard,
/// which does not recover a NaN (`NaN <= 1e-9` is false): all 16 transform
/// entries and the extrusion direction came out NaN. The raw vector must
/// reach the shared guard, which falls back to +Z, so the result is the
/// same as an absent Axis.
#[test]
fn zero_axis_direction_yields_a_finite_transform() {
    let control = extract_profiles(&fixture("IFCPROJECT", "$"), 0);
    let zero_axis = extract_profiles(&fixture("IFCPROJECT", "#20"), 0);
    assert_eq!(control.len(), 1, "control extracts the wall");
    assert_eq!(zero_axis.len(), 1, "a zero Axis must not drop the wall");

    let (c, z) = (&control[0], &zero_axis[0]);
    assert!(
        z.transform.iter().all(|v| v.is_finite()),
        "transform must be finite, got {:?}",
        z.transform
    );
    assert!(z.extrusion_dir.iter().all(|v| v.is_finite()), "got {:?}", z.extrusion_dir);
    assert_eq!(z.transform, c.transform, "zero Axis falls back to the same +Z frame as an absent one");
    assert_eq!(z.extrusion_dir, c.extrusion_dir);
}

/// STEP keyword case is not significant (ISO 10303-21) and the scanner hands
/// the keyword back as written. The unit-scale hunt compared `IFCPROJECT`
/// exactly, so a file spelling it `IfcProject` fell through to scale 1 and
/// every millimetre profile came out 1000x too large.
#[test]
fn project_keyword_case_does_not_change_the_unit_scale() {
    let upper = extract_profiles(&fixture("IFCPROJECT", "$"), 0);
    let mixed = extract_profiles(&fixture("IfcProject", "$"), 0);
    assert_eq!(upper.len(), 1);
    assert_eq!(mixed.len(), 1);

    // 4000 mm wide, centred: 2 m half-extent in metres, 2000 unscaled.
    let (u, m) = (max_abs_x(&upper[0].outer_points), max_abs_x(&mixed[0].outer_points));
    assert!((u - 2.0).abs() < 1e-4, "control half-extent in metres, got {u}");
    assert!((m - u).abs() < 1e-6, "keyword case changed the unit scale: {m} vs {u}");
    assert!((mixed[0].extrusion_depth - 2.5).abs() < 1e-4, "depth in metres, got {}", mixed[0].extrusion_depth);
}
