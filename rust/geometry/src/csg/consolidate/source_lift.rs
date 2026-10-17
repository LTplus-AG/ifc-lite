// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Recover retained source corners without projecting away their third coordinate.
use super::{buckets::Buckets, conform::{PlanBucket, CONFORM_TOL}};
use crate::triangulation::project_to_2d_with_basis;
use i_overlay::i_float::{adapter::FloatPointAdapter, int::point::IntPoint};
use nalgebra::{Point2, Point3};
use std::collections::BTreeMap;

pub(super) type CornerLifts = BTreeMap<[u64; 2], Point3<f64>>;
pub(super) type SourceLifts = Vec<Vec<CornerLifts>>;
pub(super) fn point_key(p: &Point2<f64>) -> [u64; 2] {
    [p.x, p.y].map(|v| if v == 0.0 { 0 } else { v.to_bits() })
}
fn record_alias(
    map: &mut BTreeMap<[u64; 2], Option<Point3<f64>>>,
    xy: &Point2<f64>, original: Option<Point3<f64>>,
) {
    let entry = map.entry(point_key(xy)).or_insert(original);
    if *entry != original { *entry = None; }
}

/// Only the additional, otherwise rejected conform pays for these tables.
/// The original overlay derives its adapter from exactly these projected source
/// vertices. Winding reversal changes neither bounds nor canonical coordinates.
pub(super) fn build(plans: &[PlanBucket], buckets: &Buckets) -> Option<SourceLifts> {
    let source: Vec<_> = buckets.values().collect();
    let mut result = Vec::with_capacity(plans.len());
    let mut changed = false;
    for plan in plans {
        if plan.regions.is_empty() { result.push(Vec::new()); continue; }
        let vertices: Vec<_> = source.get(plan.bid as usize)?.iter()
            .flat_map(|t| t.v).collect();
        if vertices.iter().flat_map(|p| p.iter()).any(|v| !v.is_finite()) { return None; }
        let projected = project_to_2d_with_basis(&vertices, &plan.u_axis, &plan.v_axis, &plan.origin);
        let xy: Vec<_> = projected.iter().map(|p| [p.x, p.y]).collect();
        if xy.iter().flatten().any(|v| !v.is_finite()) { return None; }
        let adapter = FloatPointAdapter::<[f64; 2], i32>::with_iter(xy.iter());
        let mut corners = BTreeMap::<(i32, i32), Option<Point3<f64>>>::new();
        for (xy, original) in xy.iter().zip(&vertices) {
            let q = adapter.float_to_int(xy);
            let entry = corners.entry((q.x, q.y)).or_insert(Some(*original));
            // Once two distinct 3D points share an overlay key it stays ambiguous,
            // even if a later source occurrence repeats either point.
            if entry.is_some_and(|old| old != *original) { *entry = None; }
        }
        let mut canonical = BTreeMap::<[u64; 2], Option<Point3<f64>>>::new();
        // Existing conform insertions carry the exact direct projection; overlay
        // corners carry its dequantized representative. Both require the SAME
        // unambiguous integer provenance, and aliases remain collision-poisoned.
        for p in &projected {
            let q = adapter.float_to_int(&[p.x, p.y]);
            record_alias(&mut canonical, p, corners[&(q.x,q.y)]);
        }
        for ((x,y), original) in corners {
            let xy = adapter.int_to_float(&IntPoint::new(x,y));
            record_alias(&mut canonical, &Point2::new(xy[0],xy[1]), original);
        }
        let mut regions = Vec::with_capacity(plan.regions.len());
        for region in &plan.regions {
            let mut retained = CornerLifts::new();
            // Exact canonical endpoint identity, not a nearest-point search.
            // Removed corners and interior CDT/Steiner vertices have no entries.
            for p in region.outer_conformed.iter().chain(region.holes_conformed.iter().flatten()) {
                let key = point_key(p);
                let Some(original) = canonical.get(&key).copied().flatten() else { continue; };
                let lifted = plan.origin + plan.u_axis * p.x + plan.v_axis * p.y;
                let stored = Point3::from(lifted.coords.map(|v| f64::from(v as f32)));
                if !stored.iter().all(|v| v.is_finite())
                    || (stored - original).norm_squared() > CONFORM_TOL * CONFORM_TOL {
                    return None;
                }
                if stored != original { retained.insert(key, original); changed = true; }
            }
            regions.push(retained);
        }
        result.push(regions);
    }
    changed.then_some(result)
}

#[cfg(test)]
#[path = "source_lift_tests.rs"]
mod tests;
