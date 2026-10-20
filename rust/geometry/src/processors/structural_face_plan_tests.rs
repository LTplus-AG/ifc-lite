// SPDX-License-Identifier: MPL-2.0
//! Platform extraction: structural topology survives source disposal unchanged.
use super::*;

#[test]
fn planar_structural_face_keeps_false_same_sense_loop_winding_and_rtc_precision() {
    let plan = {
        let source = "#1=IFCFACESURFACE((#2),#3,.F.);#2=IFCFACEOUTERBOUND(#4,.T.);\n\
            #3=IFCPLANE(#5);#5=IFCAXIS2PLACEMENT3D(#11,$,$);#4=IFCPOLYLOOP((#11,#12,#13));\n\
            #11=IFCCARTESIANPOINT((2600000.,1200000.,10.));\n\
            #12=IFCCARTESIANPOINT((2600000.01,1200000.,10.));\n\
            #13=IFCCARTESIANPOINT((2600000.,1200000.01,10.));"
            .to_owned();
        let mut decoder = EntityDecoder::new(&source);
        let face = decoder.decode_by_id(1).unwrap();
        lower(
            &face,
            &mut decoder,
            TessellationQuality::Medium,
            Some((2_600_000., 1_200_000., 10.)),
        )
        .unwrap()
    };
    let mesh = plan.evaluate().unwrap();
    assert!(mesh.rtc_applied);
    assert_eq!(mesh.indices.len(), 3);
    let p = |i: u32| {
        let k = i as usize * 3;
        [mesh.positions[k], mesh.positions[k + 1]]
    };
    let a = p(mesh.indices[0]);
    let b = p(mesh.indices[1]);
    let c = p(mesh.indices[2]);
    let twice_area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    assert!(
        (twice_area - 0.0001).abs() < 1e-9,
        "loop winding and sub-ULP area: {twice_area}"
    );
}
#[test]
fn nonplanar_structural_face_admits_empty_before_reading_malformed_bounds() {
    let plan = {
        let source = "#1=IFCFACESURFACE($,#2,.T.);#2=IFCCYLINDRICALSURFACE($,1.);".to_owned();
        let mut decoder = EntityDecoder::new(&source);
        let face = decoder.decode_by_id(1).unwrap();
        lower(
            &face,
            &mut decoder,
            TessellationQuality::Medium,
            Some((1., 2., 3.)),
        )
        .unwrap()
    };
    let mesh = plan.evaluate().unwrap();
    assert!(mesh.is_empty());
    assert!(!mesh.rtc_applied, "preserve the early-empty frame policy");
}
#[test]
fn dangling_structural_surface_remains_an_error_during_source_admission() {
    let source = "#1=IFCFACESURFACE((),#999,.T.);";
    let mut decoder = EntityDecoder::new(source);
    let face = decoder.decode_by_id(1).unwrap();
    assert!(lower(&face, &mut decoder, TessellationQuality::Medium, None).is_err());
}
