/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::{
    measure::{finite_measure, finite_sum},
    parcel_measure::probe_loop,
    topology::{point_in_loop, segments_intersect},
    LandXmlParcel, LandXmlParcelProbe, LandXmlParcelState, LandXmlPlanDocument,
    LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlPlanPointLocation, LandXmlPlanResolver,
    ParcelProbeWork,
};
use crate::plan::parser::area_scale;

const MAX_PARCEL_TOPOLOGY_EDGES: usize = 700;
const MAX_PARCEL_TOPOLOGY_WORK: usize = 1_000_000;

struct TopologyBudget<'a> {
    work: usize,
    max_work: usize,
    cancelled: Option<&'a dyn crate::LandXmlCancellation>,
}

impl TopologyBudget<'_> {
    fn check(&mut self) -> std::result::Result<(), crate::LandXmlError> {
        if self
            .cancelled
            .is_some_and(crate::LandXmlCancellation::is_cancelled)
        {
            return Err(crate::LandXmlError::new(
                crate::LandXmlDiagnosticCode::Cancelled,
                "parcel probe cancelled",
            ));
        }
        self.work = self.work.checked_add(1).ok_or_else(|| {
            crate::LandXmlError::new(
                crate::LandXmlDiagnosticCode::LimitExceeded,
                "parcel topology work limit exceeded",
            )
        })?;
        if self.work > self.max_work {
            return Err(crate::LandXmlError::new(
                crate::LandXmlDiagnosticCode::LimitExceeded,
                "parcel topology work limit exceeded",
            ));
        }
        Ok(())
    }
}

impl ParcelProbeWork for TopologyBudget<'_> {
    fn check(&mut self) -> std::result::Result<(), crate::LandXmlError> {
        TopologyBudget::check(self)
    }

    fn resolve(
        &mut self,
        document: &LandXmlPlanDocument,
        scope: Option<&crate::LandXmlSourceId>,
        location: &LandXmlPlanPointLocation,
    ) -> std::result::Result<Option<LandXmlPlanPoint>, crate::LandXmlError> {
        document.resolve_point_with_work(scope, location, self)
    }
}

/// Combines the document-wide reference cache with a deliberately local parcel
/// topology budget. A complex parcel cannot spend the resolver work reserved
/// for later monuments, geometry, or sibling parcels.
struct BulkParcelProbe<'resolver, 'document> {
    resolver: &'resolver mut LandXmlPlanResolver<'document>,
    topology: TopologyBudget<'static>,
    topology_exhausted: bool,
}

impl<'resolver, 'document> BulkParcelProbe<'resolver, 'document> {
    fn new(resolver: &'resolver mut LandXmlPlanResolver<'document>, max_work: usize) -> Self {
        Self {
            resolver,
            topology: TopologyBudget {
                work: 0,
                max_work,
                cancelled: None,
            },
            topology_exhausted: false,
        }
    }
}

impl ParcelProbeWork for BulkParcelProbe<'_, '_> {
    fn check(&mut self) -> std::result::Result<(), crate::LandXmlError> {
        let result = self.topology.check();
        if result
            .as_ref()
            .is_err_and(|error| error.code == crate::LandXmlDiagnosticCode::LimitExceeded)
        {
            self.topology_exhausted = true;
        }
        result
    }

    fn resolve(
        &mut self,
        _document: &LandXmlPlanDocument,
        scope: Option<&crate::LandXmlSourceId>,
        location: &LandXmlPlanPointLocation,
    ) -> std::result::Result<Option<LandXmlPlanPoint>, crate::LandXmlError> {
        self.resolver.resolve(scope, location)
    }
}

impl LandXmlPlanDocument {
    /// Probe a parcel in authored units with the default topology work bound.
    pub fn probe_parcel(&self, parcel: &LandXmlParcel) -> LandXmlParcelProbe {
        self.probe_parcel_with_cancel(parcel, 1_000_000, None)
            .unwrap_or_else(|error| preserved(parcel, &error.message))
    }

    /// Probe a parcel while polling cancellation inside pairwise topology work.
    pub fn probe_parcel_with_cancel(
        &self,
        parcel: &LandXmlParcel,
        max_topology_work: usize,
        cancelled: Option<&dyn crate::LandXmlCancellation>,
    ) -> std::result::Result<LandXmlParcelProbe, crate::LandXmlError> {
        let mut budget = TopologyBudget {
            work: 0,
            max_work: max_topology_work,
            cancelled,
        };
        probe_parcel_with_work(self, parcel, &mut budget)
    }

    /// Probe many parcels through one document-scoped resolver. Alias
    /// resolution is aggregate and path-compressed across the document, while
    /// each parcel gets a checked topology bound. This keeps a pathological
    /// boundary local to its source record rather than starving its siblings.
    pub fn probe_parcels_with_resolver(
        &self,
        parcels: &[LandXmlParcel],
        resolver: &mut LandXmlPlanResolver<'_>,
    ) -> std::result::Result<Vec<LandXmlParcelProbe>, crate::LandXmlError> {
        let mut probes = Vec::with_capacity(parcels.len());
        for parcel in parcels {
            let Some(max_topology_work) = parcel_topology_budget(parcel) else {
                probes.push(preserved(parcel, "parcel topology work limit exceeded"));
                continue;
            };
            let mut work = BulkParcelProbe::new(resolver, max_topology_work);
            match probe_parcel_with_work(self, parcel, &mut work) {
                Ok(probe) => probes.push(probe),
                Err(_) if work.topology_exhausted => {
                    probes.push(preserved(parcel, "parcel topology work limit exceeded"));
                }
                // Resolver limits and cancellation are document-level states:
                // never mislabel them as an individual parcel refusal.
                Err(error)
                    if matches!(
                        error.code,
                        crate::LandXmlDiagnosticCode::LimitExceeded
                            | crate::LandXmlDiagnosticCode::Cancelled
                    ) =>
                {
                    return Err(error);
                }
                Err(error) => probes.push(preserved(parcel, &error.message)),
            }
        }
        Ok(probes)
    }
}

/// Bound the existing exact pairwise topology checks before they allocate or
/// traverse an adversarial boundary. Two scans cost at most `2n² + 3n` for n
/// generated edges; extra slack covers loop bookkeeping. Curve edges are
/// deterministically capped at 64, while irregular-line vertices are counted
/// exactly. A checked cap keeps this arithmetic and the later edge vectors
/// bounded even for malformed, enormous input.
fn parcel_topology_budget(parcel: &LandXmlParcel) -> Option<usize> {
    let mut edges = 0usize;
    for geometry in parcel.loops.iter().flatten() {
        let geometry_edges = match geometry.kind {
            super::LandXmlGeometryKind::Line => 1,
            super::LandXmlGeometryKind::Curve => 64,
            super::LandXmlGeometryKind::IrregularLine => {
                geometry.intermediate_points.len().checked_add(1)?
            }
        };
        edges = edges.checked_add(geometry_edges)?;
        if edges > MAX_PARCEL_TOPOLOGY_EDGES {
            return None;
        }
    }
    let work = edges
        .checked_mul(edges)?
        .checked_mul(2)?
        .checked_add(edges.checked_mul(4)?)?
        .checked_add(64)?;
    (work <= MAX_PARCEL_TOPOLOGY_WORK).then_some(work)
}

fn probe_parcel_with_work<W: ParcelProbeWork>(
    document: &LandXmlPlanDocument,
    parcel: &LandXmlParcel,
    work: &mut W,
) -> std::result::Result<LandXmlParcelProbe, crate::LandXmlError> {
    if let Some(reason) = &parcel.preservation_reason {
        return Ok(preserved(parcel, reason));
    }
    // Curve edges are sampled only to reject self-intersection within the one
    // supported arc-plus-chord loop. Those chords are not an exact predicate
    // for crossings against another loop, so never fabricate a filled parcel
    // from multi-loop curve topology. A future analytic line/arc and arc/arc
    // intersection kernel may relax this deliberately conservative boundary.
    if parcel.loops.len() > 1
        && parcel
            .loops
            .iter()
            .flatten()
            .any(|geometry| geometry.kind == super::LandXmlGeometryKind::Curve)
    {
        return Ok(preserved(parcel, "multi-loop boundary with curves"));
    }
    let mut perimeter = 0.0;
    // Per loop: |twice signed area| and its edge range in `all_segments`.
    let mut loop_areas = Vec::with_capacity(parcel.loops.len());
    let mut all_segments = Vec::new();
    for loop_geometry in &parcel.loops {
        if !supports_analytic_curve_loop(loop_geometry) {
            return Ok(preserved(parcel, "unsupported curved boundary topology"));
        }
        let Some(loop_probe) = probe_loop(document, loop_geometry, work)? else {
            return Ok(preserved(parcel, "open or unresolved boundary"));
        };
        if loop_probe.self_intersects {
            return Ok(preserved(parcel, "self-intersecting boundary"));
        }
        perimeter = finite_sum(perimeter, loop_probe.perimeter)?;
        if segments_intersect(&all_segments, &loop_probe.segments, work)? {
            return Ok(preserved(parcel, "cross-loop or retraced boundary"));
        }
        let start = all_segments.len();
        all_segments.extend(loop_probe.segments);
        loop_areas.push((loop_probe.twice_area.abs(), start..all_segments.len()));
    }
    if parcel.loops.is_empty() {
        return Ok(preserved(parcel, "missing CoordGeom boundary"));
    }
    // #5179 (maintainer ruling): winding carries no meaning for parcel loops.
    // Loops cannot cross or touch (checked above), so each lies wholly inside
    // or outside every other. A loop nested inside an odd number of the
    // parcel's other loops is a hole; every other loop is a filled part, so
    // disjoint loops add whatever their winding.
    let mut twice_area = 0.0;
    for (index, (area, range)) in loop_areas.iter().enumerate() {
        let probe_point = all_segments[range.start].0;
        let mut is_hole = false;
        for (other_index, (_, other)) in loop_areas.iter().enumerate() {
            if other_index != index
                && point_in_loop(probe_point, &all_segments[other.clone()], work)?
            {
                is_hole = !is_hole;
            }
        }
        let signed = if is_hole { -*area } else { *area };
        twice_area = finite_sum(twice_area, signed)?;
    }
    if twice_area <= 0.0 {
        return Ok(preserved(parcel, "zero-area boundary"));
    }
    let coordinate_area = finite_measure(twice_area.abs() * 0.5)?;
    let (perimeter_in_meters, area_in_square_meters, area_in_declared_square_units) =
        match &document.units {
            Some(units) => {
                let square_meters =
                    finite_measure(coordinate_area * units.linear_scale_to_meters.powi(2))?;
                let declared_scale = match parcel.declared_area_unit.as_deref() {
                    Some(unit) => match area_scale(unit) {
                        Ok(scale) => scale,
                        Err(_) => return Ok(preserved(parcel, "unsupported parcel area unit")),
                    },
                    None => document
                        .area_scale_to_square_meters
                        .unwrap_or(units.linear_scale_to_meters.powi(2)),
                };
                if !declared_scale.is_finite() || declared_scale <= 0.0 {
                    return Ok(preserved(parcel, "invalid declared area unit scale"));
                }
                (
                    Some(finite_measure(perimeter * units.linear_scale_to_meters)?),
                    Some(square_meters),
                    Some(finite_measure(square_meters / declared_scale)?),
                )
            }
            None if parcel.declared_area_unit.is_some() => {
                return Ok(preserved(
                    parcel,
                    "parcel area unit requires document linear units",
                ));
            }
            None => (None, None, Some(coordinate_area)),
        };
    Ok(LandXmlParcelProbe {
        state: LandXmlParcelState::Analytic,
        perimeter_in_declared_linear_units: Some(perimeter),
        area_in_declared_square_units,
        declared_area: parcel.declared_area,
        declared_perimeter: parcel.declared_perimeter,
        perimeter_in_meters,
        area_in_square_meters,
    })
}

/// Curved parcel measurement is exact only for a circular arc and its one
/// straight closing chord. An `IrregularLine` may expand to arbitrary segments
/// that sampled curve edges cannot validate, so it is intentionally never a
/// fill-capable companion to a curve. Resolved endpoint continuity is checked
/// by `probe_loop`, which accepts either authored record order/direction.
fn supports_analytic_curve_loop(geometry: &[LandXmlPlanGeometry]) -> bool {
    let curve_count = geometry
        .iter()
        .filter(|item| item.kind == super::LandXmlGeometryKind::Curve)
        .count();
    curve_count == 0
        || (geometry.len() == 2
            && curve_count == 1
            && geometry
                .iter()
                .any(|item| item.kind == super::LandXmlGeometryKind::Line))
}

fn preserved(parcel: &LandXmlParcel, reason: &str) -> LandXmlParcelProbe {
    LandXmlParcelProbe {
        state: LandXmlParcelState::PreservedOnly {
            reason: reason.to_owned(),
        },
        perimeter_in_declared_linear_units: None,
        area_in_declared_square_units: None,
        declared_area: parcel.declared_area,
        declared_perimeter: parcel.declared_perimeter,
        perimeter_in_meters: None,
        area_in_square_meters: None,
    }
}
