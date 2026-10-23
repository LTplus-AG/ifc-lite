// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Same-bucket contour context for guarded collinear simplification.
use nalgebra::Point2;
use super::{ring_is_noise,simplify_with_guard,topology,weld_near_coincident_2d};
type Ring=Vec<Point2<f64>>;
pub(in crate::csg::consolidate) struct CleanShape {
    pub outer:Ring,
    pub holes:Vec<Ring>,
}

/// The pure existing weld is evaluated first for all contour context. The old
/// shape/ring simplification and noise decision order is retained. No weld
/// threshold, noise gate or coordinate is changed here.
pub(in crate::csg::consolidate) fn clean_shapes(
    shapes:&[Vec<Vec<[f64;2]>>],area:f64,scale:f64,
)->Vec<CleanShape> {
    let mut rings=Vec::new();let mut indices=Vec::new();
    for shape in shapes {
        indices.push(shape.iter().map(|r|{
            let id=rings.len();let p:Vec<_>=r.iter().map(|p|Point2::new(p[0],p[1])).collect();
            rings.push(weld_near_coincident_2d(&p));id
        }).collect::<Vec<_>>());
    }
    // Retain original source footprints while cleaning adjacent regions; earlier
    // simplification must not authorize a later shortcut across a source ear.
    let originals=rings.clone();
    let mut active=vec![true;rings.len()];
    let mut shape_active=Vec::new();
    for ids in &indices {
        let mut outer_ok=false;
        for (index,&id) in ids.iter().enumerate() {
            if index>0&&!outer_ok {active[id]=false;continue;}
            let welded=std::mem::take(&mut rings[id]);
            let simplified=simplify_with_guard(&welded,|ring,keep,prev,i,next,live|
                topology::admissible(ring,keep,prev,i,next,live,
                    rings.iter().enumerate().filter(|(j,_)|*j!=id&&active[*j]).map(|(_,r)|r.as_slice())
                        .chain(originals.iter().enumerate().filter(|(j,_)|*j!=id).map(|(_,r)|r.as_slice()))));
            if ring_is_noise(&simplified,area,scale) {active[id]=false;}
            rings[id]=simplified;
            if index==0 {outer_ok=active[id];}
        }
        shape_active.push(outer_ok);
    }
    let mut out=Vec::new();
    for (ids,valid) in indices.into_iter().zip(shape_active) {
        if !valid {continue;}
        let outer_id=ids[0];let outer=std::mem::take(&mut rings[outer_id]);
        let mut holes=Vec::new();
        for id in ids.into_iter().skip(1).filter(|&id|active[id]) {
            holes.push(std::mem::take(&mut rings[id]));
        }
        out.push(CleanShape{outer,holes});
    }
    out
}

impl super::super::conform::PlanRegion {
    pub(in crate::csg::consolidate) fn from_shapes(shapes:&[Vec<Vec<[f64;2]>>],area:f64,scale:f64)->Vec<Self>{
        clean_shapes(shapes,area,scale).into_iter().map(|s|Self{
            outer_conformed:s.outer.clone(),holes_conformed:s.holes.clone(),
            outer:s.outer,holes:s.holes,changed:false,cached:None}).collect()
    }
}
