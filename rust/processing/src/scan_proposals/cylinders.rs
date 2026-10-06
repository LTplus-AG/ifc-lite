// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Columns and pipes from cylinders.
//!
//! An axis within `classificationAngleDegrees` of vertical is an
//! `IfcColumn`: a circular profile from the lower axis end (for a polygonal
//! column, #6937, the circle of the polygon's cross-section area), whose ends snap
//! to a floor or ceiling within `levelSnapMetres` whose outline the column's
//! footprint reaches: the axis lies within `levelSnapMetres` plus the radius
//! of the outline, since a slab's extent can stop at the column's face. Any
//! other axis is a pipe: `IfcPipeSegment` (IFC4 and later) or
//! `IfcFlowSegment` (IFC2X3, which has no `IfcPipeSegment`).
use super::frame::{Face, Tube};
use super::levels::{snap_to, Level, Role};
use super::options::{Params, ProposalSchema};
use super::report::{ProposalBasis, ProposalClass, ProposalGeometry, ScanProposalStats};
use super::score::{confidence, tube_fit, Draft};

pub(crate) fn propose(tubes: &[Tube], faces: &[Face], levels: &[Level], params: &Params, stats: &mut ScanProposalStats) -> Vec<Draft> {
    tubes
        .iter()
        .map(|tube| {
            let (sources, fit) = tube_fit(tube);
            let coverage = 0.5 + 0.5 * (tube.arc_degrees / 360.).min(1.);
            let basis = ProposalBasis::Cylinder;
            let vertical = tube.direction()[2].abs() >= params.cos_class;
            let (class, geometry) = if vertical {
                stats.columns += 1;
                let (low, high) = if tube.start[2] <= tube.end[2] { (tube.start, tube.end) } else { (tube.end, tube.start) };
                let xy = [(low[0] + high[0]) / 2., (low[1] + high[1]) / 2.];
                let margin = params.snap + tube.radius;
                let bottom = snap_to(levels, faces, Role::Floor, xy, low[2], params.snap, margin);
                let top = snap_to(levels, faces, Role::Ceiling, xy, high[2], params.snap, margin);
                (
                    ProposalClass::IfcColumn,
                    ProposalGeometry::Column { base: [xy[0], xy[1], bottom], height_metres: top - bottom, radius_metres: tube.profile_radius() },
                )
            } else {
                stats.pipes += 1;
                let class = match params.schema {
                    ProposalSchema::Ifc2x3 => ProposalClass::IfcFlowSegment,
                    ProposalSchema::Ifc4 | ProposalSchema::Ifc4x3 => ProposalClass::IfcPipeSegment,
                };
                (class, ProposalGeometry::Pipe { start: tube.start, end: tube.end, radius_metres: tube.profile_radius() })
            };
            Draft {
                class,
                basis,
                confidence: confidence(basis, fit.rms_metres, coverage),
                sources,
                support: fit.area_square_metres,
                fit,
                geometry,
            }
        })
        .collect()
}
