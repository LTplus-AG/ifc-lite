// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Complete raw/cop and cop/cop crossings using original supporting planes.
//! Existing raw/raw construction and ordering run first, unchanged. Invalid
//! support metadata is never used to manufacture a projected-only triple point.
use super::*;
use crate::kernel::{budget, interval, predicates::orient3d};
use num_traits::Zero;
use std::cmp::Ordering;
#[path = "mixed_broadphase.rs"]
mod broadphase;

pub(super) struct Supported {
    pub constraint: Constraint,
    pub support: Tri,
}
struct Validated {
    lambda: (interval::IvLam, interval::IvLam),
    valid: bool,
}
pub(super) struct Built {
    pub constraints: Vec<Vec<Constraint>>,
    segments: Vec<Vec<Supported>>,
    validated: Vec<Option<Vec<Option<Validated>>>>,
}
fn charge() -> bool {
    if budget::tripped() { return false; }
    budget::note_escalation();
    !budget::tripped()
}
fn finite(p: &ImplicitPoint) -> bool {
    let f = |p: &[f64; 3]| p.iter().all(|v| v.is_finite());
    match p {
        ImplicitPoint::Explicit(p) => f(p),
        ImplicitPoint::Lpi(l) => [l.p,l.q,l.r,l.s,l.t].iter().all(f),
        ImplicitPoint::Tpi(t) => t.planes.iter().flatten().all(f),
    }
}
fn defined(p: &ImplicitPoint, lambda: &interval::IvLam) -> bool {
    if !finite(p) { return false; }
    if matches!(p, ImplicitPoint::Explicit(_)) { return true; }
    match lambda.1.sign() {
        Some(Sign::Positive | Sign::Negative) => true,
        Some(Sign::Zero) => false,
        None => charge() && !crate::kernel::rational::lambda_of(p).1.is_zero(),
    }
}
fn on_plane(p: &ImplicitPoint, t: &Tri) -> bool {
    orient3d(p, &ImplicitPoint::Explicit(t[0]), &ImplicitPoint::Explicit(t[1]),
        &ImplicitPoint::Explicit(t[2])) == Sign::Zero
}
fn validate_one(t: &Tri, s: &Supported) -> Option<Validated> {
    if !charge() { return None; }
    let c = &s.constraint;
    let finite = finite(&c.a) && finite(&c.b)
        && t.iter().chain(s.support.iter()).flatten().all(|v| v.is_finite());
    let lambda = if finite {
        (interval::ilambda_cached(&c.a), interval::ilambda_cached(&c.b))
    } else {
        let zero = interval::ilambda_cached(&ImplicitPoint::Explicit([0.;3]));
        (zero, zero)
    };
    let valid = finite && defined(&c.a, &lambda.0) && defined(&c.b, &lambda.1)
        && projection_axis(t).is_some() && projection_axis(&s.support).is_some()
        && on_plane(&c.a, t) && on_plane(&c.b, t)
        && on_plane(&c.a, &s.support) && on_plane(&c.b, &s.support)
        && t.iter().any(|p| !on_plane(&ImplicitPoint::Explicit(*p), &s.support));
    Some(Validated { lambda, valid })
}
fn validate(t: &Tri, segments: &[Supported]) -> Vec<Validated> {
    let mut out = Vec::new();
    for s in segments {
        let Some(validated) = validate_one(t, s) else { break; };
        out.push(validated);
    }
    out
}

// Share this function item with raw splitting so both stable sorts instantiate
// the same exact comparator, including its predicate-budget side effects.
pub(super) fn order(p: &ImplicitPoint, q: &ImplicitPoint) -> Ordering {
    match cmp_lex(p, q) {
        Sign::Negative => Ordering::Less, Sign::Positive => Ordering::Greater, Sign::Zero => Ordering::Equal,
    }
}
fn canonical(points: &mut Vec<ImplicitPoint>) -> bool {
    if !charge() { return false; }
    // The comparator remains a total exact order even if its predicates trip
    // the budget. Check immediately after this finite noninterruptible sort.
    points.sort_by(order);
    if budget::tripped() { return false; }
    points.dedup_by(|a,b| cmp_lex(a,b) == Sign::Zero);
    !budget::tripped()
}

/// Every newly considered segment has its exact support validated once. No cop
/// constraints means the legacy raw/raw path incurs no additional predicates.
/// `has_coplanar` covers ALL operands, not just these carriers: a crossing on
/// another operand can require propagation into a locally raw-only seam.
pub(super) fn build(tris: &[Tri], raw: &[Vec<RawSeg>], cop: &[Vec<SupportedClip>],
    generated: &mut Vec<ImplicitPoint>, has_coplanar: bool) -> Built {
    let mut out = Built { constraints: Vec::new(), segments: Vec::new(), validated: Vec::new() };
    for (i,t) in tris.iter().enumerate() {
        if budget::tripped() { break; }
        let mut segments = split_crossings(t, &raw[i]);
        if !has_coplanar {
            // No operand can generate a mixed crossing. Consume the unchanged
            // raw/raw splitter output without cloning it for unused supports.
            debug_assert!(cop[i].is_empty());
            out.constraints.push(segments.into_iter().map(|s| s.constraint).collect());
            continue;
        }
        let raw_count = segments.len();
        segments.extend(cop[i].iter().map(|c| Supported {
            constraint: Constraint { a:c.a.clone(), b:c.b.clone() }, support:c.support,
        }));
        let mut constraints = Vec::new();
        let mut checked = None;
        if cop[i].is_empty() {
            constraints.extend(segments.iter().map(|s| s.constraint.clone()));
        } else if let Some((axis,_)) = projection_axis(t) {
            let valid = validate(t, &segments);
            if budget::tripped() { break; }
            let mut splits = vec![Vec::new(); segments.len()];
            let candidates = broadphase::Candidates::new(&valid);
            for k in 0..segments.len() {
                for l in candidates.after(k) {
                    if k < raw_count && l < raw_count { continue; }
                    if !charge() { break; }
                    if !valid[k].valid || !valid[l].valid { continue; }
                    let a = &valid[k]; let b = &valid[l];
                    let ca = &segments[k].constraint; let cb = &segments[l].constraint;
                    if segments_cross((&a.lambda.0,&ca.a), (&a.lambda.1,&ca.b),
                        (&b.lambda.0,&cb.a), (&b.lambda.1,&cb.b),axis) {
                        // Valid endpoints on BOTH original supporting planes,
                        // proper crossing on t: these three planes are independent.
                        let p = ImplicitPoint::Tpi(Tpi { planes:[*t,segments[k].support,segments[l].support] });
                        splits[k].push(p.clone()); splits[l].push(p.clone()); generated.push(p);
                    }
                }
                if budget::tripped() { break; }
            }
            for (s,mut split) in segments.iter().zip(splits) {
                if budget::tripped() { break; }
                if split.is_empty() { constraints.push(s.constraint.clone()); continue; }
                split.push(s.constraint.a.clone()); split.push(s.constraint.b.clone());
                if !canonical(&mut split) { break; }
                constraints.extend(split.windows(2).map(|w| Constraint { a:w[0].clone(),b:w[1].clone() }));
            }
            checked = Some(valid.into_iter().map(Some).collect());
        } else {
            constraints.extend(segments.iter().map(|s| s.constraint.clone()));
        }
        out.constraints.push(constraints); out.segments.push(segments); out.validated.push(checked);
    }
    out
}

/// A crossing generated on B may lie on A's existing seam too. Explicitly pass
/// that exact point to every supported constraint that contains it, BEFORE any
/// carrier is retriangulated. A shared interner alone does not split A's seam.
pub(super) fn propagate(tris: &[Tri], built: &mut Built, generated: &[ImplicitPoint],
    points: &mut [Vec<ImplicitPoint>]) {
    if generated.is_empty() || budget::tripped() { return; }
    let mut generated = generated.to_vec();
    if !canonical(&mut generated) { return; }
    let generated_candidates = broadphase::Candidates::points(&generated);
    for (i,t) in tris.iter().enumerate().take(built.segments.len()) {
        if budget::tripped() { break; }
        if built.segments[i].is_empty() { continue; }
        // Bounds use the actual seams, including raw-only seams. Carrier AABBs
        // cannot cull these points: finite cop clips can extend beyond them.
        // Unknown endpoint intervals keep all candidates and exact validation.
        let candidates = broadphase::Candidates::unvalidated(&built.segments[i]);
        let point_indices = generated_candidates.overlapping(candidates.bounds());
        if point_indices.is_empty() { continue; }
        let Some((axis,_)) = projection_axis(t) else { continue; };
        let valid = built.validated[i].get_or_insert_with(||
            (0..built.segments[i].len()).map(|_| None).collect());
        let before = points[i].len();
        for j in point_indices {
            let p = &generated[j];
            let lam = interval::ilambda_cached(p);
            let segment_indices = candidates.at(&lam);
            if segment_indices.is_empty() { continue; }
            if !charge() { break; }
            if !on_plane(p,t) { continue; }
            for k in segment_indices {
                if valid[k].is_none() {
                    valid[k] = validate_one(t, &built.segments[i][k]);
                }
                if budget::tripped() { break; }
                let Some(s) = valid[k].as_ref().filter(|s| s.valid) else { continue; };
                if !charge() { break; }
                let c = &built.segments[i][k].constraint;
                if orient2d_end((&s.lambda.0,&c.a),(&s.lambda.1,&c.b),(&lam,p),axis) == Sign::Zero {
                    let (a,b) = if order(&c.a,&c.b) == Ordering::Greater { (&c.b,&c.a) } else { (&c.a,&c.b) };
                    if order(a,p) != Ordering::Greater && order(p,b) != Ordering::Greater {
                        points[i].push(p.clone()); break;
                    }
                }
            }
        }
        if points[i].len() != before && !budget::tripped() { let _ = canonical(&mut points[i]); }
    }
}

#[cfg(test)]
#[path = "mixed_tests.rs"]
mod tests;
