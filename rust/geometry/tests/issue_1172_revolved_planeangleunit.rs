// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #1172 — IfcRevolvedAreaSolid.Angle is an
//! IfcPlaneAngleMeasure expressed in the project's PLANEANGLEUNIT, not
//! unconditionally radians.
//!
//! The Advance-Steel-exported `RusFal20.03.23.ifc` declares
//! `IFCCONVERSIONBASEDUNIT(...,.PLANEANGLEUNIT.,'DEGREE',...)` and authors a
//! curved FL8x100 plate as a rectangle revolved 25.35° around an axis ~14.7 m
//! from the profile:
//!
//! ```text
//! #62040 = IFCREVOLVEDAREASOLID(#1110, #62080, #62050, 25.350156597);
//! ```
//!
//! Before the fix, `swept.rs::RevolvedAreaSolidProcessor` used the raw value
//! as radians. 25.35 rad ≈ 1452° ≈ 4 full turns, so the `full_circle` branch
//! fired and the plate rendered as a complete ~14.7 m-radius ring — the
//! "huge circle" bug. After the fix the processor multiplies by
//! `decoder.plane_angle_to_radians()` (π/180 for DEGREE files, 1.0 for RADIAN
//! files — see issue #820 for the same bug on IfcTrimmedCurve parameters).
//!
//! Self-contained: the inline model below is a minimal IFC2X3 reproduction so
//! the test needs no downloaded fixture.

use ifc_lite_core::{build_entity_index, EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

/// Rectangle 100×8 mm revolved 90° around an X-axis at y = 14738.6 mm, in a
/// file whose PLANEANGLEUNIT is DEGREE. A correct quarter-circle sweep spans
/// ≈ 14.7 m (the radius); the pre-fix bug treats 90 as radians (≈14 turns →
/// `full_circle`) and produces the full ≈ 29.5 m-diameter ring.
const DEGREE_REVOLVE_IFC: &str = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('issue_1172.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#10=IFCPROJECT('0qLQAFtMz86g0DvV8YPsGD',$,'',$,$,$,$,(#20),#70);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT('','Model',3,1.E-9,#30,$);
#30=IFCAXIS2PLACEMENT3D(#60,#40,#50);
#40=IFCDIRECTION((0.,0.,1.));
#50=IFCDIRECTION((1.,0.,0.));
#60=IFCCARTESIANPOINT((0.,0.,0.));
#70=IFCUNITASSIGNMENT((#80,#110));
#80=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#110=IFCCONVERSIONBASEDUNIT(#140,.PLANEANGLEUNIT.,'DEGREE',#120);
#120=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.01745329),#130);
#130=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#140=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#1110=IFCRECTANGLEPROFILEDEF(.AREA.,'t8x100',#1120,100.,8.);
#1120=IFCAXIS2PLACEMENT2D(#1130,$);
#1130=IFCCARTESIANPOINT((0.,0.));
#62040=IFCREVOLVEDAREASOLID(#1110,#62080,#62050,90.);
#62050=IFCAXIS1PLACEMENT(#62070,#62060);
#62060=IFCDIRECTION((1.,0.,0.));
#62070=IFCCARTESIANPOINT((0.,14738.615548609,0.));
#62080=IFCAXIS2PLACEMENT3D(#62090,$,$);
#62090=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
";

const REVOLVE_ID: u32 = 62040;

fn mesh_bbox(positions: &[f32]) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(chunk[axis]);
            max[axis] = max[axis].max(chunk[axis]);
        }
    }
    (min, max)
}

#[test]
fn revolve_angle_honors_degree_planeangleunit() {
    let entity_index = build_entity_index(DEGREE_REVOLVE_IFC);
    let mut decoder = EntityDecoder::with_index(DEGREE_REVOLVE_IFC, entity_index);

    // Sanity: the decoder reads DEGREE from the unit assignment (#110), using
    // the file's declared conversion factor (0.01745329 — a rounded π/180).
    // The loose tolerance only needs to separate DEGREE from RADIAN (1.0).
    let scale = decoder.plane_angle_to_radians();
    assert!(
        (scale - std::f64::consts::PI / 180.0).abs() < 1e-6,
        "expected DEGREE scale ≈ π/180 for this file, got {scale}",
    );

    let router = GeometryRouter::new();
    let entity = decoder
        .decode_by_id(REVOLVE_ID)
        .expect("decode IfcRevolvedAreaSolid #62040");
    assert_eq!(entity.ifc_type, IfcType::IfcRevolvedAreaSolid);

    // `process_representation_item` keeps positions in raw file units (mm) and
    // skips any element placement, so the bbox is the bare revolved arc.
    let mesh = router
        .process_representation_item(&entity, &mut decoder)
        .expect("revolved solid tessellation must not error");

    assert!(
        !mesh.positions.is_empty() && !mesh.indices.is_empty(),
        "revolved mesh empty",
    );

    let (min, max) = mesh_bbox(&mesh.positions);
    let span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let max_span = span[0].max(span[1]).max(span[2]);

    // Radius from profile (y≈0) to the revolution axis (y=14738.6) is
    // ≈14738 mm. A correct 90° sweep spans ≈ one radius (~14.8 m). The pre-fix
    // bug interpreted 90 as radians → `full_circle`, producing the full
    // ≈2·radius ≈ 29.5 m-diameter ring. 20 m cleanly separates the two states.
    assert!(
        max_span < 20_000.0,
        "revolved-arc max span {max_span:.1} mm — expected < 20000 (≈14.8 m \
         quarter arc). A span near 29.5 m means the 90° angle was treated as \
         radians and swept a full ring (see swept.rs RevolvedAreaSolidProcessor \
         — must scale Angle by decoder.plane_angle_to_radians()). span={span:?}",
    );
    assert!(
        max_span > 10_000.0,
        "revolved-arc max span {max_span:.1} mm — expected ≈14.8 m; a tiny span \
         means the sweep collapsed. span={span:?}",
    );
}
