// SPDX-License-Identifier: MPL-2.0
//! Hand-defined unit square and quarter-disk constructions (#7955 CUT-0).
use ifc_lite_geometry::document::{RetainedPrism, PrismRole, PrismLoop, PrismSegment, RetainedTessellation};
pub fn prism(arc: bool) -> RetainedPrism {
    let points = [[0.,0.],[1.,0.],[1.,1.],[0.,1.]];
    let segments = if arc { vec![
        PrismSegment::Arc { center: [0.,0.], radius: 1., start_angle: 0., sweep_angle: std::f64::consts::FRAC_PI_2 },
        PrismSegment::Line { start: [0.,1.], end: [0.,0.] }, PrismSegment::Line { start: [0.,0.], end: [1.,0.] },
    ] } else { (0..4).map(|i| PrismSegment::Line { start: points[i], end: points[(i+1)%4] }).collect() };
    RetainedPrism { source_id: 1, role: PrismRole::BoundedHalfSpace,
        frame: [1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.], loops: vec![PrismLoop { outer:true, segments }],
        direction:[0.,0.,1.], depth:1. }
}
pub fn volume(mesh: &RetainedTessellation) -> f64 {
    let point = |i: u32| { let i=i as usize*3; [mesh.positions[i],mesh.positions[i+1],mesh.positions[i+2]] };
    mesh.indices.chunks_exact(3).map(|t| {
        let [a,b,c]=[point(t[0]),point(t[1]),point(t[2])];
        (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6.
    }).sum::<f64>().abs()
}
pub fn verify(mesh: &RetainedTessellation, arc: bool) {
    let tol: serde_json::Value = serde_json::from_str(include_str!("../../../../tests/fixtures/cli-retained/tolerances.json")).unwrap();
    let cut0: serde_json::Value = serde_json::from_str(include_str!("../../../../tests/fixtures/cli-retained/tolerances.d/cut-0.json")).unwrap();
    let expected = if arc { std::f64::consts::PI / 4. } else { 1. };
    let limit = if arc { expected * tol["sourceVolumeRelative"]["curved"].as_f64().unwrap() }
        else { cut0["cut0PrismUnitVolumeAbsolute"].as_f64().unwrap() };
    assert!((volume(mesh)-expected).abs() <= limit, "{} vs {expected}, limit {limit}",volume(mesh));
    assert_eq!((mesh.boundary_edges,mesh.spine_edges),(0,0));
    assert!(!mesh.indices.is_empty());
}
