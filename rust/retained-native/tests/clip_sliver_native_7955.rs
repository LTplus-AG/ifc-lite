// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: a plain clip plane nearly parallel to an extrusion's end cap, removing a wedge
//! microns deep, as in ISSUE_129 #271772 and beam #314098. The real SDK treats it as
//! coincident and keeps the wedge: past the frozen 1e-6 it is refused with a typed origin.
//! The same plane deep enough for the kernel to cut still publishes the cut solid.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{ModelOptions, ProductOutcome};

/// A 2 x 1 x 1 m box; the clip removes the wedge above z = 1 - depth + depth x / 2.
fn clipped_box(depth: f64) -> String {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#2=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);#6=IFCUNITASSIGNMENT((#1,#2));
#7=IFCPROJECT('0000000000000000000000',$,'SYNTHETIC',$,$,$,$,$,#6);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCAXIS2PLACEMENT3D(#10,$,$);#12=IFCDIRECTION((0.,0.,1.));#13=IFCLOCALPLACEMENT($,#11);
#14=IFCCARTESIANPOINT((1.,0.5));#15=IFCAXIS2PLACEMENT2D(#14,$);#16=IFCRECTANGLEPROFILEDEF(.AREA.,$,#15,2.,1.);
#17=IFCEXTRUDEDAREASOLID(#16,#11,#12,1.);
#20=IFCCARTESIANPOINT((0.,0.,{z0:?}));#21=IFCDIRECTION(({nx:?},0.,1.));#22=IFCDIRECTION((1.,0.,{rx:?}));#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCPLANE(#23);#25=IFCHALFSPACESOLID(#24,.F.);#26=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#17,#25);
#33=IFCSHAPEREPRESENTATION($,'Body','Clipping',(#26));#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#36=IFCSLAB('0000000000000000000001',$,'SYNTHETIC slab',$,$,#13,#34,$,.FLOOR.);
ENDSEC;END-ISO-10303-21;", z0 = 1. - depth, nx = -depth / 2., rx = depth / 2.)
}
fn run(text: &str, worker: &std::ffi::OsStr) -> ProductOutcome {
    let mut outcomes = Vec::new();
    ifc_lite_retained_native::run_model_native(SourceBundle::new(text.as_bytes().to_vec()), worker,
        &ModelOptions { ids: Some([36].into_iter().collect()), ..Default::default() }, |o| outcomes.push(o)).unwrap();
    assert_eq!(outcomes.len(), 1, "one atomic publication/refusal");
    outcomes.pop().unwrap()
}

#[test]
fn a_wedge_the_kernel_keeps_is_refused_and_a_real_cut_publishes() {
    let Some(worker) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SDK required");
        return;
    };
    // Inside the 1e-6 limit the kept wedge is harmless, so nothing refuses a good product.
    let ProductOutcome::Published(_) = run(&clipped_box(1e-6), &worker) else { panic!("a wedge within the limit publishes") };
    // A 5 and a 10 micron wedge the kernel keeps: 2.5e-6 and 5e-6 of the volume.
    for depth in [5e-6, 1e-5] {
        let outcome = run(&clipped_box(depth), &worker);
        let ProductOutcome::Refused { refusal, origin, .. } = &outcome else { panic!("{depth}: must not publish: {outcome:?}") };
        assert_eq!(refusal.code(), "incomplete");
        let origin = origin.expect("typed origin");
        assert_eq!((origin.site, origin.entity, origin.cause), ("clip_sliver", Some(25), "material_beyond_clip_plane"));
    }
    // Deep enough for the kernel to cut: the exact solid publishes.
    for depth in [5e-5, 1e-3, 0.1] {
        let outcome = run(&clipped_box(depth), &worker);
        let ProductOutcome::Published(shape) = &outcome else { panic!("{depth}: must publish: {outcome:?}") };
        let part = &shape.parts[0];
        let point = |i: u32| { let i = i as usize * 3; [part.positions[i], part.positions[i + 1], part.positions[i + 2]] };
        let six: f64 = part.indices.chunks_exact(3).map(|t| { let (a, b, c) = (point(t[0]), point(t[1]), point(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]) }).sum();
        assert!((six.abs() / 6. - (2. - depth)).abs() < 1e-9, "{depth}: {}", six.abs() / 6.);
    }
    println!("sdk witness executed: clip_sliver_refusal");
}
