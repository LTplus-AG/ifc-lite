// SPDX-License-Identifier: MPL-2.0
//! Report-only comparison: exact and retained have different triangulations.
//! Angles are measured against the same analytic source, never used as a gate.
use ifc_lite_retained_native::oracle::normals::{angle,Surface};
use ifc_lite_processing::ProcessingResult;

pub fn histogram(exact: &ProcessingResult,id: u32,source: &[Surface]) -> [usize;5] {
    // <=1e-9 rad, <=1 degree, <=5 degrees, larger, no incident source.
    let mut bins = [0;5];
    for mesh in exact.meshes.iter().filter(|m| m.express_id==id) {
        for &i in &mesh.indices {
            let p = exact.frame.to_world(std::array::from_fn(|a| mesh.origin[a]+f64::from(mesh.positions[i as usize*3+a])));
            let n = exact.frame.rotate_out_of_frame(std::array::from_fn(|a| f64::from(mesh.normals[i as usize*3+a])));
            let nearest = source.iter().filter_map(|s| s.sample(p)).filter(|(_,d)| *d <= 0.001001)
                .map(|(expected,_)| angle(expected,n)).min_by(f64::total_cmp);
            let bin = match nearest {Some(a) if a<=1e-9=>0,Some(a) if a<=std::f64::consts::PI/180.=>1,
                Some(a) if a<=0.0873=>2,Some(_)=>3,None=>4};
            bins[bin]+=1;
        }
    }
    bins
}
