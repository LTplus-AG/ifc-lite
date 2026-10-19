// SPDX-License-Identifier: MPL-2.0
//! Deterministic endpoint-only line arrangement. Noncollinear intersections are
//! refused: no rational intersection is rounded back to source coordinates.
use super::exact::{Budget, R};
use super::*;
use crate::analytic::{AnalyticCurveSegment, AnalyticStatus, ProfileLoopKind};
use num_traits::{One, Signed, Zero};
use std::sync::atomic::{AtomicU64, Ordering};
pub(super) fn run(
    source: Arc<UntrustedProfileChain>,
    limits: RegionLimits,
) -> Result<UntrustedRegionCertificate, RegionError> {
    let mut budget = Budget::new(limits);
    budget.tick(1)?;
    if !matches!(source.parse_status(), AnalyticStatus::Complete) {
        return Err(refused(RegionRefusal::Source(
            "original chain parsing incomplete".into(),
        )));
    }
    if source.original().profile_type.as_deref() != Some("AREA") {
        return Err(refused(RegionRefusal::FillPolicy));
    }
    let loops = &source.original().loops;
    if loops.len() != 1 || loops[0].kind != ProfileLoopKind::Outer {
        return Err(refused(RegionRefusal::MultipleLoops));
    }
    let n = loops[0].segments.len();
    if n == 0 {
        return Err(refused(RegionRefusal::Empty));
    }
    if n > super::super::profile::MAX_LOOPS {
        return Err(resource::overflow().into());
    }
    let pairs = n.checked_mul(n).ok_or_else(resource::overflow)?;
    // Refuse impossible bounded cohorts before allocation or quadratic loops.
    budget.tick(pairs as u64)?;
    let span_bound = n
        .checked_mul(
            n.checked_mul(2)
                .and_then(|v| v.checked_add(1))
                .ok_or_else(resource::overflow)?,
        )
        .ok_or_else(resource::overflow)?;
    // Each rational has at most 8192-bit numerator AND denominator, bounded
    // before arithmetic. Arena covers point/parameter copies, all spans and
    // incidence/cancellation arrays, derived topology input and fixed scratch.
    let bytes = span_bound
        .checked_mul(32768)
        .and_then(|v| v.checked_add(1048576))
        .ok_or_else(resource::overflow)?;
    let permit = resource::charge(resource::Cost {
        live_bytes: bytes as u64,
        ..Default::default()
    })?;
    let mut edges = Vec::with_capacity(n);
    for segment in &loops[0].segments {
        budget.tick(1)?;
        let AnalyticCurveSegment::Line { start, end } = segment else {
            return Err(refused(RegionRefusal::Curved));
        };
        if start.iter().chain(end).any(|v| !v.is_finite()) {
            return Err(refused(RegionRefusal::Nonfinite));
        }
        if start[2] != 0. || end[2] != 0. {
            return Err(refused(RegionRefusal::Nonplanar));
        }
        let a = [start[0], start[1]];
        let b = [end[0], end[1]];
        if a == b {
            return Err(refused(RegionRefusal::Degenerate));
        }
        edges.push((a, b));
    }
    for i in 0..n {
        budget.tick(1)?;
        if edges[i].1 != edges[(i + 1) % n].0 {
            return Err(refused(RegionRefusal::Gapped));
        }
        for j in i + 1..n {
            reject_crossing(&mut budget, edges[i], edges[j])?;
        }
    }
    let mut spans = Vec::with_capacity(span_bound);
    for (edge, &(a, b)) in edges.iter().enumerate() {
        let mut splits = Vec::with_capacity(2 * n + 2);
        splits.push((R::zero(), a));
        splits.push((R::one(), b));
        for &(c, d) in &edges {
            for point in [c, d] {
                budget.tick(1)?;
                if let Some(t) = budget.parameter(a, b, point)? {
                    let mut position = 0;
                    while position < splits.len() && budget.cmp(&splits[position].0, &t)?.is_lt() {
                        position += 1;
                    }
                    if position == splits.len() || !budget.cmp(&splits[position].0, &t)?.is_eq() {
                        splits.insert(position, (t, point));
                    }
                }
            }
        }
        for pair in splits.windows(2) {
            budget.tick(1)?;
            spans.push(SourceSpan {
                edge,
                t0: pair[0].0.clone(),
                t1: pair[1].0.clone(),
                start: pair[0].1,
                end: pair[1].1,
            });
        }
    }
    let original = budget.area2(edges.iter().copied())?;
    let (cancellations, cycle, area2) =
        super::certify::certify(&source, &spans, &original, &mut budget)?;
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
        .map_err(|_| resource::overflow())?;
    Ok(UntrustedRegionCertificate {
        id: DerivedRegionId(id),
        source,
        spans,
        cancellations,
        cycle,
        area2,
        _permit: permit,
    })
}
fn reject_crossing(
    budget: &mut Budget,
    (a, b): ([f64; 2], [f64; 2]),
    (c, d): ([f64; 2], [f64; 2]),
) -> Result<(), RegionError> {
    budget.tick(1)?;
    let x = budget.orient(a, b, c)?;
    let y = budget.orient(a, b, d)?;
    let u = budget.orient(c, d, a)?;
    let v = budget.orient(c, d, b)?;
    let opposite =
        |p: &R, q: &R| (p.is_positive() && q.is_negative()) || (p.is_negative() && q.is_positive());
    if opposite(&x, &y) && opposite(&u, &v) {
        return Err(refused(RegionRefusal::Crossing));
    }
    // Endpoint contacts on noncollinear lines are split only at authored source
    // endpoints. Degree/branching and unchanged-Precision topology handle them.
    Ok(())
}
