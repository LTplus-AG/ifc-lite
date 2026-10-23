// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Necessary exact directed-edge incidence for represented triangle soups.
//! No snapping/edge splits; not a simplicity or non-self-intersection proof.
use rustc_hash::FxHashMap;

/// Exact incidence and volume on the existing kernel grid.
pub(crate) mod kernel_grid;

/// Finite, exact nondegenerate, nonempty triangles with exactly one forward and
/// reverse use of every geometric edge. Numeric signed zero shares one key.
/// Conservatively rejects valid soups with unsplit collinear T-junctions.
pub(crate) fn strict_closed(tris:impl IntoIterator<Item=[[f64;3];3]>)->bool{
    let mut edges=FxHashMap::<([u64;3],[u64;3]),(usize,usize)>::default();
    let mut any=false;
    for tri in tris{
        any=true;
        if tri.iter().flatten().any(|x|!x.is_finite())
            || crate::kernel::retriangulate::projection_axis(&tri).is_none(){return false;}
        let points=tri.map(|p|p.map(|v|if v==0.0{0}else{v.to_bits()}));
        for i in 0..3{
            let(a,b)=(points[i],points[(i+1)%3]);if a==b{return false;}
            let(key,forward)=if a<b{((a,b),true)}else{((b,a),false)};
            let counts=edges.entry(key).or_default();if forward{counts.0+=1;}else{counts.1+=1;}
            if counts.0>1||counts.1>1{return false;}
        }
    }
    any&&edges.values().all(|&counts|counts==(1,1))
}

/// Actual indexed local f32 positions; placement/origin never enter the keys.
pub(crate) fn strict_closed_mesh(mesh:&crate::mesh::Mesh)->bool{
    if !mesh.positions.len().is_multiple_of(3) || !mesh.indices.len().is_multiple_of(3) { return false; }
    let count=mesh.positions.len()/3;
    if mesh.indices.iter().any(|&i|i as usize>=count){return false;}
    strict_closed(mesh.indices.chunks_exact(3).map(|t|std::array::from_fn(|k|{
        let i=t[k]as usize*3;
        [f64::from(mesh.positions[i]),f64::from(mesh.positions[i+1]),f64::from(mesh.positions[i+2])]
    })))
}

#[cfg(test)]
#[path="exact_topology_tests.rs"]
mod tests;
