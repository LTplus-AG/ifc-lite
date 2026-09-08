// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A wall whose `IfcExtrudedAreaSolid.SweptArea` cannot be resolved is a real
//! decode/extraction failure (a malformed or truncated file, not a type this
//! extractor deliberately skips): `extract_extruded_solid` returns `Err`, and
//! that element's 2D construction-drawing footprint is dropped.
//!
//! Before the fix, the ONLY signal for that drop was `diag_debug!`'s legacy
//! leg, itself gated `#[cfg(feature = "debug_geometry")]`. Neither
//! `debug_geometry` nor `observability` is a default feature (see
//! `rust/geometry/Cargo.toml`, `default = []`), and the shipped wasm build
//! (`scripts/build-wasm.sh`) never passes either flag unless `DEBUG_GEOMETRY=1`
//! is set locally — so in the browser build every user actually runs, a wall
//! silently vanishes from the generated 2D drawing with nothing to tell the
//! user or an operator that anything was lost.
//!
//! `extract_profiles_with_diagnostics` is the fix: same walk, but it also
//! returns which elements were dropped and why, with default features (no
//! `debug_geometry`/`observability` needed) — so the signal survives into the
//! shipped build. `extract_profiles` (the pre-existing, still-used-by-export
//! entry point) is untouched: same signature, same output, RED here is about
//! visibility, not behaviour.

use ifc_lite_geometry::{extract_profiles, extract_profiles_with_diagnostics};

/// One healthy wall (`#100`) with a normal rectangular `SweptArea`, and one
/// "wall" (`#500`) whose `IfcExtrudedAreaSolid` (`#540`) SweptArea attribute
/// (`#530`) references express id `#999999`, which does not exist in the
/// file — the STEP-level equivalent of a truncated/corrupted reference.
const IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('shipped-profile-drop-signal fixture'),'2;1');
FILE_NAME('issue_shipped_profile_drop_signal.ifc','2026-09-02T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0ShippedDropSignal00A',$,'ShippedDropSignal',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#110=IFCLOCALPLACEMENT($,#111);
#111=IFCAXIS2PLACEMENT3D(#12,$,$);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,'GoodWall',#131,4.0,0.3);
#131=IFCAXIS2PLACEMENT2D(#132,#133);
#132=IFCCARTESIANPOINT((0.,0.));
#133=IFCDIRECTION((1.,0.));
#140=IFCEXTRUDEDAREASOLID(#130,#141,#142,2.5);
#141=IFCAXIS2PLACEMENT3D(#12,$,$);
#142=IFCDIRECTION((0.,0.,1.));
#150=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));
#151=IFCPRODUCTDEFINITIONSHAPE($,$,(#150));
#100=IFCWALL('0ShippedDropSignalWlA',$,'GoodWall',$,$,#110,#151,$,$);
#510=IFCLOCALPLACEMENT($,#511);
#511=IFCAXIS2PLACEMENT3D(#512,$,$);
#512=IFCCARTESIANPOINT((10.,0.,0.));
#540=IFCEXTRUDEDAREASOLID(#999999,#141,#142,2.5);
#550=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#540));
#551=IFCPRODUCTDEFINITIONSHAPE($,$,(#550));
#500=IFCWALL('0ShippedDropSignalWlB',$,'BrokenWall',$,$,#510,#551,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn broken_wall_is_dropped_from_the_2d_drawing() {
    let profiles = extract_profiles(IFC, 0);
    assert_eq!(
        profiles.len(),
        1,
        "the broken wall's SweptArea cannot resolve, so it must not emit a profile: {profiles:?}"
    );
    assert_eq!(profiles[0].express_id, 100, "the healthy wall must still extract");
}

/// GREEN: with default features (no `debug_geometry`, no `observability` —
/// the exact feature set the shipped wasm build ships), the diagnostics path
/// still reports the drop.
#[test]
fn dropped_wall_is_reported_with_default_features() {
    let (profiles, skipped) = extract_profiles_with_diagnostics(IFC, 0);
    assert_eq!(profiles.len(), 1, "unchanged extraction behaviour");
    assert_eq!(
        skipped.len(),
        1,
        "the broken wall must be reported as skipped even with default (release-shaped) features: {skipped:?}"
    );
    assert_eq!(skipped[0].express_id, 500);
    assert_eq!(skipped[0].ifc_type, "IfcWall");
}

/// Control: a file where nothing is dropped must report zero skips — a
/// diagnostic that fires on a healthy file is worse than none.
#[test]
fn healthy_file_reports_no_skips() {
    let healthy = IFC.lines().filter(|l| !l.starts_with("#500=") && !l.starts_with("#540=") && !l.starts_with("#550=") && !l.starts_with("#551=") && !l.starts_with("#510=") && !l.starts_with("#511=") && !l.starts_with("#512=")).collect::<Vec<_>>().join("\n");
    let (profiles, skipped) = extract_profiles_with_diagnostics(&healthy, 0);
    assert_eq!(profiles.len(), 1);
    assert!(skipped.is_empty(), "a clean file must not produce any skip diagnostics: {skipped:?}");
}
