// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for two pre-existing defects in `symbolic/mod.rs`,
//! found while closing #2256 but independent of it (reported, not fixed,
//! in #2356's "Two pre-existing defects found in mod.rs" section):
//!
//!   1. `mod.rs` read `context.get_ref(2)` for
//!      `IfcGeometricRepresentationContext.WorldCoordinateSystem`, but that
//!      attribute is at index 4 (`rust/core/src/generated/schema.rs:9314`:
//!      `["ContextIdentifier", "ContextType", "CoordinateSpaceDimension",
//!      "Precision", "WorldCoordinateSystem", "TrueNorth"]` — index 2 is
//!      `CoordinateSpaceDimension`, an integer). `get_ref(2)` returned
//!      `None` for every conformant file, so a non-identity WCS was never
//!      composed into symbolic annotation placement.
//!   2. `combined_transform`'s "is this WCS trivial" gate tested only `tx`,
//!      `ty`, and the 2x2 rotation block, never `tz` — a WCS that is a pure
//!      vertical offset was discarded as trivial even once read correctly.
//!
//! Both must be fixed together: fixing the index alone without the gate
//! still drops a pure-Z-offset WCS, and the primary test below (a pure
//! Z-offset WCS) is RED against either defect independently.
//!
//! This file also proves the sentinel convention (#2352/#2355) is applied
//! correctly to the four sites this composition touches:
//!
//!   - `IfcRepresentation.ContextOfItems` is MANDATORY
//!     (`packages/codegen/schemas/IFC4_ADD2_TC1.exp:8737`: `ContextOfItems :
//!     IfcRepresentationContext;`, not `OPTIONAL`) — absent or dangling is
//!     malformed data, not a legitimate default.
//!   - `IfcGeometricRepresentationContext.WorldCoordinateSystem` is
//!     MANDATORY (`…:6209`: `WorldCoordinateSystem : IfcAxis2Placement;`,
//!     not `OPTIONAL`) — absent or dangling is likewise malformed.
//!   - `IfcGeometricRepresentationSubContext` legitimately has no WCS of
//!     its own — it is a `DERIVE`d attribute inherited from `ParentContext`
//!     (`…:6255`) — so a resolved SubContext must stay `identity()`, not
//!     `unresolved()`, and must NOT inherit the parent's WCS (matching the
//!     wasm pipeline, which also leaves this case alone).

use ifc_lite_processing::extract_symbolic_data;

const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-2256 mod.rs WCS fixture'),'2;1');
FILE_NAME('test.ifc','2026-08-07T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#12),#3);
#3=IFCUNITASSIGNMENT((#6));
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#40=IFCLOCALPLACEMENT($,#5);

/* Context A: pure Z-offset WCS (the critical case — hits both defects). */
#10=IFCCARTESIANPOINT((0.,0.,7.));
#11=IFCAXIS2PLACEMENT3D(#10,$,$);
#12=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',3,1.0E-5,#11,$);
#20=IFCCARTESIANPOINT((0.,0.));
#21=IFCCARTESIANPOINT((1.,0.));
#22=IFCCARTESIANPOINT((1.,1.));
#23=IFCCARTESIANPOINT((0.,1.));
#24=IFCCARTESIANPOINT((0.,0.));
#25=IFCPOLYLINE((#20,#21,#22,#23,#24));
#26=IFCSHAPEREPRESENTATION(#12,'Annotation','Annotation2D',(#25));
#27=IFCPRODUCTDEFINITIONSHAPE($,$,(#26));
#28=IFCANNOTATION('1xScRe4drECQ4DMSqUjdZA',$,'ZOffsetNote',$,$,#40,#27);

/* Context B: pure X/Y-offset WCS (proves x/y also compose, not just tz). */
#30=IFCCARTESIANPOINT((10.,20.,0.));
#31=IFCAXIS2PLACEMENT3D(#30,$,$);
#32=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',3,1.0E-5,#31,$);
#33=IFCCARTESIANPOINT((0.,0.));
#34=IFCCARTESIANPOINT((1.,0.));
#35=IFCCARTESIANPOINT((1.,1.));
#36=IFCCARTESIANPOINT((0.,1.));
#37=IFCCARTESIANPOINT((0.,0.));
#38=IFCPOLYLINE((#33,#34,#35,#36,#37));
#39=IFCSHAPEREPRESENTATION(#32,'Annotation','Annotation2D',(#38));
#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#39));
#42=IFCANNOTATION('2xScRe4drECQ4DMSqUjdXY',$,'XYOffsetNote',$,$,#40,#41);

/* Context C: WorldCoordinateSystem is a dangling ref (#9999 doesn't exist). */
#50=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',3,1.0E-5,#9999,$);
#51=IFCCARTESIANPOINT((0.,0.));
#52=IFCCARTESIANPOINT((1.,0.));
#53=IFCCARTESIANPOINT((1.,1.));
#54=IFCCARTESIANPOINT((0.,1.));
#55=IFCCARTESIANPOINT((0.,0.));
#56=IFCPOLYLINE((#51,#52,#53,#54,#55));
#57=IFCSHAPEREPRESENTATION(#50,'Annotation','Annotation2D',(#56));
#58=IFCPRODUCTDEFINITIONSHAPE($,$,(#57));
#59=IFCANNOTATION('3xScRe4drECQ4DMSqUjdWC',$,'DanglingWcsNote',$,$,#40,#58);

/* Context D: WorldCoordinateSystem attribute is null ($) — mandatory but absent. */
#61=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',3,1.0E-5,$,$);
#62=IFCCARTESIANPOINT((0.,0.));
#63=IFCCARTESIANPOINT((1.,0.));
#64=IFCCARTESIANPOINT((1.,1.));
#65=IFCCARTESIANPOINT((0.,1.));
#66=IFCCARTESIANPOINT((0.,0.));
#67=IFCPOLYLINE((#62,#63,#64,#65,#66));
#68=IFCSHAPEREPRESENTATION(#61,'Annotation','Annotation2D',(#67));
#69=IFCPRODUCTDEFINITIONSHAPE($,$,(#68));
#70=IFCANNOTATION('4xScRe4drECQ4DMSqUjdWN',$,'NullWcsNote',$,$,#40,#69);

/* ContextOfItems is a dangling ref (#9998 doesn't exist). */
#82=IFCCARTESIANPOINT((0.,0.));
#83=IFCCARTESIANPOINT((1.,0.));
#84=IFCCARTESIANPOINT((1.,1.));
#85=IFCCARTESIANPOINT((0.,1.));
#86=IFCCARTESIANPOINT((0.,0.));
#87=IFCPOLYLINE((#82,#83,#84,#85,#86));
#88=IFCSHAPEREPRESENTATION(#9998,'Annotation','Annotation2D',(#87));
#89=IFCPRODUCTDEFINITIONSHAPE($,$,(#88));
#90=IFCANNOTATION('5xScRe4drECQ4DMSqUjdDC',$,'DanglingContextNote',$,$,#40,#89);

/* ContextOfItems attribute is null ($) — mandatory but absent. */
#92=IFCCARTESIANPOINT((0.,0.));
#93=IFCCARTESIANPOINT((1.,0.));
#94=IFCCARTESIANPOINT((1.,1.));
#95=IFCCARTESIANPOINT((0.,1.));
#96=IFCCARTESIANPOINT((0.,0.));
#97=IFCPOLYLINE((#92,#93,#94,#95,#96));
#98=IFCSHAPEREPRESENTATION($,'Annotation','Annotation2D',(#97));
#99=IFCPRODUCTDEFINITIONSHAPE($,$,(#98));
#100=IFCANNOTATION('6xScRe4drECQ4DMSqUjdNC',$,'NullContextNote',$,$,#40,#99);

/* SubContext of Context A — must NOT inherit A's Z offset (bounding control). */
#105=IFCGEOMETRICREPRESENTATIONSUBCONTEXT($,'Body',*,*,*,*,#12,$,.MODEL_VIEW.,$);
#106=IFCCARTESIANPOINT((0.,0.));
#107=IFCCARTESIANPOINT((1.,0.));
#108=IFCCARTESIANPOINT((1.,1.));
#109=IFCCARTESIANPOINT((0.,1.));
#110=IFCCARTESIANPOINT((0.,0.));
#111=IFCPOLYLINE((#106,#107,#108,#109,#110));
#112=IFCSHAPEREPRESENTATION(#105,'Annotation','Annotation2D',(#111));
#113=IFCPRODUCTDEFINITIONSHAPE($,$,(#112));
#114=IFCANNOTATION('7xScRe4drECQ4DMSqUjdSC',$,'SubContextNote',$,$,#40,#113);

/* Context F: identity WCS (Location at origin, no rotation) — bounding
   control (a): a model with an identity WorldCoordinateSystem must produce
   byte-identical placement to today, proving the fix does not move every
   annotation in every existing model. */
#150=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',3,1.0E-5,#5,$);
#151=IFCCARTESIANPOINT((0.,0.));
#152=IFCCARTESIANPOINT((1.,0.));
#153=IFCCARTESIANPOINT((1.,1.));
#154=IFCCARTESIANPOINT((0.,1.));
#155=IFCCARTESIANPOINT((0.,0.));
#156=IFCPOLYLINE((#151,#152,#153,#154,#155));
#157=IFCSHAPEREPRESENTATION(#150,'Annotation','Annotation2D',(#156));
#158=IFCPRODUCTDEFINITIONSHAPE($,$,(#157));
#159=IFCANNOTATION('8xScRe4drECQ4DMSqUjdID',$,'IdentityNote',$,$,#40,#158);
ENDSEC;
END-ISO-10303-21;
"#;

fn polyline_for(express_id: u32) -> ifc_lite_processing::SymbolicPolyline {
    let data = extract_symbolic_data(FIXTURE);
    data.polylines
        .into_iter()
        .find(|p| p.express_id == express_id)
        .unwrap_or_else(|| panic!("annotation #{express_id} should produce a polyline"))
}

/// The critical test: a pure-Z-offset WCS must land on `world_y`. This is
/// RED against BOTH pre-existing defects — the wrong attribute index (WCS
/// never read) AND the gate that discards a WCS with zero tx/ty/rotation
/// even once it IS read.
#[test]
fn pure_z_offset_wcs_is_composed_into_world_y() {
    let pl = polyline_for(28);
    assert_eq!(
        pl.world_y, 7.0,
        "IfcGeometricRepresentationContext #12's WorldCoordinateSystem is a \
         pure Z=7 offset with identity ObjectPlacement; world_y must reflect \
         it. Got: {}",
        pl.world_y
    );
}

/// A WCS with an X/Y offset must also compose into the annotation's plan
/// coordinates, not just its elevation.
#[test]
fn xy_offset_wcs_is_composed_into_plan_coordinates() {
    let pl = polyline_for(42);
    assert_eq!(pl.points[0], 10.0, "x should be shifted by WCS tx=10");
    assert_eq!(pl.points[1], -20.0, "y (screen, flipped) should be shifted by WCS ty=20");
}

/// A dangling `WorldCoordinateSystem` ref is malformed data (the attribute
/// is mandatory) — must be `unresolved()`, not silently `identity()`.
#[test]
fn dangling_wcs_ref_is_not_finite() {
    let pl = polyline_for(59);
    assert!(
        !pl.world_y.is_finite(),
        "WorldCoordinateSystem #9999 does not exist. world_y must be \
         non-finite, not silently 0.0. Got: {}",
        pl.world_y
    );
}

/// A null (absent) `WorldCoordinateSystem` on an otherwise-resolved context
/// is malformed data (the attribute is mandatory) — must be `unresolved()`.
#[test]
fn null_wcs_on_mandatory_attr_is_not_finite() {
    let pl = polyline_for(70);
    assert!(
        !pl.world_y.is_finite(),
        "WorldCoordinateSystem is null on a mandatory attribute. world_y \
         must be non-finite, not silently 0.0. Got: {}",
        pl.world_y
    );
}

/// A dangling `ContextOfItems` ref is malformed data (the attribute is
/// mandatory) — must be `unresolved()`.
#[test]
fn dangling_context_ref_is_not_finite() {
    let pl = polyline_for(90);
    assert!(
        !pl.world_y.is_finite(),
        "ContextOfItems #9998 does not exist. world_y must be non-finite, \
         not silently 0.0. Got: {}",
        pl.world_y
    );
}

/// A null (absent) `ContextOfItems` is malformed data (the attribute is
/// mandatory) — must be `unresolved()`.
#[test]
fn null_context_on_mandatory_attr_is_not_finite() {
    let pl = polyline_for(100);
    assert!(
        !pl.world_y.is_finite(),
        "ContextOfItems is null on a mandatory attribute. world_y must be \
         non-finite, not silently 0.0. Got: {}",
        pl.world_y
    );
}

/// Bounding control: an `IfcGeometricRepresentationSubContext` legitimately
/// has no inline WCS (it's `DERIVE`d from `ParentContext`) and must resolve
/// as `identity()` — NOT `unresolved()` (it's not malformed), and NOT
/// inheriting the parent's Z=7 offset (mod.rs deliberately doesn't walk
/// `ParentContext`, matching the wasm pipeline).
#[test]
fn subcontext_stays_identity_and_does_not_inherit_parent_wcs() {
    let pl = polyline_for(114);
    assert_eq!(
        pl.world_y, 0.0,
        "a resolved SubContext must resolve to identity(): finite zero, not \
         the parent context's Z=7 offset and not unresolved(). Got: {}",
        pl.world_y
    );
    assert!(pl.world_y.is_finite());
}

/// Bounding control (a): an identity `WorldCoordinateSystem` (Location at
/// the origin, no rotation) must produce byte-identical placement to today
/// — proving the fix does not move every annotation in every existing
/// model, only ones that actually carry a non-identity WCS. Also covers
/// bounding control (b): a genuine zero elevation stays exactly `0.0`, not
/// non-finite, as a side effect of making the WCS composition live.
#[test]
fn identity_wcs_context_is_byte_identical_to_pre_fix_placement() {
    let pl = polyline_for(159);
    assert_eq!(pl.points[0], 0.0, "identity WCS must not move x");
    assert_eq!(pl.points[1], 0.0, "identity WCS must not move y");
    assert_eq!(
        pl.world_y, 0.0,
        "identity WCS: a genuine zero elevation must stay exactly 0.0, not \
         non-finite. Got: {}",
        pl.world_y
    );
    assert!(pl.world_y.is_finite());
}
