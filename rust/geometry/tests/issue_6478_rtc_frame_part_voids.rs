// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6478: with a model RTC offset, a void host's frame part far from the RTC
//! origin must be cut like the part near it. The product holds a near-origin
//! 0.9 m box plus the same box mapped to X = 5,000,000.123456; opening #40 holds a
//! 0.4 m through-hole at each. With RTC (5e6, 0, 0) the near box is 5,000 km
//! from the RTC origin, where an absolute f32 cutter collapses onto a 0.5 m grid.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const FAR_X: f64 = 5_000_000.123456;
const RTC: [f64; 3] = [5_000_000.0, 0.0, 0.0];

/// Box #11 (0.9 m square, x/y in [-0.45, 0.45], z in [0, 1]; off the 0.5 m f32 grid at 5,000 km) and the same box mapped to
/// FAR_X by #16. Opening #40 lists `opening` from #33 (0.4 m through-hole) and
/// #38 (the same hole mapped to FAR_X).
fn fixture(body: &str, opening: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCLOCALPLACEMENT($,#2);\
         #4=IFCDIRECTION((0.,0.,1.));#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);\
         #10=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.9,0.9);#11=IFCEXTRUDEDAREASOLID(#10,#2,#4,1.);\
         #12=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#11));#13=IFCREPRESENTATIONMAP(#2,#12);\
         #14=IFCCARTESIANPOINT(({FAR_X},0.,0.));#15=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#14,1.,$);\
         #16=IFCMAPPEDITEM(#13,#15);#17=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',({body}));\
         #18=IFCPRODUCTDEFINITIONSHAPE($,$,(#17));\
         #20=IFCBUILDINGELEMENTPROXY('0000000000000000000000',$,'Mixed',$,$,#3,#18,$,$);\
         #30=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.4,0.4);#31=IFCCARTESIANPOINT((0.,0.,-1.));\
         #32=IFCAXIS2PLACEMENT3D(#31,$,$);#33=IFCEXTRUDEDAREASOLID(#30,#32,#4,3.);\
         #36=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#33));#37=IFCREPRESENTATIONMAP(#2,#36);\
         #38=IFCMAPPEDITEM(#37,#15);#34=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',({opening}));\
         #35=IFCPRODUCTDEFINITIONSHAPE($,$,(#34));\
         #40=IFCOPENINGELEMENT('0000000000000000000001',$,'Opening',$,$,#3,#35,$,.OPENING.);\
         #41=IFCRELVOIDSELEMENT('0000000000000000000002',$,$,$,#20,#40);"
    )
}

fn volume(mesh: &Mesh) -> f64 {
    let p = |i: u32| [0, 1, 2].map(|k| f64::from(mesh.positions[i as usize * 3 + k]));
    let six: f64 = mesh
        .indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum();
    six.abs() / 6.
}

/// World X extent (`origin + position + rtc`) of a part, in f64.
fn world_x_extent(part: &Mesh) -> (f64, f64) {
    part.positions
        .chunks_exact(3)
        .map(|p| p[0] as f64 + part.origin[0] + RTC[0])
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| (lo.min(x), hi.max(x)))
}

#[test]
fn issue_6478_voids_cut_both_frame_parts_under_an_rtc_offset() {
    for body in ["#11,#16", "#16,#11"] {
        for opening in ["#33,#38", "#38,#33"] {
            for (label, local_frame) in [("absolute + rtc", false), ("local frame + rtc", true)] {
                let mut router = GeometryRouter::with_scale_and_local_frame(1.0, local_frame);
                router.set_rtc_offset((RTC[0], RTC[1], RTC[2]));
                let source = fixture(body, opening);
                let mut decoder = EntityDecoder::new(&source);
                let element = decoder.decode_by_id(20).unwrap();
                let index = FxHashMap::from_iter([(20, vec![40])]);
                let parts = router.process_element_with_voids_parts(&element, &mut decoder, &index).unwrap();
                let context = format!("{label}, body ({body}), opening ({opening})");
                assert_eq!(parts.len(), 2, "{context}: near and far items stay separate parts");
                let mut spans = Vec::new();
                for part in &parts {
                    let (lo, hi) = world_x_extent(part);
                    let expected = if lo > 1_000.0 { (FAR_X - 0.45, FAR_X + 0.45) } else { (-0.45, 0.45) };
                    assert!(
                        (lo - expected.0).abs() < 1e-5 && (hi - expected.1).abs() < 1e-5,
                        "{context}: world X spans [{lo:.9}, {hi:.9}], expected {expected:?}"
                    );
                    assert!(
                        (volume(part) - 0.65).abs() < 1e-5,
                        "{context}: part at X {lo:.3} has volume {}, expected 0.65",
                        volume(part)
                    );
                    spans.push(lo > 1_000.0);
                }
                assert_ne!(spans[0], spans[1], "{context}: one part per frame");
            }
        }
    }
}
