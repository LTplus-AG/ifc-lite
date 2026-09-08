// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1994: the symbolic 2D transform (`Transform2D` in
//! `rust/processing/src/symbolic/transform.rs`) stored its linear block as a
//! `(cos_theta, sin_theta)` similarity, which has no reflection component. A
//! mirroring `IfcMappedItem` MappingTarget — an `Axis2` that disagrees with
//! the right-handed perpendicular of `Axis1` — therefore drew its 2D plan
//! symbols un-mirrored, while the 3D mesh path (fixed in #1990) mirrors
//! correctly.
//!
//! Both fixtures below map the SAME source polyline — a single segment from
//! (0, 0) to (1, 2) in map-local coordinates, chosen off-axis so a Y-mirror
//! is visible on the endpoint — through two `IfcCartesianTransformationOperator2D`
//! MappingTargets that are identical except for `Axis2`:
//!
//! - Non-mirrored: `Axis1 = (1, 0)`, `Axis2 = $` (defaults to the
//!   right-handed perpendicular `(0, 1)` — identity).
//! - Mirrored: `Axis1 = (1, 0)`, `Axis2 = (0, -1)` (disagrees with the
//!   perpendicular — a reflection about the X axis).
//!
//! The extractor applies a further Y-flip to match the section-cut display
//! convention (`y_out = -y_world`), so the expected endpoints below are
//! `(1, -2)` for the non-mirrored map and `(1, 2)` for the mirrored one.

use ifc_lite_processing::extract_symbolic_data;

/// `extra_entities` may define `#23` (or any other unused id) for
/// `axis2_ref` to point at; `axis2_ref` is `$` for "no Axis2 supplied".
fn fixture(extra_entities: &str, axis2_ref: &str) -> String {
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-1994 fixture'),'2;1');
FILE_NAME('test.ifc','2026-08-03T00:00:00',(''),(''),'','','');
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
#11=IFCCARTESIANPOINT((1.,2.));
#17=IFCCARTESIANPOINT((3.,1.));
#12=IFCPOLYLINE((#10,#11,#17));
#13=IFCSHAPEREPRESENTATION(#2,'Body','GeometricCurveSet',(#12));
#14=IFCCARTESIANPOINT((0.,0.));
#15=IFCAXIS2PLACEMENT3D(#14,$,$);
#16=IFCREPRESENTATIONMAP(#15,#13);
#20=IFCDIRECTION((1.,0.));
#21=IFCCARTESIANPOINT((0.,0.));
{extra_entities}
#22=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#20,{axis2_ref},#21,$);
#30=IFCMAPPEDITEM(#16,#22);
#40=IFCLOCALPLACEMENT($,#5);
#50=IFCSHAPEREPRESENTATION(#2,'Annotation','MappedRepresentation',(#30));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#52=IFCANNOTATION('1xScRe4drECQ4DMSqUjd6d',$,'Note',$,$,#40,#51);
ENDSEC;
END-ISO-10303-21;
"#
    )
}

/// Non-mirrored MappingTarget (`Axis2 = $`, default right-handed
/// perpendicular): the mapped endpoint stays where it always did — this pins
/// the regression risk, not the new capability.
#[test]
fn non_mirroring_axis2_null_is_unchanged() {
    let data = extract_symbolic_data(&fixture("", "$"));
    let pl = data
        .polylines
        .iter()
        .find(|p| p.representation == "Annotation")
        .expect("mapped annotation polyline");
    assert_eq!(pl.points.len(), 6, "3-point polyline -> 6 floats");
    assert_eq!((pl.points[0], pl.points[1]), (0.0, 0.0), "start point");
    let (ex, ey) = (pl.points[2], pl.points[3]);
    assert!((ex - 1.0).abs() < 1e-5, "non-mirrored endpoint x: {ex}");
    assert!((ey - -2.0).abs() < 1e-5, "non-mirrored endpoint y: {ey}");
}

/// Mirroring MappingTarget (`Axis2 = (0, -1)`, disagreeing with the
/// right-handed perpendicular of Axis1): the mapped endpoint's Y must flip
/// relative to the non-mirrored case above. This is the RED case: before the
/// fix, `Transform2D` could not represent a reflection at all, so Axis2 was
/// never even read and this endpoint came out identical to the non-mirrored
/// fixture.
#[test]
fn mirroring_axis2_flips_the_mapped_geometry() {
    let content = fixture("#23=IFCDIRECTION((0.,-1.));", "#23");
    let data = extract_symbolic_data(&content);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.representation == "Annotation")
        .expect("mapped annotation polyline");
    assert_eq!(pl.points.len(), 6, "3-point polyline -> 6 floats");
    assert_eq!((pl.points[0], pl.points[1]), (0.0, 0.0), "start point");
    let (ex, ey) = (pl.points[2], pl.points[3]);
    assert!((ex - 1.0).abs() < 1e-5, "mirrored endpoint x: {ex}");
    assert!(
        (ey - 2.0).abs() < 1e-5,
        "mirrored endpoint y should flip sign vs the non-mirrored case: {ey}"
    );

    // Chirality, not just position. A single moved point cannot distinguish a
    // reflection from some rotation about the preserved origin — the endpoint
    // above is reachable either way. Signed area over three non-collinear
    // points can: a rotation preserves its sign, a reflection inverts it. The
    // authored winding is positive (see `non_mirroring_axis2_null_is_unchanged`),
    // so a genuine mirror must come out negative.
    assert!(
        signed_area(&pl.points) < 0.0,
        "a reflection must invert the winding, not merely move points; got {:?}",
        pl.points
    );
}

/// Twice the signed area of the polygon through a flat `[x, y, x, y, ...]`
/// point list (the shoelace sum). Sign is the chirality: positive for
/// counter-clockwise, negative once reflected.
fn signed_area(points: &[f32]) -> f32 {
    let n = points.len() / 2;
    let mut sum = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        sum += points[2 * i] * points[2 * j + 1] - points[2 * j] * points[2 * i + 1];
    }
    sum
}

/// Rotation-only MappingTarget (no mirror): `Axis1 = (0, 1)` is a plain 90°
/// rotation with `Axis2` absent (defaults to the perpendicular). Pins that
/// ordinary rotation is unaffected by the full-2x2 representation change.
#[test]
fn pure_rotation_is_unchanged() {
    let content = fixture("", "$").replace(
        "#20=IFCDIRECTION((1.,0.));",
        "#20=IFCDIRECTION((0.,1.));",
    );
    let data = extract_symbolic_data(&content);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.representation == "Annotation")
        .expect("mapped annotation polyline");
    let (ex, ey) = (pl.points[2], pl.points[3]);
    // Local (1, 2) rotated 90° CCW (X -> (0,1), Y -> (-1,0)) = (1*0 + 2*-1, 1*1 + 2*0) = (-2, 1).
    // Display Y-flip: (-2, -1).
    assert!((ex - -2.0).abs() < 1e-5, "rotated endpoint x: {ex}");
    assert!((ey - -1.0).abs() < 1e-5, "rotated endpoint y: {ey}");
}

/// Uniform-scale MappingTarget (no mirror): `Scale = 2` with the default
/// (identity) axes. Pins that `Transform2D::scale()` (now `sqrt(|det|)`)
/// still recovers a plain uniform scale exactly.
#[test]
fn uniform_scale_is_unchanged() {
    let content = fixture("", "$").replace(
        "#22=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#20,$,#21,$);",
        "#22=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#20,$,#21,2.);",
    );
    let data = extract_symbolic_data(&content);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.representation == "Annotation")
        .expect("mapped annotation polyline");
    let (ex, ey) = (pl.points[2], pl.points[3]);
    assert!((ex - 2.0).abs() < 1e-5, "scaled endpoint x: {ex}");
    assert!((ey - -4.0).abs() < 1e-5, "scaled endpoint y: {ey}");
}

/// Translation-only MappingTarget (no mirror): a non-zero `LocalOrigin`.
/// Pins that translation composition is unaffected.
#[test]
fn translation_is_unchanged() {
    let content = fixture("", "$").replace(
        "#21=IFCCARTESIANPOINT((0.,0.));",
        "#21=IFCCARTESIANPOINT((5.,7.));",
    );
    let data = extract_symbolic_data(&content);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.representation == "Annotation")
        .expect("mapped annotation polyline");
    let (sx, sy) = (pl.points[0], pl.points[1]);
    let (ex, ey) = (pl.points[2], pl.points[3]);
    assert!((sx - 5.0).abs() < 1e-5, "start x: {sx}");
    assert!((sy - -7.0).abs() < 1e-5, "start y: {sy}");
    assert!((ex - 6.0).abs() < 1e-5, "translated endpoint x: {ex}");
    assert!((ey - -9.0).abs() < 1e-5, "translated endpoint y: {ey}");
}

/// Identity MappingTarget must still be recognised as identity: `mod.rs`'s
/// combined-transform fast-path check reads the full 2x2 now, so an all-
/// identity chain (no scale, no rotation, no mirror, no translation) has to
/// still take the `placement_transform`-only branch rather than always
/// composing in a context transform. Not directly observable from
/// `SymbolicData` alone, so this asserts the plain-identity geometry still
/// lands exactly where authored (a regression here would show as an
/// off-by-epsilon or NaN, not a crash).
#[test]
fn identity_mapping_target_lands_unmoved() {
    let data = extract_symbolic_data(&fixture("", "$"));
    let pl = data
        .polylines
        .iter()
        .find(|p| p.representation == "Annotation")
        .expect("mapped annotation polyline");
    let (sx, sy) = (pl.points[0], pl.points[1]);
    assert_eq!((sx, sy), (0.0, 0.0), "identity start point");
}
