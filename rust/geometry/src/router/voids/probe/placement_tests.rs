// SPDX-License-Identifier: MPL-2.0
//! X2 (#8385): the rectangular probe reads its profile Position through
//! `Axis2Placement::read_2d`. Valid input keeps the old reader's bits; input
//! the old reader defaulted (origin, x ratio 1.0) now defers to the kernel.
use super::*;
use crate::profiles::ProfileProcessor;
use crate::TessellationQuality;
use ifc_lite_core::IfcSchema;

/// `#6` is a 2 x 1 `IfcRectangleProfileDef` whose Position is `position`
/// (`$` or a reference), `#10` its unit extrusion; `extra` adds records.
fn profile_step(position: &str, extra: &str) -> String {
    format!(
        "#6=IFCRECTANGLEPROFILEDEF(.AREA.,'R',{position},2.,1.);\n\
         #11=IFCDIRECTION((0.,0.,1.));\n\
         #10=IFCEXTRUDEDAREASOLID(#6,$,#11,1.);\n{extra}"
    )
}

/// `#6` with Position `#2 = IFCAXIS2PLACEMENT2D(#3, ref_direction)`, `#3`
/// the point `location`, and `#4` the direction `direction` when given.
fn placed(location: &str, ref_direction: &str, direction: Option<&str>) -> String {
    let mut extra = format!("#2=IFCAXIS2PLACEMENT2D(#3,{ref_direction});\n#3={location};\n");
    if let Some(direction) = direction {
        extra.push_str(&format!("#4={direction};\n"));
    }
    profile_step("#2", &extra)
}

/// The reader on main before X2, verbatim: `(off_x, off_y, cos, sin)`.
fn old_reader(profile: &DecodedEntity, decoder: &mut EntityDecoder) -> (f64, f64, f64, f64) {
    let (mut cos_t, mut sin_t, mut off_x, mut off_y) = (1.0, 0.0, 0.0, 0.0);
    if let Some(pos_attr) = profile.get(2) {
        if !pos_attr.is_null() {
            if let Ok(Some(pos)) = decoder.resolve_ref(pos_attr) {
                if let Some(loc_attr) = pos.get(0) {
                    if let Ok(Some(loc)) = decoder.resolve_ref(loc_attr) {
                        if let Some(c) = loc.get(0).and_then(|x| x.as_list()) {
                            off_x = c.first().and_then(|x| x.as_float()).unwrap_or(0.0);
                            off_y = c.get(1).and_then(|x| x.as_float()).unwrap_or(0.0);
                        }
                    }
                }
                if let Some(rd_attr) = pos.get(1) {
                    if !rd_attr.is_null() {
                        if let Ok(Some(rd)) = decoder.resolve_ref(rd_attr) {
                            if let Some(c) = rd.get(0).and_then(|x| x.as_list()) {
                                let dx = c.first().and_then(|x| x.as_float()).unwrap_or(1.0);
                                let dy = c.get(1).and_then(|x| x.as_float()).unwrap_or(0.0);
                                let n = (dx * dx + dy * dy).sqrt();
                                if n > 1e-12 {
                                    cos_t = dx / n;
                                    sin_t = dy / n;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    (off_x, off_y, cos_t, sin_t)
}

fn old(content: &str) -> (f64, f64, f64, f64) {
    let mut decoder = EntityDecoder::new(content);
    let profile = decoder.decode_by_id(6).unwrap();
    old_reader(&profile, &mut decoder)
}

/// The probe's reading of `#6` and the distinct records it refused.
fn probe(content: &str) -> (Option<(f64, f64, f64, f64)>, Vec<u32>) {
    let mut decoder = EntityDecoder::new(content);
    let profile = decoder.decode_by_id(6).unwrap();
    let read = GeometryRouter::new()
        .read_rect_profile_2d(&profile, &mut decoder)
        .map(|(x, y, off_x, off_y, cos_t, sin_t)| {
            assert_eq!((x, y), (2.0, 1.0));
            (off_x, off_y, cos_t, sin_t)
        });
    let mut refused = decoder.refused_record_ids();
    refused.sort_unstable();
    (read, refused)
}

/// The distinct records the exact kernel refuses meshing the same profile.
fn kernel_refusals(content: &str) -> Vec<u32> {
    let mut decoder = EntityDecoder::new(content);
    let profile = decoder.decode_by_id(6).unwrap();
    let _ = ProfileProcessor::new(IfcSchema::new()).process(&profile, &mut decoder, TessellationQuality::default());
    let mut refused = decoder.refused_record_ids();
    refused.sort_unstable();
    refused
}

fn bits(frame: (f64, f64, f64, f64)) -> [u64; 4] {
    [frame.0.to_bits(), frame.1.to_bits(), frame.2.to_bits(), frame.3.to_bits()]
}

#[test]
fn x2_valid_positions_keep_the_old_readers_bits() {
    let cases = [
        placed("IFCCARTESIANPOINT((0.,0.))", "#4", Some("IFCDIRECTION((1.,0.))")),
        placed("IFCCARTESIANPOINT((1.25,-3.5))", "#4", Some("IFCDIRECTION((3.,4.))")),
        placed("IFCCARTESIANPOINT((0.1,0.2))", "#4", Some("IFCDIRECTION((0.6,0.8))")),
        placed("IFCCARTESIANPOINT((7.,8.))", "#4", Some("IFCDIRECTION((-2.5,1.E-7))")),
        placed("IFCCARTESIANPOINT((-0.,5.))", "#4", Some("IFCDIRECTION((0.70710678118654757,-0.70710678118654746))")),
        placed("IFCCARTESIANPOINT((2,3))", "#4", Some("IFCDIRECTION((0,-17))")),
        placed("IFCCARTESIANPOINT((1.,2.,9.))", "#4", Some("IFCDIRECTION((1.E-3,2.E-3,0.))")),
        placed("IFCCARTESIANPOINT((4.,4.))", "#4", Some("IFCDIRECTION((1.E-200,1.E-200))")),
        // Readable but degenerate: both readers keep +X under `n > 1e-12`.
        placed("IFCCARTESIANPOINT((4.,4.))", "#4", Some("IFCDIRECTION((0.,0.))")),
        placed("IFCCARTESIANPOINT((4.,4.))", "#4", Some("IFCDIRECTION((1.E-13,0.))")),
        // `$` RefDirection is the IFC +X, not a defaulted component.
        placed("IFCCARTESIANPOINT((4.,4.))", "$", None),
        // `$` Position is the IFC identity.
        profile_step("$", ""),
    ];
    for content in &cases {
        let (read, refused) = probe(content);
        let read = read.unwrap_or_else(|| panic!("valid Position must read:\n{content}"));
        assert_eq!(bits(read), bits(old(content)), "{content}");
        assert!(refused.is_empty(), "{content}: {refused:?}");
    }
    // A rotated, non-unit RefDirection really is rotated (not the identity).
    let (read, _) = probe(&cases[1]);
    assert_eq!(read.unwrap(), (1.25, -3.5, 0.6, 0.8));
}

#[test]
fn x2_malformed_positions_defer_instead_of_inventing_a_frame() {
    let cases = [
        // `$` Location: the old reader used the origin.
        profile_step("#2", "#2=IFCAXIS2PLACEMENT2D($,$);\n"),
        // A missing y ratio: the old reader used 0.
        placed("IFCCARTESIANPOINT((5.))", "$", None),
        // A non-numeric component: the old reader used 0.
        placed("IFCCARTESIANPOINT((5.,'y'))", "$", None),
        // A `$` x ratio in the RefDirection: the old reader invented 1.0.
        placed("IFCCARTESIANPOINT((0.,0.))", "#4", Some("IFCDIRECTION(($,1.))")),
        // A non-numeric x ratio: the old reader invented 1.0.
        placed("IFCCARTESIANPOINT((0.,0.))", "#4", Some("IFCDIRECTION(('x',1.))")),
        // No ratios at all: the old reader invented (1, 0).
        placed("IFCCARTESIANPOINT((0.,0.))", "#4", Some("IFCDIRECTION(())")),
    ];
    for content in &cases {
        old(content); // the old reader produced a frame for every one of these
        let (read, refused) = probe(content);
        assert_eq!(read, None, "malformed Position must defer:\n{content}");
        assert!(!refused.is_empty(), "{content}: read_2d counts its refusal");
        // Refusal counting: the kernel the probe defers to refuses and counts
        // the same distinct records, so the diagnostics count does not move.
        assert_eq!(refused, kernel_refusals(content), "{content}");
    }
}

#[test]
fn x2_unreadable_position_records_defer_uncounted_like_the_kernel() {
    let cases = [
        // Dangling: the old reader used the identity.
        profile_step("#999", ""),
        // A 3D placement where IFC requires 2D: the kernel skips it uncounted.
        profile_step("#2", "#2=IFCAXIS2PLACEMENT3D(#3,$,$);\n#3=IFCCARTESIANPOINT((1.,2.,3.));\n"),
    ];
    for content in &cases {
        let (read, refused) = probe(content);
        assert_eq!(read, None, "{content}");
        assert!(refused.is_empty(), "{content}: {refused:?}");
        assert_eq!(refused, kernel_refusals(content), "{content}");
    }
}

#[test]
fn x2_a_refused_position_makes_the_whole_rectangular_probe_defer() {
    let valid = placed("IFCCARTESIANPOINT((0.5,0.))", "#4", Some("IFCDIRECTION((0.,2.))"));
    let malformed = placed("IFCCARTESIANPOINT((0.5,0.))", "#4", Some("IFCDIRECTION(($,2.))"));
    let rect = |content: &str| {
        let mut decoder = EntityDecoder::new(content);
        let item = decoder.decode_by_id(10).unwrap();
        GeometryRouter::new().rect_param_from_item(item, &Matrix4::identity(), &mut decoder)
    };
    let found = rect(&valid).expect("a valid rotated Position is a rectangular prism");
    assert_eq!(found.center, Point3::new(0.5, 0.0, 0.5));
    assert_eq!(found.r.column(0).into_owned(), Vector3::new(0.0, 1.0, 0.0));
    assert!(rect(&malformed).is_none(), "an invented +X frame must not reach the cut");
}
