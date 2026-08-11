// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for two #2256-shaped defects flagged on PR #2355 by
//! maintainer review, both still open in `transform.rs` / `items.rs` after
//! the `IfcMappedItem` fix landed:
//!
//!   * `parse_axis2_placement_2d` falls back to `(0.0, 0.0, 0.0)` — a
//!     legitimate-looking resolved transform — when an `IfcAxis2Placement2D`
//!     / `IfcAxis2Placement3D`'s own mandatory `Location` (attribute 0) is a
//!     dangling reference or not an `IfcCartesianPoint`. The placement
//!     entity itself is correctly typed and reached through a normal
//!     `IfcLocalPlacement` chain — only its `Location` is malformed.
//!   * `extract_symbolic_item`'s `IfcMappedItem` branch calls
//!     `parse_axis2_placement_2d` / `parse_cartesian_transformation_operator`
//!     on whatever `MappingOrigin` / `MappingTarget` resolve to, without
//!     checking the resolved entity is actually the expected type first
//!     (unlike `resolve_placement_for_symbolic`, which does check). A
//!     `MappingOrigin` that resolves to some other entity (e.g. a bare
//!     `IfcCartesianPoint`, which has no `RefDirection` attribute) is read
//!     as an all-defaults identity transform instead of `unresolved()`.
//!
//! Both collapse a genuine resolution *failure* into a plausible-looking
//! zero/identity transform, indistinguishable from a real ground-floor
//! placement — exactly the #2256 defect shape, one level deeper.

use ifc_lite_processing::extract_symbolic_data;

const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-2355 wrong-type resolution fixture'),'2;1');
FILE_NAME('test.ifc','2026-08-08T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCLOCALPLACEMENT($,#5);

/* ---- #100: ground truth, resolves cleanly to genuine Z=0 ---- */
#110=IFCCARTESIANPOINT((0.,0.));
#111=IFCCARTESIANPOINT((1.,0.));
#112=IFCCARTESIANPOINT((1.,1.));
#113=IFCCARTESIANPOINT((0.,1.));
#114=IFCCARTESIANPOINT((0.,0.));
#120=IFCPOLYLINE((#110,#111,#112,#113,#114));
#130=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#120));
#131=IFCPRODUCTDEFINITIONSHAPE($,$,(#130));
#100=IFCANNOTATION('1xScRe4drECQ4DMSqUjd6d',$,'GenuineZero',$,$,#40,#131);

/* ---- #200: ObjectPlacement's RelativePlacement is a correctly-typed
   IFCAXIS2PLACEMENT3D, but ITS OWN Location (attr 0) is dangling (#999990
   does not exist). The placement chain is otherwise completely normal. ---- */
#210=IFCCARTESIANPOINT((5.,0.));
#211=IFCCARTESIANPOINT((6.,0.));
#212=IFCCARTESIANPOINT((6.,1.));
#213=IFCCARTESIANPOINT((5.,1.));
#214=IFCCARTESIANPOINT((5.,0.));
#220=IFCPOLYLINE((#210,#211,#212,#213,#214));
#230=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#220));
#231=IFCPRODUCTDEFINITIONSHAPE($,$,(#230));
#240=IFCAXIS2PLACEMENT3D(#999990,$,$);
#250=IFCLOCALPLACEMENT($,#240);
#200=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'DanglingLocationOnValidPlacement',$,$,#250,#231);

/* ---- #300: IfcMappedItem's MappingOrigin (RepresentationMap attr 0)
   resolves to an entity that EXISTS but is the WRONG type — a bare
   IFCCARTESIANPOINT instead of an IFCAXIS2PLACEMENT2D/3D. ---- */
#310=IFCCARTESIANPOINT((10.,0.));
#311=IFCCARTESIANPOINT((11.,0.));
#312=IFCCARTESIANPOINT((11.,1.));
#313=IFCCARTESIANPOINT((10.,1.));
#314=IFCCARTESIANPOINT((10.,0.));
#320=IFCPOLYLINE((#310,#311,#312,#313,#314));
#330=IFCSHAPEREPRESENTATION(#2,'Body','Curve2D',(#320));
#340=IFCCARTESIANPOINT((0.,0.));
/* Malformed on purpose: attr 0 of an IFCLOCALPLACEMENT is normally
   PlacementRelTo (an ObjectPlacement ref), but this file points it at
   #340, a genuine IFCCARTESIANPOINT — the STEP decoder resolves refs by
   id regardless of expected type, so #341's own express type is
   IfcLocalPlacement while its attr(0) coincidentally resolves to a real
   IfcCartesianPoint. This exercises the items.rs call site's type check
   in isolation: parse_axis2_placement_2d's OWN internal Location-fallback
   fix (transform.rs) cannot catch this, because attr(0) here legitimately
   decodes as an IfcCartesianPoint — only rejecting #341's outer type
   (IfcLocalPlacement is not IfcAxis2Placement2D/3D) catches it. */
#341=IFCLOCALPLACEMENT(#340,#340);
#350=IFCREPRESENTATIONMAP(#341,#330);
#360=IFCCARTESIANPOINT((0.,0.));
#361=IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#360,$);
#370=IFCMAPPEDITEM(#350,#361);
#380=IFCSHAPEREPRESENTATION(#2,'Annotation','MappedRepresentation',(#370));
#381=IFCPRODUCTDEFINITIONSHAPE($,$,(#380));
#300=IFCANNOTATION('3xScRe4drECQ4DMSqUjd6d',$,'WrongTypeMappingOrigin',$,$,#40,#381);

/* ---- #400: IfcMappedItem's MappingTarget (MappedItem attr 1) resolves
   to an entity that EXISTS but is the WRONG type — a bare IFCCARTESIANPOINT
   instead of an IFCCARTESIANTRANSFORMATIONOPERATOR2D/3D. ---- */
#410=IFCCARTESIANPOINT((15.,0.));
#411=IFCCARTESIANPOINT((16.,0.));
#412=IFCCARTESIANPOINT((16.,1.));
#413=IFCCARTESIANPOINT((15.,1.));
#414=IFCCARTESIANPOINT((15.,0.));
#420=IFCPOLYLINE((#410,#411,#412,#413,#414));
#430=IFCSHAPEREPRESENTATION(#2,'Body','Curve2D',(#420));
#440=IFCCARTESIANPOINT((0.,0.));
#441=IFCAXIS2PLACEMENT2D(#440,$);
#450=IFCREPRESENTATIONMAP(#441,#430);
#460=IFCCARTESIANPOINT((0.,0.));
#470=IFCMAPPEDITEM(#450,#460);
#480=IFCSHAPEREPRESENTATION(#2,'Annotation','MappedRepresentation',(#470));
#481=IFCPRODUCTDEFINITIONSHAPE($,$,(#480));
#400=IFCANNOTATION('4xScRe4drECQ4DMSqUjd6d',$,'WrongTypeMappingTarget',$,$,#40,#481);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn genuine_zero_elevation_stays_finite_zero() {
    let data = extract_symbolic_data(FIXTURE);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.express_id == 100)
        .expect("annotation #100 should produce a polyline");
    assert_eq!(
        pl.world_y, 0.0,
        "a fully-resolved chain to a real ground-floor elevation must stay \
         exactly 0.0 — bounding control proving the fix does not just \
         return NaN unconditionally"
    );
    assert!(pl.world_y.is_finite());
}

#[test]
fn dangling_location_on_correctly_typed_placement_is_not_finite() {
    let data = extract_symbolic_data(FIXTURE);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.express_id == 200)
        .expect("annotation #200 should still produce a polyline (points are independent of placement resolution)");
    assert!(
        !pl.world_y.is_finite(),
        "IFCAXIS2PLACEMENT3D #240 is the correct type reached through a \
         normal IfcLocalPlacement chain, but its own Location (#999990) is \
         a dangling reference. world_y must be non-finite (NaN), not \
         silently 0.0 — a resolved-looking (0,0,0) here is indistinguishable \
         from #100's genuine ground floor. Got: {}",
        pl.world_y
    );
}

#[test]
fn wrong_type_mapping_origin_is_not_finite() {
    let data = extract_symbolic_data(FIXTURE);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.express_id == 300)
        .expect("annotation #300 should still produce a polyline (points are independent of MappingOrigin resolution)");
    assert!(
        !pl.world_y.is_finite(),
        "IfcRepresentationMap #350's MappingOrigin (#341) exists but is an \
         IFCLOCALPLACEMENT, not an IFCAXIS2PLACEMENT2D/3D — parsing it as a \
         placement anyway (its attr(0) coincidentally decodes as a real \
         IfcCartesianPoint) silently produces a plausible identity \
         transform. world_y must be non-finite (NaN). Got: {}",
        pl.world_y
    );
}

#[test]
fn wrong_type_mapping_target_is_not_finite() {
    let data = extract_symbolic_data(FIXTURE);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.express_id == 400)
        .expect("annotation #400 should still produce a polyline (points are independent of MappingTarget resolution)");
    assert!(
        !pl.world_y.is_finite(),
        "IfcMappedItem #470's MappingTarget (#460) exists but is an \
         IFCCARTESIANPOINT, not an IFCCARTESIANTRANSFORMATIONOPERATOR2D/3D \
         — parsing it as an operator anyway silently produces a plausible \
         identity transform. world_y must be non-finite (NaN). Got: {}",
        pl.world_y
    );
}
