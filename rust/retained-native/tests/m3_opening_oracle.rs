// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_processing::extract_analytic_quantity_sources;
use ifc_lite_retained_native::oracle::openings::{
    bbox_excess, expected, prism_result_volume, volume_bounds_relative,
};
const ISSUE_2019: &[u8] =
    include_bytes!("../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc");
fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-9,
        "actual={actual:.15}, hand={expected:.15}"
    );
}

// #7955 M3-0 mutation witness. All arithmetic below is from authored dimensions,
// not exact meshes, the clipping oracle, or a snapshot of either.
#[test]
fn issue_2019_hand_derived_bands() {
    let sources = extract_analytic_quantity_sources(ISSUE_2019, None);
    // H: [0,4] x [0,1/5], height 3 => Vh=12/5.
    // Set t=y-1/10 in [-1/10,1/10]. Inside H, A=[1,2].
    // B's rotated width constraint gives x=[5/3+4t/3,7/3+4t/3];
    // its other constraint is inactive throughout H. Thus areas:
    // H&A=1/5; H&B=(2/3)(1/5)=2/15; H&A&B=integral(1/3-4t/3)dt=1/15.
    // Union AB=1/5+2/15-1/15=4/15.
    // C=[119/80-3t/4,169/80-3t/4], entirely inside A union B.
    // Area C=1/8, AC=41/400. B/C lower edges cross at t=-43/500.
    // BC=(5/8)(7/500)+integral[-43/500,1/10](107/240-25t/12)dt=7117/80000.
    // ABC=integral[-1/10,-43/500](41/80+3t/4)dt
    //    +integral[-43/500,1/10](1/3-4t/3)dt=5317/80000.
    // ABC union=1/5+2/15+1/8-1/15-41/400-7117/80000+5317/80000=4/15.
    // Bands: [0,.3]:none; [.3,.6]:AB; [.6,1.5]:ABC; [1.5,3]:none.
    // Vremoved=(.3+.9)*4/15=8/25. Vremaining=12/5-8/25=52/25=2.08.
    close(
        prism_result_volume(&sources, 30, &[50, 70, 100]).unwrap(),
        52. / 25.,
    );
    // Isolated cuts exercise each profile; AB detects the pairwise-sign mutation.
    close(
        prism_result_volume(&sources, 30, &[50]).unwrap(),
        12. / 5. - 6. / 25.,
    );
    close(
        prism_result_volume(&sources, 30, &[70]).unwrap(),
        12. / 5. - 4. / 25.,
    );
    close(
        prism_result_volume(&sources, 30, &[100]).unwrap(),
        12. / 5. - 9. / 80.,
    );
    close(
        prism_result_volume(&sources, 30, &[50, 70]).unwrap(),
        52. / 25.,
    );
    let e = expected(&sources, 30, &[50, 70, 100]).unwrap();
    // Nominal cutters: .4*1.2 + .4*1.2 + .35*.9 = 1.275.
    close(e.volume_bounds[0], 2.4 - 1.275);
    close(e.volume_bounds[1], 2.4);
    assert_eq!(e.host_bbox, Some([0., 0., 0., 4., 0.2, 3.]));
}

// #7955: Green's integral for a circular annular sector, with both arc senses.
#[test]
fn curved_bands_match_hand_integrals() {
    let s = extract_analytic_quantity_sources(
        include_bytes!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc"),
        None,
    );
    for (host, cutter, a, b) in [
        (122, 129, 10., 10.1),
        (188, 195, 10.1, 10.3),
        (254, 261, 10.3, 10.6),
    ] {
        // Quarter annulus: A=pi*(b²-a²)/4, height 3.
        // Door spans x=[9,12], y=[-.5,.5], height 2. Over that strip,
        // integral[-.5,.5] sqrt(r²-y²)dy = .5*sqrt(r²-.25)+r²*asin(.5/r)=F(r).
        // Thus Vafter=3*pi*(b²-a²)/4 - 2*(F(b)-F(a)).
        let f = |r: f64| 0.5 * (r * r - 0.25).sqrt() + r * r * (0.5 / r).asin();
        let hand = 3. * std::f64::consts::PI * (b * b - a * a) / 4. - 2. * (f(b) - f(a));
        let e = expected(&s, host, &[cutter]).unwrap();
        close(e.result_volume.unwrap(), hand);
        assert!(e.curved);
        assert!(e.host_bbox.is_none());
    }
}

// #7955: reversing a source extrusion axis remains a right prism, whereas an
// oblique axis must decline the prism family but retain valid nominal bounds.
#[test]
fn bounds_nonintersection_containment_and_unsupported_prisms() {
    let mut s = extract_analytic_quantity_sources(ISSUE_2019, None);
    let key = s.extrusion_definitions.instances[&50][0].source.clone();
    let source = &mut s
        .extrusion_definitions
        .sources
        .iter_mut()
        .find(|x| x.key == key)
        .unwrap()
        .source;
    source.position_matrix.as_mut().unwrap()[12] = 100.;
    // A shifted by 100 m has no intersection: V=4*.2*3=2.4.
    close(prism_result_volume(&s, 30, &[50]).unwrap(), 2.4);
    source_reset_oblique(&mut s, &key);
    assert!(prism_result_volume(&s, 30, &[50]).is_none());
    assert!(expected(&s, 30, &[50]).unwrap().volume_bounds[0] > 0.);
    assert!(prism_result_volume(&s, 30, &[50; 9]).is_none());
    // Bbox containment permits shrinking, but x protrusion is exactly .25 m.
    let host = [0., 0., 0., 4., 2., 3.];
    close(bbox_excess(&[1., 0.5, 0., 3., 1.5, 2.], &host), 0.);
    close(bbox_excess(&[-0.25, 0., 0., 4., 2., 3.], &host), 0.25);
    assert!(!bbox_excess(&[f64::NAN; 6], &host).is_finite());
    close(volume_bounds_relative(2.5, [1., 2.]), 0.25);
    close(volume_bounds_relative(0.5, [1., 2.]), 0.25);
    close(volume_bounds_relative(1.5, [1., 2.]), 0.);
    assert!(!volume_bounds_relative(f64::NAN, [0., 2.]).is_finite());
}
fn source_reset_oblique(
    s: &mut ifc_lite_processing::AnalyticQuantitySources,
    key: &ifc_lite_processing::AnalyticSourceKey,
) {
    let source = &mut s
        .extrusion_definitions
        .sources
        .iter_mut()
        .find(|x| &x.key == key)
        .unwrap()
        .source;
    source.axis_unit_vector = Some([0.6, 0., 0.8]);
}
