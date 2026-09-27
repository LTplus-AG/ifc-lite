// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Nominal circular-section quantities from exact world-space directrices.

use super::{DirectrixMetrics, SweptDiskOccurrence};
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticExtrusion, AnalyticStatus, ProfileLoopKind};
use serde::Serialize;

/// Derived measurements in square and cubic metres for one uncut source solid.
/// The volume and lateral areas are section × centreline estimates; they do
/// not account for self-overlap, mitred joins, or later boolean operations.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct SweptDiskNominalQuantities {
    /// Circular or annular material cross-section, in m².
    pub cross_section_area: f64,
    /// Cross-section area × exact directrix length, in m³.
    pub nominal_volume: f64,
    /// Outer circumference × exact directrix length, in m².
    pub outer_lateral_area: f64,
    /// Inner circumference × exact directrix length, in m² when hollow.
    pub inner_lateral_area: Option<f64>,
}

impl SweptDiskNominalQuantities {
    pub(super) fn from_occurrence(
        disk: &SweptDiskOccurrence,
        metrics: &DirectrixMetrics,
    ) -> Option<Self> {
        // A CSG operand is a source description, not the product's visible
        // geometry. Its quantities must not look like final product quantities.
        if disk.source_modified || !disk.radius.is_finite() || disk.radius <= 0.0 {
            return None;
        }
        let inner = disk.inner_radius.unwrap_or(0.0);
        if !inner.is_finite()
            || disk.inner_radius.is_some_and(|radius| radius <= 0.0)
            || inner >= disk.radius
        {
            return None;
        }
        let length = metrics.total_length;
        if !length.is_finite() || length <= 0.0 {
            return None;
        }
        // IFC's swept-disk geometry requires every directrix arc to have a
        // radius greater than the disk radius. At or beyond the centre of
        // curvature the circular sweep folds over itself, so section area ×
        // centreline length is not a defensible nominal material volume.
        if disk.directrix.iter().any(|segment| matches!(segment,
            AnalyticCurveSegment::Arc { radius, .. } if *radius <= disk.radius
        )) {
            return None;
        }
        // Difference of squares in factored form avoids cancellation for a
        // thin annulus whose InnerRadius is close to Radius.
        let cross_section_area =
            std::f64::consts::PI * (disk.radius - inner) * (disk.radius + inner);
        let nominal_volume = cross_section_area * length;
        let outer_lateral_area = std::f64::consts::TAU * disk.radius * length;
        let inner_lateral_area = disk
            .inner_radius
            .map(|radius| std::f64::consts::TAU * radius * length);
        if !cross_section_area.is_finite()
            || !nominal_volume.is_finite()
            || !outer_lateral_area.is_finite()
            || inner_lateral_area.is_some_and(|area| !area.is_finite())
        {
            return None;
        }
        Some(Self {
            cross_section_area,
            nominal_volume,
            outer_lateral_area,
            inner_lateral_area,
        })
    }
}

/// Nominal source-solid quantities in raw IFC file-length units. A product's
/// occurrence transform, openings, and other boolean operations are excluded.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct ExtrusionNominalQuantities {
    /// Material area in squared IFC file-length units, with inner loops removed.
    pub profile_area: f64,
    /// Perpendicular distance between profile planes in IFC file-length units.
    pub projected_height: f64,
    /// Profile area × projected height in cubed IFC file-length units.
    pub nominal_volume: f64,
}

/// Derive source quantities only when the profile and extrusion are complete.
/// The projected height accounts for an oblique `ExtrudedDirection`: IFC Depth
/// measures along that unit direction, rather than along the profile normal.
pub fn extrusion_nominal_quantities(
    extrusion: &AnalyticExtrusion,
) -> Option<ExtrusionNominalQuantities> {
    if extrusion.status != AnalyticStatus::Complete {
        return None;
    }
    let profile = extrusion.profile.as_ref()?;
    if profile.status != AnalyticStatus::Complete || profile.profile_type.as_deref() != Some("AREA")
    {
        return None;
    }
    let mut profile_area = 0.0;
    let mut outer_count = 0;
    for boundary in &profile.loops {
        let area = boundary.signed_area.abs();
        if !area.is_finite() || area <= 0.0 {
            return None;
        }
        match boundary.kind {
            ProfileLoopKind::Outer => {
                outer_count += 1;
                profile_area += area;
            }
            ProfileLoopKind::Inner => profile_area -= area,
        }
    }
    if outer_count != 1 || !profile_area.is_finite() || profile_area <= 0.0 {
        return None;
    }
    let depth = extrusion.depth?;
    let axis = extrusion.axis_unit_vector?;
    let projected_height = depth * axis[2].abs();
    let nominal_volume = profile_area * projected_height;
    if !projected_height.is_finite() || projected_height <= 0.0 || !nominal_volume.is_finite() {
        return None;
    }
    Some(ExtrusionNominalQuantities {
        profile_area,
        projected_height,
        nominal_volume,
    })
}
