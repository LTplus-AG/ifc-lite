// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #2256 — a symbolic primitive at world Y = 0 is AT DATUM, and must
//! not be confused with one whose elevation the extractor never resolved.
//!
//! The viewer buckets symbolic annotations by `world_y`, falling back to the
//! storey table when the extractor could not resolve one. That fallback needs
//! a truthful "could not resolve" signal. The extractor used to default every
//! missing contribution to `0.0`, so the consumer guessed with `world_y !== 0`
//! and every ground-floor annotation was treated as unresolved — re-bucketed
//! onto whatever the storey table said, or dropped into the loose bucket for
//! the hierarchy-less exports (3DEXPERIENCE / IfcPlusPlus) that priority order
//! was written for in the first place.
//!
//! The producer now says "no elevation" with `f32::NAN`, so `is_finite` alone
//! separates the two. Everything below is the same fixture parsed once: what
//! matters is that entities differing ONLY in whether the file states an
//! elevation come out different.

use ifc_lite_processing::{extract_symbolic_data, SymbolicData};

/// One file, one storey-less export, several products that differ only in
/// where (and whether) their elevation is authored.
///
/// - `#21` polyline, placement Location `(0.,0.,0.)` — authored AT DATUM.
/// - `#31` polyline, NO `ObjectPlacement`, 2D points — nothing authored.
/// - `#43` / `#53` polylines at `+5` / `-3.5` — the unambiguous controls.
/// - `#65` polyline, no placement, but 3D points at `Z = 0.` — datum from the
///   geometry rather than the placement.
/// - `#75` polyline under a 2D placement chain — an `IfcAxis2Placement2D`
///   Location has no Z to give, so this is unresolved too.
/// - `#85` circle, `#95` text, `#105` fill: the other three primitive kinds,
///   each at datum via an explicit placement Z.
/// - `#115` circle / `#125` text / `#135` fill: the same three with nothing
///   authored anywhere.
/// - `#150` grid with placement Z `0.`, `#170` grid with no placement.
const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-2256 fixture'),'2;1');
FILE_NAME('t.ifc','2026-08-08T00:00:00',(''),(''),'','','');
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
#11=IFCCARTESIANPOINT((1.,0.));
#12=IFCCARTESIANPOINT((1.,1.));
#13=IFCPOLYLINE((#10,#11,#12));
#14=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#13));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));

#20=IFCLOCALPLACEMENT($,#5);
#21=IFCANNOTATION('1xScRe4drECQ4DMSqUjd6d',$,'datum',$,$,#20,#15);

#31=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'nowhere',$,$,$,#15);

#40=IFCCARTESIANPOINT((0.,0.,5.));
#41=IFCAXIS2PLACEMENT3D(#40,$,$);
#42=IFCLOCALPLACEMENT($,#41);
#43=IFCANNOTATION('3xScRe4drECQ4DMSqUjd6d',$,'upper',$,$,#42,#15);

#50=IFCCARTESIANPOINT((0.,0.,-3.5));
#51=IFCAXIS2PLACEMENT3D(#50,$,$);
#52=IFCLOCALPLACEMENT($,#51);
#53=IFCANNOTATION('4xScRe4drECQ4DMSqUjd6d',$,'basement',$,$,#52,#15);

#60=IFCCARTESIANPOINT((0.,0.,0.));
#61=IFCCARTESIANPOINT((1.,0.,0.));
#62=IFCPOLYLINE((#60,#61));
#63=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#62));
#64=IFCPRODUCTDEFINITIONSHAPE($,$,(#63));
#65=IFCANNOTATION('5xScRe4drECQ4DMSqUjd6d',$,'geomdatum',$,$,$,#64);

#70=IFCCARTESIANPOINT((2.,2.));
#71=IFCAXIS2PLACEMENT2D(#70,$);
#72=IFCLOCALPLACEMENT($,#71);
#75=IFCANNOTATION('6xScRe4drECQ4DMSqUjd6d',$,'flat',$,$,#72,#15);

#80=IFCCARTESIANPOINT((0.,0.));
#81=IFCAXIS2PLACEMENT2D(#80,$);
#82=IFCCIRCLE(#81,1.);
#83=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#82));
#84=IFCPRODUCTDEFINITIONSHAPE($,$,(#83));
#85=IFCANNOTATION('7xScRe4drECQ4DMSqUjd6d',$,'circle-datum',$,$,#20,#84);
#115=IFCANNOTATION('8xScRe4drECQ4DMSqUjd6d',$,'circle-nowhere',$,$,$,#84);

#90=IFCCARTESIANPOINT((0.,0.));
#91=IFCAXIS2PLACEMENT2D(#90,$);
#92=IFCPLANAREXTENT(1.,0.4);
#93=IFCTEXTLITERALWITHEXTENT('label',#91,.RIGHT.,#92,'center');
#94=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#93));
#96=IFCPRODUCTDEFINITIONSHAPE($,$,(#94));
#95=IFCANNOTATION('9xScRe4drECQ4DMSqUjd6d',$,'text-datum',$,$,#20,#96);
#125=IFCANNOTATION('AxScRe4drECQ4DMSqUjd6d',$,'text-nowhere',$,$,$,#96);

#100=IFCCARTESIANPOINT((0.,0.));
#101=IFCCARTESIANPOINT((2.,0.));
#102=IFCCARTESIANPOINT((2.,2.));
#103=IFCCARTESIANPOINT((0.,0.));
#104=IFCPOLYLINE((#100,#101,#102,#103));
#106=IFCANNOTATIONFILLAREA(#104,$);
#107=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#106));
#108=IFCPRODUCTDEFINITIONSHAPE($,$,(#107));
#105=IFCANNOTATION('BxScRe4drECQ4DMSqUjd6d',$,'fill-datum',$,$,#20,#108);
#135=IFCANNOTATION('CxScRe4drECQ4DMSqUjd6d',$,'fill-nowhere',$,$,$,#108);

#140=IFCCARTESIANPOINT((0.,0.));
#141=IFCCARTESIANPOINT((10.,0.));
#142=IFCPOLYLINE((#140,#141));
#143=IFCGRIDAXIS('A',#142,.T.);
#150=IFCGRID('DxScRe4drECQ4DMSqUjd6d',$,'grid-datum',$,$,#20,$,(#143),$,$);
#170=IFCGRID('ExScRe4drECQ4DMSqUjd6d',$,'grid-nowhere',$,$,$,$,(#143),$,$);
ENDSEC;
END-ISO-10303-21;
"#;

fn parse() -> SymbolicData {
    extract_symbolic_data(FIXTURE)
}

fn polyline_world_y(data: &SymbolicData, express_id: u32) -> f32 {
    data.polylines
        .iter()
        .find(|p| p.express_id == express_id)
        .unwrap_or_else(|| panic!("no polyline for #{express_id}"))
        .world_y
}

/// The defect, stated directly: datum and unknown must not be the same number.
#[test]
fn datum_and_unresolved_are_distinguishable() {
    let data = parse();

    let datum = polyline_world_y(&data, 21);
    let unresolved = polyline_world_y(&data, 31);

    assert_eq!(datum, 0.0, "an authored Location Z of 0. is an elevation of 0");
    assert!(
        !datum.is_nan(),
        "an authored datum elevation must not read as unresolved"
    );
    assert!(
        unresolved.is_nan(),
        "a product with no ObjectPlacement and 2D-only geometry has no elevation, got {unresolved}"
    );
    // The assertion the old code could not make: these two are DIFFERENT.
    assert!(
        datum.is_nan() != unresolved.is_nan(),
        "datum and unresolved collapsed onto the same value again"
    );
}

/// Elevations that were never ambiguous, pinned so the sentinel work cannot
/// quietly break them. The negative one is a basement storey — the other half
/// of the same "valid but falsy" boundary.
#[test]
fn ordinary_elevations_are_unchanged() {
    let data = parse();
    assert_eq!(polyline_world_y(&data, 43), 5.0);
    assert_eq!(polyline_world_y(&data, 53), -3.5);
    assert!(!polyline_world_y(&data, 53).is_nan());
}

/// Datum can also come from the geometry rather than the placement, and a 2D
/// placement chain supplies no elevation at all.
#[test]
fn elevation_can_come_from_either_source_and_neither() {
    let data = parse();
    assert_eq!(
        polyline_world_y(&data, 65),
        0.0,
        "an explicit Z=0. on the curve's points is an authored datum"
    );
    assert!(
        polyline_world_y(&data, 75).is_nan(),
        "an IfcAxis2Placement2D Location has no Z ordinate to contribute"
    );
}

/// Same boundary for the other three primitive kinds, since each has its own
/// producer path (circle centre, text placement composition, fill boundary
/// sampling). Fixing only the polyline path would leave three copies.
#[test]
fn every_primitive_kind_carries_the_sentinel() {
    let data = parse();

    let circle = |id: u32| {
        data.circles
            .iter()
            .find(|c| c.express_id == id)
            .unwrap_or_else(|| panic!("no circle for #{id}"))
            .world_y
    };
    assert_eq!(circle(85), 0.0, "circle under a Z=0. placement is at datum");
    assert!(circle(115).is_nan(), "unplaced circle has no elevation");

    let text = |id: u32| {
        data.texts
            .iter()
            .find(|t| t.express_id == id)
            .unwrap_or_else(|| panic!("no text for #{id}"))
            .world_y
    };
    assert_eq!(text(95), 0.0, "text under a Z=0. placement is at datum");
    assert!(text(125).is_nan(), "unplaced text has no elevation");

    let fill = |id: u32| {
        data.fills
            .iter()
            .find(|f| f.express_id == id)
            .unwrap_or_else(|| panic!("no fill for #{id}"))
            .world_y
    };
    assert_eq!(fill(105), 0.0, "fill under a Z=0. placement is at datum");
    assert!(fill(135).is_nan(), "unplaced fill has no elevation");
}

/// Grid axes go through `extract_grid`, a fourth producer path.
#[test]
fn grid_axes_carry_the_sentinel() {
    let data = parse();
    let axis = |grid_id: u32| {
        data.grid_axes
            .iter()
            .find(|a| a.grid_express_id == grid_id)
            .unwrap_or_else(|| panic!("no axis for grid #{grid_id}"))
            .world_y
    };
    assert_eq!(axis(150), 0.0, "grid under a Z=0. placement is at datum");
    assert!(axis(170).is_nan(), "unplaced grid has no elevation");
}
