// SPDX-License-Identifier: MPL-2.0
//! Exhaustive span disposition, directed cycle incidence and independent exact
//! area identity, followed by the established Precision topology gate.
use super::exact::{Budget, R};
use super::*;
use crate::analytic::{AnalyticCurveSegment, AnalyticProfileLoop, ProfileLoopKind};
use num_traits::Zero;
pub(super) fn certify(
    source: &UntrustedProfileChain,
    spans: &[SourceSpan],
    original: &R,
    budget: &mut Budget,
) -> Result<(Vec<[usize; 2]>, Vec<usize>, R), RegionError> {
    let mut disposition = vec![false; spans.len()];
    let mut cancellations = Vec::with_capacity(spans.len() / 2);
    let mut active = Vec::with_capacity(spans.len());
    for (i, span) in spans.iter().enumerate() {
        budget.tick(1)?;
        if disposition[i] {
            continue;
        }
        let mut same = 0;
        let mut reverse = None;
        for (j, other) in spans.iter().enumerate().skip(i + 1) {
            budget.tick(1)?;
            if other.start == span.start && other.end == span.end {
                same += 1;
            }
            if other.start == span.end && other.end == span.start {
                if reverse.is_some() {
                    return Err(refused(RegionRefusal::Multiplicity));
                }
                reverse = Some(j);
            }
        }
        if same != 0 {
            return Err(refused(RegionRefusal::Multiplicity));
        }
        disposition[i] = true;
        if let Some(j) = reverse {
            if disposition[j] {
                return Err(refused(RegionRefusal::Multiplicity));
            }
            disposition[j] = true;
            cancellations.push([i, j]);
        } else {
            active.push(i);
        }
    }
    if active.is_empty() {
        return Err(refused(RegionRefusal::Empty));
    }
    for &i in &active {
        let span = &spans[i];
        let mut incoming = 0;
        let mut outgoing = 0;
        for &j in &active {
            budget.tick(1)?;
            incoming += usize::from(spans[j].end == span.start);
            outgoing += usize::from(spans[j].start == span.start);
        }
        if incoming != 1 || outgoing != 1 {
            return Err(refused(RegionRefusal::Branching));
        }
    }
    let mut cycle = Vec::with_capacity(active.len());
    let mut current = active[0];
    loop {
        budget.tick(1)?;
        budget.tick(cycle.len() as u64)?;
        if cycle.contains(&current) {
            if current != active[0] || cycle.len() != active.len() {
                return Err(refused(RegionRefusal::Branching));
            }
            break;
        }
        cycle.push(current);
        budget.tick(active.len() as u64)?;
        current = *active
            .iter()
            .find(|&&i| spans[i].start == spans[current].end)
            .ok_or_else(|| refused(RegionRefusal::Branching))?;
    }
    let area = budget.area2(cycle.iter().map(|&i| (spans[i].start, spans[i].end)))?;
    if !budget.cmp(&area, original)?.is_eq() || area.is_zero() {
        return Err(refused(RegionRefusal::Area));
    }
    let mut segments = Vec::with_capacity(cycle.len());
    let mut float_area = 0.;
    let mut perimeter = 0.;
    // Same source-relative f64 area/perimeter policy as canonical profile parsing.
    let origin = spans[cycle[0]].start;
    for &i in &cycle {
        budget.tick(1)?;
        let span = &spans[i];
        let a = span.start;
        let b = span.end;
        float_area += ((a[0] - origin[0]) * (b[1] - origin[1])
            - (b[0] - origin[0]) * (a[1] - origin[1]))
            * 0.5;
        perimeter += (b[0] - a[0]).hypot(b[1] - a[1]);
        segments.push(AnalyticCurveSegment::Line {
            start: [a[0], a[1], 0.],
            end: [b[0], b[1], 0.],
        });
    }
    let boundary = AnalyticProfileLoop {
        kind: ProfileLoopKind::Outer,
        segments,
        signed_area: float_area,
        perimeter,
        source: None,
    };
    let precision = source.declared_precision();
    let clearance = precision.map_or(1e-9, |(_, max)| max.max(1e-9));
    let join = precision.map_or(1e-9, |(min, _)| min.min(1e-9));
    budget.tick(1)?;
    let (topology, spent) = super::super::profile_topology::validate_accounted_remaining(
        std::slice::from_ref(&boundary),
        clearance,
        join,
        budget.remaining(),
    );
    budget.topology_spent(spent)?;
    topology.map_err(|reason| refused(RegionRefusal::Topology(reason)))?;
    resource::check_current()?;
    Ok((cancellations, cycle, area))
}
