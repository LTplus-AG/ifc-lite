// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! One source-qualified integer lattice for a sequence of planar booleans.
//! Source groups are quantized together once; intermediate coordinates never
//! return through a floating adapter. IDs are local to this composition only.
use crate::{BooleanOp2D, ContourFillRule, ContourSet, Ring2D};
use i_overlay::{
    core::{fill_rule::FillRule, overlay::Overlay, overlay_rule::OverlayRule},
    i_float::{adapter::FloatPointAdapter, float::rect::FloatRect, int::point::IntPoint},
};
type Ring = Vec<IntPoint<i64>>;
struct Group {
    rings: Vec<Ring>,
    shape_offsets: Vec<usize>,
    classified: bool,
}
/// Bounded sequential fixed-grid authoring. The caller charges worst-case work
/// before construction and each overlay; this context independently caps sizes.
pub struct FixedGridComposition {
    adapter: FloatPointAdapter<[f64; 2], i64>,
    groups: Vec<Group>,
    vertices: usize,
}
impl FixedGridComposition {
    /// Input group IDs are their indices; `groups.len()` is a built-in empty set.
    /// Original endpoints and topology are qualified jointly before conversion.
    pub fn new(groups: &[Vec<Ring2D>], grid: f64) -> Result<Self, String> {
        if groups.len() > 257 || !grid.is_finite() || grid <= 0. || !(1. / grid).is_finite() {
            return Err("Fixed-grid composition has invalid group count or grid".into());
        }
        let n = groups
            .iter()
            .flatten()
            .try_fold(0usize, |n, r| n.checked_add(r.len()))
            .ok_or("Fixed-grid source vertex overflow")?;
        if n > 1024
            || groups
                .iter()
                .flatten()
                .flatten()
                .flatten()
                .any(|v| !v.is_finite() || v.abs() > 1e12)
        {
            return Err("Fixed-grid composition exceeds 1024 finite source vertices".into());
        }
        let rings: Vec<_> = groups.iter().flatten().cloned().collect();
        let adapter =
            FloatPointAdapter::with_iter_and_scale_checked(rings.iter().flatten(), 1. / grid)
                .map_err(|e| format!("Fixed-grid composition numeric range: {e:?}"))?;
        crate::contour_grid_guard::validate_with_adapter(&rings, &[], grid, &adapter)
            .map_err(|e| format!("PDF original lattice qualification: {e}"))?;
        let mut result = Self {
            adapter,
            groups: vec![],
            vertices: n,
        };
        for group in groups {
            let sanitized = crate::contour_bool2d::sanitize_fixed_grid(group)?;
            let rings: Vec<Ring> = sanitized
                .iter()
                .map(|r| r.iter().map(|p| result.adapter.float_to_int(p)).collect())
                .collect();
            exact_range(&rings)?;
            result.groups.push(Group {
                rings,
                shape_offsets: vec![],
                classified: false,
            });
        }
        result.groups.push(Group {
            rings: vec![],
            shape_offsets: vec![],
            classified: true,
        });
        Ok(result)
    }
    /// Vertex count supports the caller's shared work precharge.
    pub fn vertex_count(&self, id: usize) -> Result<usize, String> {
        Ok(self.group(id)?.rings.iter().map(Vec::len).sum())
    }
    fn group(&self, id: usize) -> Result<&Group, String> {
        self.groups
            .get(id)
            .ok_or_else(|| "Unknown fixed-grid composition group".into())
    }
    /// Returns a new local group ID, preserving all islands and holes.
    pub fn overlay(
        &mut self,
        a: usize,
        b: usize,
        op: BooleanOp2D,
        fill: ContourFillRule,
    ) -> Result<usize, String> {
        let a = self.group(a)?;
        let b = self.group(b)?;
        let n = a.rings.iter().chain(&b.rings).map(Vec::len).sum::<usize>();
        if n > 1024 || self.groups.len() >= 2048 {
            return Err("Fixed-grid composition stage exceeds bounds".into());
        }
        // Integer coordinates are exactly representable under exact_range.
        // Qualification runs in integer units using a zero-centred unit adapter,
        // so it cannot introduce another rounding phase or floating near-contact.
        let floats = |rings: &[Ring]| {
            rings
                .iter()
                .map(|r| r.iter().map(|p| [p.x as f64, p.y as f64]).collect())
                .collect::<Vec<Ring2D>>()
        };
        let af = floats(&a.rings);
        let bf = floats(&b.rings);
        let radius = (1_u64 << 51) as f64;
        let unit =
            FloatPointAdapter::try_with_scale(FloatRect::new(-radius, radius, -radius, radius), 1.)
                .map_err(|e| format!("Fixed-grid composition unit range: {e:?}"))?;
        crate::contour_grid_guard::validate_with_adapter(&af, &bf, 1., &unit)
            .map_err(|e| format!("PDF integer stage qualification: {e}"))?;
        let rule = match op {
            BooleanOp2D::Union => OverlayRule::Union,
            BooleanOp2D::Difference => OverlayRule::Difference,
            BooleanOp2D::Intersection => OverlayRule::Intersect,
        };
        let fill = match fill {
            ContourFillRule::NonZero => FillRule::NonZero,
            ContourFillRule::EvenOdd => FillRule::EvenOdd,
        };
        let shapes = Overlay::with_contours(&a.rings, &b.rings).overlay(rule, fill);
        let mut group = Group {
            rings: vec![],
            shape_offsets: vec![],
            classified: true,
        };
        for shape in shapes {
            if shape.first().is_none_or(|r| r.len() < 3) {
                continue;
            }
            group.shape_offsets.push(group.rings.len());
            group
                .rings
                .extend(shape.into_iter().filter(|r| r.len() >= 3));
        }
        exact_range(&group.rings)?;
        let output = group.rings.iter().map(Vec::len).sum::<usize>();
        self.vertices = self
            .vertices
            .checked_add(output)
            .ok_or("Fixed-grid composition vertex overflow")?;
        if self.vertices > 16_384 {
            return Err("Fixed-grid composition exceeds cumulative vertex budget".into());
        }
        let id = self.groups.len();
        self.groups.push(group);
        Ok(id)
    }
    /// Convert only a completed output to model coordinates. Raw input groups
    /// are unclassified and cannot be exported as shapes.
    pub fn contours(&self, id: usize) -> Result<ContourSet, String> {
        let group = self.group(id)?;
        if !group.classified {
            return Err("Cannot export an unclassified fixed-grid source group".into());
        }
        Ok(ContourSet {
            rings: group
                .rings
                .iter()
                .map(|r| r.iter().map(|p| self.adapter.int_to_float(p)).collect())
                .collect(),
            shape_offsets: group.shape_offsets.clone(),
        })
    }
}
fn exact_range(rings: &[Ring]) -> Result<(), String> {
    if rings
        .iter()
        .flatten()
        .any(|p| p.x.unsigned_abs() > (1_u64 << 50) || p.y.unsigned_abs() > (1_u64 << 50))
    {
        return Err("Fixed-grid composition exceeds exact diagnostic coordinate range".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "contour_composition_tests.rs"]
mod tests;
