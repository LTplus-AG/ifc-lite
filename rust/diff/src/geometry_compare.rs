// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared geometry comparison arithmetic, preserving JS evaluation order (#8042).
use crate::model::EntityAabb;

#[derive(Debug, Clone, Copy)]
pub struct GeometryTolerances {
    pub move_tolerance: f64,
    pub reshape_tolerance: f64,
    pub max_move_distance: f64,
}
impl Default for GeometryTolerances {
    fn default() -> Self {
        Self { move_tolerance: 2e-3, reshape_tolerance: 1e-3, max_move_distance: 10.0 }
    }
}
/// Nonfinite or negative settings use the same defaults as the TS boundary.
pub fn positive_or(value: Option<f64>, fallback: f64) -> f64 {
    value.filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(fallback)
}
impl GeometryTolerances {
    pub fn resolve(movement: Option<f64>, reshape: Option<f64>, maximum: Option<f64>) -> Self {
        let defaults = Self::default();
        Self {
            move_tolerance: positive_or(movement, defaults.move_tolerance),
            reshape_tolerance: positive_or(reshape, defaults.reshape_tolerance),
            max_move_distance: positive_or(maximum, defaults.max_move_distance),
        }
    }
}

pub fn usable_aabb(aabb: &EntityAabb) -> bool {
    aabb.min.iter().chain(&aabb.max).all(|value| value.is_finite())
}
pub fn centre(aabb: &EntityAabb) -> [f64; 3] {
    std::array::from_fn(|axis| (aabb.min[axis] + aabb.max[axis]) / 2.0)
}
pub fn centre_distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let dz = b[2] - a[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}
pub fn size_agrees(a: &EntityAabb, b: &EntityAabb, tolerance: f64) -> bool {
    for axis in 0..3 {
        let size_a = a.max[axis] - a.min[axis];
        let size_b = b.max[axis] - b.min[axis];
        if (size_a - size_b).abs() > tolerance { return false; }
    }
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryChangeKind { Moved, Reshaped }
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GeometryChange {
    pub kind: GeometryChangeKind,
    pub distance: Option<f64>,
}
pub fn classify_geometry_change(
    base: Option<&EntityAabb>, head: Option<&EntityAabb>, tolerances: GeometryTolerances,
) -> GeometryChange {
    let (Some(a), Some(b)) = (base.filter(|a| usable_aabb(a)), head.filter(|b| usable_aabb(b))) else {
        return GeometryChange { kind: GeometryChangeKind::Moved, distance: None };
    };
    let raw_distance = centre_distance(centre(a), centre(b));
    let distance = if raw_distance > tolerances.move_tolerance { raw_distance } else { 0.0 };
    let kind = if !size_agrees(a, b, tolerances.reshape_tolerance) || distance <= 0.0 {
        GeometryChangeKind::Reshaped
    } else { GeometryChangeKind::Moved };
    GeometryChange { kind, distance: Some(distance) }
}
