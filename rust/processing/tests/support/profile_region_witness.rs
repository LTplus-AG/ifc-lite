// SPDX-License-Identifier: MPL-2.0
//! Independent #3641 source oracle shared only by native/browser test programs.
//! Decimal rational shoelace: 6057000031/2000 mm²; depth 25632 mm.
//! No SDK face/volume metadata supplies the expected answer.
use ifc_lite_geometry::document::{RetainedCompletion, RetainedRecipe};
pub const FIXTURE: &[u8] = include_bytes!("../fixtures/issue_3641_voiding_trap.ifc");
pub const VOLUME: f64 = 77.626512397296;

pub fn check(completion: &RetainedCompletion) {
    let request = completion.request();
    let RetainedRecipe::RegularizedExtrusion(recipe) = request.recipe() else { panic!("REGION_SOURCE_RECIPE") };
    assert_eq!(recipe.region.authored().solid_id, 61271);
    assert_eq!(recipe.region.raw_precision(), Some((0.2,0.2)));
    assert_eq!(recipe.length_unit_scale, 0.001);
    assert_eq!(recipe.region.edges().iter().map(|e| e.authored_edge).collect::<Vec<_>>(), [1,2,3,4], "REGION_SOURCE_PROVENANCE");
    assert_eq!(recipe.region.authored().profile.as_ref().unwrap().loops[0].segments.len(), 5);
    assert_eq!(recipe.region.cancelled().authored_edges, [4,0]);
    let frame = request.payload().source_from_evaluation;
    assert_eq!([frame[12],frame[13],frame[14]], [870.,0.,12816.]);
    let mesh = &completion.tessellation;
    assert_eq!((mesh.boundary_edges,mesh.spine_edges), (0,0), "REGION_CLOSED_SOLID");
    let point = |i: u32| { let i = i as usize*3; [mesh.positions[i],mesh.positions[i+1],mesh.positions[i+2]] };
    let mut volume = 0.;
    let mut section_x = Vec::new();
    for triangle in mesh.indices.chunks_exact(3) {
        let [a,b,c] = [point(triangle[0]),point(triangle[1]),point(triangle[2])];
        volume += (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6.;
        // Intersect actual triangle with the mid-depth plane, then the
        // horizontal section line. Coplanar/endpoint hits are kept; extrema
        // are independent of tessellation and need no nearest-triangle labels.
        let mut hits = Vec::new();
        for (p,q) in [(a,b),(b,c),(c,a)] {
            let z = -12.816;
            if (p[2] <= z && z < q[2]) || (q[2] <= z && z < p[2]) {
                let t = (z-p[2])/(q[2]-p[2]);
                hits.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])]);
            }
        }
        if hits.len() == 2 {
            let (p,q) = (hits[0],hits[1]);
            let y = -0.45+3.8448e-9;
            if (p[1] <= y && y < q[1]) || (q[1] <= y && y < p[1]) {
                section_x.push(p[0]+(y-p[1])/(q[1]-p[1])*(q[0]-p[0]));
            }
        }
    }
    assert!((volume.abs()-VOLUME).abs() <= 1e-6, "REGION_SDK_VOLUME: {volume}");
    // #7955 diagnostic checkpoint: retain the failed oracle unchanged. Capture
    // actual SDK triangles before deciding whether slicing or geometry is wrong.
    if section_x.is_empty() || (section_x.iter().copied().fold(f64::INFINITY,f64::min)
        -(0.265+1.2816e-8)).abs() > 1e-7 {
        dump_section(mesh.positions.as_ref(), mesh.indices.as_ref(), &section_x, volume);
    }
    assert!(!section_x.is_empty(), "REGION_SDK_SECTION");
    let min = section_x.iter().copied().fold(f64::INFINITY,f64::min);
    let max = section_x.iter().copied().fold(f64::NEG_INFINITY,f64::max);
    assert!((min-(0.265+1.2816e-8)).abs() <= 1e-7, "REGION_SDK_SECTION: {min}");
    assert!((max-(3.63+1.2816e-8)).abs() <= 1e-7, "REGION_SDK_SECTION: {max}");
    println!("REGION_3641_SOURCE_VOLUME_SECTION_PROVENANCE_EXECUTED");
}

/// Failure-only evidence, bounded independently of file-supplied mesh size.
/// Inclusive boxes deliberately retain endpoint/coplanar candidates discarded
/// by the current half-open witness. No result here participates in acceptance.
fn dump_section(positions: &[f64], indices: &[u32], section_x: &[f64], volume: f64) {
    const LIMIT: usize = 256;
    let z = -12.816;
    let y = -0.45+3.8448e-9;
    eprintln!("REGION_SECTION_DIAGNOSTIC volume={volume:?} z={z:?} y={y:?} vertices={} triangles={} hits={} first_hits={:?}",
        positions.len()/3, indices.len()/3, section_x.len(), &section_x[..section_x.len().min(LIMIT)]);
    let point = |i: u32| { let i = i as usize*3; [positions[i],positions[i+1],positions[i+2]] };
    let mut candidates = 0;
    for (index, triangle) in indices.chunks_exact(3).enumerate() {
        let points = [point(triangle[0]),point(triangle[1]),point(triangle[2])];
        // A small diagnostic-only halo exposes rounding gaps too. It does not
        // change the slice, its fixed expected values, or either tolerance.
        if [(2,z),(1,y)].iter().all(|&(axis,value)| {
            let min = points.iter().map(|p| p[axis]).fold(f64::INFINITY,f64::min);
            let max = points.iter().map(|p| p[axis]).fold(f64::NEG_INFINITY,f64::max);
            min <= value+1e-7 && value-1e-7 <= max
        }) {
            if candidates < LIMIT {
                eprintln!("REGION_SECTION_TRIANGLE index={index} indices={triangle:?} points={points:?}");
            }
            candidates += 1;
        }
    }
    eprintln!("REGION_SECTION_DIAGNOSTIC_END candidates={candidates} emitted={} truncated={}",
        candidates.min(LIMIT), candidates.saturating_sub(LIMIT));
}
