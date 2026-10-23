// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Box predicates for split/merge evidence (#8042).
use crate::model::EntityAabb;

pub fn containment_padding(b: &EntityAabb, min: f64, ratio: f64) -> f64 {
    let dx = b.max[0] - b.min[0];
    let dy = b.max[1] - b.min[1];
    let dz = b.max[2] - b.min[2];
    min.max(ratio * (dx * dx + dy * dy + dz * dz).sqrt())
}
pub fn box_within(inner: &EntityAabb, outer: &EntityAabb, pad: f64) -> bool {
    (0..3).all(|axis| !(inner.min[axis] < outer.min[axis] - pad || inner.max[axis] > outer.max[axis] + pad))
}
pub fn boxes_touch(a: &EntityAabb, b: &EntityAabb, pad: f64) -> bool {
    (0..3).all(|axis| !(a.min[axis] - pad > b.max[axis] + pad || b.min[axis] - pad > a.max[axis] + pad))
}
pub fn box_union(boxes: &[EntityAabb]) -> EntityAabb {
    let mut result = EntityAabb { min: [f64::INFINITY; 3], max: [f64::NEG_INFINITY; 3] };
    for b in boxes {
        for axis in 0..3 {
            if b.min[axis] < result.min[axis] { result.min[axis] = b.min[axis]; }
            if b.max[axis] > result.max[axis] { result.max[axis] = b.max[axis]; }
        }
    }
    result
}
pub fn sorted_extents(b: &EntityAabb) -> [f64; 3] {
    let mut extents = std::array::from_fn(|axis| b.max[axis] - b.min[axis]);
    extents.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    extents
}
pub fn extent_coverage(whole: &EntityAabb, pieces: &[EntityAabb], pad: f64) -> bool {
    if pieces.is_empty() { return false; }
    for axis in 0..3 {
        let mut intervals: Vec<_> = pieces.iter().map(|p| (p.min[axis], p.max[axis])).collect();
        intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut cursor = whole.min[axis];
        for (lo, hi) in intervals {
            if lo > cursor + pad { return false; }
            if hi > cursor { cursor = hi; }
            if cursor >= whole.max[axis] - pad { break; }
        }
        if cursor < whole.max[axis] - pad { return false; }
    }
    true
}
fn box_volume(b: &EntityAabb) -> f64 {
    (b.max[0] - b.min[0]).max(0.0) * (b.max[1] - b.min[1]).max(0.0) * (b.max[2] - b.min[2]).max(0.0)
}
pub fn box_iou(a: &EntityAabb, b: &EntityAabb) -> f64 {
    let mut intersection = 1.0;
    for axis in 0..3 {
        let lo = a.min[axis].max(b.min[axis]);
        let hi = a.max[axis].min(b.max[axis]);
        if hi <= lo { return 0.0; }
        intersection *= hi - lo;
    }
    let union = box_volume(a) + box_volume(b) - intersection;
    if union > 0.0 { intersection / union } else { 0.0 }
}
pub fn any_coincident(boxes: &[EntityAabb], limit: f64) -> bool {
    boxes.iter().enumerate().any(|(i, a)| boxes[i + 1..].iter().any(|b| box_iou(a, b) >= limit))
}
