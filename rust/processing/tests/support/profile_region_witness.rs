// SPDX-License-Identifier: MPL-2.0
//! Independent #3641 source oracle shared only by native/browser test programs.
//! Decimal rational shoelace: 6057000031/2000 mm²; depth 25632 mm.
//! No SDK face/volume metadata supplies the expected answer.
use ifc_lite_geometry::document::{RetainedCompletion, RetainedRecipe};
#[path = "profile_section.rs"]
mod profile_section;
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
        section_x.extend(profile_section::triangle_section([a,b,c], -0.45+3.8448e-9, -12.816));
    }
    assert!((volume.abs()-VOLUME).abs() <= 1e-6, "REGION_SDK_VOLUME: {volume}");
    // Retain bounded actual-mesh evidence when the fixed source oracle fails.
    if section_x.is_empty() || (section_x.iter().copied().fold(f64::INFINITY,f64::min)
        -(0.265+1.2816e-8)).abs() > 1e-7 {
        dump_section(mesh.positions.as_ref(), mesh.indices.as_ref(), &section_x, volume);
    }
    profile_section::assert_profile_section(&section_x);
    println!("REGION_3641_SOURCE_VOLUME_SECTION_PROVENANCE_EXECUTED");
}

/// Failure-only evidence, bounded independently of file-supplied mesh size.
/// Inclusive boxes deliberately retain endpoint/coplanar candidates discarded
/// by the original half-open witness. No result here participates in acceptance.
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
