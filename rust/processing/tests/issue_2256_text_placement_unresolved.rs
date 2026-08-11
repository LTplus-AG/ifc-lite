// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for `text.rs`'s half of issue #2256, the last two of the
//! six sites #2352/#2355 flagged as remaining in `symbolic/`.
//!
//! `extract_text_literal` resolves `IfcTextLiteral.Placement` (attribute 1),
//! which is MANDATORY per schema (`packages/codegen/schemas/
//! IFC4_ADD2_TC1.exp`: `ENTITY IfcTextLiteral … Placement :
//! IfcAxis2Placement;` — not `OPTIONAL`). Both the `Err(_)` (dangling ref)
//! and `None` (absent/null attribute) arms were falling back to
//! `Transform2D::identity()` (`tz: 0.0`), bit-for-bit indistinguishable from
//! a real ground-floor elevation.
//!
//! Three annotations, each carrying one `IfcTextLiteralWithExtent`:
//!
//!   * `#200` — `Placement` resolves cleanly to Z = 0. Genuine ground-floor
//!     elevation; `world_y` must stay exactly `0.0` (bounding control).
//!   * `#300` — `Placement` is a dangling reference (`#999999` does not
//!     exist). `world_y` must be non-finite.
//!   * `#400` — `Placement` is null (`$`) on a mandatory attribute —
//!     malformed data. `world_y` must be non-finite.

use ifc_lite_processing::extract_symbolic_data;

const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-2256 text-placement fixture'),'2;1');
FILE_NAME('test.ifc','2026-08-07T00:00:00',(''),(''),'','','');
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

/* ---- #200: text literal, Placement resolves, genuine Z=0 ---- */
#210=IFCCARTESIANPOINT((0.,0.));
#211=IFCAXIS2PLACEMENT2D(#210,$);
#220=IFCPLANAREXTENT(1.,1.);
#230=IFCTEXTLITERALWITHEXTENT('Good',#211,.LEFT.,#220,'bottom-left');
#240=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#230));
#241=IFCPRODUCTDEFINITIONSHAPE($,$,(#240));
#200=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'GoodText',$,$,#40,#241);

/* ---- #300: Placement is a dangling reference ---- */
#320=IFCPLANAREXTENT(1.,1.);
#330=IFCTEXTLITERALWITHEXTENT('Dangling',#999999,.LEFT.,#320,'bottom-left');
#340=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#330));
#341=IFCPRODUCTDEFINITIONSHAPE($,$,(#340));
#300=IFCANNOTATION('3xScRe4drECQ4DMSqUjd6d',$,'DanglingPlacement',$,$,#40,#341);

/* ---- #400: Placement is null on a mandatory attribute ---- */
#420=IFCPLANAREXTENT(1.,1.);
#430=IFCTEXTLITERALWITHEXTENT('Null',$,.LEFT.,#420,'bottom-left');
#440=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#430));
#441=IFCPRODUCTDEFINITIONSHAPE($,$,(#440));
#400=IFCANNOTATION('4xScRe4drECQ4DMSqUjd6d',$,'NullPlacement',$,$,#40,#441);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn genuine_zero_elevation_text_stays_finite_zero() {
    let data = extract_symbolic_data(FIXTURE);
    let t = data
        .texts
        .iter()
        .find(|t| t.express_id == 200)
        .expect("text literal for annotation #200 should be extracted");
    assert_eq!(
        t.world_y, 0.0,
        "Placement resolves cleanly to Z=0 — a genuine ground-floor \
         elevation on an IfcTextLiteral must stay exactly 0.0, not become \
         non-finite"
    );
    assert!(t.world_y.is_finite());
}

#[test]
fn dangling_text_placement_ref_is_not_finite() {
    let data = extract_symbolic_data(FIXTURE);
    let t = data
        .texts
        .iter()
        .find(|t| t.express_id == 300)
        .expect("text literal for annotation #300 should still be extracted (Placement resolution failure does not drop the item)");
    assert!(
        !t.world_y.is_finite(),
        "IfcTextLiteralWithExtent #330 (annotation #300)'s Placement (#999999) does not \
         exist — ifc-lite cannot resolve an elevation for this text. \
         world_y must be non-finite (NaN), not silently 0.0, or it becomes \
         indistinguishable from a genuine ground-floor annotation \
         (issue #2256). Got: {}",
        t.world_y
    );
}

#[test]
fn null_text_placement_on_mandatory_attr_is_not_finite() {
    let data = extract_symbolic_data(FIXTURE);
    let t = data
        .texts
        .iter()
        .find(|t| t.express_id == 400)
        .expect("text literal for annotation #400 should still be extracted (a null Placement does not drop the item)");
    assert!(
        !t.world_y.is_finite(),
        "IfcTextLiteralWithExtent #430 (annotation #400)'s Placement is null ($) — a \
         MANDATORY attribute per schema — so this is malformed data, not a \
         legitimate default. world_y must be non-finite (NaN), not silently \
         0.0 (issue #2256). Got: {}",
        t.world_y
    );
}
